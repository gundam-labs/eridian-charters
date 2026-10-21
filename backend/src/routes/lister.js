/**
 * Lister self-service (v1.3): charter operators, travel agents and private flyers manage their own
 * profile, post empty legs on aircraft outside the Meridian fleet, and confirm or decline requests.
 *
 * Every query is scoped to req.user.lister_id — a lister never sees another lister's flights or customers.
 * Lister legs never create Meridian charters or GST invoices: the lister operates the flight and takes payment.
 */
const { pool, withTransaction, getSettings } = require('../db');
const { asyncRouter, HttpError, isUuid } = require('../lib/http');
const { logEvent } = require('../lib/events');
const { nextNumber } = require('../lib/numbers');
const { haversineNm, ceil10 } = require('../lib/pricing');
const { parseIST } = require('../lib/time');
const { LEG_SELECT, staffLeg, isBookable, minNoticeHours, expireStaleLegs } = require('../lib/emptyLegs');
const { sendListerBookingConfirmed, sendEmptyLegRequestClosed, sendMarketplaceCancelled } = require('../lib/email');
const { captureBooking, refundBooking, completeBooking, tryPayout, runMarketplaceJobsThrottled } = require('../lib/marketplace');
const { notifyForLeg } = require('../lib/routeAlerts');
const { aopKey } = require('./operators');
const { listerProfile } = require('./auth');

const router = asyncRouter();

const HOUR_MS = 3600 * 1000;
const MAX_WINDOW_HOURS = 24;
const MAX_SEATS = 30;
// Flight-time estimate when the lister does not give one: a typical light/mid-size jet (Citation, Phenom,
// Learjet class) at 400 kts plus a taxi allowance. Listers can override it with the real figure.
const DEFAULT_CRUISE_KTS = 400;

router.use((req, res, next) => {
  if (req.user.role !== 'lister' || !req.user.lister_id) return next(new HttpError(403, 'Only lister accounts can use this'));
  next();
});

const PROFILE_SELECT = `SELECT l.id, l.lister_type, l.company, l.phone, l.city, l.gstin, l.pan, l.tan, l.nsop_permit_no, l.about, l.status,
  l.decided_at, l.decision_reason, l.created_at, u.name, u.email
  FROM listers l JOIN users u ON u.id = l.user_id`;

async function loadProfile(listerId, db = pool) {
  return (await db.query(`${PROFILE_SELECT} WHERE l.id = $1`, [listerId])).rows[0];
}

// ── Profile ─────────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  res.json(await loadProfile(req.user.lister_id));
});

router.patch('/me', async (req, res) => {
  const cur = await loadProfile(req.user.lister_id);
  if (cur.status === 'suspended') throw new HttpError(409, 'Your account is suspended — contact us to resolve it');
  const b = req.body || {};
  const fields = listerProfile(b, { partial: true, type: cur.lister_type, current: cur });
  const name = b.name !== undefined ? String(b.name).trim().slice(0, 120) : undefined;
  if (name !== undefined && name.length < 2) throw new HttpError(400, 'Please enter your full name');
  if (!Object.keys(fields).length && name === undefined) throw new HttpError(400, 'Nothing to update');
  await withTransaction(async (client) => {
    if (Object.keys(fields).length) {
      const keys = Object.keys(fields);
      // A rejected lister who updates their details goes back into the review queue.
      await client.query(
        `UPDATE listers SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}${cur.status === 'rejected' ? ", status = 'pending'" : ''} WHERE id = $1`,
        [cur.id, ...Object.values(fields)]);
    }
    if (name !== undefined) await client.query('UPDATE users SET name = $2 WHERE id = $1', [req.user.id, name]);
    await logEvent({ entity_type: 'lister', entity_id: cur.id, action: cur.status === 'rejected' ? 'resubmitted' : 'updated', actor_user_id: req.user.id,
      detail: { fields: Object.keys(fields).concat(name !== undefined ? ['name'] : []) } }, client);
  });
  res.json(await loadProfile(cur.id));
});

/** Airports listers can fly between — the same network as the public page; fees are internal. */
router.get('/airports', async (req, res) => {
  const { rows } = await pool.query('SELECT code, name, city FROM airports ORDER BY city, code');
  res.json(rows);
});

