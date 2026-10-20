/**
 * Payments API (SPEC v1.2). Mounted at /api/payments behind authenticate; the webhook handler is exported
 * separately and mounted WITHOUT auth on a raw body in index.js.
 */
const { pool, withTransaction } = require('../db');
const { asyncRouter, HttpError, isUuid } = require('../lib/http');
const { requireRole, isStaff } = require('../middleware/auth');
const { isDateStr, parseIST } = require('../lib/time');
const { provider, providerName } = require('../lib/payments');
const mock = require('../lib/payments/mock');
const { processWebhook, applyPayment, sendNotifications, toPaise, fromPaise, round2 } = require('../lib/payments/service');
const { getOrCreateVirtualAccount } = require('../lib/payments/virtualAccounts');
const { runDeadlines } = require('../lib/payments/deadlines');
const { invoiceDetail } = require('./invoices');

const router = asyncRouter();

/** POST /api/payments/webhook/razorpay — no auth; req.body is the RAW Buffer (express.raw mounted first). */
async function webhookHandler(req, res, next) {
  try {
    const out = await processWebhook(req.body, req.get('x-razorpay-signature'), req.get('x-razorpay-event-id'));
    res.status(out.status).json(out.body);
  } catch (err) {
    next(err);
  }
}

// ── Config (never a secret) ─────────────────────────────────────────────────
router.get('/config', async (req, res) => {
  const p = provider();
  res.json({ provider: p.name, key_id: p.name === 'razorpay' ? p.keyId() : null });
});

// ── Checkout verification (UX speed-up; the webhook stays the source of truth) ──
router.post('/verify', async (req, res) => {
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
  if (!orderId || !paymentId || !signature) throw new HttpError(400, 'razorpay_order_id, razorpay_payment_id and razorpay_signature are required');
  const order = (await pool.query('SELECT * FROM payment_orders WHERE provider_order_id = $1', [String(orderId)])).rows[0];
  if (!order) throw new HttpError(404, 'Order not found');
  const inv = (await pool.query('SELECT member_id FROM invoices WHERE id = $1', [order.invoice_id])).rows[0];
  if (req.user.role === 'member' ? inv.member_id !== req.user.member_id : !isStaff(req.user)) throw new HttpError(404, 'Order not found');
  const prov = provider();
  if (order.provider !== prov.name) throw new HttpError(409, 'Order was created with a different payment provider');
  if (!prov.verifyCheckout(String(orderId), String(paymentId), String(signature))) throw new HttpError(400, 'Payment signature verification failed');
  const p = await prov.fetchPayment(String(paymentId));
  if (p.order_id !== order.provider_order_id) throw new HttpError(400, 'Payment does not belong to this order');
  if (p.status !== 'captured') {
    // Authorised but not yet captured: the webhook will apply it.
    return res.status(202).json({ invoice: await invoiceDetail(order.invoice_id, req.user), pending: true, payment_status: p.status });
  }
  if (Number(p.amount) !== toPaise(order.amount)) throw new HttpError(400, 'Payment amount does not match the order');
  const result = await withTransaction((client) => applyPayment(client, { invoiceId: order.invoice_id, providerName: prov.name, entity: p, actorUserId: req.user.id }));
  await sendNotifications([result.notify]);
  res.json({ invoice: await invoiceDetail(order.invoice_id, req.user) });
});

