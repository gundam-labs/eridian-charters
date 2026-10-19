const { pool, withTransaction, getSettings } = require('../db');
const { asyncRouter, HttpError, isUuid } = require('../lib/http');
const { requireRole, isStaff } = require('../middleware/auth');
const { logEvent } = require('../lib/events');
const { nextNumber } = require('../lib/numbers');
const { conflicts } = require('../lib/availability');
const { priceEmptyLeg } = require('../lib/pricing');
const { parseIST, istDate } = require('../lib/time');
const {
  LEG_SELECT, LEG_STATUSES, BOOKING_STATUSES, publicLeg, staffLeg, isBookable, minNoticeHours,
  expireStaleLegs, generateForCharter, generatedBounds, bookLegTx, findOrCreateMemberForBooking,
} = require('../lib/emptyLegs');
const { sendEmptyLegBooked, sendEmptyLegRequestClosed, APP_URL } = require('../lib/email');
const { issueInvite } = require('./auth');

const router = asyncRouter();

const HOUR_MS = 3600 * 1000;
const MAX_WINDOW_HOURS = 24;

const BOOKING_SELECT = `SELECT b.*,
  el.leg_no, el.from_code, el.to_code, el.depart_earliest, el.depart_latest, el.flight_hours::float8 AS flight_hours,
  el.price_inr::float8 AS price_inr, el.list_price_inr::float8 AS list_price_inr, el.seats, el.status AS leg_status,
  fa.city AS from_city, ta.city AS to_city, a.registration AS aircraft_registration, a.type AS aircraft_type,
  m.member_no, m.contact_name AS member_name, c.charter_no, u.name AS decided_by_name
  FROM empty_leg_bookings b
  JOIN empty_legs el ON el.id = b.empty_leg_id
  JOIN airports fa ON fa.code = el.from_code
  JOIN airports ta ON ta.code = el.to_code
  JOIN aircraft a ON a.id = el.aircraft_id
  LEFT JOIN members m ON m.id = b.member_id
  LEFT JOIN charters c ON c.id = b.charter_id
  LEFT JOIN users u ON u.id = b.decided_by`;

function shapeBooking(b) {
  const { leg_no, from_code, to_code, from_city, to_city, depart_earliest, depart_latest, flight_hours, price_inr, list_price_inr, seats, leg_status,
    aircraft_registration, aircraft_type, ...rest } = b;
  return {
    ...rest,
    leg: { id: b.empty_leg_id, leg_no, from_code, to_code, from_city, to_city, depart_earliest, depart_latest, flight_hours, price_inr, list_price_inr, seats,
      status: leg_status, aircraft_registration, aircraft_type },
  };
}

async function loadLeg(id, db = pool) {
  if (!isUuid(id)) throw new HttpError(404, 'Empty leg not found');
  const l = (await db.query(`${LEG_SELECT} WHERE el.id = $1`, [id])).rows[0];
  if (!l) throw new HttpError(404, 'Empty leg not found');
  return l;
}

async function legDetailForStaff(id) {
  const l = await loadLeg(id);
  const bookings = (await pool.query(`${BOOKING_SELECT} WHERE b.empty_leg_id = $1 ORDER BY b.created_at`, [l.id])).rows.map(shapeBooking);
  const source_charter = l.source_charter_id
    ? (await pool.query(
      `SELECT c.id, c.charter_no, c.status, c.starts_on, c.ends_on, c.legs, m.contact_name AS member_name
         FROM charters c JOIN members m ON m.id = c.member_id WHERE c.id = $1`, [l.source_charter_id])).rows[0] || null
    : null;
  const events = (await pool.query(
    `SELECT e.id, e.action, e.detail, e.created_at, u.name AS actor_name FROM events e LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.entity_type = 'empty_leg' AND e.entity_id = $1 ORDER BY e.created_at`, [l.id])).rows;
  return { ...staffLeg(l), bookings, source_charter, events };
}

function parseInstant(v, label) {
  const d = parseIST(v);
  if (!d) throw new HttpError(400, `${label} must be a date-time (YYYY-MM-DDTHH:mm IST or ISO 8601)`);
  return d;
}

function parsePrice(v, label = 'price_inr') {
  const n = Number(v);
  if (v === '' || v === null || !Number.isFinite(n) || n < 0) throw new HttpError(400, `${label} must be a non-negative number`);
  return Math.round(n);
}

