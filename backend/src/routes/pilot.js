const { pool } = require('../db');
const { asyncRouter } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { publicAircraft } = require('../lib/serialize');
const { todayIST } = require('../lib/time');
const { CHARTER_SELECT, PILOT_CLAUSE } = require('./charters');

const router = asyncRouter();

// Charters assigned to the current user's crew record: upcoming first (soonest first), then past (most recent first).
router.get('/flights', requireRole('pilot'), async (req, res) => {
  const today = todayIST();
  const { rows } = await pool.query(
    `${CHARTER_SELECT}
      WHERE ${PILOT_CLAUSE(1)} AND c.status <> 'cancelled'
      ORDER BY (c.ends_on < $2::date OR c.status IN ('flown','closed')) ASC,
               CASE WHEN c.ends_on >= $2::date AND c.status NOT IN ('flown','closed') THEN c.starts_on END ASC,
               c.starts_on DESC`,
    [req.user.id, today]);
  const ids = rows.map((r) => r.id);
  const pax = ids.length
    ? (await pool.query('SELECT charter_id, full_name FROM passengers WHERE charter_id = ANY($1::uuid[]) ORDER BY created_at, full_name', [ids])).rows
    : [];
  res.json(rows.map((c) => {
    const { ops_notes, member_email, ...rest } = c;
    return {
      ...rest,
      aircraft: publicAircraft(c.aircraft),
      pax_count: c.passenger_count,
      passengers: pax.filter((p) => p.charter_id === c.id).map((p) => ({ full_name: p.full_name })),
      crew: { captain: c.captain_name, first_officer: c.first_officer_name, cabin_crew: c.cabin_crew_name },
      upcoming: c.ends_on >= today && !['flown', 'closed'].includes(c.status),
    };
  }));
});

module.exports = router;
