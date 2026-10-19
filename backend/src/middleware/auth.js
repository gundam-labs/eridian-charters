const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || (['development', 'test'].includes(process.env.NODE_ENV) ? 'meridian-dev-only-secret' : null);
const TOKEN_TTL = '12h';

const STAFF = ['admin', 'sales', 'ops'];
const ROLES = ['admin', 'sales', 'ops', 'pilot', 'member'];

const signToken = (user) => jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });

/** Verify the Bearer JWT and load the (active) user. Sets req.user = { id, email, name, role, member_id, member_no }. */
async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  let decoded;
  try {
    decoded = jwt.verify(header.slice(7), JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: err.name === 'TokenExpiredError' ? 'Session expired' : 'Invalid token' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.member_id, u.is_active, m.member_no
         FROM users u LEFT JOIN members m ON m.id = u.member_id
        WHERE u.id = $1`,
      [decoded.id]
    );
    const u = rows[0];
    if (!u || !u.is_active) return res.status(401).json({ error: 'User not found or inactive' });
    if (u.role === 'member' && !u.member_id) return res.status(401).json({ error: 'Member account not linked' });
    req.user = { id: u.id, email: u.email, name: u.name, role: u.role, member_id: u.member_id, member_no: u.member_no || undefined };
    next();
  } catch (err) {
    next(err);
  }
}

/** Allow only the listed roles. Admin is always allowed (admin can do everything staff can). */
function requireRole(...roles) {
  const allowed = roles.flat();
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.role === 'admin' || allowed.includes(req.user.role)) return next();
    return res.status(403).json({ error: 'You do not have permission to do this' });
  };
}

const isStaff = (user) => STAFF.includes(user?.role);

module.exports = { authenticate, requireRole, signToken, isStaff, STAFF, ROLES, JWT_SECRET };
