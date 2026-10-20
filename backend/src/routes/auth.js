const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool, withTransaction } = require('../db');
const { asyncRouter, HttpError } = require('../lib/http');
const { authenticate, signToken } = require('../middleware/auth');
const { logEvent } = require('../lib/events');
const { sendListerWelcome, sendListerAdminNotice } = require('../lib/email');

const router = asyncRouter();

const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

async function loadUser(id, db = pool) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name, u.role, u.member_id, m.member_no, l.id AS lister_id, l.lister_type, l.status AS lister_status, l.company AS lister_company
       FROM users u LEFT JOIN members m ON m.id = u.member_id LEFT JOIN listers l ON l.user_id = u.id WHERE u.id = $1`,
    [id]
  );
  return rows[0] ? toUser(rows[0]) : null;
}

function toUser(u) {
  const out = { id: u.id, email: u.email, name: u.name, role: u.role, member_id: u.member_id || null };
  if (u.member_no) out.member_no = u.member_no;
  if (u.lister_id) Object.assign(out, { lister_id: u.lister_id, lister_type: u.lister_type, lister_status: u.lister_status, lister_company: u.lister_company || null });
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

// ── Self sign-up for listers (charter operators, travel agents, private flyers) ──
const LISTER_TYPES = ['operator', 'agent', 'flyer'];
const EMAIL_RE = /^[^@\s<>"',;]+@[^@\s<>"',;]+\.[^@\s<>"',;]{2,}$/;
const PHONE_RE = /^\+?[0-9][0-9 ()-]{6,19}$/;
const GSTIN_RE = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/;
// PAN: 5 letters, 4 digits, 1 letter; the 4th letter is the holder type (P person, C company, F firm, …).
const PAN_RE = /^[A-Z]{3}[ABCFGHLJPTK][A-Z][0-9]{4}[A-Z]$/;
// TAN: 4 letters, 5 digits, 1 letter.
const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
const PAN_REQUIRED = ['operator', 'agent'];
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/** Validate lister profile fields. partial = only check fields that are present (profile edits). */
function listerProfile(b, { partial = false, type, current = {} } = {}) {
  const out = {};
  const has = (k) => !partial || b[k] !== undefined;
  const lister_type = type || b.lister_type;
  if (has('company')) out.company = clean(b.company, 160) || null;
  if (has('phone')) {
    out.phone = clean(b.phone, 30);
    if (!PHONE_RE.test(out.phone) || out.phone.replace(/\D/g, '').length < 7) throw new HttpError(400, 'Please enter a valid phone number');
  }
  if (has('city')) out.city = clean(b.city, 80) || null;
  if (has('gstin')) {
    out.gstin = clean(b.gstin, 15).toUpperCase() || null;
    if (out.gstin && !GSTIN_RE.test(out.gstin)) throw new HttpError(400, 'GSTIN must be 15 characters, e.g. 27ABCDE1234F1Z5');
  }
  if (has('pan')) {
    out.pan = clean(b.pan, 20).replace(/\s/g, '').toUpperCase() || null;
    if (out.pan && !PAN_RE.test(out.pan)) throw new HttpError(400, 'PAN must be 10 characters, e.g. ABCDE1234F');
  }
  if (has('tan')) {
    out.tan = clean(b.tan, 20).replace(/\s/g, '').toUpperCase() || null;
    if (out.tan && !TAN_RE.test(out.tan)) throw new HttpError(400, 'TAN must be 10 characters, e.g. MUMA12345B');
  }
  if (has('nsop_permit_no')) out.nsop_permit_no = clean(b.nsop_permit_no, 60) || null;
  if (has('about')) out.about = clean(b.about, 1000) || null;
  if (!partial || out.company !== undefined) {
    if (['operator', 'agent'].includes(lister_type) && !out.company) throw new HttpError(400, 'Company name is required for operators and travel agents');
  }
  if (!partial || out.nsop_permit_no !== undefined) {
    if (lister_type === 'operator' && !out.nsop_permit_no) throw new HttpError(400, 'Charter operators must give their DGCA NSOP permit number');
  }
  if (!partial || out.pan !== undefined) {
    if (PAN_REQUIRED.includes(lister_type) && !out.pan) throw new HttpError(400, 'PAN is required for operators and travel agents');
  }
  // A GSTIN embeds the holder's PAN (characters 3–12): the two must agree.
  const pan = out.pan !== undefined ? out.pan : current.pan;
  const gstin = out.gstin !== undefined ? out.gstin : current.gstin;
  if (pan && gstin && gstin.slice(2, 12) !== pan) throw new HttpError(400, 'The PAN does not match the PAN inside your GSTIN (characters 3–12)');
  return out;
}

router.post('/register', async (req, res) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  // Honeypot: real browsers leave the hidden "website" field empty.
  if (b.website !== undefined && b.website !== null && String(b.website).trim() !== '') return res.status(202).json({ ok: true });
  const name = clean(b.name, 120);
  const email = clean(b.email, 254).toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  const lister_type = String(b.lister_type || '');
  if (!LISTER_TYPES.includes(lister_type)) throw new HttpError(400, 'Choose whether you are a charter operator, travel agent or private flyer');
  if (name.length < 2) throw new HttpError(400, 'Please enter your full name');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email address');
  if (password.length < 10) throw new HttpError(400, 'Password must be at least 10 characters');
  if (b.accept_terms !== true) throw new HttpError(400, 'Please accept the lister terms to continue');
  const profile = listerProfile(b, { type: lister_type });

  const created = await withTransaction(async (client) => {
    const dup = await client.query('SELECT 1 FROM users WHERE lower(email) = $1', [email]);
    if (dup.rows.length) throw new HttpError(409, 'An account with this email already exists — sign in instead');
    const hash = await bcrypt.hash(password, 10);
    const u = (await client.query(
      `INSERT INTO users (email, name, role, password_hash, last_login_at) VALUES ($1,$2,'lister',$3, now()) RETURNING id`,
      [email, name, hash])).rows[0];
    const l = (await client.query(
      `INSERT INTO listers (user_id, lister_type, company, phone, city, gstin, pan, tan, nsop_permit_no, about)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [u.id, lister_type, profile.company, profile.phone, profile.city, profile.gstin, profile.pan, profile.tan, profile.nsop_permit_no, profile.about])).rows[0];
    await logEvent({ entity_type: 'lister', entity_id: l.id, action: 'registered', actor_user_id: u.id, detail: { lister_type } }, client);
    return { userId: u.id, lister: l };
  });
  const user = await loadUser(created.userId);
  await sendListerWelcome({ to: email, name });
  for (const to of await adminRecipients()) {
    await sendListerAdminNotice({ to, lister: { ...created.lister, name, email } });
  }
  res.status(201).json({ token: signToken(user), user });
});

/** Who reviews new listers: LISTER_REVIEW_EMAIL (comma-separated) or all active admin and sales users. */
async function adminRecipients() {
  const env = String(process.env.LISTER_REVIEW_EMAIL || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (env.length) return env;
  const { rows } = await pool.query(`SELECT email FROM users WHERE role IN ('admin','sales') AND is_active ORDER BY role, email`);
  return rows.map((r) => r.email);
}

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
module.exports.listerProfile = listerProfile;
module.exports.LISTER_TYPES = LISTER_TYPES;
