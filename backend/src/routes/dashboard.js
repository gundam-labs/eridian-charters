const { pool } = require('../db');
const { asyncRouter } = require('../lib/http');
const { requireRole, STAFF } = require('../middleware/auth');
const { expireStaleQuotes } = require('../lib/quotes');
const { todayIST, addDays } = require('../lib/time');
const { BUSY_STATUSES } = require('../lib/availability');
const { expireStaleLegs } = require('../lib/emptyLegs');

const router = asyncRouter();

/**
 * Empty-leg KPIs over generated/booked legs. "90d" scope = legs whose source charter starts within the last 90 days
 * (or later, i.e. upcoming), plus manual legs created/booked in the last 90 days for the booked/revenue figures.
 */
async function emptyLegStats(today) {
  const from90 = addDays(today, -89);
  const r = (await pool.query(
    `SELECT
       (SELECT count(*)::int FROM empty_legs WHERE status = 'published') AS published,
       (SELECT count(*)::int FROM empty_leg_bookings b JOIN empty_legs el ON el.id = b.empty_leg_id
         WHERE b.status = 'requested') AS pending_requests,
       (SELECT count(*)::int FROM empty_legs el WHERE el.status = 'booked' AND el.booked_at >= now() - interval '90 days') AS booked_90d,
       (SELECT COALESCE(sum(i.subtotal), 0)::float8 FROM charters c JOIN invoices i ON i.charter_id = c.id
         WHERE c.empty_leg_id IS NOT NULL AND c.status <> 'cancelled' AND i.status <> 'cancelled'
           AND c.created_at >= now() - interval '90 days') AS revenue_90d,
       (SELECT COALESCE(sum(el.flight_hours), 0)::float8 FROM empty_legs el JOIN charters sc ON sc.id = el.source_charter_id
         WHERE sc.starts_on >= $1::date) AS gen_hours,
       (SELECT COALESCE(sum(el.flight_hours), 0)::float8 FROM empty_legs el JOIN charters sc ON sc.id = el.source_charter_id
         WHERE sc.starts_on >= $1::date AND el.status = 'booked') AS sold_hours`, [from90])).rows[0];
  return {
    published: r.published,
    pending_requests: r.pending_requests,
    booked_90d: r.booked_90d,
    revenue_recovered_90d_inr: Math.round(r.revenue_90d),
    positioning_hours_sold_pct_90d: r.gen_hours > 0 ? Math.round((r.sold_hours / r.gen_hours) * 1000) / 10 : 0,
  };
}

/** v1.2 payments card: gross collected and absorbed gateway fees (30 days), open balances due within 48h. */
async function paymentStats() {
  const r = (await pool.query(
    `SELECT
       (SELECT COALESCE(sum(amount), 0)::float8 FROM payments WHERE captured_at >= now() - interval '30 days') AS collected_30d,
       (SELECT COALESCE(sum(fee), 0)::float8 FROM payments WHERE captured_at >= now() - interval '30 days') AS fees_30d,
       (SELECT count(*)::int FROM invoices i JOIN charters c ON c.id = i.charter_id
         WHERE i.status IN ('unpaid','partially_paid') AND c.status IN ('accepted','confirmed','manifest_complete')
           AND i.due_at BETWEEN now() AND now() + interval '48 hours') AS due_count,
       (SELECT COALESCE(sum(i.total - i.amount_paid), 0)::float8 FROM invoices i JOIN charters c ON c.id = i.charter_id
         WHERE i.status IN ('unpaid','partially_paid') AND c.status IN ('accepted','confirmed','manifest_complete')
           AND i.due_at BETWEEN now() AND now() + interval '48 hours') AS due_amount`)).rows[0];
  return {
    collected_30d: Math.round(r.collected_30d * 100) / 100,
    fees_30d: Math.round(r.fees_30d * 100) / 100,
    unpaid_due_48h_count: r.due_count,
    unpaid_due_48h_amount: Math.round(r.due_amount * 100) / 100,
  };
}

