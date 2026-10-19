/**
 * Empty legs (SPEC v1.1): generation from a charter's positioning legs, lazy expiry,
 * the race-safe booking transaction, the source-cancellation cascade and serializers.
 */
const { pool, getSettings } = require('../db');
const { HttpError } = require('./http');
const { priceQuote, priceEmptyLeg } = require('./pricing');
const { nextNumber, nextMemberNo } = require('./numbers');
const { logEvent } = require('./events');
const { conflicts } = require('./availability');
const { istDate, toISTISO, todayIST, addDays } = require('./time');

const HOUR_MS = 3600 * 1000;
const MIN_MS = 60 * 1000;
// Generated window: scheduled positioning departure −2h / +1h, clamped so the aircraft is never
// needed for the source charter's passenger legs (with a 30-minute turnaround buffer).
const WINDOW_BEFORE_MS = 2 * HOUR_MS;
const WINDOW_AFTER_MS = 1 * HOUR_MS;
const TURNAROUND_MS = 30 * MIN_MS;

const LEG_STATUSES = ['draft', 'published', 'booked', 'withdrawn', 'expired'];
const BOOKING_STATUSES = ['requested', 'confirmed', 'rejected', 'cancelled'];

const isTrue = (v) => v === true || String(v).toLowerCase() === 'true' || String(v) === '1';
const minNoticeHours = (settings) => {
  const n = Number(settings.empty_leg_min_notice_hours);
  return Number.isFinite(n) && n >= 0 ? n : 6;
};

/** Published legs whose depart_latest − now < min notice become 'expired' (persisted lazily on read). */
async function expireStaleLegs(db = pool) {
  const settings = await getSettings(db);
  const { rows } = await db.query(
    `UPDATE empty_legs SET status = 'expired'
      WHERE status = 'published' AND depart_latest < now() + make_interval(mins => $1::int)
      RETURNING id, leg_no`,
    [Math.round(minNoticeHours(settings) * 60)]
  );
  for (const l of rows) {
    await db.query(`INSERT INTO events (entity_type, entity_id, action, detail) VALUES ('empty_leg', $1, 'expired', $2)`, [l.id, JSON.stringify({ leg_no: l.leg_no })]);
  }
  return rows.length;
}

/** True when a leg row can still be booked right now. */
function isBookable(leg, settings) {
  return leg.status === 'published' && new Date(leg.depart_latest).getTime() - Date.now() >= minNoticeHours(settings) * HOUR_MS;
}

const savingsPct = (l) => (Number(l.list_price_inr) > 0 ? Math.round((1 - Number(l.price_inr) / Number(l.list_price_inr)) * 100) : 0);

// ── SQL ─────────────────────────────────────────────────────────────────────
const LEG_SELECT = `SELECT el.*,
  fa.city AS from_city, fa.name AS from_name, ta.city AS to_city, ta.name AS to_name,
  a.registration AS aircraft_registration, a.type AS aircraft_type, a.home_base AS aircraft_home_base,
  sc.charter_no AS source_charter_no, sc.status AS source_charter_status,
  (SELECT count(*)::int FROM empty_leg_bookings b WHERE b.empty_leg_id = el.id) AS bookings_count,
  (SELECT count(*)::int FROM empty_leg_bookings b WHERE b.empty_leg_id = el.id AND b.status = 'requested') AS pending_requests_count,
  (SELECT c.id FROM charters c WHERE c.empty_leg_id = el.id) AS booked_charter_id,
  (SELECT c.charter_no FROM charters c WHERE c.empty_leg_id = el.id) AS booked_charter_no
  FROM empty_legs el
  JOIN airports fa ON fa.code = el.from_code
  JOIN airports ta ON ta.code = el.to_code
  JOIN aircraft a ON a.id = el.aircraft_id
  LEFT JOIN charters sc ON sc.id = el.source_charter_id`;

/**
 * Public/member-safe shape. Whitelist only — never registration, partner, hourly rate, aircraft id,
 * source charter or anything about other customers.
 */
function publicLeg(l) {
  return {
    id: l.id,
    leg_no: l.leg_no,
    from_code: l.from_code,
    from_city: l.from_city,
    from_name: l.from_name,
    to_code: l.to_code,
    to_city: l.to_city,
    to_name: l.to_name,
    depart_earliest: l.depart_earliest,
    depart_latest: l.depart_latest,
    flight_hours: Number(l.flight_hours),
    aircraft_type: l.aircraft_type,
    seats: l.seats,
    price_inr: Number(l.price_inr),
    list_price_inr: Number(l.list_price_inr),
    savings_pct: savingsPct(l),
  };
}

