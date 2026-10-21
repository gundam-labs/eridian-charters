/**
 * Marketplace payments for lister flights (v1.6).
 *
 *   request → pending_payment ──(traveller authorises card/UPI; money HELD)──▶ requested
 *   requested ──(lister confirms before respond_by; hold CAPTURED)──▶ confirmed ──(flown)──▶ completed → payout
 *   requested ──(lister declines / deadline passes / flight withdrawn)──▶ rejected|cancelled; hold RELEASED
 *   pending_payment ──(checkout not finished in time)──▶ expired
 *   confirmed ──(operator cancels: main charter changed, weather, technical)──▶ cancelled; 100% refund
 *
 * Releasing a hold is a DB trigger (release_booking_hold) so every code path that closes a request releases it.
 * With Razorpay the bank releases an uncaptured authorisation when the order's hold period ends.
 *
 * Money: base = the lister's price; GST at gst_rate_pct on top; commission = marketplace_commission_pct of the
 * base (of the part kept, after any refund); payout = amount kept − commission.
 */
const crypto = require('crypto');
const { pool, withTransaction, getSettings } = require('../db');
const { HttpError } = require('./http');
const { logEvent } = require('./events');
const { provider, providerFor } = require('./payments');

const HOUR_MS = 3600 * 1000;
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const toPaise = (r) => Math.round(Number(r) * 100);
const fromPaise = (p) => Math.round(Number(p || 0)) / 100;
const num = (v, d) => (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);

const confirmHours = (s) => Math.max(0.25, num(s.lister_confirm_hours, 2));
const checkoutMinutes = (s) => Math.max(5, num(s.marketplace_checkout_minutes, 30));
const minNotice = (s) => Math.max(0, num(s.empty_leg_min_notice_hours, 6));
/** Hold period asked of the provider: checkout + confirmation window + an hour of slack (Razorpay: 12 min – 5 days). */
const holdMinutes = (s) => Math.round(checkoutMinutes(s) + confirmHours(s) * 60 + 60);

const newToken = () => crypto.randomBytes(24).toString('base64url');

/** Totals the traveller pays for a lister leg. */
function priceFor(leg, settings) {
  const base = round2(leg.price_inr);
  const gst_rate_pct = num(settings.gst_rate_pct, 12);
  const gst = round2((base * gst_rate_pct) / 100);
  return { base, gst_rate_pct, gst, total: round2(base + gst) };
}

/** The lister must answer by: now + lister_confirm_hours, but never later than departure − minimum notice. */
function respondByFor(leg, settings, now = new Date()) {
  const t = now.getTime();
  const latest = new Date(leg.depart_latest).getTime() - minNotice(settings) * HOUR_MS;
  return new Date(Math.max(t + 15 * 60 * 1000, Math.min(t + confirmHours(settings) * HOUR_MS, latest)));
}

/** Refund % for a cancelled confirmed booking. Traveller: 80% >72h, 50% 24–72h, 0 <24h (settings). Others: 100%. */
function refundPctFor(who, departAt, settings, now = new Date()) {
  if (who !== 'traveller') return 100;
  const hours = (new Date(departAt).getTime() - now.getTime()) / HOUR_MS;
  if (hours > 72) return num(settings.traveller_refund_72h_pct, 80);
  if (hours >= 24) return num(settings.traveller_refund_24h_pct, 50);
  return 0;
}

/**
 * Create the payment hold order for a pending_payment booking. Pass the transaction client.
 * → checkout payload for the browser (never secrets).
 */