// ── Listings ────────────────────────────────────────────────────────────────
async function loadOwnLeg(req, id, db = pool) {
  if (!isUuid(id)) throw new HttpError(404, 'Listing not found');
  const l = (await db.query(`${LEG_SELECT} WHERE el.id = $1 AND el.lister_id = $2`, [id, req.user.lister_id])).rows[0];
  if (!l) throw new HttpError(404, 'Listing not found');
  return l;
}

/** Lister view of their own leg: no Meridian-internal fields. */
function ownLeg(l) {
  const s = staffLeg(l);
  const keep = ['id', 'leg_no', 'from_code', 'from_city', 'from_name', 'to_code', 'to_city', 'to_name', 'depart_earliest', 'depart_latest',
    'flight_hours', 'distance_nm', 'seats', 'price_inr', 'list_price_inr', 'savings_pct', 'status', 'notes', 'published_at', 'booked_at',
    'withdrawn_reason', 'created_at', 'aircraft_type', 'aircraft_registration', 'operator_name', 'operated_by', 'bookings_count', 'pending_requests_count',
    'dgca_check', 'dgca_operator_name'];
  return Object.fromEntries(keep.map((k) => [k, s[k] ?? null]));
}

function parseInstant(v, label) {
  const d = parseIST(v);
  if (!d) throw new HttpError(400, `${label} must be a date-time (YYYY-MM-DDTHH:mm IST or ISO 8601)`);
  return d;
}

function money(v, label) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n <= 0) throw new HttpError(400, `${label} must be a positive amount in rupees`);
  return Math.round(n);
}

function checkWindow(earliest, latest) {
  if (latest < earliest) throw new HttpError(400, 'Window end must be on or after its start');
  if (latest - earliest > MAX_WINDOW_HOURS * HOUR_MS) throw new HttpError(400, `The departure window may be at most ${MAX_WINDOW_HOURS} hours`);
  if (earliest <= new Date()) throw new HttpError(400, 'The departure window must be in the future');
}

/** Validate the editable fields of a listing. Returns only the fields present in b (all of them when !partial). */
function listingFields(b, partial) {
  const out = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has('aircraft_type')) {
    out.ext_aircraft_type = String(b.aircraft_type ?? '').trim().slice(0, 80);
    if (out.ext_aircraft_type.length < 2) throw new HttpError(400, 'Aircraft type is required, e.g. Citation XLS or King Air 350');
  }
  if (has('registration')) out.ext_registration = String(b.registration ?? '').trim().toUpperCase().slice(0, 12) || null;
  if (has('operator_name')) out.operator_name = String(b.operator_name ?? '').trim().slice(0, 120) || null;
  if (has('seats')) {
    const n = Number(b.seats);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SEATS) throw new HttpError(400, `Seats must be a whole number from 1 to ${MAX_SEATS}`);
    out.seats = n;
  }
  if (has('price_inr')) out.price_inr = money(b.price_inr, 'Price');
  if (b.list_price_inr !== undefined && b.list_price_inr !== null && b.list_price_inr !== '') out.list_price_inr = money(b.list_price_inr, 'Usual charter price');
  if (has('notes')) out.notes = b.notes ? String(b.notes).slice(0, 2000) : null;
  return out;
}

// ── DGCA aircraft check ─────────────────────────────────────────────────────
const normReg = (v) => {
  const s = String(v || '').toUpperCase().replace(/[\s.]/g, '');
  const m = s.match(/^VT-?([A-Z]{3})$/);
  return m ? `VT-${m[1]}` : (s || null);
};

/**
 * Look a registration up in the DGCA operator directory.
 * → { registration, found, model, seats, kind, role, operator: {id, name, aop_no}, check } where check is
 *   own_fleet (the lister is that operator, by permit number) | other_operator | not_listed.
 */
