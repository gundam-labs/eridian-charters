const { pool } = require('../db');
const { asyncRouter, HttpError, isUuid } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { nextNumber } = require('../lib/numbers');
const { logEvent } = require('../lib/events');
const { parseIST, toISTISO } = require('../lib/time');
const { expireStaleQuotes } = require('../lib/quotes');
const { shapeQuote, QUOTE_SELECT } = require('./quotes');

const router = asyncRouter();

const REQ_SELECT = `SELECT r.*, m.member_no, m.contact_name AS member_name, m.company AS member_company,
  (SELECT count(*)::int FROM quotes q WHERE q.request_id = r.id) AS quote_count,
  (SELECT count(*)::int FROM quotes q WHERE q.request_id = r.id AND q.status NOT IN ('draft')) AS visible_quote_count
  FROM quote_requests r JOIN members m ON m.id = r.member_id`;

function shapeRequest(r, user) {
  const out = { ...r };
  if (user.role === 'member') { out.quote_count = r.visible_quote_count; }
  delete out.visible_quote_count;
  return out;
}

/** Validate and normalise legs; departures returned as ISO strings with +05:30. */
async function validateLegs(legs) {
  if (!Array.isArray(legs) || legs.length < 1 || legs.length > 6) throw new HttpError(400, 'Between 1 and 6 legs are required');
  const codes = (await pool.query('SELECT code FROM airports')).rows.map((r) => r.code);
  const now = Date.now();
  let prev = null;
  return legs.map((l, i) => {
    const n = i + 1;
    const from = String(l?.from || '').toUpperCase();
    const to = String(l?.to || '').toUpperCase();
    if (!codes.includes(from)) throw new HttpError(400, `Leg ${n}: unknown airport ${from || '(blank)'}`);
    if (!codes.includes(to)) throw new HttpError(400, `Leg ${n}: unknown airport ${to || '(blank)'}`);
    if (from === to) throw new HttpError(400, `Leg ${n}: from and to must differ`);
    const d = parseIST(l?.depart_at);
    if (!d) throw new HttpError(400, `Leg ${n}: depart_at must be YYYY-MM-DDTHH:mm`);
    if (d.getTime() <= now) throw new HttpError(400, `Leg ${n}: departure must be in the future`);
    if (prev && d.getTime() <= prev) throw new HttpError(400, `Leg ${n}: departures must be in order`);
    prev = d.getTime();
    return { from, to, depart_at: toISTISO(d) };
  });
}

router.post('/', requireRole('member', 'sales'), async (req, res) => {
  const { legs, pax, notes, member_id } = req.body || {};
  let memberId;
  if (req.user.role === 'member') {
    memberId = req.user.member_id;
  } else {
    if (!isUuid(member_id)) throw new HttpError(400, 'member_id is required');
    memberId = member_id;
  }
  const m = (await pool.query('SELECT id, status FROM members WHERE id = $1', [memberId])).rows[0];
  if (!m) throw new HttpError(400, 'Unknown member');
  if (m.status !== 'active') throw new HttpError(409, 'Member is inactive');
  const cleanLegs = await validateLegs(legs);
  const p = Number(pax);
  if (!Number.isInteger(p) || p < 1 || p > 20) throw new HttpError(400, 'pax must be between 1 and 20');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const request_no = await nextNumber('RQ', client);
    const { rows } = await client.query(
      `INSERT INTO quote_requests (request_no, member_id, legs, pax, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [request_no, memberId, JSON.stringify(cleanLegs), p, notes || null, req.user.id]);
    await logEvent({ entity_type: 'quote_request', entity_id: rows[0].id, action: 'created', actor_user_id: req.user.id, detail: { request_no } }, client);
    await client.query('COMMIT');
    const r = (await pool.query(`${REQ_SELECT} WHERE r.id = $1`, [rows[0].id])).rows[0];
    res.status(201).json(shapeRequest(r, req.user));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.get('/', requireRole('member', 'sales', 'ops'), async (req, res) => {
  const params = [];
  const where = [];
  if (req.user.role === 'member') { params.push(req.user.member_id); where.push(`r.member_id = $${params.length}`); }
  if (req.query.status) { params.push(String(req.query.status)); where.push(`r.status = $${params.length}`); }
  if (req.query.member_id && req.user.role !== 'member') {
    if (!isUuid(req.query.member_id)) throw new HttpError(400, 'Invalid member_id');
    params.push(req.query.member_id); where.push(`r.member_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `${REQ_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'quoted' THEN 1 ELSE 2 END, r.created_at DESC`, params);
  res.json(rows.map((r) => shapeRequest(r, req.user)));
});

async function loadVisible(id, user) {
  if (!isUuid(id)) throw new HttpError(404, 'Request not found');
  const r = (await pool.query(`${REQ_SELECT} WHERE r.id = $1`, [id])).rows[0];
  if (!r) throw new HttpError(404, 'Request not found');
  if (user.role === 'member' && r.member_id !== user.member_id) throw new HttpError(404, 'Request not found');
  return r;
}

router.get('/:id', requireRole('member', 'sales', 'ops'), async (req, res) => {
  await expireStaleQuotes();
  const r = await loadVisible(req.params.id, req.user);
  const statusFilter = req.user.role === 'member' ? "AND q.status IN ('sent','accepted','declined','expired')" : '';
  const quotes = (await pool.query(`${QUOTE_SELECT} WHERE q.request_id = $1 ${statusFilter} ORDER BY q.created_at`, [r.id])).rows;
  const charter = (await pool.query(
    `SELECT c.id, c.charter_no, c.status FROM charters c JOIN quotes q ON q.id = c.quote_id WHERE q.request_id = $1 LIMIT 1`, [r.id])).rows[0] || null;
  res.json({ ...shapeRequest(r, req.user), quotes: quotes.map((q) => shapeQuote(q, req.user)), charter });
});

router.post('/:id/cancel', requireRole('member', 'sales'), async (req, res) => {
  const r = await loadVisible(req.params.id, req.user);
  if (!['open', 'quoted'].includes(r.status)) throw new HttpError(409, `Cannot cancel a request that is ${r.status}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(`UPDATE quote_requests SET status = 'cancelled' WHERE id = $1 AND status IN ('open','quoted') RETURNING id`, [r.id]);
    if (!upd.rows.length) throw new HttpError(409, 'Request changed — reload and try again');
    const w = await client.query(`UPDATE quotes SET status = 'withdrawn', decided_at = now() WHERE request_id = $1 AND status IN ('draft','sent') RETURNING id`, [r.id]);
    for (const q of w.rows) await logEvent({ entity_type: 'quote', entity_id: q.id, action: 'withdrawn', actor_user_id: req.user.id, detail: { reason: 'request cancelled' } }, client);
    await logEvent({ entity_type: 'quote_request', entity_id: r.id, action: 'cancelled', actor_user_id: req.user.id, detail: { reason: req.body?.reason || null } }, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json(shapeRequest((await pool.query(`${REQ_SELECT} WHERE r.id = $1`, [r.id])).rows[0], req.user));
});

module.exports = router;
