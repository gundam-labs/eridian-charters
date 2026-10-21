/**
 * Marketplace back office (v1.6, sales and admin): lister payouts, cancelling a confirmed lister booking with
 * the refund policy, and route demand from traveller alerts.
 */
const { pool, withTransaction, getSettings } = require('../db');
const { asyncRouter, HttpError, isUuid } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { logEvent } = require('../lib/events');
const { refundPctFor, refundBooking, tryPayout, runMarketplaceJobsThrottled } = require('../lib/marketplace');
const { LEG_SELECT } = require('../lib/emptyLegs');
const { sendMarketplaceCancelled, sendListerLegWithdrawn } = require('../lib/email');
const { demandSummary } = require('../lib/routeAlerts');

const router = asyncRouter();

const PAYOUT_SELECT = `SELECT bp.id, bp.booking_id, bp.provider, bp.provider_payment_id, bp.method, bp.status,
  bp.amount::float8 AS amount, bp.base_amount::float8 AS base, bp.gst_amount::float8 AS gst, bp.refunded_amount::float8 AS refunded,
  bp.commission_pct::float8 AS commission_pct, bp.commission_amount::float8 AS commission, bp.payout_amount::float8 AS payout,
  bp.payout_status, bp.payout_ref, bp.payout_at, bp.payout_error, bp.captured_at,
  b.booking_no, b.status AS booking_status, b.guest_name, b.completed_at,
  el.leg_no, el.from_code, el.to_code, el.depart_earliest, el.depart_latest,
  l.id AS lister_id, l.company AS lister_company, l.razorpay_account_id, u.name AS lister_name, u.email AS lister_email
  FROM booking_payments bp
  JOIN empty_leg_bookings b ON b.id = bp.booking_id
  JOIN empty_legs el ON el.id = b.empty_leg_id
  JOIN listers l ON l.id = bp.lister_id JOIN users u ON u.id = l.user_id`;

router.get('/payouts', requireRole('sales'), async (req, res) => {
  await runMarketplaceJobsThrottled();
  const params = [];
  let where = `WHERE bp.status IN ('captured','partially_refunded','refunded')`;
  if (req.query.payout_status) {
    const st = String(req.query.payout_status).split(',').filter(Boolean);
    params.push(st); where += ` AND bp.payout_status = ANY($1)`;
  }
  const rows = (await pool.query(`${PAYOUT_SELECT} ${where} ORDER BY CASE bp.payout_status WHEN 'due' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, el.depart_earliest DESC`, params)).rows;
  const sum = (f, k) => Math.round(rows.filter(f).reduce((s, r) => s + Number(r[k] || 0), 0) * 100) / 100;
  res.json({
    payouts: rows,
    totals: {
      collected: sum(() => true, 'amount'), refunded: sum(() => true, 'refunded'), commission: sum((r) => r.payout_status !== 'cancelled', 'commission'),
      due: sum((r) => r.payout_status === 'due', 'payout'), pending: sum((r) => r.payout_status === 'pending', 'payout'),
      paid_out: sum((r) => ['paid', 'transferred'].includes(r.payout_status), 'payout'),
    },
  });
});

async function loadPayout(id) {
  if (!isUuid(id)) throw new HttpError(404, 'Payout not found');
  const p = (await pool.query(`${PAYOUT_SELECT} WHERE bp.id = $1`, [id])).rows[0];
  if (!p) throw new HttpError(404, 'Payout not found');
  return p;
}

router.post('/payouts/:id/mark-paid', requireRole('sales'), async (req, res) => {
  const p = await loadPayout(req.params.id);
  if (p.payout_status !== 'due') throw new HttpError(409, `Only due payouts can be marked paid (this one is ${p.payout_status})`);
  const ref = String(req.body?.reference || '').trim().slice(0, 120);
  if (!ref) throw new HttpError(400, 'Enter the bank transfer reference (UTR)');
  await pool.query(`UPDATE booking_payments SET payout_status = 'paid', payout_ref = $2, payout_at = now(), payout_error = NULL WHERE id = $1 AND payout_status = 'due'`, [p.id, ref]);
  await logEvent({ entity_type: 'empty_leg_booking', entity_id: p.booking_id, action: 'payout_paid', actor_user_id: req.user.id, detail: { amount: p.payout, reference: ref } });
  res.json(await loadPayout(p.id));
});

