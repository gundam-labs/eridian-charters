/**
 * Public, no-login endpoints (v1.6):
 *   /api/public/bookings/:token        — status of a request on a lister flight (the token is the traveller's secret)
 *   /api/public/bookings/:token/verify — Razorpay Checkout handler: verify the signature, record the held payment
 *   /api/public/bookings/:token/mock-pay — test mode only: simulate the traveller authorising the payment
 *   /api/public/route-alerts           — save a route alert; /stop/:token to unsubscribe
 */
const { pool, withTransaction } = require('../db');
const { asyncRouter, HttpError } = require('../lib/http');
const { provider, providerName } = require('../lib/payments');
const mock = require('../lib/payments/mock');
const { processWebhook, sendNotifications } = require('../lib/payments/service');
const { markAuthorized } = require('../lib/marketplace');
const { LEG_SELECT, publicLeg } = require('../lib/emptyLegs');
const { createAlert, unsubscribe } = require('../lib/routeAlerts');

const bookings = asyncRouter();

async function loadByToken(token) {
  const t = String(token || '');
  if (t.length < 20) throw new HttpError(404, 'Booking not found');
  const b = (await pool.query('SELECT * FROM empty_leg_bookings WHERE access_token = $1', [t])).rows[0];
  if (!b) throw new HttpError(404, 'Booking not found');
  return b;
}

async function view(b) {
  const leg = (await pool.query(`${LEG_SELECT} WHERE el.id = $1`, [b.empty_leg_id])).rows[0];
  const bp = (await pool.query(
    `SELECT provider, provider_order_id, status, amount::float8 AS amount, base_amount::float8 AS base, gst_amount::float8 AS gst,
            refunded_amount::float8 AS refunded FROM booking_payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1`, [b.id])).rows[0] || null;
  return {
    booking_no: b.booking_no, status: b.status, pax: b.pax, respond_by: b.respond_by, reject_reason: b.reject_reason,
    created_at: b.created_at, leg: publicLeg(leg),
    payment: bp && { provider: bp.provider, order_id: bp.status === 'created' ? bp.provider_order_id : undefined, status: bp.status,
      amount: bp.amount, base: bp.base, gst: bp.gst, refunded: bp.refunded,
      key_id: bp.status === 'created' && bp.provider === 'razorpay' ? provider().keyId() : undefined,
      prefill: bp.status === 'created' ? { name: b.guest_name, email: b.guest_email, contact: b.guest_phone } : undefined },
  };
}

bookings.get('/:token', async (req, res) => {
  res.json(await view(await loadByToken(req.params.token)));
});

bookings.post('/:token/verify', async (req, res) => {
  const b = await loadByToken(req.params.token);
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
  if (!orderId || !paymentId || !signature) throw new HttpError(400, 'razorpay_order_id, razorpay_payment_id and razorpay_signature are required');
  const bp = (await pool.query('SELECT * FROM booking_payments WHERE provider_order_id = $1 AND booking_id = $2', [String(orderId), b.id])).rows[0];
  if (!bp) throw new HttpError(404, 'Order not found');
  const prov = provider();
  if (bp.provider !== prov.name) throw new HttpError(409, 'Order was created with a different payment provider');
  if (!prov.verifyCheckout(String(orderId), String(paymentId), String(signature))) throw new HttpError(400, 'Payment signature verification failed');
  const p = await prov.fetchPayment(String(paymentId));
  if (p.order_id !== bp.provider_order_id) throw new HttpError(400, 'Payment does not belong to this order');
  if (p.status === 'authorized') {
    const out = await withTransaction((client) => markAuthorized(client, { orderId: bp.provider_order_id, entity: p }));
    await sendNotifications(out?.notify || []);
  }
  // Any other state (e.g. still processing) is settled by the payment.authorized webhook.
  res.json(await view(await loadByToken(req.params.token)));
});

bookings.post('/:token/mock-pay', async (req, res) => {
  if (providerName() !== 'mock') throw new HttpError(404, 'Not available: payments provider is not mock');
  const b = await loadByToken(req.params.token);
  const method = String(req.body?.method || 'upi');
  if (!['card', 'upi', 'netbanking'].includes(method)) throw new HttpError(400, "method must be 'card', 'upi' or 'netbanking'");
  // 'expired' too: lets tests simulate a payment that arrives after the checkout timed out.
  const bp = (await pool.query(`SELECT * FROM booking_payments WHERE booking_id = $1 AND (status = 'created' OR (status = 'expired' AND provider_payment_id IS NULL)) ORDER BY created_at DESC LIMIT 1`, [b.id])).rows[0];
  if (!bp) throw new HttpError(409, 'There is no payment waiting for this request');
  if (bp.provider !== 'mock') throw new HttpError(409, 'Order was not created by the mock provider');
  const payment = mock.authorizedPayment({ amount_paise: Math.round(Number(bp.amount) * 100), order_id: bp.provider_order_id, method, notes: { booking_id: b.id } });
  const event = { entity: 'event', account_id: 'acc_mock', event: 'payment.authorized', contains: ['payment'], payload: { payment: { entity: payment } }, created_at: Math.floor(Date.now() / 1000) };
  const raw = Buffer.from(JSON.stringify(event));
  const out = await processWebhook(raw, mock.signWebhook(raw), mock.newEventId());
  if (out.status !== 200) throw new HttpError(500, 'Mock webhook was rejected');
  res.json(await view(await loadByToken(req.params.token)));
});

const alerts = asyncRouter();

alerts.post('/', async (req, res) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  if (b.website !== undefined && b.website !== null && String(b.website).trim() !== '') return res.status(202).json({ ok: true });
  const out = await createAlert(b);
  res.status(out.existing ? 200 : 201).json({ ok: true, existing: out.existing });
});

alerts.post('/stop/:token', async (req, res) => {
  const r = await unsubscribe(req.params.token);
  res.json({ ok: true, from_code: r.from_code, to_code: r.to_code });
});

/** Airports for the alert form (name and city only — fees are internal). */
async function airportsHandler(req, res, next) {
  try { res.json((await pool.query('SELECT code, name, city FROM airports ORDER BY city, code')).rows); } catch (err) { next(err); }
}

module.exports = { bookings, alerts, airportsHandler };
