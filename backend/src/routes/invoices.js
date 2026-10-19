const { pool, withTransaction } = require('../db');
const { asyncRouter, HttpError, isUuid } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { logEvent } = require('../lib/events');
const { isDateStr, todayIST } = require('../lib/time');
const { invoicePdf } = require('../lib/pdf');

const router = asyncRouter();

const INVOICE_SELECT = `SELECT i.*, c.charter_no, c.status AS charter_status, c.starts_on, c.ends_on, c.legs, c.pax,
  m.member_no, m.contact_name AS member_name, m.company AS member_company, m.city AS member_city, m.email AS member_email, m.gstin AS member_gstin,
  q.quote_no, q.line_items, a.registration AS aircraft_registration, a.type AS aircraft_type
  FROM invoices i
  JOIN charters c ON c.id = i.charter_id
  JOIN members m ON m.id = i.member_id
  JOIN quotes q ON q.id = c.quote_id
  JOIN aircraft a ON a.id = c.aircraft_id`;

async function loadInvoice(id, user) {
  if (!isUuid(id)) throw new HttpError(404, 'Invoice not found');
  const inv = (await pool.query(`${INVOICE_SELECT} WHERE i.id = $1`, [id])).rows[0];
  if (!inv) throw new HttpError(404, 'Invoice not found');
  if (user.role === 'member' && inv.member_id !== user.member_id) throw new HttpError(404, 'Invoice not found');
  return inv;
}

router.get('/', requireRole('member', 'sales', 'ops'), async (req, res) => {
  const params = [];
  const where = [];
  if (req.user.role === 'member') { params.push(req.user.member_id); where.push(`i.member_id = $${params.length}`); }
  if (req.query.status) { params.push(String(req.query.status)); where.push(`i.status = $${params.length}`); }
  const { rows } = await pool.query(
    `${INVOICE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE i.status WHEN 'unpaid' THEN 0 WHEN 'paid' THEN 1 ELSE 2 END, i.issued_on DESC, i.invoice_no DESC`, params);
  res.json(rows);
});

router.get('/:id', requireRole('member', 'sales', 'ops'), async (req, res) => {
  res.json(await loadInvoice(req.params.id, req.user));
});

router.get('/:id/pdf', requireRole('member', 'sales', 'ops'), async (req, res) => {
  const inv = await loadInvoice(req.params.id, req.user);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${inv.invoice_no}.pdf"`);
  invoicePdf(inv, res);
});

router.post('/:id/mark-paid', requireRole('sales'), async (req, res) => {
  const inv = await loadInvoice(req.params.id, req.user);
  if (inv.status !== 'unpaid') throw new HttpError(409, `Cannot mark an invoice paid that is ${inv.status}`);
  const paid_on = req.body?.paid_on || todayIST();
  if (!isDateStr(paid_on)) throw new HttpError(400, 'paid_on must be YYYY-MM-DD');
  const payment_ref = req.body?.payment_ref ? String(req.body.payment_ref).trim().slice(0, 200) : null;
  await withTransaction(async (client) => {
    const upd = await client.query(`UPDATE invoices SET status='paid', paid_on=$2, payment_ref=$3 WHERE id=$1 AND status='unpaid' RETURNING id`, [inv.id, paid_on, payment_ref]);
    if (!upd.rows.length) throw new HttpError(409, 'Invoice changed — reload and try again');
    await logEvent({ entity_type: 'invoice', entity_id: inv.id, action: 'paid', actor_user_id: req.user.id, detail: { paid_on, payment_ref } }, client);
    const closed = await client.query(`UPDATE charters SET status='closed', closed_at=now() WHERE id=$1 AND status='flown' RETURNING id`, [inv.charter_id]);
    if (closed.rows.length) await logEvent({ entity_type: 'charter', entity_id: inv.charter_id, action: 'closed', actor_user_id: req.user.id, detail: { reason: 'invoice paid' } }, client);
  });
  res.json(await loadInvoice(inv.id, req.user));
});

module.exports = router;
