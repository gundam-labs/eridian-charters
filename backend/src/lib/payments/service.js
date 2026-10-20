/**
 * Payments domain logic (SPEC v1.2): due dates, applying a confirmed payment to an invoice (idempotent),
 * the signed-webhook processor shared by Razorpay and the mock provider, and refunds.
 *
 * Amounts: paise (integers) at the provider boundary, rupees (NUMERIC(14,2)) in our tables.
 */
const crypto = require('crypto');
const { pool, withTransaction, getSettings } = require('../../db');
const { logEvent } = require('../events');
const { todayIST } = require('../time');
const { isUuid } = require('../http');
const { provider, providerFor } = require('./index');

const HOUR_MS = 3600 * 1000;
const METHODS = ['card', 'upi', 'netbanking', 'wallet', 'bank_transfer', 'emi', 'other'];
const OPEN_STATUSES = ['unpaid', 'partially_paid'];
/** Paid when amount_paid ≥ total − ₹1 (rounding tolerance). */
const PAID_TOLERANCE = 1;

const toPaise = (rupees) => Math.round(Number(rupees) * 100);
const fromPaise = (paise) => Math.round(Number(paise || 0)) / 100;
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);

/** Outstanding balance of an invoice row (0 unless unpaid/partially_paid). */
function balanceOf(inv) {
  if (!OPEN_STATUSES.includes(inv.status)) return 0;
  return Math.max(0, round2(Number(inv.total) - Number(inv.amount_paid || 0)));
}

/**
 * Invoice payment deadline.
 *  - Charter from a quote: first passenger departure − payment_due_hours_before_departure (24h).
 *  - Empty leg: min(first departure − 24h, booking time + empty_leg_payment_window_hours (2h)).
 *  - Either way, if first departure − 24h is already past at booking: booking time + 2h (never after departure).
 */
function computeDueAt(firstDepartAt, settings, { emptyLeg = false, now = new Date() } = {}) {
  const dep = new Date(firstDepartAt).getTime();
  const nowMs = new Date(now).getTime();
  const std = dep - num(settings.payment_due_hours_before_departure, 24) * HOUR_MS;
  const late = nowMs + num(settings.empty_leg_payment_window_hours, 2) * HOUR_MS;
  if (std <= nowMs) return new Date(Math.min(late, dep));
  return new Date(emptyLeg ? Math.min(std, late) : std);
}

/** Card-safe subset of a provider payment entity (never card details). */
function sanitizeEntity(p, extra = {}) {
  const keep = ['id', 'entity', 'method', 'amount', 'currency', 'fee', 'tax', 'status', 'order_id', 'bank', 'vpa', 'wallet', 'created_at', 'bank_transfer_ref'];
  const out = {};
  for (const k of keep) if (p?.[k] !== undefined && p[k] !== null) out[k] = p[k];
  const acq = p?.acquirer_data;
  if (acq) {
    const a = {};
    for (const k of ['bank_transaction_id', 'rrn', 'upi_transaction_id', 'utr']) if (acq[k]) a[k] = acq[k];
    if (Object.keys(a).length) out.acquirer_data = a;
  }
  return { ...out, ...extra };
}

/**
 * Apply a provider-confirmed payment to an invoice. Pass a transaction client.
 * Idempotent on provider_payment_id (a replay inserts nothing and changes nothing).
 * → { applied, invoice, payment, notify } — notify is { kind:'receipt', … } for the caller to email after commit.
 */