async function dgcaLookup(registration, listerId) {
  const reg = normReg(registration);
  if (!reg) return null;
  const a = (await pool.query(
    `SELECT a.registration, a.model, a.seats, a.kind, a.role, o.id AS operator_id, o.name AS operator_name, o.aop_no
       FROM operator_aircraft a JOIN charter_operators o ON o.id = a.operator_id WHERE a.registration = $1`, [reg])).rows[0];
  if (!a) return { registration: reg, found: false, check: 'not_listed' };
  const lister = (await pool.query('SELECT lister_type, nsop_permit_no FROM listers WHERE id = $1', [listerId])).rows[0];
  const own = lister?.lister_type === 'operator' && aopKey(lister.nsop_permit_no) && aopKey(lister.nsop_permit_no) === aopKey(a.aop_no);
  return {
    registration: reg, found: true, model: a.model, seats: a.seats, kind: a.kind, role: a.role,
    operator: { id: a.operator_id, name: a.operator_name, aop_no: a.aop_no }, check: own ? 'own_fleet' : 'other_operator',
  };
}

router.get('/aircraft-lookup', async (req, res) => {
  const r = await dgcaLookup(req.query.registration, req.user.lister_id);
  if (!r) throw new HttpError(400, 'Enter a registration such as VT-ABC');
  res.json(r);
});

/** Apply the DGCA check to listing fields; refuse aircraft the DGCA list registers for cargo only. */
async function applyDgca(fields, listerId) {
  if (fields.ext_registration === undefined) return fields;
  if (!fields.ext_registration) return { ...fields, dgca_check: null, dgca_operator_id: null };
  const r = await dgcaLookup(fields.ext_registration, listerId);
  if (r.found && r.role === 'cargo') throw new HttpError(400, `${r.registration} is registered with DGCA as a cargo aircraft and cannot carry passengers`);
  const out = { ...fields, ext_registration: r.registration, dgca_check: r.check, dgca_operator_id: r.found ? r.operator.id : null };
  if (r.found && out.operator_name === null) out.operator_name = r.operator.name; // default "Operated by" to the DGCA holder
  return out;
}

router.get('/empty-legs', async (req, res) => {
  await expireStaleLegs();
  const { rows } = await pool.query(
    `${LEG_SELECT} WHERE el.lister_id = $1
     ORDER BY CASE el.status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 WHEN 'booked' THEN 2 ELSE 3 END, el.depart_earliest`,
    [req.user.lister_id]);
  res.json(rows.map(ownLeg));
});

router.get('/empty-legs/:id', async (req, res) => {
  res.json(ownLeg(await loadOwnLeg(req, req.params.id)));
});

router.post('/empty-legs', async (req, res) => {
  const profile = await loadProfile(req.user.lister_id);
  if (profile.status === 'suspended') throw new HttpError(403, 'Your account is suspended');
  const b = req.body || {};
  const from = String(b.from_code || '').trim().toUpperCase();
  const to = String(b.to_code || '').trim().toUpperCase();
  if (!from || !to) throw new HttpError(400, 'From and to airports are required');
  if (from === to) throw new HttpError(400, 'From and to must be different airports');
  const aps = (await pool.query('SELECT code, lat, lon FROM airports WHERE code = ANY($1)', [[from, to]])).rows;
  const a = aps.find((x) => x.code === from);
  const z = aps.find((x) => x.code === to);
  if (!a || !z) throw new HttpError(400, 'Unknown airport — choose one from the list');
  const earliest = parseInstant(b.depart_earliest, 'depart_earliest');
  const latest = b.depart_latest ? parseInstant(b.depart_latest, 'depart_latest') : earliest;
  checkWindow(earliest, latest);
  const f = await applyDgca(listingFields(b, false), req.user.lister_id);
  const nm = haversineNm({ lat: Number(a.lat), lon: Number(a.lon) }, { lat: Number(z.lat), lon: Number(z.lon) });
  let flight_hours;
  if (b.flight_hours !== undefined && b.flight_hours !== null && b.flight_hours !== '') {
    flight_hours = Number(b.flight_hours);
    if (!Number.isFinite(flight_hours) || flight_hours < 0.2 || flight_hours > 12) throw new HttpError(400, 'Flight time must be between 0.2 and 12 hours');
    flight_hours = Math.round(flight_hours * 10) / 10;
  } else {
    const settings = await getSettings();
    flight_hours = ceil10(nm / DEFAULT_CRUISE_KTS + Number(settings.taxi_allowance_hours ?? 0.3));
  }
  // No "usual price" given → no strike-through price and no savings claim.
  const list_price_inr = Math.max(f.list_price_inr ?? f.price_inr, f.price_inr);
  const id = await withTransaction(async (client) => {
    const leg_no = await nextNumber('EL', client);
    const { rows } = await client.query(
      `INSERT INTO empty_legs (leg_no, lister_id, ext_aircraft_type, ext_registration, operator_name, from_code, to_code,
         depart_earliest, depart_latest, flight_hours, distance_nm, seats, list_price_inr, price_inr, status, notes, created_by, dgca_check, dgca_operator_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft',$15,$16,$17,$18) RETURNING id`,
      [leg_no, req.user.lister_id, f.ext_aircraft_type, f.ext_registration, f.operator_name, from, to, earliest, latest,
        flight_hours, Math.round(nm), f.seats, list_price_inr, f.price_inr, f.notes, req.user.id, f.dgca_check ?? null, f.dgca_operator_id ?? null]);
    await logEvent({ entity_type: 'empty_leg', entity_id: rows[0].id, action: 'created', actor_user_id: req.user.id,
      detail: { leg_no, lister_id: req.user.lister_id, price_inr: f.price_inr } }, client);
    return rows[0].id;
  });
  res.status(201).json(ownLeg(await loadOwnLeg(req, id)));
});