/** Staff shape: everything, plus savings_pct. */
function staffLeg(l) {
  return { ...l, flight_hours: Number(l.flight_hours), savings_pct: savingsPct(l) };
}

// ── Generation ──────────────────────────────────────────────────────────────
/**
 * Compute the positioning legs of a charter as [{ source_leg, from, to, depart_at, arrive_at, flight_hours, distance_nm,
 * earliest, latest }]. Uses the quote's stored positioning when the charter still flies the quoted aircraft;
 * otherwise re-derives positioning for the current aircraft from the charter's legs.
 */
async function positioningFor(charter, db = pool) {
  if (!charter.quote_id) return [];
  const q = (await db.query('SELECT aircraft_id, positioning FROM quotes WHERE id = $1', [charter.quote_id])).rows[0];
  if (!q) return [];
  const legs = charter.legs || [];
  if (!legs.length) return [];
  let positioning = q.positioning || [];
  if (q.aircraft_id !== charter.aircraft_id) {
    const aircraft = (await db.query('SELECT * FROM aircraft WHERE id = $1', [charter.aircraft_id])).rows[0];
    const airports = (await db.query('SELECT * FROM airports')).rows;
    const settings = await getSettings(db);
    positioning = priceQuote({ legs: legs.map((l) => ({ from: l.from, to: l.to, depart_at: l.depart_at })), aircraft, airports, settings }).positioning;
  }
  const firstDep = Date.parse(legs[0].depart_at);
  const lastArr = Date.parse(legs[legs.length - 1].arrive_at);
  return positioning.map((p) => {
    const dep = Date.parse(p.depart_at);
    const durMs = Math.round(Number(p.flight_hours) * HOUR_MS);
    const out = dep < firstDep;
    let earliest = dep - WINDOW_BEFORE_MS;
    let latest = dep + WINDOW_AFTER_MS;
    if (out) latest = Math.min(latest, firstDep - durMs - TURNAROUND_MS); // must arrive before passengers board
    else earliest = Math.max(earliest, lastArr + TURNAROUND_MS); // aircraft must be back on the ground first
    if (latest < earliest) latest = earliest = dep;
    return { source_leg: out ? 'positioning_out' : 'positioning_back', ...p, earliest, latest };
  });
}

/**
 * Create draft empty legs for each positioning leg of a charter that does not have one yet
 * (charter + source_leg). Publishes immediately when empty_leg_auto_publish is true.
 * Pass a transaction client. → array of created leg rows.
 */
async function generateForCharter(charter, actorUserId, db) {
  const pos = await positioningFor(charter, db);
  if (!pos.length) return [];
  const settings = await getSettings(db);
  const aircraft = (await db.query('SELECT * FROM aircraft WHERE id = $1', [charter.aircraft_id])).rows[0];
  const airports = (await db.query('SELECT * FROM airports')).rows;
  const autoPublish = isTrue(settings.empty_leg_auto_publish);
  const created = [];
  for (const p of pos) {
    const exists = await db.query('SELECT 1 FROM empty_legs WHERE source_charter_id = $1 AND source_leg = $2', [charter.id, p.source_leg]);
    if (exists.rows.length) continue;
    const price = priceEmptyLeg({ from: p.from, to: p.to, aircraft, airports, settings, flight_hours: p.flight_hours, distance_nm: p.distance_nm });
    const leg_no = await nextNumber('EL', db);
    const status = autoPublish ? 'published' : 'draft';
    const { rows } = await db.query(
      `INSERT INTO empty_legs (leg_no, source_charter_id, source_leg, aircraft_id, from_code, to_code, depart_earliest, depart_latest,
         flight_hours, distance_nm, seats, list_price_inr, price_inr, status, published_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, CASE WHEN $14 = 'published' THEN now() END, $15)
       ON CONFLICT DO NOTHING RETURNING *`,
      [leg_no, charter.id, p.source_leg, aircraft.id, p.from, p.to, new Date(p.earliest), new Date(p.latest),
        price.flight_hours, price.distance_nm, aircraft.seats, price.list_price_inr, price.price_inr, status, actorUserId]);
    if (!rows[0]) continue;
    created.push(rows[0]);
    await logEvent({ entity_type: 'empty_leg', entity_id: rows[0].id, action: 'generated', actor_user_id: actorUserId,
      detail: { leg_no, charter_no: charter.charter_no, source_leg: p.source_leg, auto_published: autoPublish } }, db);
    await logEvent({ entity_type: 'charter', entity_id: charter.id, action: 'empty_leg_generated', actor_user_id: actorUserId,
      detail: { leg_no, source_leg: p.source_leg, route: `${p.from}-${p.to}` } }, db);
  }
  return created;
}