async function startHold(client, { booking, leg }) {
  const settings = await getSettings(client);
  const price = priceFor(leg, settings);
  const prov = provider();
  const order = await prov.createHoldOrder({
    amount_paise: toPaise(price.total), receipt: booking.booking_no.slice(0, 40),
    notes: { booking_id: booking.id, booking_no: booking.booking_no, leg_no: leg.leg_no }, holdMinutes: holdMinutes(settings),
  });
  await client.query(
    `INSERT INTO booking_payments (booking_id, lister_id, provider, provider_order_id, base_amount, gst_rate_pct, gst_amount, amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [booking.id, leg.lister_id, prov.name, order.id, price.base, price.gst_rate_pct, price.gst, price.total]);
  await logEvent({ entity_type: 'empty_leg_booking', entity_id: booking.id, action: 'payment_hold_started', detail: { provider: prov.name, order_id: order.id, amount: price.total } }, client);
  return {
    provider: prov.name, key_id: prov.name === 'razorpay' ? prov.keyId() : null, order_id: order.id,
    amount: price.total, base: price.base, gst: price.gst, gst_rate_pct: price.gst_rate_pct, currency: 'INR',
    confirm_hours: confirmHours(settings), checkout_minutes: checkoutMinutes(settings),
    prefill: { name: booking.guest_name, email: booking.guest_email, contact: booking.guest_phone },
  };
}

/**
 * A payment for a hold order was authorised (webhook payment.authorized or checkout verification).
 * Idempotent. → null when the order is not a marketplace order, else { notify: [...] }.
 */
async function markAuthorized(client, { orderId, entity }) {
  const bp = (await client.query('SELECT * FROM booking_payments WHERE provider_order_id = $1 FOR UPDATE', [orderId])).rows[0];
  if (!bp) return null;
  if (bp.status === 'expired' && !bp.provider_payment_id) {
    // The checkout had timed out, but the traveller's payment came through anyway: record it and release it.
    await client.query(`UPDATE booking_payments SET status = 'released', provider_payment_id = $2, method = $3, authorized_at = now(), released_at = now() WHERE id = $1`,
      [bp.id, entity.id, entity.method || null]);
    await logEvent({ entity_type: 'empty_leg_booking', entity_id: bp.booking_id, action: 'payment_released', detail: { reason: 'authorised after checkout expired' } }, client);
    return { notify: [{ kind: 'mk_released_late', bookingId: bp.booking_id }] };
  }
  if (bp.status !== 'created') return { notify: [] };
  if (Number(entity.amount) !== toPaise(bp.amount)) throw new Error(`Authorised amount ${entity.amount} does not match hold ${toPaise(bp.amount)} for order ${orderId}`);
  const booking = (await client.query('SELECT * FROM empty_leg_bookings WHERE id = $1 FOR UPDATE', [bp.booking_id])).rows[0];
  const leg = (await client.query('SELECT * FROM empty_legs WHERE id = $1 FOR SHARE', [booking.empty_leg_id])).rows[0];
  await client.query(
    `UPDATE booking_payments SET status = 'authorized', provider_payment_id = $2, method = $3, authorized_at = now(), raw = $4 WHERE id = $1`,
    [bp.id, entity.id, entity.method || null, JSON.stringify({ id: entity.id, method: entity.method, amount: entity.amount, status: entity.status })]);
  const settings = await getSettings(client);
  const stillOpen = leg.status === 'published' && new Date(leg.depart_latest).getTime() - Date.now() >= minNotice(settings) * HOUR_MS;
  if (booking.status !== 'pending_payment' || !stillOpen) {
    // Paid too late (checkout expired, or the flight was booked/withdrawn meanwhile): release straight away.
    await client.query(`UPDATE booking_payments SET status = 'released', released_at = now() WHERE id = $1`, [bp.id]);
    if (booking.status === 'pending_payment') {
      await client.query(`UPDATE empty_leg_bookings SET status = 'expired', reject_reason = 'The flight is no longer available' WHERE id = $1`, [booking.id]);
    }
    await logEvent({ entity_type: 'empty_leg_booking', entity_id: booking.id, action: 'payment_released', detail: { reason: 'authorised after the request closed' } }, client);
    return { notify: [{ kind: 'mk_released_late', bookingId: booking.id }] };
  }
  const respond_by = respondByFor(leg, settings);
  await client.query(`UPDATE empty_leg_bookings SET status = 'requested', respond_by = $2 WHERE id = $1`, [booking.id, respond_by]);
  await logEvent({ entity_type: 'empty_leg_booking', entity_id: booking.id, action: 'requested',
    detail: { booking_no: booking.booking_no, channel: 'public', payment_held: bp.amount, respond_by } }, client);
  return { notify: [{ kind: 'mk_requested', bookingId: booking.id }] };
}

/** Webhook hook: handle events for marketplace orders/payments/refunds. → null when not ours. */
async function handleMarketplaceEvent(client, evt) {
  const p = evt?.payload?.payment?.entity;
  const type = evt?.event;
  if (type === 'payment.authorized' && p?.order_id) {
    return markAuthorized(client, { orderId: p.order_id, entity: p });
  }
  if ((type === 'payment.captured' || type === 'order.paid') && p) {
    const bp = (await client.query('SELECT id, status FROM booking_payments WHERE provider_order_id = $1 OR provider_payment_id = $2', [p.order_id || '', p.id])).rows[0];
    if (!bp) return null;
    return { notify: [] }; // we capture ourselves; the event only confirms it
  }
  if ((type === 'payment.failed') && p?.order_id) {
    const bp = (await client.query('SELECT id FROM booking_payments WHERE provider_order_id = $1', [p.order_id])).rows[0];
    return bp ? { notify: [] } : null; // traveller may retry in the same checkout
  }
  if (type === 'refund.processed' || type === 'refund.failed') {
    const rf = evt?.payload?.refund?.entity;
    if (!rf?.id) return null;
    const bp = (await client.query('SELECT id FROM booking_payments WHERE provider_refund_id = $1', [rf.id])).rows[0];
    if (!bp) return null;
    await client.query('UPDATE booking_payments SET payout_error = CASE WHEN $2::boolean THEN payout_error ELSE $3::text END WHERE id = $1',
      [bp.id, type === 'refund.processed', 'Refund failed at provider']);
    return { notify: [] };
  }
  return null;
}

/** Capture the held payment of a booking (inside the lister-confirm transaction). → updated row, or null when no hold. */
async function captureBooking(client, bookingId) {
  const bp = (await client.query(
    `SELECT * FROM booking_payments WHERE booking_id = $1 AND status = 'authorized' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [bookingId])).rows[0];
  if (!bp) return null;
  const prov = providerFor(bp.provider);
  if (!prov) throw new HttpError(500, `Unknown payment provider ${bp.provider}`);
  await prov.capture(bp.provider_payment_id, toPaise(bp.amount));
  const settings = await getSettings(client);
  const pct = num(settings.marketplace_commission_pct, 10);
  const commission = round2((Number(bp.base_amount) * pct) / 100);
  const row = (await client.query(
    `UPDATE booking_payments SET status = 'captured', captured_at = now(), commission_pct = $2, commission_amount = $3,
       payout_amount = $4, payout_status = 'pending' WHERE id = $1 RETURNING *`,
    [bp.id, pct, commission, round2(Number(bp.amount) - commission)])).rows[0];
  await logEvent({ entity_type: 'empty_leg_booking', entity_id: bookingId, action: 'payment_captured',
    detail: { amount: Number(bp.amount), commission, payout: Number(row.payout_amount) } }, client);
  return row;
}

