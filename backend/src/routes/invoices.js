const crypto = require('crypto');
const { pool, withTransaction } = require('../db');
const { asyncRouter, HttpError, isUuid } = require('../lib/http');
const { requireRole, isStaff } = require('../middleware/auth');
const { isDateStr, todayIST } = require('../lib/time');
const { invoicePdf } = require('../lib/pdf');
const { provider } = require('../lib/payments');
const { applyPayment, sendNotifications, paymentsForInvoice, toPaise, balanceOf } = require('../lib/payments/service');
const { runDeadlinesThrottled } = require('../lib/payments/deadlines');
const { logEvent } = require('../lib/events');

const router = asyncRouter();

const INVOICE_SELECT = `SELECT i.*, c.charter_no, c.status AS charter_status, c.starts_on, c.ends_on, c.legs, c.pax,
  CASE WHEN i.status IN ('unpaid','partially_paid') THEN GREATEST(i.total - i.amount_paid, 0) ELSE 0 END::float8 AS balance,
  m.member_no, m.contact_name AS member_name, m.company AS member_company, m.city AS member_city, m.email AS member_email, m.gstin AS member_gstin,
  m.phone AS member_phone,
  q.quote_no, el.leg_no AS empty_leg_no,
  COALESCE(q.line_items, CASE WHEN el.id IS NOT NULL THEN jsonb_build_array(jsonb_build_object(
    'code', 'EMPTY_LEG', 'description', 'Empty-leg charter ' || el.leg_no || ' (' || el.from_code || ' – ' || el.to_code || ', whole aircraft)',
    'qty', 1, 'unit', 'flight', 'rate', i.subtotal::float8, 'amount', i.subtotal::float8)) END) AS line_items,
  a.registration AS aircraft_registration, a.type AS aircraft_type
  FROM invoices i
  JOIN charters c ON c.id = i.charter_id
  JOIN members m ON m.id = i.member_id
  LEFT JOIN quotes q ON q.id = c.quote_id
  LEFT JOIN empty_legs el ON el.id = c.empty_leg_id
  JOIN aircraft a ON a.id = c.aircraft_id`;

async function loadInvoice(id, user) {
  if (!isUuid(id)) throw new HttpError(404, 'Invoice not found');
  const inv = (await pool.query(`${INVOICE_SELECT} WHERE i.id = $1`, [id])).rows[0];
  if (!inv) throw new HttpError(404, 'Invoice not found');
  if (user.role === 'member' && inv.member_id !== user.member_id) throw new HttpError(404, 'Invoice not found');
  return inv;
}

/** Invoice + payments[] + refunds[] (fee only for staff). */
async function invoiceDetail(id, user) {
  const inv = await loadInvoice(id, user);
  return { ...inv, ...(await paymentsForInvoice(inv.id, isStaff(user))) };
}

router.get('/', requireRole('member', 'sales', 'ops'), async (req, res) => {
  await runDeadlinesThrottled();
  const params = [];
  const where = [];
  if (req.user.role === 'member') { params.push(req.user.member_id); where.push(`i.member_id = $${params.length}`); }
  if (req.query.status) {
    const st = String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean);
    params.push(st); where.push(`i.status = ANY($${params.length})`);
  }
  const { rows } = await pool.query(
    `${INVOICE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE i.status WHEN 'unpaid' THEN 0 WHEN 'partially_paid' THEN 0 WHEN 'paid' THEN 1 ELSE 2 END, i.issued_on DESC, i.invoice_no DESC`, params);
  res.json(rows);
});

router.get('/:id', requireRole('member', 'sales', 'ops'), async (req, res) => {
  await runDeadlinesThrottled();
  res.json(await invoiceDetail(req.params.id, req.user));
});

router.get('/:id/pdf', requireRole('member', 'sales', 'ops'), async (req, res) => {
  const inv = await loadInvoice(req.params.id, req.user);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${inv.invoice_no}.pdf"`);
  invoicePdf(inv, res);
});