/** Generation bounds for a generated leg (used to validate edits). → { earliest, latest } in ms, or null. */
async function generatedBounds(leg, db = pool) {
  if (!leg.source_charter_id) return null;
  const charter = (await db.query('SELECT * FROM charters WHERE id = $1', [leg.source_charter_id])).rows[0];
  if (!charter) return null;
  const p = (await positioningFor(charter, db)).find((x) => x.source_leg === leg.source_leg);
  return p ? { earliest: p.earliest, latest: p.latest } : null;
}

// ── Booking (one transaction, caller supplies the client) ──────────────────
/**
 * Book an empty leg for a member. Locks the leg row FOR UPDATE so concurrent bookings serialise;
 * the loser gets 409. Creates/updates the booking (confirmed), the charter (accepted), the invoice,
 * marks the leg booked and rejects other pending requests.
 *   bookingId: an existing 'requested' booking being confirmed (public channel); otherwise a new booking is created.
 * → { booking, charter, invoice, leg, rejected: [booking rows to email] }
 */
async function bookLegTx(client, { legId, member, pax, channel, actorUserId, bookingId = null, guest = null, message = null }) {
  const settings = await getSettings(client);
  const leg = (await client.query('SELECT * FROM empty_legs WHERE id = $1 FOR UPDATE', [legId])).rows[0];
  if (!leg) throw new HttpError(404, 'Empty leg not found');
  if (leg.status === 'booked') throw new HttpError(409, 'This empty leg has already been booked');
  if (leg.status !== 'published') throw new HttpError(409, `This empty leg is ${leg.status} and cannot be booked`);
  if (!isBookable(leg, settings)) {
    await client.query(`UPDATE empty_legs SET status = 'expired' WHERE id = $1`, [leg.id]);
    await logEvent({ entity_type: 'empty_leg', entity_id: leg.id, action: 'expired', detail: { leg_no: leg.leg_no } }, client);
    return { expired: true };
  }
  const n = Number(pax);
  if (!Number.isInteger(n) || n < 1 || n > leg.seats) throw new HttpError(400, `pax must be between 1 and ${leg.seats}`);

  const ac = (await client.query('SELECT * FROM aircraft WHERE id = $1 FOR UPDATE', [leg.aircraft_id])).rows[0];
  const departMs = new Date(leg.depart_earliest).getTime();
  const arriveMs = departMs + Math.round(Number(leg.flight_hours) * HOUR_MS);
  const starts_on = istDate(departMs);
  const ends_on = istDate(arriveMs);
  const cf = await conflicts(leg.aircraft_id, starts_on, ends_on, null, client, { sourceCharterId: leg.source_charter_id });
  if (cf.length || ac.status === 'inactive') throw new HttpError(409, 'Aircraft no longer available for this flight — contact sales');

  // Crew copied from the source charter when there is one.
  const src = leg.source_charter_id
    ? (await client.query('SELECT charter_no, captain_id, first_officer_id, cabin_crew_id FROM charters WHERE id = $1', [leg.source_charter_id])).rows[0]
    : null;
  const charter_no = await nextNumber('CH', client);
  const legs = [{
    from: leg.from_code, to: leg.to_code, depart_at: toISTISO(departMs), arrive_at: toISTISO(arriveMs),
    distance_nm: leg.distance_nm, flight_hours: Number(leg.flight_hours),
  }];
  const charter = (await client.query(
    `INSERT INTO charters (charter_no, quote_id, empty_leg_id, member_id, aircraft_id, legs, starts_on, ends_on, pax, status,
       captain_id, first_officer_id, cabin_crew_id, ops_notes)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, 'accepted', $9, $10, $11, $12) RETURNING *`,
    [charter_no, leg.id, member.id, leg.aircraft_id, JSON.stringify(legs), starts_on, ends_on, n,
      src?.captain_id || null, src?.first_officer_id || null, src?.cabin_crew_id || null,
      `Empty leg ${leg.leg_no}${src ? ` (positioning of ${src.charter_no})` : ''} — departure window ${toISTISO(leg.depart_earliest)} to ${toISTISO(leg.depart_latest)}`])).rows[0];
  await logEvent({ entity_type: 'charter', entity_id: charter.id, action: 'accepted', actor_user_id: actorUserId,
    detail: { charter_no, empty_leg: leg.leg_no, channel } }, client);

  const gst_rate_pct = Number(settings.gst_rate_pct ?? 12);
  const subtotal = Math.round(Number(leg.price_inr));
  const gst_amount = Math.round(subtotal * gst_rate_pct / 100);
  const today = todayIST();
  const invoice_no = await nextNumber('INV', client);
  const invoice = (await client.query(
    `INSERT INTO invoices (invoice_no, charter_id, member_id, subtotal, gst_rate_pct, gst_amount, total, issued_on, due_on, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unpaid') RETURNING *`,
    [invoice_no, charter.id, member.id, subtotal, gst_rate_pct, gst_amount, subtotal + gst_amount, today,
      addDays(today, Number(settings.invoice_due_days) || 7)])).rows[0];
  await logEvent({ entity_type: 'invoice', entity_id: invoice.id, action: 'issued', actor_user_id: actorUserId, detail: { invoice_no, total: invoice.total } }, client);

  let booking;
  if (bookingId) {
    booking = (await client.query(
      `UPDATE empty_leg_bookings SET status = 'confirmed', member_id = $2, charter_id = $3, pax = $4, decided_by = $5, decided_at = now()
        WHERE id = $1 AND status = 'requested' RETURNING *`,
      [bookingId, member.id, charter.id, n, actorUserId])).rows[0];
    if (!booking) throw new HttpError(409, 'Booking request changed — reload and try again');
  } else {
    const booking_no = await nextNumber('ELB', client);
    booking = (await client.query(
      `INSERT INTO empty_leg_bookings (booking_no, empty_leg_id, member_id, channel, guest_name, guest_email, guest_phone, guest_company,
         pax, message, status, charter_id, decided_by, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'confirmed',$11,$12,now()) RETURNING *`,
      [booking_no, leg.id, member.id, channel, guest?.name || member.contact_name, guest?.email || member.email,
        guest?.phone || member.phone || null, guest?.company || member.company || null, n, message, charter.id, actorUserId])).rows[0];
  }
  await logEvent({ entity_type: 'empty_leg_booking', entity_id: booking.id, action: 'confirmed', actor_user_id: actorUserId,
    detail: { booking_no: booking.booking_no, charter_no, channel } }, client);

  await client.query(`UPDATE empty_legs SET status = 'booked', booked_at = now() WHERE id = $1`, [leg.id]);
  await logEvent({ entity_type: 'empty_leg', entity_id: leg.id, action: 'booked', actor_user_id: actorUserId,
    detail: { booking_no: booking.booking_no, charter_no, member_id: member.id } }, client);

  const rejected = (await client.query(
    `UPDATE empty_leg_bookings SET status = 'rejected', reject_reason = 'Booked by another customer', decided_by = $3, decided_at = now()
      WHERE empty_leg_id = $1 AND id <> $2 AND status = 'requested' RETURNING *`,
    [leg.id, booking.id, actorUserId])).rows;
  for (const r of rejected) {
    await logEvent({ entity_type: 'empty_leg_booking', entity_id: r.id, action: 'rejected', actor_user_id: actorUserId, detail: { reason: 'Booked by another customer' } }, client);
  }
  return { booking, charter, invoice, leg: { ...leg, status: 'booked' }, rejected };
}