router.patch('/empty-legs/:id', async (req, res) => {
  await expireStaleLegs();
  const l = await loadOwnLeg(req, req.params.id);
  if (!['draft', 'published'].includes(l.status)) throw new HttpError(409, `Cannot edit a listing that is ${l.status}`);
  const b = req.body || {};
  const sets = await applyDgca(listingFields(b, true), req.user.lister_id);
  if (b.list_price_inr === null || b.list_price_inr === '') sets.list_price_inr = sets.price_inr ?? Number(l.price_inr);
  const price = sets.price_inr ?? Number(l.price_inr);
  if (sets.list_price_inr !== undefined || sets.price_inr !== undefined) {
    sets.list_price_inr = Math.max(sets.list_price_inr ?? Number(l.list_price_inr), price);
  }
  if (b.depart_earliest !== undefined || b.depart_latest !== undefined) {
    const earliest = b.depart_earliest !== undefined ? parseInstant(b.depart_earliest, 'depart_earliest') : new Date(l.depart_earliest);
    const latest = b.depart_latest !== undefined ? parseInstant(b.depart_latest, 'depart_latest') : new Date(l.depart_latest);
    checkWindow(earliest, latest);
    sets.depart_earliest = earliest;
    sets.depart_latest = latest;
  }
  if (b.flight_hours !== undefined) {
    const h = Number(b.flight_hours);
    if (!Number.isFinite(h) || h < 0.2 || h > 12) throw new HttpError(400, 'Flight time must be between 0.2 and 12 hours');
    sets.flight_hours = Math.round(h * 10) / 10;
  }
  if (!Object.keys(sets).length) throw new HttpError(400, 'Nothing to update');
  if (sets.seats !== undefined) {
    const maxPax = (await pool.query(`SELECT COALESCE(max(pax), 0)::int AS n FROM empty_leg_bookings WHERE empty_leg_id = $1 AND status = 'requested'`, [l.id])).rows[0].n;
    if (sets.seats < maxPax) throw new HttpError(409, `A pending request is for ${maxPax} passengers — seats cannot go below that`);
  }
  const keys = Object.keys(sets);
  const upd = await pool.query(
    `UPDATE empty_legs SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE id = $1 AND lister_id = $2 AND status IN ('draft','published') RETURNING id`,
    [l.id, req.user.lister_id, ...Object.values(sets)]);
  if (!upd.rows.length) throw new HttpError(409, 'Listing changed — reload and try again');
  await logEvent({ entity_type: 'empty_leg', entity_id: l.id, action: 'updated', actor_user_id: req.user.id, detail: { fields: keys } });
  res.json(ownLeg(await loadOwnLeg(req, l.id)));
});