/**
 * Refund pct% of a captured booking payment (after the cancellation committed) and re-work the payout on what is kept.
 * → { amount, status } or null when there is nothing to refund.
 */
async function refundBooking({ bookingId, pct, reason, actorUserId = null }) {
  const bp = (await pool.query(`SELECT * FROM booking_payments WHERE booking_id = $1 AND status IN ('captured','partially_refunded') ORDER BY created_at DESC LIMIT 1`, [bookingId])).rows[0];
  if (!bp) return null;
  const amount = round2(Math.min(Number(bp.amount) - Number(bp.refunded_amount), (Number(bp.amount) * pct) / 100));
  let refundId = null;
  let error = null;
  if (amount > 0) {
    try {
      const r = await providerFor(bp.provider).refund(bp.provider_payment_id, toPaise(amount), { booking_id: bookingId, reason: String(reason || '').slice(0, 200) });
      refundId = r.id;
    } catch (err) {
      error = String(err.message).slice(0, 500);
    }
  }
  const refunded = round2(Number(bp.refunded_amount) + (error ? 0 : amount));
  const kept = round2(Number(bp.amount) - refunded);
  const keptBase = round2((kept * Number(bp.base_amount)) / Number(bp.amount));
  const commission = round2((keptBase * Number(bp.commission_pct ?? 0)) / 100);
  const row = (await pool.query(
    `UPDATE booking_payments SET refunded_amount = $2::numeric, provider_refund_id = COALESCE($3::text, provider_refund_id),
       status = CASE WHEN $2::numeric >= amount - 0.005 THEN 'refunded' WHEN $2::numeric > 0 THEN 'partially_refunded' ELSE status END,
       commission_amount = $4::numeric, payout_amount = $5::numeric,
       payout_status = CASE WHEN $5::numeric <= 0 AND payout_status IN ('pending','due') THEN 'cancelled' ELSE payout_status END,
       payout_error = COALESCE($6::text, payout_error)
     WHERE id = $1 RETURNING *`,
    [bp.id, refunded, refundId, commission, round2(kept - commission), error ? `Refund failed: ${error}` : null])).rows[0];
  await logEvent({ entity_type: 'empty_leg_booking', entity_id: bookingId, action: error ? 'refund_failed' : 'refund_initiated', actor_user_id: actorUserId,
    detail: { amount, pct, provider_refund_id: refundId, error } });
  return { amount: error ? 0 : amount, pct, status: row.status, error };
}