// ── Payments list (sales/admin) ─────────────────────────────────────────────
router.get('/', requireRole('sales'), async (req, res) => {
  const params = [];
  const where = [];
  const { from, to } = req.query;
  if (from) { if (!isDateStr(from)) throw new HttpError(400, 'from must be YYYY-MM-DD'); params.push(from); where.push(`(p.captured_at AT TIME ZONE 'Asia/Kolkata')::date >= $${params.length}`); }
  if (to) { if (!isDateStr(to)) throw new HttpError(400, 'to must be YYYY-MM-DD'); params.push(to); where.push(`(p.captured_at AT TIME ZONE 'Asia/Kolkata')::date <= $${params.length}`); }
  if (req.query.member_id) {
    if (!isUuid(req.query.member_id)) throw new HttpError(400, 'Invalid member_id');
    params.push(req.query.member_id); where.push(`i.member_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT p.id, p.provider, p.provider_payment_id, p.provider_order_id, p.method, p.amount::float8 AS amount, p.fee::float8 AS fee,
            p.status, p.captured_at, p.created_at,
            COALESCE((SELECT sum(r.amount) FROM refunds r WHERE r.payment_id = p.id AND r.status <> 'failed'), 0)::float8 AS refunded,
            i.id AS invoice_id, i.invoice_no, i.status AS invoice_status, i.total::float8 AS invoice_total,
            c.id AS charter_id, c.charter_no, m.id AS member_id, m.member_no, m.contact_name AS member_name, m.company AS member_company
       FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN charters c ON c.id = i.charter_id JOIN members m ON m.id = i.member_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY p.captured_at DESC, p.created_at DESC`, params);
  const sum = (k) => round2(rows.reduce((s, r) => s + Number(r[k] || 0), 0));
  res.json({
    payments: rows,
    totals: { count: rows.length, amount: sum('amount'), fees: sum('fee'), refunded: sum('refunded'), net: round2(sum('amount') - sum('refunded')) },
  });
});

// ── Mock-only endpoints ─────────────────────────────────────────────────────
function mockOnly() {
  if (providerName() !== 'mock') throw new HttpError(404, 'Not available: payments provider is not mock');
}

/** Simulated Checkout success: build a signed payment.captured event and feed it through the webhook handler. */
router.post('/mock/complete', async (req, res) => {
  mockOnly();
  const orderId = String(req.body?.order_id || '');
  const method = String(req.body?.method || 'card');
  if (!['card', 'upi', 'netbanking'].includes(method)) throw new HttpError(400, "method must be 'card', 'upi' or 'netbanking'");
  const order = (await pool.query('SELECT * FROM payment_orders WHERE provider_order_id = $1', [orderId])).rows[0];
  if (!order) throw new HttpError(404, 'Order not found');
  const inv = (await pool.query('SELECT id, member_id, invoice_no FROM invoices WHERE id = $1', [order.invoice_id])).rows[0];
  if (req.user.role === 'member' ? inv.member_id !== req.user.member_id : !isStaff(req.user)) throw new HttpError(404, 'Order not found');
  if (order.provider !== 'mock') throw new HttpError(409, 'Order was not created by the mock provider');
  if (order.status !== 'created') throw new HttpError(409, `Order is ${order.status}`);

  const payment = mock.capturedPayment({ amount_paise: toPaise(order.amount), order_id: order.provider_order_id, method, notes: { invoice_id: inv.id, invoice_no: inv.invoice_no } });
  const event = {
    entity: 'event', account_id: 'acc_mock', event: 'payment.captured', contains: ['payment'],
    payload: { payment: { entity: payment } }, created_at: Math.floor(Date.now() / 1000),
  };
  const raw = Buffer.from(JSON.stringify(event));
  const eventId = mock.newEventId();
  const out = await processWebhook(raw, mock.signWebhook(raw), eventId);
  if (out.status !== 200) throw new HttpError(500, 'Mock webhook was rejected');
  res.json({
    event_id: eventId, payment_id: payment.id, order_id: order.provider_order_id,
    checkout_signature: mock.signCheckout(order.provider_order_id, payment.id),
    invoice: await invoiceDetail(order.invoice_id, req.user),
  });
});

/** Simulated bank transfer into a member's virtual account → signed virtual_account.credited event. */
router.post('/mock/bank-transfer', requireRole('sales'), async (req, res) => {
  mockOnly();
  let memberId = req.body?.member_id;
  if (!memberId && req.body?.invoice_id) {
    if (!isUuid(req.body.invoice_id)) throw new HttpError(400, 'Invalid invoice_id');
    memberId = (await pool.query('SELECT member_id FROM invoices WHERE id = $1', [req.body.invoice_id])).rows[0]?.member_id;
    if (!memberId) throw new HttpError(404, 'Invoice not found');
  }
  if (!isUuid(memberId)) throw new HttpError(400, 'member_id is required');
  const amount = round2(Number(req.body?.amount));
  if (!Number.isFinite(amount) || amount < 1) throw new HttpError(400, 'amount must be at least ₹1');
  const va = await getOrCreateVirtualAccount(memberId, req.user.id);
  if (va.provider !== 'mock') throw new HttpError(409, 'Member virtual account is not a mock account');

  const payment = mock.capturedPayment({ amount_paise: toPaise(amount), order_id: null, method: 'bank_transfer' });
  const bankRef = payment.bank_transfer_ref;
  const event = {
    entity: 'event', account_id: 'acc_mock', event: 'virtual_account.credited', contains: ['payment', 'virtual_account', 'bank_transfer'],
    payload: {
      payment: { entity: payment },
      virtual_account: { entity: { id: va.provider_va_id, entity: 'virtual_account', status: 'active', amount_paid: payment.amount } },
      bank_transfer: { entity: { id: `bt_mock_${bankRef.slice(-10)}`, entity: 'bank_transfer', payment_id: payment.id, mode: 'NEFT', bank_reference: bankRef, amount: payment.amount, virtual_account_id: va.provider_va_id } },
    },
    created_at: Math.floor(Date.now() / 1000),
  };
  const raw = Buffer.from(JSON.stringify(event));
  const eventId = mock.newEventId();
  const out = await processWebhook(raw, mock.signWebhook(raw), eventId);
  if (out.status !== 200) throw new HttpError(500, 'Mock webhook was rejected');
  const applied = (await pool.query('SELECT invoice_id FROM payments WHERE provider_payment_id = $1', [payment.id])).rows[0];
  const err = (await pool.query('SELECT error FROM webhook_events WHERE event_id = $1', [eventId])).rows[0]?.error;
  res.json({
    event_id: eventId, payment_id: payment.id, amount: fromPaise(payment.amount), bank_reference: bankRef,
    applied: !!applied, error: err || null,
    invoice: applied ? await invoiceDetail(applied.invoice_id, req.user) : null,
  });
});

// ── Dev/test only: run the deadline job now (optionally as of `now`, limited to one charter) ──
router.post('/run-deadlines', requireRole('sales', 'ops'), async (req, res) => {
  if (!['development', 'test'].includes(process.env.NODE_ENV)) throw new HttpError(404, 'Not found');
  const { charter_id, now } = req.body || {};
  if (charter_id && !isUuid(charter_id)) throw new HttpError(400, 'Invalid charter_id');
  let at = null;
  if (now) { at = parseIST(String(now)); if (!at) throw new HttpError(400, 'now must be an ISO datetime'); }
  if (at && !charter_id) throw new HttpError(400, 'A simulated now requires charter_id');
  res.json(await runDeadlines({ now: at, charterId: charter_id || null }));
});

module.exports = router;
module.exports.webhookHandler = webhookHandler;