router.post('/empty-legs/:id/publish', async (req, res) => {
  if (req.user.lister_status !== 'approved') {
    throw new HttpError(403, req.user.lister_status === 'pending'
      ? 'Your account is still being verified — you can publish as soon as it is approved'
      : 'Your account is not approved to publish listings');
  }
  const l = await loadOwnLeg(req, req.params.id);
  if (l.status !== 'draft') throw new HttpError(409, `Only drafts can be published (this listing is ${l.status})`);
  const settings = await getSettings();
  if (!isBookable({ ...l, status: 'published' }, settings)) throw new HttpError(409, `Departure is less than ${minNoticeHours(settings)} hours away — too late to publish`);
  const upd = await pool.query(`UPDATE empty_legs SET status = 'published', published_at = now() WHERE id = $1 AND lister_id = $2 AND status = 'draft' RETURNING id`,
    [l.id, req.user.lister_id]);
  if (!upd.rows.length) throw new HttpError(409, 'Listing changed — reload and try again');
  await logEvent({ entity_type: 'empty_leg', entity_id: l.id, action: 'published', actor_user_id: req.user.id, detail: { leg_no: l.leg_no, price_inr: Number(l.price_inr) } });
  notifyForLeg(l.id); // route alerts, in the background
  res.json(ownLeg(await loadOwnLeg(req, l.id)));
});

router.post('/empty-legs/:id/withdraw', async (req, res) => {
  const l = await loadOwnLeg(req, req.params.id);
  if (!['draft', 'published', 'expired'].includes(l.status)) throw new HttpError(409, `Cannot withdraw a listing that is ${l.status}`);
  const reason = String(req.body?.reason || '').trim().slice(0, 1000) || 'Withdrawn by the operator';
  const cancelled = await withTransaction(async (client) => {
    const upd = await client.query(
      `UPDATE empty_legs SET status = 'withdrawn', withdrawn_reason = $3 WHERE id = $1 AND lister_id = $2 AND status IN ('draft','published','expired') RETURNING id`,
      [l.id, req.user.lister_id, reason]);
    if (!upd.rows.length) throw new HttpError(409, 'Listing changed — reload and try again');
    await logEvent({ entity_type: 'empty_leg', entity_id: l.id, action: 'withdrawn', actor_user_id: req.user.id, detail: { reason } }, client);
    const rows = (await client.query(
      `UPDATE empty_leg_bookings SET status = 'cancelled', reject_reason = 'Flight withdrawn', decided_by = $2, decided_at = now()
        WHERE empty_leg_id = $1 AND status IN ('requested','pending_payment') RETURNING *`, [l.id, req.user.id])).rows;
    for (const r of rows) await logEvent({ entity_type: 'empty_leg_booking', entity_id: r.id, action: 'cancelled', actor_user_id: req.user.id, detail: { reason: 'Flight withdrawn' } }, client);
    return rows.filter((r) => r.status === 'cancelled');
  });
  for (const r of cancelled) await sendEmptyLegRequestClosed({ to: r.guest_email, name: r.guest_name, booking: r, leg: l, reason: 'The flight has been withdrawn by the operator' });
  res.json(ownLeg(await loadOwnLeg(req, l.id)));
});

// ── Requests on the lister's flights ────────────────────────────────────────
const BOOKING_SELECT = `SELECT b.id, b.booking_no, b.empty_leg_id, b.channel, b.pax, b.message, b.status, b.reject_reason, b.decided_at, b.created_at,
  b.guest_name, b.guest_email, b.guest_phone, b.guest_company, b.respond_by, b.completed_at, b.cancel_reason_type,
  bp.status AS pay_status, bp.amount::float8 AS pay_amount, bp.refunded_amount::float8 AS pay_refunded, bp.commission_amount::float8 AS pay_commission,
  bp.payout_amount::float8 AS pay_payout, bp.payout_status, bp.payout_ref, bp.payout_at,
  el.leg_no, el.from_code, el.to_code, el.depart_earliest, el.depart_latest, el.price_inr::float8 AS price_inr, el.seats, el.status AS leg_status,
  el.ext_aircraft_type AS aircraft_type, fa.city AS from_city, ta.city AS to_city
  FROM empty_leg_bookings b
  JOIN empty_legs el ON el.id = b.empty_leg_id
  JOIN airports fa ON fa.code = el.from_code
  JOIN airports ta ON ta.code = el.to_code
  LEFT JOIN LATERAL (SELECT * FROM booking_payments x WHERE x.booking_id = b.id ORDER BY x.created_at DESC LIMIT 1) bp ON true`;