/** Mark a confirmed lister booking flown; its payout becomes due. Pass a transaction client. */
async function completeBooking(client, bookingId, actorUserId = null) {
  const b = (await client.query(`UPDATE empty_leg_bookings SET status = 'completed', completed_at = now() WHERE id = $1 AND status = 'confirmed' RETURNING *`, [bookingId])).rows[0];
  if (!b) return null;
  await client.query(`UPDATE booking_payments SET payout_status = 'due' WHERE booking_id = $1 AND payout_status = 'pending'`, [bookingId]);
  await logEvent({ entity_type: 'empty_leg_booking', entity_id: bookingId, action: 'completed', actor_user_id: actorUserId }, client);
  return b;
}

/**
 * Pay a due payout: a Route transfer when the lister has a linked Razorpay account, else it stays due for
 * finance to pay by bank transfer and mark paid. Never throws. → updated row.
 */
async function tryPayout(bookingPaymentId) {
  const bp = (await pool.query(
    `SELECT bp.*, l.razorpay_account_id FROM booking_payments bp JOIN listers l ON l.id = bp.lister_id WHERE bp.id = $1`, [bookingPaymentId])).rows[0];
  if (!bp || bp.payout_status !== 'due' || !(Number(bp.payout_amount) > 0)) return bp;
  if (!bp.razorpay_account_id) return bp;
  try {
    const t = await providerFor(bp.provider).transfer(bp.provider_payment_id, {
      account: bp.razorpay_account_id, amount_paise: toPaise(bp.payout_amount), notes: { booking_payment_id: bp.id },
    });
    const row = (await pool.query(
      `UPDATE booking_payments SET payout_status = 'transferred', payout_ref = $2, payout_at = now(), payout_error = NULL WHERE id = $1 AND payout_status = 'due' RETURNING *`,
      [bp.id, t.id])).rows[0];
    await logEvent({ entity_type: 'empty_leg_booking', entity_id: bp.booking_id, action: 'payout_transferred', detail: { amount: Number(bp.payout_amount), transfer_id: t.id } });
    return row || bp;
  } catch (err) {
    await pool.query('UPDATE booking_payments SET payout_error = $2 WHERE id = $1', [bp.id, String(err.message).slice(0, 500)]);
    return { ...bp, payout_error: err.message };
  }
}

// ── Background job ──────────────────────────────────────────────────────────
const AUTO_COMPLETE_HOURS = 12;

