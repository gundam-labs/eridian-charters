/**
 * Charter operator directory (v1.4, admin and sales): the DGCA list of non-scheduled operators and
 * their registered aircraft. Read-only for now; website/notes are for later enrichment.
 */
const { pool } = require('../db');
const { asyncRouter, HttpError, isUuid } = require('../lib/http');
const { requireRole } = require('../middleware/auth');

const router = asyncRouter();
router.use(requireRole('sales'));

const FLEET_TYPES = ['fixed_wing', 'rotary_wing', 'mixed', 'hot_air_balloon'];

const LIST_SELECT = `SELECT o.id, o.aop_no, o.name, o.address, o.pincode, o.phone, o.emails, o.aop_valid_until, o.fleet_type,
  o.aircraft_count, o.source_as_of, o.in_latest_list, o.website,
  (SELECT count(*)::int FROM operator_aircraft a WHERE a.operator_id = o.id AND a.kind = 'fixed_wing') AS fixed_wing_count,
  (SELECT count(*)::int FROM operator_aircraft a WHERE a.operator_id = o.id AND a.kind = 'rotary_wing') AS rotary_wing_count,
  (SELECT max(a.seats) FROM operator_aircraft a WHERE a.operator_id = o.id) AS max_seats,
  (SELECT string_agg(DISTINCT a.model, ', ' ORDER BY a.model) FROM operator_aircraft a WHERE a.operator_id = o.id) AS models
  FROM charter_operators o`;

router.get('/', async (req, res) => {
  const where = [];
  const params = [];
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q) {
    params.push(`%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    const p = `$${params.length}`;
    where.push(`(o.name ILIKE ${p} OR o.address ILIKE ${p} OR o.aop_no ILIKE ${p} OR array_to_string(o.emails, ' ') ILIKE ${p}
      OR EXISTS (SELECT 1 FROM operator_aircraft a WHERE a.operator_id = o.id AND (a.registration ILIKE ${p} OR a.model ILIKE ${p})))`);
  }
  if (req.query.fleet_type) {
    if (!FLEET_TYPES.includes(req.query.fleet_type)) throw new HttpError(400, `fleet_type must be one of ${FLEET_TYPES.join(', ')}`);
    params.push(req.query.fleet_type); where.push(`o.fleet_type = $${params.length}`);
  }
  if (req.query.listed !== 'all') where.push('o.in_latest_list');
  const { rows } = await pool.query(`${LIST_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY lower(o.name)`, params);
  const meta = (await pool.query(`SELECT version, detail, imported_at FROM data_imports WHERE name = 'dgca_nsop_operators'`)).rows[0] || null;
  const totals = (await pool.query(`SELECT count(DISTINCT o.id)::int AS operators, count(a.id)::int AS aircraft,
      count(a.id) FILTER (WHERE a.kind = 'fixed_wing')::int AS fixed_wing, count(a.id) FILTER (WHERE a.kind = 'rotary_wing')::int AS rotary_wing
    FROM charter_operators o LEFT JOIN operator_aircraft a ON a.operator_id = o.id WHERE o.in_latest_list`)).rows[0];
  res.json({ operators: rows, totals, source: meta && { as_of: meta.version, imported_at: meta.imported_at, name: meta.detail?.source } });
});

router.get('/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'Operator not found');
  const o = (await pool.query('SELECT * FROM charter_operators WHERE id = $1', [req.params.id])).rows[0];
  if (!o) throw new HttpError(404, 'Operator not found');
  const aircraft = (await pool.query(
    `SELECT registration, kind, model, seats, role, seats_raw FROM operator_aircraft WHERE operator_id = $1
      ORDER BY kind, model, registration`, [o.id])).rows;
  // Listers who registered with this operator's AOP / NSOP permit number.
  const listers = (await pool.query(
    `SELECT l.id, l.status, l.company, l.nsop_permit_no, u.name, u.email FROM listers l JOIN users u ON u.id = l.user_id
      WHERE l.nsop_permit_no IS NOT NULL ORDER BY l.created_at`)).rows.filter((l) => sameAop(l.nsop_permit_no, o.aop_no));
  res.json({ ...o, aircraft, listers });
});

/**
 * DGCA writes AOP numbers as "#07/2019"; operators type them as "NSOP-07/2019", "7/2019", "AOP No. 07/2019"…
 * Compare the permit number and year only.
 */
function aopKey(v) {
  const m = String(v || '').match(/(\d{1,3})\s*\/\s*(\d{4})/);
  return m ? `${Number(m[1])}/${m[2]}` : null;
}
const sameAop = (a, b) => aopKey(a) !== null && aopKey(a) === aopKey(b);

module.exports = router;
module.exports.aopKey = aopKey;