/**
 * Customer contact details are shared with the lister only once they confirm the booking — before that the
 * lister sees the name, party size and message, enough to decide, without being able to go around the platform.
 */
function shapeRequest(b) {
  const confirmed = ['confirmed', 'completed'].includes(b.status);
  return {
    id: b.id, booking_no: b.booking_no, pax: b.pax, message: b.message, status: b.status, reject_reason: b.reject_reason,
    decided_at: b.decided_at, created_at: b.created_at, respond_by: b.status === 'requested' ? b.respond_by : null,
    completed_at: b.completed_at, cancel_reason_type: b.cancel_reason_type,
    payment: b.pay_status ? {
      status: b.pay_status, amount: b.pay_amount, refunded: b.pay_refunded, commission: b.pay_commission, payout: b.pay_payout,
      payout_status: b.payout_status, payout_ref: b.payout_ref, payout_at: b.payout_at,
    } : null,
    customer: { name: b.guest_name, company: b.guest_company, email: confirmed ? b.guest_email : null, phone: confirmed ? b.guest_phone : null },
    leg: { id: b.empty_leg_id, leg_no: b.leg_no, from_code: b.from_code, to_code: b.to_code, from_city: b.from_city, to_city: b.to_city,
      depart_earliest: b.depart_earliest, depart_latest: b.depart_latest, price_inr: b.price_inr, seats: b.seats, status: b.leg_status, aircraft_type: b.aircraft_type },
  };
}

router.get('/bookings', async (req, res) => {
  await runMarketplaceJobsThrottled();
  const params = [req.user.lister_id];
  // Unpaid checkouts never reach the lister.
  let extra = ` AND b.status NOT IN ('pending_payment','expired')`;
  if (req.query.status) {
    const st = String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean);
    if (st.some((s) => !['requested', 'confirmed', 'completed', 'rejected', 'cancelled'].includes(s))) throw new HttpError(400, 'Invalid status');
    params.push(st); extra = ` AND b.status = ANY($2)`;
  }
  const { rows } = await pool.query(
    `${BOOKING_SELECT} WHERE el.lister_id = $1${extra} ORDER BY CASE b.status WHEN 'requested' THEN 0 ELSE 1 END, b.created_at DESC`, params);
  res.json(rows.map(shapeRequest));
});

async function loadOwnBooking(req, id, db = pool) {
  if (!isUuid(id)) throw new HttpError(404, 'Request not found');
  const b = (await db.query(`${BOOKING_SELECT} WHERE b.id = $1 AND el.lister_id = $2`, [id, req.user.lister_id])).rows[0];
  if (!b) throw new HttpError(404, 'Request not found');
  return b;
}