// ── Source charter cancelled ────────────────────────────────────────────────
/**
 * Inside the cancel transaction: withdraw the cancelled charter's non-booked empty legs, cancel pending
 * requests on them, and flag charters already sold on its legs. Also, if the cancelled charter was itself
 * sold on an empty leg, its booking is cancelled.
 * → { cancelledRequests: [{booking, leg}], flagged: [{charter_no, leg_no}] } for emailing after commit.
 */
async function onCharterCancelled(charter, actorUserId, db) {
  const out = { cancelledRequests: [], flagged: [] };
  const withdrawn = (await db.query(
    `UPDATE empty_legs SET status = 'withdrawn', withdrawn_reason = 'Source charter cancelled'
      WHERE source_charter_id = $1 AND status IN ('draft','published','expired') RETURNING id, leg_no`, [charter.id])).rows;
  for (const l of withdrawn) {
    await logEvent({ entity_type: 'empty_leg', entity_id: l.id, action: 'withdrawn', actor_user_id: actorUserId, detail: { reason: 'Source charter cancelled', charter_no: charter.charter_no } }, db);
    const reqs = (await db.query(
      `UPDATE empty_leg_bookings SET status = 'cancelled', reject_reason = 'Flight withdrawn', decided_by = $2, decided_at = now()
        WHERE empty_leg_id = $1 AND status = 'requested' RETURNING *`, [l.id, actorUserId])).rows;
    if (reqs.length) {
      const leg = (await db.query(`${LEG_SELECT} WHERE el.id = $1`, [l.id])).rows[0];
      for (const b of reqs) {
        await logEvent({ entity_type: 'empty_leg_booking', entity_id: b.id, action: 'cancelled', actor_user_id: actorUserId, detail: { reason: 'Source charter cancelled' } }, db);
        out.cancelledRequests.push({ booking: b, leg });
      }
    }
  }
  // Legs already sold: do not cancel the derived charter; warn ops and sales.
  const derived = (await db.query(
    `SELECT c.id, c.charter_no, el.leg_no FROM charters c JOIN empty_legs el ON el.id = c.empty_leg_id
      WHERE el.source_charter_id = $1 AND c.status NOT IN ('cancelled','closed')`, [charter.id])).rows;
  for (const d of derived) {
    const note = `Source charter ${charter.charter_no} was cancelled — confirm this flight is still operating`;
    await db.query(`UPDATE charters SET ops_notes = CASE WHEN ops_notes IS NULL OR ops_notes = '' THEN $2 ELSE ops_notes || E'\\n' || $2 END WHERE id = $1`, [d.id, note]);
    await logEvent({ entity_type: 'charter', entity_id: d.id, action: 'source_charter_cancelled', actor_user_id: actorUserId, detail: { source_charter_no: charter.charter_no, note } }, db);
    out.flagged.push(d);
  }
  // The cancelled charter was itself bought on an empty leg.
  if (charter.empty_leg_id) {
    const b = (await db.query(`UPDATE empty_leg_bookings SET status = 'cancelled' WHERE charter_id = $1 AND status = 'confirmed' RETURNING id`, [charter.id])).rows;
    for (const x of b) await logEvent({ entity_type: 'empty_leg_booking', entity_id: x.id, action: 'cancelled', actor_user_id: actorUserId, detail: { reason: 'charter cancelled' } }, db);
  }
  return out;
}

