const { pool } = require('../db');
const { asyncRouter, HttpError, isUuid } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { nextMemberNo } = require('../lib/numbers');
const { logEvent } = require('../lib/events');
const { sendInvite, APP_URL } = require('../lib/email');
const { issueInvite } = require('./auth');

const router = asyncRouter();

const TYPES = ['individual', 'corporate', 'agent'];
const TIERS = ['silver', 'gold', 'platinum'];
const STATUSES = ['active', 'inactive'];
const FIELDS = ['member_type', 'contact_name', 'company', 'city', 'email', 'phone', 'gstin', 'tier', 'status', 'member_since', 'past_charters', 'notes'];

const USER_STATUS_SQL = `
  CASE
    WHEN EXISTS (SELECT 1 FROM users u WHERE u.member_id = m.id AND u.password_hash IS NOT NULL AND u.is_active) THEN 'active'
    WHEN EXISTS (SELECT 1 FROM users u WHERE u.member_id = m.id AND u.invite_token_hash IS NOT NULL) THEN 'invited'
    ELSE 'none'
  END`;

function validate(body, partial) {
  const out = {};
  for (const f of FIELDS) if (body[f] !== undefined) out[f] = body[f] === '' && f !== 'contact_name' && f !== 'email' ? null : body[f];
  if (!partial) {
    if (!out.contact_name) throw new HttpError(400, 'contact_name is required');
    if (!out.email) throw new HttpError(400, 'email is required');
  }
  if (out.contact_name !== undefined && !String(out.contact_name || '').trim()) throw new HttpError(400, 'contact_name is required');
  if (out.email !== undefined) {
    out.email = String(out.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) throw new HttpError(400, 'A valid email is required');
  }
  for (const [f, list] of [['member_type', TYPES], ['tier', TIERS], ['status', STATUSES]]) {
    if (out[f] != null) {
      out[f] = String(out[f]).toLowerCase();
      if (!list.includes(out[f])) throw new HttpError(400, `${f} must be one of ${list.join(', ')}`);
    }
  }
  if (out.member_since != null && !/^\d{4}-\d{2}$/.test(out.member_since)) throw new HttpError(400, 'member_since must be YYYY-MM');
  if (out.past_charters != null) {
    out.past_charters = parseInt(out.past_charters, 10);
    if (!Number.isInteger(out.past_charters) || out.past_charters < 0) throw new HttpError(400, 'past_charters must be a non-negative integer');
  }
  return out;
}

router.get('/', requireRole('sales', 'ops'), async (req, res) => {
  const { q, type, status } = req.query;
  const params = [];
  const where = [];
  if (q) {
    params.push(`%${q}%`);
    where.push(`(m.contact_name ILIKE $${params.length} OR m.company ILIKE $${params.length} OR m.email ILIKE $${params.length} OR m.member_no ILIKE $${params.length} OR m.city ILIKE $${params.length})`);
  }
  if (type) { params.push(String(type).toLowerCase()); where.push(`m.member_type = $${params.length}`); }
  if (status) { params.push(String(status).toLowerCase()); where.push(`m.status = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT m.*, ${USER_STATUS_SQL} AS user_status FROM members m
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY m.member_no`,
    params
  );
  res.json(rows);
});

router.get('/:id', requireRole('sales', 'ops'), async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'Member not found');
  const m = (await pool.query(`SELECT m.*, ${USER_STATUS_SQL} AS user_status FROM members m WHERE m.id = $1`, [req.params.id])).rows[0];
  if (!m) throw new HttpError(404, 'Member not found');
  const users = (await pool.query(
    `SELECT id, email, name, role, is_active, last_login_at, created_at,
            CASE WHEN password_hash IS NOT NULL THEN 'active' WHEN invite_token_hash IS NOT NULL THEN 'invited' ELSE 'none' END AS user_status,
            invite_expires_at
       FROM users WHERE member_id = $1 ORDER BY created_at`, [m.id])).rows;
  const charters = (await pool.query(
    `SELECT c.id, c.charter_no, c.status, c.starts_on, c.ends_on, c.pax, a.registration, a.type AS aircraft_type
       FROM charters c JOIN aircraft a ON a.id = c.aircraft_id
      WHERE c.member_id = $1 ORDER BY c.starts_on DESC LIMIT 10`, [m.id])).rows;
  const quotes = (await pool.query(
    `SELECT q.id, q.quote_no, q.status, q.total, q.valid_until, q.created_at, q.request_id, r.request_no
       FROM quotes q JOIN quote_requests r ON r.id = q.request_id
      WHERE q.member_id = $1 ORDER BY q.created_at DESC LIMIT 10`, [m.id])).rows;
  res.json({ ...m, users, charters, quotes });
});