// ── List ────────────────────────────────────────────────────────────────────
router.get('/', requireRole('member', 'sales', 'ops'), async (req, res) => {
  await expireStaleLegs();
  if (req.user.role === 'member') {
    const settings = await getSettings();
    const { rows } = await pool.query(
      `${LEG_SELECT} WHERE el.status = 'published' AND el.depart_latest >= now() + make_interval(mins => $1::int)
       ORDER BY el.depart_earliest`, [Math.round(minNoticeHours(settings) * 60)]);
    return res.json(rows.map((l) => ({ ...publicLeg(l), status: l.status, can_book: isBookable(l, settings) })));
  }
  const params = [];
  const where = [];
  if (req.query.status) {
    const st = String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean);
    if (st.some((s) => !LEG_STATUSES.includes(s))) throw new HttpError(400, `status must be one of ${LEG_STATUSES.join(', ')}`);
    params.push(st); where.push(`el.status = ANY($${params.length})`);
  }
  if (req.query.source_charter_id) {
    if (!isUuid(req.query.source_charter_id)) throw new HttpError(400, 'Invalid source_charter_id');
    params.push(req.query.source_charter_id); where.push(`el.source_charter_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `${LEG_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE el.status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 WHEN 'booked' THEN 2 ELSE 3 END, el.depart_earliest`, params);
  res.json(rows.map(staffLeg));
});

// ── Bookings (staff) — must precede /:id ────────────────────────────────────
router.get('/bookings', requireRole('sales', 'ops'), async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.status) {
    const st = String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean);
    if (st.some((s) => !BOOKING_STATUSES.includes(s))) throw new HttpError(400, `status must be one of ${BOOKING_STATUSES.join(', ')}`);
    params.push(st); where.push(`b.status = ANY($${params.length})`);
  }
  if (req.query.empty_leg_id) {
    if (!isUuid(req.query.empty_leg_id)) throw new HttpError(400, 'Invalid empty_leg_id');
    params.push(req.query.empty_leg_id); where.push(`b.empty_leg_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `${BOOKING_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE b.status WHEN 'requested' THEN 0 ELSE 1 END, b.created_at DESC`, params);
  res.json(rows.map(shapeBooking));
});

async function loadBooking(id, db = pool) {
  if (!isUuid(id)) throw new HttpError(404, 'Booking not found');
  const b = (await db.query(`${BOOKING_SELECT} WHERE b.id = $1`, [id])).rows[0];
  if (!b) throw new HttpError(404, 'Booking not found');
  return b;
}

router.post('/bookings/:id/confirm', requireRole('sales'), async (req, res) => {
  await expireStaleLegs();
  const b0 = await loadBooking(req.params.id);
  if (b0.status !== 'requested') throw new HttpError(409, `Cannot confirm a booking that is ${b0.status}`);
  const result = await withTransaction(async (client) => {
    // Lock the booking first, then (inside bookLegTx) the leg.
    const b = (await client.query('SELECT * FROM empty_leg_bookings WHERE id = $1 FOR UPDATE', [b0.id])).rows[0];
    if (b.status !== 'requested') throw new HttpError(409, `Cannot confirm a booking that is ${b.status}`);
    const email = String(b.guest_email).trim().toLowerCase();
    const { member, created: memberCreated } = await findOrCreateMemberForBooking(client, b, req.user.id);

    const booked = await bookLegTx(client, { legId: b.empty_leg_id, member, pax: b.pax, channel: 'public', actorUserId: req.user.id, bookingId: b.id });
    if (booked.expired) return { expired: true };

    // Member login: create if missing; issue a fresh 72h invite unless they already have a password.
    let user = (await client.query('SELECT * FROM users WHERE member_id = $1 ORDER BY created_at LIMIT 1', [member.id])).rows[0];
    if (!user) {
      const clash = (await client.query('SELECT id FROM users WHERE lower(email) = $1', [email])).rows[0];
      if (clash) throw new HttpError(409, 'A staff user already uses this email address — use a different email for the member');
      user = (await client.query(`INSERT INTO users (email, name, role, member_id) VALUES ($1,$2,'member',$3) RETURNING *`,
        [email, member.contact_name, member.id])).rows[0];
    }
    let invite_url = null;
    if (!user.password_hash) {
      const token = await issueInvite(user.id, client);
      invite_url = `${APP_URL()}/invite/${token}`;
      await logEvent({ entity_type: 'member', entity_id: member.id, action: 'invited', actor_user_id: req.user.id, detail: { user_id: user.id, via: 'empty_leg' } }, client);
    }
    return { ...booked, member, memberCreated, user, invite_url };
  });
  if (result.expired) throw new HttpError(409, 'This empty leg is no longer bookable (too close to departure)');
  const leg = await loadLeg(result.leg.id);
  await sendEmptyLegBooked({ to: result.user.email, name: result.member.contact_name, booking: result.booking, leg, charter: result.charter, invoice: result.invoice, inviteUrl: result.invite_url });
  for (const r of result.rejected) await sendEmptyLegRequestClosed({ to: r.guest_email, name: r.guest_name, booking: r, leg, reason: 'Booked by another customer' });
  const { password_hash, invite_token_hash, ...member } = { ...result.member, user_status: result.user.password_hash ? 'active' : 'invited' };
  res.json({
    booking: shapeBooking(await loadBooking(result.booking.id)),
    charter: result.charter,
    invoice: result.invoice,
    member,
    member_created: result.memberCreated,
    invite_url: result.invite_url,
  });
});

router.post('/bookings/:id/reject', requireRole('sales'), async (req, res) => {
  const b = await loadBooking(req.params.id);
  if (b.status !== 'requested') throw new HttpError(409, `Cannot reject a booking that is ${b.status}`);
  const reason = String(req.body?.reason || '').trim().slice(0, 1000);
  if (!reason) throw new HttpError(400, 'A reason is required');
  const upd = await pool.query(
    `UPDATE empty_leg_bookings SET status = 'rejected', reject_reason = $2, decided_by = $3, decided_at = now() WHERE id = $1 AND status = 'requested' RETURNING *`,
    [b.id, reason, req.user.id]);
  if (!upd.rows.length) throw new HttpError(409, 'Booking changed — reload and try again');
  await logEvent({ entity_type: 'empty_leg_booking', entity_id: b.id, action: 'rejected', actor_user_id: req.user.id, detail: { reason } });
  const leg = await loadLeg(b.empty_leg_id);
  await sendEmptyLegRequestClosed({ to: b.guest_email, name: b.guest_name, booking: b, leg, reason });
  res.json(shapeBooking(await loadBooking(b.id)));
});

// ── Generate from a charter ─────────────────────────────────────────────────
router.post('/generate/:charterId', requireRole('sales', 'ops'), async (req, res) => {
  if (!isUuid(req.params.charterId)) throw new HttpError(404, 'Charter not found');
  const created = await withTransaction(async (client) => {
    const c = (await client.query('SELECT * FROM charters WHERE id = $1 FOR UPDATE', [req.params.charterId])).rows[0];
    if (!c) throw new HttpError(404, 'Charter not found');
    if (!['accepted', 'confirmed', 'manifest_complete'].includes(c.status)) throw new HttpError(409, `Cannot generate empty legs for a charter that is ${c.status}`);
    if (!c.quote_id) throw new HttpError(409, 'This charter was itself sold as an empty leg and has no positioning legs');
    return generateForCharter(c, req.user.id, client);
  });
  const { rows } = await pool.query(`${LEG_SELECT} WHERE el.source_charter_id = $1 ORDER BY el.depart_earliest`, [req.params.charterId]);
  res.status(created.length ? 201 : 200).json({ created: created.length, empty_legs: rows.map(staffLeg) });
});

// ── Manual create ───────────────────────────────────────────────────────────
router.post('/', requireRole('sales', 'ops'), async (req, res) => {
  const b = req.body || {};
  if (!isUuid(b.aircraft_id)) throw new HttpError(400, 'aircraft_id is required');
  const from = String(b.from_code || b.from || '').trim().toUpperCase();
  const to = String(b.to_code || b.to || '').trim().toUpperCase();
  if (!from || !to) throw new HttpError(400, 'from_code and to_code are required');
  if (from === to) throw new HttpError(400, 'From and to must be different airports');
  const earliest = parseInstant(b.depart_earliest, 'depart_earliest');
  const latest = b.depart_latest ? parseInstant(b.depart_latest, 'depart_latest') : earliest;
  if (latest < earliest) throw new HttpError(400, 'depart_latest must be on or after depart_earliest');
  if (latest - earliest > MAX_WINDOW_HOURS * HOUR_MS) throw new HttpError(400, `The departure window may be at most ${MAX_WINDOW_HOURS} hours`);
  if (earliest <= new Date()) throw new HttpError(400, 'The departure window must be in the future');
  const ac = (await pool.query('SELECT * FROM aircraft WHERE id = $1', [b.aircraft_id])).rows[0];
  if (!ac) throw new HttpError(400, 'Unknown aircraft');
  if (ac.status !== 'active') throw new HttpError(409, `${ac.registration} is inactive`);
  const airports = (await pool.query('SELECT * FROM airports')).rows;
  const settings = await getSettings();
  const priced = priceEmptyLeg({ from, to, aircraft: ac, airports, settings });
  const price_inr = b.price_inr === undefined || b.price_inr === null || b.price_inr === '' ? priced.price_inr : parsePrice(b.price_inr);
  const arrive = new Date(latest.getTime() + Math.round(priced.flight_hours * HOUR_MS));
  const cf = await conflicts(ac.id, istDate(earliest), istDate(arrive));
  if (cf.length && b.force !== true) {
    return res.status(409).json({ error: `${ac.registration} is not available on these dates — pass force:true to override`, conflicts: cf });
  }
  const id = await withTransaction(async (client) => {
    const leg_no = await nextNumber('EL', client);
    const { rows } = await client.query(
      `INSERT INTO empty_legs (leg_no, aircraft_id, from_code, to_code, depart_earliest, depart_latest, flight_hours, distance_nm, seats,
         list_price_inr, price_inr, status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft',$12,$13) RETURNING id`,
      [leg_no, ac.id, from, to, earliest, latest, priced.flight_hours, priced.distance_nm, ac.seats, priced.list_price_inr, price_inr,
        b.notes ? String(b.notes).slice(0, 2000) : null, req.user.id]);
    await logEvent({ entity_type: 'empty_leg', entity_id: rows[0].id, action: 'created', actor_user_id: req.user.id, detail: { leg_no, manual: true, price_inr } }, client);
    return rows[0].id;
  });
  res.status(201).json({ ...(await legDetailForStaff(id)), conflicts: cf });
});

// ── Get one ─────────────────────────────────────────────────────────────────
router.get('/:id', requireRole('member', 'sales', 'ops'), async (req, res) => {
  await expireStaleLegs();
  if (req.user.role === 'member') {
    const settings = await getSettings();
    const l = await loadLeg(req.params.id);
    if (!isBookable(l, settings)) throw new HttpError(404, 'Empty leg not found');
    return res.json({ ...publicLeg(l), status: l.status, can_book: true });
  }
  res.json(await legDetailForStaff(req.params.id));
});

// ── Edit (draft | published) ────────────────────────────────────────────────
router.patch('/:id', requireRole('sales', 'ops'), async (req, res) => {
  await expireStaleLegs();
  const l = await loadLeg(req.params.id);
  if (!['draft', 'published'].includes(l.status)) throw new HttpError(409, `Cannot edit an empty leg that is ${l.status}`);
  const b = req.body || {};
  const sets = {};
  if (b.price_inr !== undefined) sets.price_inr = parsePrice(b.price_inr);
  if (b.notes !== undefined) sets.notes = b.notes ? String(b.notes).slice(0, 2000) : null;
  let earliest = new Date(l.depart_earliest);
  let latest = new Date(l.depart_latest);
  if (b.depart_earliest !== undefined) earliest = parseInstant(b.depart_earliest, 'depart_earliest');
  if (b.depart_latest !== undefined) latest = parseInstant(b.depart_latest, 'depart_latest');
  if (b.depart_earliest !== undefined || b.depart_latest !== undefined) {
    if (latest < earliest) throw new HttpError(400, 'depart_latest must be on or after depart_earliest');
    if (latest - earliest > MAX_WINDOW_HOURS * HOUR_MS) throw new HttpError(400, `The departure window may be at most ${MAX_WINDOW_HOURS} hours`);
    if (earliest <= new Date()) throw new HttpError(400, 'The departure window must be in the future');
    // Generated legs must stay inside the window the source charter allows.
    const bounds = await generatedBounds(l);
    if (bounds && (earliest.getTime() < bounds.earliest || latest.getTime() > bounds.latest)) {
      throw new HttpError(400, `The window must stay within ${new Date(bounds.earliest).toISOString()} – ${new Date(bounds.latest).toISOString()} so it never conflicts with the source charter`);
    }
    sets.depart_earliest = earliest;
    sets.depart_latest = latest;
  }
  if (!Object.keys(sets).length) throw new HttpError(400, 'Nothing to update (price_inr, depart_earliest, depart_latest, notes)');
  const keys = Object.keys(sets);
  const upd = await pool.query(
    `UPDATE empty_legs SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 AND status IN ('draft','published') RETURNING id`,
    [l.id, ...Object.values(sets)]);
  if (!upd.rows.length) throw new HttpError(409, 'Empty leg changed — reload and try again');
  await logEvent({ entity_type: 'empty_leg', entity_id: l.id, action: 'updated', actor_user_id: req.user.id, detail: { fields: keys, price_inr: sets.price_inr } });
  res.json(await legDetailForStaff(l.id));
});

// ── Publish / withdraw ──────────────────────────────────────────────────────
router.post('/:id/publish', requireRole('sales', 'ops'), async (req, res) => {
  const l = await loadLeg(req.params.id);
  if (l.status !== 'draft') throw new HttpError(409, `Only draft empty legs can be published (this one is ${l.status})`);
  const settings = await getSettings();
  if (!isBookable({ ...l, status: 'published' }, settings)) throw new HttpError(409, `Departure is less than ${minNoticeHours(settings)} hours away — too late to publish`);
  if (l.source_charter_status === 'cancelled') throw new HttpError(409, 'The source charter was cancelled');
  const upd = await pool.query(`UPDATE empty_legs SET status = 'published', published_at = now() WHERE id = $1 AND status = 'draft' RETURNING id`, [l.id]);
  if (!upd.rows.length) throw new HttpError(409, 'Empty leg changed — reload and try again');
  await logEvent({ entity_type: 'empty_leg', entity_id: l.id, action: 'published', actor_user_id: req.user.id, detail: { leg_no: l.leg_no, price_inr: Number(l.price_inr) } });
  res.json(await legDetailForStaff(l.id));
});

router.post('/:id/withdraw', requireRole('sales', 'ops'), async (req, res) => {
  const l = await loadLeg(req.params.id);
  if (!['draft', 'published', 'expired'].includes(l.status)) throw new HttpError(409, `Cannot withdraw an empty leg that is ${l.status}`);
  const reason = String(req.body?.reason || '').trim().slice(0, 1000);
  if (!reason) throw new HttpError(400, 'A reason is required');
  const cancelled = await withTransaction(async (client) => {
    const upd = await client.query(
      `UPDATE empty_legs SET status = 'withdrawn', withdrawn_reason = $2 WHERE id = $1 AND status IN ('draft','published','expired') RETURNING id`, [l.id, reason]);
    if (!upd.rows.length) throw new HttpError(409, 'Empty leg changed — reload and try again');
    await logEvent({ entity_type: 'empty_leg', entity_id: l.id, action: 'withdrawn', actor_user_id: req.user.id, detail: { reason } }, client);
    const rows = (await client.query(
      `UPDATE empty_leg_bookings SET status = 'cancelled', reject_reason = 'Flight withdrawn', decided_by = $2, decided_at = now()
        WHERE empty_leg_id = $1 AND status = 'requested' RETURNING *`, [l.id, req.user.id])).rows;
    for (const r of rows) await logEvent({ entity_type: 'empty_leg_booking', entity_id: r.id, action: 'cancelled', actor_user_id: req.user.id, detail: { reason: 'Flight withdrawn' } }, client);
    return rows;
  });
  for (const r of cancelled) await sendEmptyLegRequestClosed({ to: r.guest_email, name: r.guest_name, booking: r, leg: l, reason: 'The flight has been withdrawn by the operator' });
  res.json(await legDetailForStaff(l.id));
});

// ── Member instant booking ──────────────────────────────────────────────────
router.post('/:id/book', async (req, res) => {
  if (req.user.role !== 'member') throw new HttpError(403, 'Only members can book empty legs');
  if (!isUuid(req.params.id)) throw new HttpError(404, 'Empty leg not found');
  const pax = Number(req.body?.pax);
  if (!Number.isInteger(pax) || pax < 1) throw new HttpError(400, 'pax must be a whole number of passengers');
  const message = req.body?.message ? String(req.body.message).slice(0, 2000) : null;
  const result = await withTransaction(async (client) => {
    const member = (await client.query('SELECT * FROM members WHERE id = $1', [req.user.member_id])).rows[0];
    if (!member || member.status !== 'active') throw new HttpError(403, 'Your membership is not active');
    return bookLegTx(client, { legId: req.params.id, member, pax, channel: 'member', actorUserId: req.user.id, message });
  });
  if (result.expired) throw new HttpError(409, 'This empty leg is no longer bookable (too close to departure)');
  const leg = await loadLeg(result.leg.id);
  await sendEmptyLegBooked({ to: req.user.email, name: req.user.name, booking: result.booking, leg, charter: result.charter, invoice: result.invoice });
  for (const r of result.rejected) await sendEmptyLegRequestClosed({ to: r.guest_email, name: r.guest_name, booking: r, leg, reason: 'Booked by another customer' });
  const { decided_by, ...booking } = result.booking;
  res.status(201).json({ booking, charter: result.charter, invoice: result.invoice });
});

module.exports = router;