/**
 * Find the member for a public booking by email (case-insensitive) or create one
 * (individual, or corporate if a company was given; silver; active; source empty_leg_public).
 * → { member, created }
 */
async function findOrCreateMemberForBooking(client, booking, actorUserId) {
  const email = String(booking.guest_email).trim().toLowerCase();
  const existing = (await client.query('SELECT * FROM members WHERE lower(email) = $1 FOR UPDATE', [email])).rows[0];
  if (existing) {
    if (existing.status !== 'active') throw new HttpError(409, `Member ${existing.member_no} with this email is inactive — reactivate them first`);
    return { member: existing, created: false };
  }
  const member_no = await nextMemberNo(client);
  const member = (await client.query(
    `INSERT INTO members (member_no, member_type, contact_name, company, email, phone, tier, status, member_since, source, notes)
     VALUES ($1,$2,$3,$4,$5,$6,'silver','active',$7,'empty_leg_public',$8) RETURNING *`,
    [member_no, booking.guest_company ? 'corporate' : 'individual', booking.guest_name, booking.guest_company || null, email,
      booking.guest_phone || null, todayIST().slice(0, 7), `Joined via public empty-leg request ${booking.booking_no}`])).rows[0];
  await logEvent({ entity_type: 'member', entity_id: member.id, action: 'created', actor_user_id: actorUserId,
    detail: { member_no, source: 'empty_leg_public', booking_no: booking.booking_no } }, client);
  return { member, created: true };
}

/** Recipients for sales notices: SALES_EMAIL (comma-separated) or all active sales/admin users. */
async function salesRecipients(db = pool) {
  const env = String(process.env.SALES_EMAIL || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (env.length) return env;
  const { rows } = await db.query(`SELECT email FROM users WHERE role IN ('sales','admin') AND is_active ORDER BY role DESC, email`);
  return rows.map((r) => r.email);
}

module.exports = {
  LEG_SELECT, LEG_STATUSES, BOOKING_STATUSES, publicLeg, staffLeg, savingsPct, isBookable, minNoticeHours,
  expireStaleLegs, generateForCharter, generatedBounds, positioningFor, bookLegTx, onCharterCancelled, salesRecipients, findOrCreateMemberForBooking,
};
