const { pool } = require('../db');
const { asyncRouter, HttpError, isUuid } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { logEvent } = require('../lib/events');
const { sendInvite, APP_URL } = require('../lib/email');
const { issueInvite } = require('./auth');

const router = asyncRouter();
router.use(requireRole('admin'));

const STAFF_ROLES = ['admin', 'sales', 'ops', 'pilot'];
const SELECT = `SELECT u.id, u.email, u.name, u.role, u.member_id, u.is_active, u.last_login_at, u.created_at, u.invite_expires_at,
  m.member_no, m.contact_name AS member_name,
  CASE WHEN u.password_hash IS NOT NULL THEN 'active' WHEN u.invite_token_hash IS NOT NULL THEN 'invited' ELSE 'none' END AS user_status,
  (SELECT cm.id FROM crew_members cm WHERE cm.user_id = u.id LIMIT 1) AS crew_member_id
  FROM users u LEFT JOIN members m ON m.id = u.member_id`;

router.get('/', async (req, res) => {
  const { rows } = await pool.query(`${SELECT} ORDER BY u.role, u.email`);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name = String(req.body?.name || '').trim();
  const role = String(req.body?.role || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'A valid email is required');
  if (!name) throw new HttpError(400, 'name is required');
  if (!STAFF_ROLES.includes(role)) throw new HttpError(400, `role must be one of ${STAFF_ROLES.join(', ')}`);
  const dup = await pool.query('SELECT 1 FROM users WHERE lower(email) = $1', [email]);
  if (dup.rows.length) throw new HttpError(409, 'A user with this email already exists');
  const ins = (await pool.query('INSERT INTO users (email, name, role) VALUES ($1,$2,$3) RETURNING id', [email, name, role])).rows[0];
  const token = await issueInvite(ins.id);
  const invite_url = `${APP_URL()}/invite/${token}`;
  await logEvent({ entity_type: 'user', entity_id: ins.id, action: 'created', actor_user_id: req.user.id, detail: { role } });
  await sendInvite({ to: email, name, inviteUrl: invite_url });
  const user = (await pool.query(`${SELECT} WHERE u.id = $1`, [ins.id])).rows[0];
  res.status(201).json({ user, invite_url });
});

router.patch('/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'User not found');
  const cur = (await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id])).rows[0];
  if (!cur) throw new HttpError(404, 'User not found');
  const { name, role, is_active } = req.body || {};
  const sets = [];
  const vals = [];
  if (name !== undefined) {
    if (!String(name).trim()) throw new HttpError(400, 'name cannot be empty');
    vals.push(String(name).trim()); sets.push(`name = $${vals.length}`);
  }
  if (role !== undefined) {
    if (cur.role === 'member' && role !== 'member') throw new HttpError(400, 'Member users cannot be given a staff role');
    if (cur.role !== 'member' && !STAFF_ROLES.includes(role)) throw new HttpError(400, `role must be one of ${STAFF_ROLES.join(', ')}`);
    if (cur.id === req.user.id && role !== 'admin') throw new HttpError(409, 'You cannot remove your own admin role');
    vals.push(role); sets.push(`role = $${vals.length}`);
  }
  if (is_active !== undefined) {
    if (typeof is_active !== 'boolean') throw new HttpError(400, 'is_active must be boolean');
    if (cur.id === req.user.id && !is_active) throw new HttpError(409, 'You cannot deactivate yourself');
    vals.push(is_active); sets.push(`is_active = $${vals.length}`);
  }
  if (!sets.length) throw new HttpError(400, 'No fields to update');
  vals.push(cur.id);
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  await logEvent({ entity_type: 'user', entity_id: cur.id, action: 'updated', actor_user_id: req.user.id, detail: { name, role, is_active } });
  res.json((await pool.query(`${SELECT} WHERE u.id = $1`, [cur.id])).rows[0]);
});

router.post('/:id/invite', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'User not found');
  const u = (await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id])).rows[0];
  if (!u) throw new HttpError(404, 'User not found');
  if (!u.is_active) throw new HttpError(409, 'User is inactive');
  const token = await issueInvite(u.id);
  const invite_url = `${APP_URL()}/invite/${token}`;
  await logEvent({ entity_type: 'user', entity_id: u.id, action: 'invited', actor_user_id: req.user.id });
  await sendInvite({ to: u.email, name: u.name, inviteUrl: invite_url });
  res.json({ invite_url });
});

module.exports = router;