async function applyPayment(client, {
  invoiceId, providerName, entity, virtualAccountId = null, actorUserId = null, paidOn = null, paymentRef = null, capturedAt = null,
}) {
  const inv = (await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId])).rows[0];
  if (!inv) throw new Error(`Invoice ${invoiceId} not found`);
  const amount = fromPaise(entity.amount);
  if (!(amount > 0)) throw new Error('Payment amount must be positive');
  if (entity.currency && entity.currency !== 'INR') throw new Error(`Unsupported currency ${entity.currency}`);
  const method = METHODS.includes(entity.method) ? entity.method : 'other';
  const fee = fromPaise(entity.fee);
  const captured = capturedAt || (entity.created_at ? new Date(Number(entity.created_at) * 1000) : new Date());

  const ins = await client.query(
    `INSERT INTO payments (invoice_id, provider, provider_payment_id, provider_order_id, virtual_account_id, method, amount, fee, status, captured_at, raw, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'captured',$9,$10,$11)
     ON CONFLICT (provider_payment_id) DO NOTHING RETURNING *`,
    [inv.id, providerName, entity.id, entity.order_id || null, virtualAccountId, method, amount, fee, captured,
      JSON.stringify(sanitizeEntity(entity)), actorUserId]);
  if (!ins.rows.length) return { applied: false, invoice: inv, payment: null, notify: null };
  const payment = ins.rows[0];

  if (entity.order_id) await client.query(`UPDATE payment_orders SET status = 'paid' WHERE provider_order_id = $1 AND status <> 'paid'`, [entity.order_id]);

  const newPaid = round2(Number(inv.amount_paid) + amount);
  const detail = { amount, method, fee, provider: providerName, provider_payment_id: entity.id };
  await logEvent({ entity_type: 'invoice', entity_id: inv.id, action: 'payment_received', actor_user_id: actorUserId, detail }, client);

  let updated;
  if (!OPEN_STATUSES.includes(inv.status)) {
    // Money arrived for an invoice that is already paid, cancelled or refunded: record it and flag it for sales.
    updated = (await client.query('UPDATE invoices SET amount_paid = $2 WHERE id = $1 RETURNING *', [inv.id, newPaid])).rows[0];
    const action = inv.status === 'paid' ? 'overpaid' : 'payment_after_cancellation';
    await logEvent({ entity_type: 'invoice', entity_id: inv.id, action, actor_user_id: actorUserId,
      detail: { ...detail, invoice_status: inv.status, excess: inv.status === 'paid' ? round2(newPaid - Number(inv.total)) : amount, note: 'Needs attention from sales (refund or reallocate)' } }, client);
  } else {
    const isPaid = newPaid >= Number(inv.total) - PAID_TOLERANCE;
    const status = isPaid ? 'paid' : 'partially_paid';
    updated = (await client.query(
      `UPDATE invoices SET amount_paid = $2, status = $3, paid_on = CASE WHEN $3 = 'paid' THEN $4::date ELSE paid_on END,
              payment_ref = COALESCE($5, payment_ref) WHERE id = $1 RETURNING *`,
      [inv.id, newPaid, status, paidOn || todayIST(), paymentRef || entity.id])).rows[0];
    if (isPaid) {
      await logEvent({ entity_type: 'invoice', entity_id: inv.id, action: 'paid', actor_user_id: actorUserId, detail: { amount_paid: newPaid, payment_ref: updated.payment_ref } }, client);
      if (newPaid > Number(inv.total) + PAID_TOLERANCE) {
        await logEvent({ entity_type: 'invoice', entity_id: inv.id, action: 'overpaid', actor_user_id: actorUserId,
          detail: { excess: round2(newPaid - Number(inv.total)), note: 'Over-payment — sales to refund or credit' } }, client);
      }
      const closed = await client.query(`UPDATE charters SET status = 'closed', closed_at = now() WHERE id = $1 AND status = 'flown' RETURNING id`, [inv.charter_id]);
      if (closed.rows.length) await logEvent({ entity_type: 'charter', entity_id: inv.charter_id, action: 'closed', actor_user_id: actorUserId, detail: { reason: 'invoice paid' } }, client);
    } else {
      await logEvent({ entity_type: 'invoice', entity_id: inv.id, action: 'partially_paid', actor_user_id: actorUserId, detail: { amount_paid: newPaid, balance: round2(Number(inv.total) - newPaid) } }, client);
    }
  }
  return { applied: true, invoice: updated, payment, notify: { kind: 'receipt', invoiceId: inv.id, paymentId: payment.id } };
}

/** Email receipts etc. after commit. Never throws. */
async function sendNotifications(list) {
  const { sendPaymentReceipt } = require('../email');
  for (const n of list.filter(Boolean)) {
    try {
      if (n.kind === 'receipt') {
        const r = (await pool.query(
          `SELECT p.amount::float8 AS amount, p.method, p.provider_payment_id, p.captured_at, i.invoice_no, i.total::float8 AS total,
                  i.amount_paid::float8 AS amount_paid, i.status, i.due_at, c.charter_no, c.id AS charter_id, m.email, m.contact_name
             FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN charters c ON c.id = i.charter_id JOIN members m ON m.id = i.member_id
            WHERE p.id = $1`, [n.paymentId])).rows[0];
        if (r) await sendPaymentReceipt({ to: r.email, name: r.contact_name, receipt: r });
      }
    } catch (err) {
      console.error('[Payments] notification failed:', err.message);
    }
  }
}

// ── Webhooks ────────────────────────────────────────────────────────────────
async function invoiceForOrder(client, payment, orderEntity) {
  const orderId = payment.order_id || orderEntity?.id || null;
  if (orderId) {
    const o = (await client.query('SELECT invoice_id FROM payment_orders WHERE provider_order_id = $1', [orderId])).rows[0];
    if (o) return o.invoice_id;
  }
  const noteId = payment.notes?.invoice_id || orderEntity?.notes?.invoice_id;
  if (isUuid(noteId) && (await client.query('SELECT 1 FROM invoices WHERE id = $1', [noteId])).rows.length) return noteId;
  return null;
}