router.post('/bookings/:id/confirm', async (req, res) => {
  if (req.user.lister_status !== 'approved') throw new HttpError(403, 'Your account must be approved to confirm bookings');
  await expireStaleLegs();
  const b0 = await loadOwnBooking(req, req.params.id);
  if (b0.status !== 'requested') throw new HttpError(409, `Cannot confirm a request that is ${b0.status}`);
  if (b0.respond_by && new Date(b0.respond_by) < new Date()) throw new HttpError(409, 'The time to confirm this request has passed');
  const result = await withTransaction(async (client) => {
    // Lock the leg, then the booking — the same order as a competing confirm or a withdraw.
    const leg = (await client.query('SELECT * FROM empty_legs WHERE id = $1 AND lister_id = $2 FOR UPDATE', [b0.empty_leg_id, req.user.lister_id])).rows[0];
    if (!leg) throw new HttpError(404, 'Listing not found');
    if (leg.status === 'booked') throw new HttpError(409, 'This flight is already booked');
    if (leg.status !== 'published') throw new HttpError(409, `This flight is ${leg.status} and cannot be booked`);
    const settings = await getSettings(client);
    if (!isBookable(leg, settings)) throw new HttpError(409, 'This flight is too close to departure to confirm through the platform');
    const locked = (await client.query(`SELECT status FROM empty_leg_bookings WHERE id = $1 FOR UPDATE`, [b0.id])).rows[0];
    if (locked?.status !== 'requested') throw new HttpError(409, 'Request changed — reload and try again');
    // Charge the traveller's held payment. If the capture fails nothing is confirmed.
    const payment = await captureBooking(client, b0.id);
    const booking = (await client.query(
      `UPDATE empty_leg_bookings SET status = 'confirmed', decided_by = $2, decided_at = now(), respond_by = NULL WHERE id = $1 AND status = 'requested' RETURNING *`,
      [b0.id, req.user.id])).rows[0];
    if (!booking) throw new HttpError(409, 'Request changed — reload and try again');
    await client.query(`UPDATE empty_legs SET status = 'booked', booked_at = now() WHERE id = $1`, [leg.id]);
    await logEvent({ entity_type: 'empty_leg_booking', entity_id: booking.id, action: 'confirmed', actor_user_id: req.user.id, detail: { booking_no: booking.booking_no, by: 'lister' } }, client);
    await logEvent({ entity_type: 'empty_leg', entity_id: leg.id, action: 'booked', actor_user_id: req.user.id, detail: { booking_no: booking.booking_no, by: 'lister' } }, client);
    const rejected = (await client.query(
      `UPDATE empty_leg_bookings SET status = 'rejected', reject_reason = 'Booked by another customer', decided_by = $3, decided_at = now()
        WHERE empty_leg_id = $1 AND id <> $2 AND status = 'requested' RETURNING *`, [leg.id, booking.id, req.user.id])).rows;
    for (const r of rejected) await logEvent({ entity_type: 'empty_leg_booking', entity_id: r.id, action: 'rejected', actor_user_id: req.user.id, detail: { reason: 'Booked by another customer' } }, client);
    return { booking, rejected, payment };
  });
  const leg = (await pool.query(`${LEG_SELECT} WHERE el.id = $1`, [b0.empty_leg_id])).rows[0];
  const profile = await loadProfile(req.user.lister_id);
  await sendListerBookingConfirmed({ to: result.booking.guest_email, name: result.booking.guest_name, booking: result.booking, leg, lister: profile, payment: result.payment });
  for (const r of result.rejected) await sendEmptyLegRequestClosed({ to: r.guest_email, name: r.guest_name, booking: r, leg, reason: 'Booked by another customer' });
  res.json(shapeRequest(await loadOwnBooking(req, b0.id)));
});

router.post('/bookings/:id/reject', async (req, res) => {
  const b = await loadOwnBooking(req, req.params.id);
  if (b.status !== 'requested') throw new HttpError(409, `Cannot decline a request that is ${b.status}`);
  const reason = String(req.body?.reason || '').trim().slice(0, 1000);
  if (!reason) throw new HttpError(400, 'A reason is required');
  const upd = await pool.query(
    `UPDATE empty_leg_bookings SET status = 'rejected', reject_reason = $2, decided_by = $3, decided_at = now() WHERE id = $1 AND status = 'requested' RETURNING *`,
    [b.id, reason, req.user.id]);
  if (!upd.rows.length) throw new HttpError(409, 'Request changed — reload and try again');
  await logEvent({ entity_type: 'empty_leg_booking', entity_id: b.id, action: 'rejected', actor_user_id: req.user.id, detail: { reason, by: 'lister' } });
  const leg = (await pool.query(`${LEG_SELECT} WHERE el.id = $1`, [b.empty_leg_id])).rows[0];
  await sendEmptyLegRequestClosed({ to: b.guest_email, name: b.guest_name, booking: b, leg, reason });
  res.json(shapeRequest(await loadOwnBooking(req, b.id)));
});

/**
 * Cancel a booked flight. reason_type: charter_change (the main charter moved or was cancelled) | weather_technical | other.
 * The traveller is refunded in full; the reason type is kept for the operator's record.
 */