router.get('/', requireRole(...STAFF), async (req, res) => {
  await expireStaleQuotes();
  await expireStaleLegs();
  const today = todayIST();
  const in7 = addDays(today, 6);
  const from30 = addDays(today, -29);
  const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];

  const [openReq, sent, expiring, next7, awaitingConf, awaitingMan, unpaid, inMaint, util] = await Promise.all([
    one(`SELECT count(*)::int AS n FROM quote_requests WHERE status = 'open'`),
    one(`SELECT count(*)::int AS n FROM quotes WHERE status = 'sent'`),
    one(`SELECT count(*)::int AS n FROM quotes WHERE status = 'sent' AND valid_until BETWEEN now() AND now() + interval '24 hours'`),
    pool.query(
      `SELECT c.id, c.charter_no, c.status, c.starts_on, c.ends_on, c.pax, c.legs, m.contact_name AS member_name,
              a.registration AS aircraft_registration, a.type AS aircraft_type,
              (SELECT count(*)::int FROM passengers p WHERE p.charter_id = c.id) AS passenger_count
         FROM charters c JOIN members m ON m.id = c.member_id JOIN aircraft a ON a.id = c.aircraft_id
        WHERE c.status IN ('accepted','confirmed','manifest_complete') AND c.starts_on <= $2 AND c.ends_on >= $1
        ORDER BY c.starts_on`, [today, in7]),
    one(`SELECT count(*)::int AS n FROM charters WHERE status = 'accepted'`),
    one(`SELECT count(*)::int AS n FROM charters WHERE status = 'confirmed'`),
    one(`SELECT COALESCE(sum(total - amount_paid), 0)::float8 AS n FROM invoices WHERE status IN ('unpaid','partially_paid')`),
    one(`SELECT count(DISTINCT aircraft_id)::int AS n FROM maintenance_blocks WHERE starts_on <= $1 AND ends_on >= $1`, [today]),
    // aircraft-days on charter in the last 30 days ÷ active aircraft × 30
    one(`SELECT
           COALESCE((SELECT sum(LEAST(c.ends_on, $2::date) - GREATEST(c.starts_on, $1::date) + 1)
                       FROM charters c
                      WHERE (c.status = ANY($3) OR c.status = 'closed')
                        AND c.starts_on <= $2::date AND c.ends_on >= $1::date), 0)::float8 AS busy_days,
           (SELECT count(*)::int FROM aircraft WHERE status = 'active') AS fleet`, [from30, today, BUSY_STATUSES]),
  ]);
  res.json({
    open_requests: openReq.n,
    quotes_sent: sent.n,
    quotes_expiring_24h: expiring.n,
    charters_next_7_days: next7.rows,
    awaiting_confirmation: awaitingConf.n,
    awaiting_manifest: awaitingMan.n,
    unpaid_invoices_total: unpaid.n,
    aircraft_in_maintenance_today: inMaint.n,
    fleet_utilisation_30d_pct: util.fleet ? Math.round((util.busy_days / (util.fleet * 30)) * 1000) / 10 : 0,
    empty_legs: await emptyLegStats(today),
    payments: await paymentStats(),
  });
});

router.get('/member', requireRole('member'), async (req, res) => {
  if (req.user.role !== 'member') return res.status(403).json({ error: 'Members only' });
  await expireStaleQuotes();
  const mid = req.user.member_id;
  const today = todayIST();
  const upcoming = (await pool.query(
    `SELECT c.id, c.charter_no, c.status, c.starts_on, c.ends_on, c.pax, c.legs, a.registration AS aircraft_registration, a.type AS aircraft_type,
            (SELECT count(*)::int FROM passengers p WHERE p.charter_id = c.id) AS passenger_count
       FROM charters c JOIN aircraft a ON a.id = c.aircraft_id
      WHERE c.member_id = $1 AND c.status IN ('accepted','confirmed','manifest_complete') AND c.ends_on >= $2
      ORDER BY c.starts_on`, [mid, today])).rows;
  const one = async (sql) => (await pool.query(sql, [mid])).rows[0];
  const openReq = await one(`SELECT count(*)::int AS n FROM quote_requests WHERE member_id = $1 AND status IN ('open','quoted')`);
  const awaiting = await one(`SELECT count(*)::int AS n FROM quotes WHERE member_id = $1 AND status = 'sent'`);
  const unpaid = await one(`SELECT count(*)::int AS n, COALESCE(sum(total - amount_paid),0)::float8 AS total, min(due_at) AS next_due_at
                              FROM invoices WHERE member_id = $1 AND status IN ('unpaid','partially_paid')`);
  res.json({
    upcoming_charters: upcoming,
    open_requests: openReq.n,
    quotes_awaiting_decision: awaiting.n,
    unpaid_invoices: { count: unpaid.n, total: unpaid.total, next_due_at: unpaid.next_due_at },
  });
});

module.exports = router;