/** Handle one verified event inside the transaction. → array of notifications. Throws to record an error. */
async function handleEvent(client, evt, providerName) {
  const type = evt?.event;
  const payload = evt?.payload || {};
  switch (type) {
    case 'payment.captured':
    case 'order.paid': {
      const p = payload.payment?.entity;
      if (!p?.id) throw new Error('Event has no payment entity');
      if (p.status && p.status !== 'captured') return [];
      const invoiceId = await invoiceForOrder(client, p, payload.order?.entity);
      if (!invoiceId) {
        if (p.method === 'bank_transfer') return []; // virtual-account credits are applied via virtual_account.credited
        throw new Error(`No invoice found for payment ${p.id} (order ${p.order_id || '-'})`);
      }
      const r = await applyPayment(client, { invoiceId, providerName, entity: p });
      return [r.notify];
    }
    case 'virtual_account.credited': {
      const p = payload.payment?.entity;
      const va = payload.virtual_account?.entity;
      const bt = payload.bank_transfer?.entity;
      if (!p?.id || !va?.id) throw new Error('Event has no payment or virtual account entity');
      if ((await client.query('SELECT 1 FROM payments WHERE provider_payment_id = $1', [p.id])).rows.length) return [];
      const vaRow = (await client.query('SELECT * FROM virtual_accounts WHERE provider_va_id = $1', [va.id])).rows[0];
      if (!vaRow) throw new Error(`Unknown virtual account ${va.id}`);
      // Oldest open invoice of that member (by issue date, then creation).
      const inv = (await client.query(
        `SELECT id FROM invoices WHERE member_id = $1 AND status IN ('unpaid','partially_paid')
          ORDER BY issued_on, created_at, invoice_no LIMIT 1 FOR UPDATE`, [vaRow.member_id])).rows[0];
      if (!inv) throw new Error(`No open invoice for the member of virtual account ${va.id} — allocate ₹${fromPaise(p.amount)} manually`);
      const entity = { ...p, method: 'bank_transfer', bank_transfer_ref: bt?.bank_reference || p.bank_transfer_ref };
      const r = await applyPayment(client, { invoiceId: inv.id, providerName, entity, virtualAccountId: vaRow.id });
      return [r.notify];
    }
    case 'refund.processed':
    case 'refund.failed': {
      const rf = payload.refund?.entity;
      if (!rf?.id) throw new Error('Event has no refund entity');
      const status = type === 'refund.processed' ? 'processed' : 'failed';
      const row = (await client.query(
        `UPDATE refunds SET status = $2, error = CASE WHEN $2 = 'failed' THEN COALESCE(error, 'Refund failed at provider') ELSE error END
          WHERE provider_refund_id = $1 RETURNING *`, [rf.id, status])).rows[0];
      if (!row) throw new Error(`Unknown refund ${rf.id}`);
      await refreshPaymentStatus(client, row.payment_id);
      const p = (await client.query('SELECT invoice_id FROM payments WHERE id = $1', [row.payment_id])).rows[0];
      await logEvent({ entity_type: 'invoice', entity_id: p.invoice_id, action: status === 'processed' ? 'refund_processed' : 'refund_failed',
        detail: { provider_refund_id: rf.id, amount: Number(row.amount) } }, client);
      return [];
    }
    default:
      return []; // other events are acknowledged and ignored
  }
}

/**
 * Process a webhook delivery: verify the HMAC of the RAW body, store the event (unique event id), apply it.
 * Used by POST /api/payments/webhook/razorpay AND by the mock endpoints, so both share one code path.
 * → { status: 200|400|401, body }
 */