router.post('/', requireRole('sales'), async (req, res) => {
  const data = validate(req.body || {}, false);
  data.member_type = data.member_type || 'individual';
  data.tier = data.tier || 'silver';
  data.status = data.status || 'active';
  const dup = await pool.query('SELECT 1 FROM members WHERE lower(email) = $1', [data.email]);
  if (dup.rows.length) throw new HttpError(409, 'A member with this email already exists');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const member_no = await nextMemberNo(client);
    const cols = ['member_no', ...Object.keys(data)];
    const vals = [member_no, ...Object.values(data)];
    const { rows } = await client.query(
      `INSERT INTO members (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals);
    await logEvent({ entity_type: 'member', entity_id: rows[0].id, action: 'created', actor_user_id: req.user.id, detail: { member_no } }, client);
    await client.query('COMMIT');
    res.status(201).json({ ...rows[0], user_status: 'none' });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.patch('/:id', requireRole('sales'), async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'Member not found');
  const data = validate(req.body || {}, true);
  if (!Object.keys(data).length) throw new HttpError(400, 'No fields to update');
  if (data.email) {
    const dup = await pool.query('SELECT 1 FROM members WHERE lower(email) = $1 AND id <> $2', [data.email, req.params.id]);
    if (dup.rows.length) throw new HttpError(409, 'A member with this email already exists');
  }
  const sets = Object.keys(data).map((k, i) => `${k} = $${i + 2}`);
  const { rows } = await pool.query(`UPDATE members SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [req.params.id, ...Object.values(data)]);
  if (!rows[0]) throw new HttpError(404, 'Member not found');
  await logEvent({ entity_type: 'member', entity_id: rows[0].id, action: 'updated', actor_user_id: req.user.id, detail: { fields: Object.keys(data) } });
  const us = (await pool.query(`SELECT ${USER_STATUS_SQL} AS user_status FROM members m WHERE m.id = $1`, [rows[0].id])).rows[0];
  res.json({ ...rows[0], user_status: us.user_status });
});

router.post('/:id/invite', requireRole('sales'), async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'Member not found');
  const m = (await pool.query('SELECT * FROM members WHERE id = $1', [req.params.id])).rows[0];
  if (!m) throw new HttpError(404, 'Member not found');
  if (m.status !== 'active') throw new HttpError(409, 'Member is inactive');
  let u = (await pool.query('SELECT * FROM users WHERE member_id = $1 ORDER BY created_at LIMIT 1', [m.id])).rows[0];
  if (!u) {
    const clash = (await pool.query('SELECT id, member_id FROM users WHERE lower(email) = lower($1)', [m.email])).rows[0];
    if (clash) throw new HttpError(409, 'A user with this email already exists');
    u = (await pool.query(
      "INSERT INTO users (email, name, role, member_id) VALUES ($1,$2,'member',$3) RETURNING *",
      [m.email.toLowerCase(), m.contact_name, m.id])).rows[0];
  }
  const token = await issueInvite(u.id);
  const invite_url = `${APP_URL()}/invite/${token}`;
  await logEvent({ entity_type: 'member', entity_id: m.id, action: 'invited', actor_user_id: req.user.id, detail: { user_id: u.id } });
  await sendInvite({ to: u.email, name: u.name, inviteUrl: invite_url });
  res.json({ invite_url });
});

module.exports = router;