router.post('/payouts/:id/transfer', requireRole('sales'), async (req, res) => {
  const p = await loadPayout(req.params.id);
  if (p.payout_status !== 'due') throw new HttpError(409, `Only due payouts can be transferred (this one is ${p.payout_status})`);
  if (!p.razorpay_account_id) throw new HttpError(409, 'This lister has no linked Razorpay account — add it on the Listers page or pay by bank transfer');
  await tryPayout(p.id);
  const after = await loadPayout(p.id);
  if (after.payout_status !== 'transferred') throw new HttpError(502, after.payout_error || 'Transfer failed');
  res.json(after);
});

/**
 * Cancel a confirmed lister booking. who: traveller (refund by policy) | operator | charter_change | force_majeure (100%).
 * refund_pct overrides the policy (0–100).
 */
router.post('/bookings/:id/cancel', requireRole('sales'), async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'Booking not found');
  const who = String(req.body?.who || '');
  if (!['traveller', 'operator', 'charter_change', 'force_majeure'].includes(who)) throw new HttpError(400, 'who must be traveller, operator, charter_change or force_majeure');
  const reason = String(req.body?.reason || '').trim().slice(0, 1000);
  if (!reason) throw new HttpError(400, 'A reason is required');
  const b = (await pool.query(`SELECT b.*, el.lister_id, el.depart_earliest FROM empty_leg_bookings b JOIN empty_legs el ON el.id = b.empty_leg_id WHERE b.id = $1`, [req.params.id])).rows[0];
  if (!b) throw new HttpError(404, 'Booking not found');
  if (!b.lister_id) throw new HttpError(409, 'Meridian fleet bookings are cancelled from the charter page');
  if (b.status !== 'confirmed') throw new HttpError(409, `Only confirmed bookings can be cancelled (this one is ${b.status})`);
  const settings = await getSettings();
  let pct = refundPctFor(who, b.depart_earliest, settings);
  if (req.body?.refund_pct !== undefined && req.body.refund_pct !== '' && req.body.refund_pct !== null) {
    pct = Number(req.body.refund_pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new HttpError(400, 'refund_pct must be 0–100');
  }
  await withTransaction(async (client) => {
    const upd = await client.query(
      `UPDATE empty_leg_bookings SET status = 'cancelled', reject_reason = $2, cancel_reason_type = $3, decided_by = $4, decided_at = now()
        WHERE id = $1 AND status = 'confirmed' RETURNING id`, [b.id, reason, who, req.user.id]);
    if (!upd.rows.length) throw new HttpError(409, 'Booking changed — reload and try again');
    // The aircraft flies (or not) regardless; the leg is closed to new requests either way.
    await client.query(`UPDATE empty_legs SET status = 'withdrawn', withdrawn_reason = $2 WHERE id = $1 AND status = 'booked'`, [b.empty_leg_id, `Booking cancelled: ${reason}`]);
    await logEvent({ entity_type: 'empty_leg_booking', entity_id: b.id, action: 'cancelled', actor_user_id: req.user.id, detail: { who, reason, refund_pct: pct } }, client);
  });
  const refund = await refundBooking({ bookingId: b.id, pct, reason, actorUserId: req.user.id });
  const leg = (await pool.query(`${LEG_SELECT} WHERE el.id = $1`, [b.empty_leg_id])).rows[0];
  await sendMarketplaceCancelled({ to: b.guest_email, name: b.guest_name, booking: b, leg, reason, refund: refund || { amount: 0, pct } });
  if (leg.lister_email) await sendListerLegWithdrawn({ to: leg.lister_email, name: leg.lister_name, leg, reason: `Booking ${b.booking_no} cancelled by our team: ${reason}` });
  res.json({ ok: true, refund });
});

router.get('/route-demand', requireRole('sales', 'ops'), async (req, res) => {
  res.json(await demandSummary());
});

module.exports = router;