async function processWebhook(rawBody, signature, eventIdHeader) {
  const prov = provider();
  if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') return { status: 400, body: { error: 'Expected a raw JSON body' } };
  if (!prov.verifyWebhook(rawBody, signature)) return { status: 401, body: { error: 'Invalid signature' } };
  let evt;
  try { evt = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody); } catch (_) {
    return { status: 400, body: { error: 'Invalid JSON body' } };
  }
  const eventId = String(eventIdHeader || '').trim() || `sha256_${crypto.createHash('sha256').update(rawBody).digest('hex')}`;
  const result = await withTransaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO webhook_events (provider, event_id, event_type) VALUES ($1,$2,$3) ON CONFLICT (event_id) DO NOTHING RETURNING id`,
      [prov.name, eventId.slice(0, 200), String(evt?.event || '').slice(0, 100)]);
    if (!ins.rows.length) return { duplicate: true, notify: [] };
    await client.query('SAVEPOINT handle_event');
    try {
      const notify = await handleEvent(client, evt, prov.name);
      await client.query('RELEASE SAVEPOINT handle_event');
      await client.query('UPDATE webhook_events SET processed_at = now() WHERE id = $1', [ins.rows[0].id]);
      return { notify };
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT handle_event');
      console.error(`[Payments] webhook ${eventId} (${evt?.event}) error:`, err.message);
      await client.query('UPDATE webhook_events SET processed_at = now(), error = $2 WHERE id = $1', [ins.rows[0].id, String(err.message).slice(0, 1000)]);
      return { error: err.message, notify: [] };
    }
  });
  await sendNotifications(result.notify);
  return { status: 200, body: { received: true, event_id: eventId, ...(result.duplicate ? { duplicate: true } : {}), ...(result.error ? { error_recorded: true } : {}) } };
}

// ── Refunds ─────────────────────────────────────────────────────────────────
async function refreshPaymentStatus(db, paymentId) {
  await db.query(
    `UPDATE payments p SET status = CASE
        WHEN r.refunded >= p.amount - 0.005 THEN 'refunded'
        WHEN r.refunded > 0 THEN 'partially_refunded'
        ELSE 'captured' END
       FROM (SELECT COALESCE(sum(amount) FILTER (WHERE status <> 'failed'), 0) AS refunded FROM refunds WHERE payment_id = $1) r
      WHERE p.id = $1`, [paymentId]);
}

/**
 * Refund `amount` (₹) of an invoice's payments, newest first, through each payment's own provider.
 * Manual (bank) payments get a 'pending' refund row for finance to pay out by hand.
 * Call AFTER the cancellation has committed. → { amount, refunds: [rows] }
 */
async function refundInvoice({ invoiceId, amount, pct, reason, actorUserId = null }) {
  let remaining = round2(amount);
  const rows = [];
  if (!(remaining > 0)) return { amount: 0, refunds: rows };
  const pays = (await pool.query(
    `SELECT p.*, COALESCE((SELECT sum(r.amount) FROM refunds r WHERE r.payment_id = p.id AND r.status <> 'failed'), 0)::float8 AS refunded
       FROM payments p WHERE p.invoice_id = $1 ORDER BY p.captured_at DESC, p.created_at DESC`, [invoiceId])).rows;
  for (const p of pays) {
    if (remaining <= 0) break;
    const take = round2(Math.min(Number(p.amount) - Number(p.refunded), remaining));
    if (take <= 0) continue;
    const prov = providerFor(p.provider);
    let rec;
    if (!prov) {
      rec = { provider_refund_id: null, status: 'pending', error: 'Manual payment — refund by bank transfer' };
    } else {
      try {
        const r = await prov.refund(p.provider_payment_id, toPaise(take), { invoice_id: invoiceId, reason: String(reason || '').slice(0, 200) });
        rec = { provider_refund_id: r.id, status: ['processed', 'failed'].includes(r.status) ? r.status : 'pending', error: null };
      } catch (err) {
        rec = { provider_refund_id: null, status: 'failed', error: String(err.message).slice(0, 500) };
      }
    }
    const row = (await pool.query(
      `INSERT INTO refunds (payment_id, provider_refund_id, amount, reason, policy_pct, status, error, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [p.id, rec.provider_refund_id, take, reason, pct, rec.status, rec.error, actorUserId])).rows[0];
    await refreshPaymentStatus(pool, p.id);
    await logEvent({ entity_type: 'invoice', entity_id: invoiceId, action: rec.status === 'failed' ? 'refund_failed' : 'refund_initiated', actor_user_id: actorUserId,
      detail: { amount: take, pct, provider: p.provider, provider_payment_id: p.provider_payment_id, provider_refund_id: rec.provider_refund_id, status: rec.status, error: rec.error } });
    rows.push(row);
    remaining = round2(remaining - take);
  }
  return { amount: round2(amount - remaining), refunds: rows };
}

/** Invoice detail extras: payments[] and refunds[] (fee only for staff). */
async function paymentsForInvoice(invoiceId, staff) {
  const payments = (await pool.query(
    `SELECT id, provider, provider_payment_id, method, amount::float8 AS amount, fee::float8 AS fee, status, captured_at
       FROM payments WHERE invoice_id = $1 ORDER BY captured_at, created_at`, [invoiceId])).rows
    .map(({ fee, ...p }) => (staff ? { ...p, fee } : p));
  const refunds = (await pool.query(
    `SELECT r.id, r.payment_id, r.amount::float8 AS amount, r.status, r.policy_pct::float8 AS policy_pct, r.reason, r.created_at
       FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.invoice_id = $1 ORDER BY r.created_at`, [invoiceId])).rows;
  return { payments, refunds };
}

/** Settings helper re-export for callers that only need payment settings. */
const paymentSettings = (db) => getSettings(db);

module.exports = {
  METHODS, OPEN_STATUSES, toPaise, fromPaise, round2, balanceOf, computeDueAt, applyPayment, sendNotifications,
  processWebhook, refundInvoice, refreshPaymentStatus, paymentsForInvoice, paymentSettings, sanitizeEntity,
};
