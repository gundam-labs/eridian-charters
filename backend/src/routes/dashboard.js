const { pool } = require('../db');
const { asyncRouter } = require('../lib/http');
const { requireRole, STAFF } = require('../middleware/auth');
const { expireStaleQuotes } = require('../lib/quotes');
const { todayIST, addDays } = require('../lib/time');
const { BUSY_STATUSES } = require('../lib/availability');

const router = asyncRouter();

router.get('/', requireRole(...STAFF), async (req, res) => {
  await expireStaleQuotes();
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
    one(`SELECT COALESCE(sum(total), 0)::float8 AS n FROM invoices WHERE status = 'unpaid'`),
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
  const unpaid = await one(`SELECT count(*)::int AS n, COALESCE(sum(total),0)::float8 AS total FROM invoices WHERE member_id = $1 AND status = 'unpaid'`);
  res.json({
    upcoming_charters: upcoming,
    open_requests: openReq.n,
    quotes_awaiting_decision: awaiting.n,
    unpaid_invoices: { count: unpaid.n, total: unpaid.total },
  });
});

module.exports = router;