/** Expire unfinished checkouts, close requests past their deadline, complete flown bookings. Never throws. */
async function runMarketplaceJobs(now = new Date()) {
  const out = { expired: 0, timed_out: [], completed: 0 };
  try {
    const settings = await getSettings();
    out.expired = (await pool.query(
      `UPDATE empty_leg_bookings SET status = 'expired', reject_reason = 'Payment not completed'
        WHERE status = 'pending_payment' AND created_at < $1::timestamptz - make_interval(mins => $2::int)`,
      [now, Math.round(checkoutMinutes(settings))])).rowCount;
    const timedOut = (await pool.query(
      `UPDATE empty_leg_bookings SET status = 'rejected', reject_reason = 'The operator did not confirm in time', decided_at = now()
        WHERE status = 'requested' AND respond_by IS NOT NULL AND respond_by < $1 RETURNING *`, [now])).rows;
    for (const b of timedOut) {
      await logEvent({ entity_type: 'empty_leg_booking', entity_id: b.id, action: 'rejected', detail: { reason: 'confirmation deadline passed', respond_by: b.respond_by } });
      out.timed_out.push(b);
    }
    const due = (await pool.query(
      `SELECT b.id FROM empty_leg_bookings b JOIN empty_legs el ON el.id = b.empty_leg_id
        WHERE b.status = 'confirmed' AND el.lister_id IS NOT NULL AND el.depart_latest < $1::timestamptz - make_interval(hours => $2::int)`,
      [now, AUTO_COMPLETE_HOURS])).rows;
    for (const d of due) {
      const done = await withTransaction((client) => completeBooking(client, d.id, null));
      if (done) {
        out.completed += 1;
        const bp = (await pool.query(`SELECT id FROM booking_payments WHERE booking_id = $1 AND payout_status = 'due'`, [d.id])).rows[0];
        if (bp) await tryPayout(bp.id);
      }
    }
    if (out.timed_out.length) {
      const { sendEmptyLegRequestClosed } = require('./email');
      const { LEG_SELECT } = require('./emptyLegs');
      for (const b of out.timed_out) {
        const leg = (await pool.query(`${LEG_SELECT} WHERE el.id = $1`, [b.empty_leg_id])).rows[0];
        await sendEmptyLegRequestClosed({ to: b.guest_email, name: b.guest_name, booking: b, leg, reason: 'The operator did not confirm in time' });
      }
    }
  } catch (err) {
    console.error('[Marketplace] job failed:', err.message);
  }
  return out;
}

let lastRun = 0;
/** At most once every 30 s per process, for read paths. */
async function runMarketplaceJobsThrottled() {
  if (Date.now() - lastRun < 30 * 1000) return null;
  lastRun = Date.now();
  return runMarketplaceJobs();
}

// ── Notifications after commit ──────────────────────────────────────────────
async function sendMarketplaceNotifications(list) {
  const email = require('./email');
  const { LEG_SELECT } = require('./emptyLegs');
  for (const n of (list || []).filter(Boolean)) {
    try {
      const b = (await pool.query('SELECT * FROM empty_leg_bookings WHERE id = $1', [n.bookingId])).rows[0];
      if (!b) continue;
      const leg = (await pool.query(`${LEG_SELECT} WHERE el.id = $1`, [b.empty_leg_id])).rows[0];
      const bp = (await pool.query('SELECT * FROM booking_payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1', [b.id])).rows[0];
      if (n.kind === 'mk_requested') {
        await email.sendEmptyLegRequestAck({ to: b.guest_email, name: b.guest_name, booking: b, leg, hold: bp });
        if (leg.lister_email) await email.sendListerRequestNotice({ to: leg.lister_email, booking: b, leg, hold: bp });
      } else if (n.kind === 'mk_released_late') {
        await email.sendEmptyLegRequestClosed({ to: b.guest_email, name: b.guest_name, booking: b, leg, reason: 'The flight was no longer available when your payment came through' });
      }
    } catch (err) {
      console.error('[Marketplace] notification failed:', err.message);
    }
  }
}

module.exports = {
  priceFor, respondByFor, refundPctFor, holdMinutes, newToken, startHold, markAuthorized, handleMarketplaceEvent,
  captureBooking, refundBooking, completeBooking, tryPayout, runMarketplaceJobs, runMarketplaceJobsThrottled,
  sendMarketplaceNotifications, round2, fromPaise,
};