router.post('/bookings/:id/cancel', async (req, res) => {
  const b = await loadOwnBooking(req, req.params.id);
  if (b.status !== 'confirmed') throw new HttpError(409, `Only confirmed bookings can be cancelled (this one is ${b.status})`);
  const reasonType = String(req.body?.reason_type || '');
  if (!['charter_change', 'weather_technical', 'other'].includes(reasonType)) throw new HttpError(400, 'reason_type must be charter_change, weather_technical or other');
  const reason = String(req.body?.reason || '').trim().slice(0, 1000);
  if (!reason) throw new HttpError(400, 'A reason is required');
  await withTransaction(async (client) => {
    const upd = await client.query(
      `UPDATE empty_leg_bookings SET status = 'cancelled', reject_reason = $2, cancel_reason_type = $3, decided_by = $4, decided_at = now()
        WHERE id = $1 AND status = 'confirmed' RETURNING id`, [b.id, reason, `operator_${reasonType}`, req.user.id]);
    if (!upd.rows.length) throw new HttpError(409, 'Booking changed — reload and try again');
    await client.query(`UPDATE empty_legs SET status = 'withdrawn', withdrawn_reason = $2 WHERE id = $1 AND status = 'booked'`, [b.empty_leg_id, reason]);
    await logEvent({ entity_type: 'empty_leg_booking', entity_id: b.id, action: 'cancelled', actor_user_id: req.user.id,
      detail: { by: 'lister', reason_type: reasonType, reason } }, client);
  });
  const refund = await refundBooking({ bookingId: b.id, pct: 100, reason, actorUserId: req.user.id });
  const leg = (await pool.query(`${LEG_SELECT} WHERE el.id = $1`, [b.empty_leg_id])).rows[0];
  await sendMarketplaceCancelled({ to: b.guest_email, name: b.guest_name, booking: b, leg, reason, refund: refund || { amount: 0, pct: 100 } });
  res.json(shapeRequest(await loadOwnBooking(req, b.id)));
});

/** Mark a confirmed flight as flown (on or after departure). The payout becomes due. */
router.post('/bookings/:id/complete', async (req, res) => {
  const b = await loadOwnBooking(req, req.params.id);
  if (b.status !== 'confirmed') throw new HttpError(409, `Only confirmed bookings can be marked flown (this one is ${b.status})`);
  if (new Date(b.depart_earliest) > new Date()) throw new HttpError(409, 'You can mark the flight as flown once its departure time has passed');
  const done = await withTransaction((client) => completeBooking(client, b.id, req.user.id));
  if (!done) throw new HttpError(409, 'Booking changed — reload and try again');
  const bp = (await pool.query(`SELECT id FROM booking_payments WHERE booking_id = $1 AND payout_status = 'due'`, [b.id])).rows[0];
  if (bp) await tryPayout(bp.id);
  res.json(shapeRequest(await loadOwnBooking(req, b.id)));
});

/** The lister's earnings: one row per paid booking, with commission and payout status. */
router.get('/payouts', async (req, res) => {
  await runMarketplaceJobsThrottled();
  const rows = (await pool.query(
    `SELECT bp.id, bp.status, bp.amount::float8 AS amount, bp.base_amount::float8 AS base, bp.gst_amount::float8 AS gst,
            bp.refunded_amount::float8 AS refunded, bp.commission_pct::float8 AS commission_pct, bp.commission_amount::float8 AS commission,
            bp.payout_amount::float8 AS payout, bp.payout_status, bp.payout_ref, bp.payout_at, bp.captured_at,
            b.booking_no, b.status AS booking_status, el.leg_no, el.from_code, el.to_code, el.depart_earliest, el.depart_latest
       FROM booking_payments bp JOIN empty_leg_bookings b ON b.id = bp.booking_id JOIN empty_legs el ON el.id = b.empty_leg_id
      WHERE bp.lister_id = $1 AND bp.status IN ('captured','partially_refunded','refunded')
      ORDER BY el.depart_earliest DESC`, [req.user.lister_id])).rows;
  const sum = (st) => Math.round(rows.filter((r) => st.includes(r.payout_status)).reduce((s, r) => s + Number(r.payout || 0), 0) * 100) / 100;
  const acct = (await pool.query('SELECT razorpay_account_id FROM listers WHERE id = $1', [req.user.lister_id])).rows[0];
  res.json({ payouts: rows, totals: { upcoming: sum(['pending']), due: sum(['due']), paid: sum(['paid', 'transferred']) }, linked_account: Boolean(acct?.razorpay_account_id) });
});

module.exports = router;