// ── Pay online: create (or reuse) a provider order for the outstanding balance ──
router.post('/:id/pay', requireRole('member', 'sales'), async (req, res) => {
  const inv = await loadInvoice(req.params.id, req.user);
  if (!['unpaid', 'partially_paid'].includes(inv.status)) throw new HttpError(409, `Invoice is ${inv.status.replace('_', ' ')}`);
  if (inv.due_at && new Date(inv.due_at) < new Date()) throw new HttpError(409, 'The payment deadline for this invoice has passed — contact sales');
  if (['cancelled', 'closed'].includes(inv.charter_status)) throw new HttpError(409, `Charter is ${inv.charter_status}`);
  const balance = balanceOf(inv);
  if (balance < 1) throw new HttpError(409, 'Nothing left to pay on this invoice');
  const prov = provider();
  const amount_paise = toPaise(balance);

  // Reuse a recent unpaid order for the same amount (double clicks, page reloads).
  let order = (await pool.query(
    `SELECT * FROM payment_orders WHERE invoice_id = $1 AND provider = $2 AND status = 'created' AND amount = $3
       AND created_at > now() - interval '30 minutes' ORDER BY created_at DESC LIMIT 1`, [inv.id, prov.name, balance])).rows[0];
  if (!order) {
    const receipt = `${inv.invoice_no}-${crypto.randomBytes(3).toString('hex')}`.slice(0, 40);
    const po = await prov.createOrder({ amount_paise, receipt, notes: { invoice_id: inv.id, invoice_no: inv.invoice_no, member_no: inv.member_no, charter_no: inv.charter_no } });
    order = (await pool.query(
      `INSERT INTO payment_orders (invoice_id, provider, provider_order_id, amount, status, created_by) VALUES ($1,$2,$3,$4,'created',$5) RETURNING *`,
      [inv.id, prov.name, po.id, balance, req.user.id])).rows[0];
    await logEvent({ entity_type: 'invoice', entity_id: inv.id, action: 'payment_order_created', actor_user_id: req.user.id,
      detail: { provider: prov.name, provider_order_id: po.id, amount: balance } });
  }
  res.json({
    order_id: order.provider_order_id,
    amount_paise,
    currency: 'INR',
    key_id: prov.keyId() || null,
    provider: prov.name,
    invoice_no: inv.invoice_no,
    prefill: { name: inv.member_name, email: inv.member_email, contact: inv.member_phone || '' },
    description: `Charter ${inv.charter_no} — invoice ${inv.invoice_no}`,
  });
});

// ── Manual "mark paid" (sales): records a manual bank-transfer payment for the balance ──
router.post('/:id/mark-paid', requireRole('sales'), async (req, res) => {
  const inv = await loadInvoice(req.params.id, req.user);
  if (!['unpaid', 'partially_paid'].includes(inv.status)) throw new HttpError(409, `Cannot mark an invoice paid that is ${inv.status}`);
  const paid_on = req.body?.paid_on || todayIST();
  if (!isDateStr(paid_on)) throw new HttpError(400, 'paid_on must be YYYY-MM-DD');
  const payment_ref = req.body?.payment_ref ? String(req.body.payment_ref).trim().slice(0, 200) : null;
  const result = await withTransaction(async (client) => {
    const cur = (await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [inv.id])).rows[0];
    if (!['unpaid', 'partially_paid'].includes(cur.status)) throw new HttpError(409, 'Invoice changed — reload and try again');
    const balance = balanceOf(cur);
    if (balance <= 0) throw new HttpError(409, 'Nothing left to pay on this invoice');
    const entity = {
      id: `manual_${crypto.randomUUID()}`, entity: 'payment', amount: toPaise(balance), currency: 'INR', method: 'bank_transfer', fee: 0, status: 'captured',
      ...(payment_ref ? { bank_transfer_ref: payment_ref } : {}),
    };
    return applyPayment(client, { invoiceId: cur.id, providerName: 'manual', entity, actorUserId: req.user.id, paidOn: paid_on, paymentRef: payment_ref || entity.id, capturedAt: new Date() });
  });
  await sendNotifications([result.notify]);
  res.json(await invoiceDetail(inv.id, req.user));
});

module.exports = router;
module.exports.invoiceDetail = invoiceDetail;
module.exports.loadInvoice = loadInvoice;
