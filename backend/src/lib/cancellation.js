/**
 * Charter cancellation with the v1.2 refund policy. Shared by POST /charters/:id/cancel and the payment
 * deadline job, so both get the same side-effects: charter cancelled (aircraft released), invoice cancelled or
 * refunded, empty-leg cascade (v1.1), provider refunds, emails.
 */
const { pool, withTransaction, getSettings } = require('../db');
const { HttpError } = require('./http');
const { logEvent } = require('./events');
const { onCharterCancelled, salesRecipients } = require('./emptyLegs');
const { sendCharterCancelled, sendEmptyLegRequestClosed, sendSourceCancelledWarning } = require('./email');
const { refundInvoice, round2 } = require('./payments/service');

const CANCELLABLE = ['accepted', 'confirmed', 'manifest_complete'];
const HOUR_MS = 3600 * 1000;

/** First PASSENGER departure of a charter (legs JSONB holds passenger legs only). */
const firstDeparture = (charter) => new Date((charter.legs || [])[0]?.depart_at || charter.starts_on);

/**
 * Refund percentage.
 *  Member: 100 if more than refund_full_days (7) before first departure, refund_half_pct (50) from refund_half_hours (48)
 *  up to that, else 0. Operator (ops/admin): requestedPct 0–100, default 100.
 */
function refundPolicy({ charter, byMember, requestedPct, settings, now = new Date() }) {
  const hours = (firstDeparture(charter).getTime() - new Date(now).getTime()) / HOUR_MS;
  if (!byMember) {
    let pct = 100;
    if (requestedPct !== undefined && requestedPct !== null && requestedPct !== '') {
      pct = Number(requestedPct);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new HttpError(400, 'refund_pct must be between 0 and 100');
    }
    return { pct, hours_to_departure: Math.round(hours * 10) / 10, policy: 'operator' };
  }
  const fullDays = Number(settings.refund_full_days ?? 7);
  const halfHours = Number(settings.refund_half_hours ?? 48);
  const halfPct = Number(settings.refund_half_pct ?? 50);
  let pct = 0;
  let policy = `Less than ${halfHours} hours before departure — no refund`;
  if (hours > fullDays * 24) { pct = 100; policy = `More than ${fullDays} days before departure — full refund`; }
  else if (hours >= halfHours) { pct = halfPct; policy = `${halfHours} hours to ${fullDays} days before departure — ${halfPct}% refund`; }
  return { pct, hours_to_departure: Math.round(hours * 10) / 10, policy };
}

/** What a cancellation would refund right now. → { pct, refund_amount, amount_paid, hours_to_departure, policy } */
async function cancellationQuote(charter, { byMember, requestedPct }) {
  const settings = await getSettings();
  const inv = (await pool.query('SELECT amount_paid FROM invoices WHERE charter_id = $1', [charter.id])).rows[0];
  const amount_paid = Number(inv?.amount_paid || 0);
  const p = refundPolicy({ charter, byMember, requestedPct, settings });
  return { pct: p.pct, refund_amount: round2((p.pct * amount_paid) / 100), amount_paid, hours_to_departure: p.hours_to_departure, policy: p.policy };
}

/**
 * Cancel a charter. Locks the invoice then the charter (same order as applying a payment, so no deadlock).
 *   onlyIfOverdueAt: (deadline job) cancel only if the invoice is still not fully paid and due_at < this instant.
 * → { charter, refund: {pct, amount}, skipped? }
 */
async function cancelCharter({ charterId, reason, actorUserId = null, byMember = false, requestedPct, onlyIfOverdueAt = null }) {
  const settings = await getSettings();
  const tx = await withTransaction(async (client) => {
    const inv = (await client.query('SELECT * FROM invoices WHERE charter_id = $1 FOR UPDATE', [charterId])).rows[0];
    const charter = (await client.query('SELECT * FROM charters WHERE id = $1 FOR UPDATE', [charterId])).rows[0];
    if (!charter) throw new HttpError(404, 'Charter not found');
    if (!CANCELLABLE.includes(charter.status)) throw new HttpError(409, `Cannot cancel a charter that is ${charter.status}`);
    if (onlyIfOverdueAt) {
      const overdue = inv && ['unpaid', 'partially_paid'].includes(inv.status) && inv.due_at && new Date(inv.due_at) < new Date(onlyIfOverdueAt);
      if (!overdue) return { skipped: true };
    }
    const { pct, policy, hours_to_departure } = refundPolicy({ charter, byMember, requestedPct, settings });
    const amountPaid = Number(inv?.amount_paid || 0);
    const refundAmount = round2((pct * amountPaid) / 100);

    const upd = (await client.query(
      `UPDATE charters SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2 WHERE id = $1 RETURNING *`,
      [charterId, reason.slice(0, 1000)])).rows[0];
    await logEvent({ entity_type: 'charter', entity_id: charterId, action: 'cancelled', actor_user_id: actorUserId,
      detail: { reason, by: byMember ? 'member' : actorUserId ? 'operator' : 'system', refund_pct: pct, refund_amount: refundAmount, policy, hours_to_departure } }, client);
    if (inv && inv.status !== 'cancelled' && inv.status !== 'refunded') {
      const status = refundAmount > 0 ? 'refunded' : 'cancelled';
      await client.query('UPDATE invoices SET status = $2 WHERE id = $1', [inv.id, status]);
      await logEvent({ entity_type: 'invoice', entity_id: inv.id, action: status, actor_user_id: actorUserId,
        detail: { reason: 'charter cancelled', refund_pct: pct, refund_amount: refundAmount, amount_paid: amountPaid } }, client);
    }
    const cascade = await onCharterCancelled(upd, actorUserId, client);
    return { charter: upd, invoice: inv, pct, refundAmount, cascade };
  });
  if (tx.skipped) return { skipped: true };

  let refunded = { amount: 0, refunds: [] };
  if (tx.refundAmount > 0 && tx.invoice) {
    refunded = await refundInvoice({ invoiceId: tx.invoice.id, amount: tx.refundAmount, pct: tx.pct, reason, actorUserId });
  }

  // Emails after commit (never throw).
  const m = (await pool.query('SELECT email, contact_name FROM members WHERE id = $1', [tx.charter.member_id])).rows[0];
  if (m) await sendCharterCancelled({ to: m.email, name: m.contact_name, charter: tx.charter, reason, refund: { pct: tx.pct, amount: tx.refundAmount } });
  for (const { booking, leg } of tx.cascade.cancelledRequests) {
    await sendEmptyLegRequestClosed({ to: booking.guest_email, name: booking.guest_name, booking, leg, reason: 'The flight has been withdrawn by the operator' });
  }
  if (tx.cascade.flagged.length) {
    const to = await salesRecipients();
    for (const d of tx.cascade.flagged) for (const addr of to) await sendSourceCancelledWarning({ to: addr, sourceCharterNo: tx.charter.charter_no, derived: d });
  }
  return { charter: tx.charter, refund: { pct: tx.pct, amount: tx.refundAmount, processed_amount: refunded.amount } };
}

module.exports = { cancelCharter, cancellationQuote, refundPolicy, firstDeparture, CANCELLABLE };
