/**
 * Public empty-leg endpoints (no auth). Never exposes registration, partner, hourly rate, aircraft id,
 * source charter or other customers' data — responses go through publicLeg() (a whitelist).
 */
const { pool, getSettings, withTransaction } = require('../db');
const { asyncRouter, HttpError, isUuid } = require('../lib/http');
const { logEvent } = require('../lib/events');
const { nextNumber } = require('../lib/numbers');
const { LEG_SELECT, publicLeg, isBookable, minNoticeHours, expireStaleLegs, salesRecipients } = require('../lib/emptyLegs');
const { sendEmptyLegRequestAck, sendEmptyLegSalesNotice, sendListerRequestNotice } = require('../lib/email');
const { priceFor, startHold, newToken } = require('../lib/marketplace');

/** Public shape plus, for lister (marketplace) flights, the total payable incl. GST. */
async function withTotals(rows) {
  const settings = await getSettings();
  return rows.map((l) => {
    const out = publicLeg(l);
    if (l.lister_id) {
      const p = priceFor(l, settings);
      Object.assign(out, { gst_rate_pct: p.gst_rate_pct, total_inr: p.total, pay_on_request: true });
    }
    return out;
  });
}

const router = asyncRouter();

const CODE_RE = /^[A-Z]{3}$/;
const EMAIL_RE = /^[^@\s<>"',;]+@[^@\s<>"',;]+\.[^@\s<>"',;]{2,}$/;
const PHONE_RE = /^\+?[0-9][0-9 ()-]{6,19}$/;

async function bookableLegs(where = [], params = []) {
  await expireStaleLegs();
  const settings = await getSettings();
  params.push(Math.round(minNoticeHours(settings) * 60));
  const { rows } = await pool.query(
    `${LEG_SELECT} WHERE el.status = 'published' AND el.depart_latest >= now() + make_interval(mins => $${params.length}::int)
       ${where.length ? `AND ${where.join(' AND ')}` : ''}
     ORDER BY el.depart_earliest, el.leg_no`, params);
  return rows;
}

router.get('/', async (req, res) => {
  const where = [];
  const params = [];
  for (const [key, col] of [['from', 'el.from_code'], ['to', 'el.to_code']]) {
    if (req.query[key]) {
      const code = String(req.query[key]).trim().toUpperCase();
      if (!CODE_RE.test(code)) throw new HttpError(400, `${key} must be a 3-letter airport code`);
      params.push(code); where.push(`${col} = $${params.length}`);
    }
  }
  if (req.query.month) {
    const month = String(req.query.month).trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'month must be YYYY-MM');
    params.push(month); where.push(`to_char(el.depart_earliest AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = $${params.length}`);
  }
  const rows = await bookableLegs(where, params);
  res.json(await withTotals(rows));
});

async function loadPublic(id) {
  if (!isUuid(id)) throw new HttpError(404, 'Empty leg not found');
  const rows = await bookableLegs(['el.id = $1'], [id]);
  if (!rows[0]) throw new HttpError(404, 'This flight is no longer available');
  return rows[0];
}

router.get('/:id', async (req, res) => {
  res.json((await withTotals([await loadPublic(req.params.id)]))[0]);
});

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

router.post('/:id/request', async (req, res) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  // Honeypot: real browsers leave the hidden "website" field empty. Pretend success, do nothing.
  if (b.website !== undefined && b.website !== null && String(b.website).trim() !== '') {
    return res.status(202).json({ ok: true });
  }
  const name = clean(b.name, 120);
  const email = clean(b.email, 254).toLowerCase();
  const phone = clean(b.phone, 30);
  const company = clean(b.company, 160) || null;
  const message = clean(b.message, 2000) || null;
  if (name.length < 2) throw new HttpError(400, 'Please enter your full name');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email address');
  if (!PHONE_RE.test(phone) || phone.replace(/\D/g, '').length < 7) throw new HttpError(400, 'Please enter a valid phone number');
  if (b.accept_terms !== true) throw new HttpError(400, 'Please accept the terms to continue');
  const pax = Number(b.pax);
  if (!Number.isInteger(pax) || pax < 1) throw new HttpError(400, 'Please choose the number of passengers');

  const leg0 = await loadPublic(req.params.id);
  if (pax > leg0.seats) throw new HttpError(400, `This aircraft seats at most ${leg0.seats} passengers`);

  const booking = await withTransaction(async (client) => {
    // Share-lock the leg so it cannot flip to booked/withdrawn underneath us.
    const leg = (await client.query('SELECT * FROM empty_legs WHERE id = $1 FOR SHARE', [leg0.id])).rows[0];
    const settings = await getSettings(client);
    if (!leg || !isBookable(leg, settings)) throw new HttpError(409, 'This flight is no longer available');
    const dup = await client.query(
      `SELECT 1 FROM empty_leg_bookings WHERE empty_leg_id = $1 AND lower(guest_email) = $2 AND status = 'requested'`, [leg.id, email]);
    if (dup.rows.length) throw new HttpError(409, 'You already have a pending request for this flight — we will be in touch shortly');
    const marketplace = Boolean(leg.lister_id);
    // An unfinished checkout by the same person is replaced by this one.
    if (marketplace) {
      await client.query(`UPDATE empty_leg_bookings SET status = 'expired', reject_reason = 'Replaced by a newer request'
        WHERE empty_leg_id = $1 AND lower(guest_email) = $2 AND status = 'pending_payment'`, [leg.id, email]);
    }
    const booking_no = await nextNumber('ELB', client);
    const row = (await client.query(
      `INSERT INTO empty_leg_bookings (booking_no, empty_leg_id, channel, guest_name, guest_email, guest_phone, guest_company, pax, message, status, access_token)
       VALUES ($1,$2,'public',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [booking_no, leg.id, name, email, phone, company, pax, message, marketplace ? 'pending_payment' : 'requested', marketplace ? newToken() : null])).rows[0];
    if (marketplace) {
      // Lister flight: the request only reaches the operator once the traveller's payment is held.
      const payment = await startHold(client, { booking: row, leg });
      return { ...row, payment };
    }
    await logEvent({ entity_type: 'empty_leg_booking', entity_id: row.id, action: 'requested', detail: { booking_no, channel: 'public', leg_no: leg.leg_no, pax } }, client);
    return row;
  });
  if (booking.payment) {
    return res.status(201).json({ booking_no: booking.booking_no, booking_token: booking.access_token, payment: booking.payment });
  }
  await sendEmptyLegRequestAck({ to: email, name, booking, leg: leg0 });
  // Marketplace legs: the lister who posted the flight decides; Meridian's own legs go to sales.
  if (leg0.lister_id) {
    if (leg0.lister_email) await sendListerRequestNotice({ to: leg0.lister_email, booking, leg: leg0 });
  } else {
    for (const to of await salesRecipients()) await sendEmptyLegSalesNotice({ to, booking, leg: leg0 });
  }
  res.status(201).json({ booking_no: booking.booking_no });
});

module.exports = router;
