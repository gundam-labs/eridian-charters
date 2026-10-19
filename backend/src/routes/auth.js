const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { asyncRouter, HttpError } = require('../lib/http');
const { authenticate, signToken } = require('../middleware/auth');
const { logEvent } = require('../lib/events');

const router = asyncRouter();

const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

async function loadUser(id, db = pool) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name, u.role, u.member_id, m.member_no
       FROM users u LEFT JOIN members m ON m.id = u.member_id WHERE u.id = $1`,
    [id]
  );
  return rows[0] ? toUser(rows[0]) : null;
}

function toUser(u) {
  const out = { id: u.id, email: u.email, name: u.name, role: u.role, member_id: u.member_id || null };
  if (u.member_no) out.member_no = u.member_no;
  return out;
}

router.post('/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) throw new HttpError(400, 'Email and password are required');
  const { rows } = await pool.query('SELECT * FROM users WHERE lower(email) = $1', [email]);
  const u = rows[0];
  const ok = u && u.is_active && u.password_hash && (await bcrypt.compare(password, u.password_hash));
  if (!ok) throw new HttpError(401, 'Invalid email or password');
  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
  const user = await loadUser(u.id);
  res.json({ token: signToken(user), user });
});

router.get('/me', authenticate, async (req, res) => {
  res.json(await loadUser(req.user.id));
});

async function findInvite(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE invite_token_hash = $1 AND invite_expires_at > now() AND is_active = true',
    [hashToken(token)]
  );
  return rows[0] || null;
}

router.get('/invite/:token', async (req, res) => {
  const u = await findInvite(req.params.token);
  if (!u) throw new HttpError(404, 'Invite link is invalid or has expired');
  res.json({ email: u.email, name: u.name });
});

router.post('/accept-invite', async (req, res) => {
  const { token, password } = req.body || {};
  if (typeof password !== 'string' || password.length < 10) throw new HttpError(400, 'Password must be at least 10 characters');
  const u = await findInvite(token);
  if (!u) throw new HttpError(404, 'Invite link is invalid or has expired');
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    'UPDATE users SET password_hash = $1, invite_token_hash = NULL, invite_expires_at = NULL, last_login_at = now() WHERE id = $2',
    [hash, u.id]
  );
  await logEvent({ entity_type: 'user', entity_id: u.id, action: 'invite_accepted', actor_user_id: u.id });
  const user = await loadUser(u.id);
  res.json({ token: signToken(user), user });
});

/** Create a fresh 72h invite token for a user; returns the raw token. */
async function issueInvite(userId, db = pool) {
  const raw = crypto.randomBytes(32).toString('base64url');
  await db.query(
    "UPDATE users SET invite_token_hash = $1, invite_expires_at = now() + interval '72 hours' WHERE id = $2",
    [hashToken(raw), userId]
  );
  return raw;
}

module.exports = router;
module.exports.issueInvite = issueInvite;
module.exports.toUser = toUser;
