require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { version: APP_VERSION } = require('../package.json');

// Fail closed: the dev fallback secret is only allowed when NODE_ENV is explicitly
// development or test. A deployment that forgets NODE_ENV must not sign tokens
// with a secret that is published in this repository.
const DEV_ENV = ['development', 'test'].includes(process.env.NODE_ENV);
if (!process.env.JWT_SECRET && !DEV_ENV) {
  console.error('FATAL: JWT_SECRET must be set (only NODE_ENV=development/test may run without it). Refusing to start.');
  process.exit(1);
}
if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32 && !DEV_ENV) {
  console.error('FATAL: JWT_SECRET must be at least 32 characters. Refusing to start.');
  process.exit(1);
}

// v1.2 payments: refuse to start with an unusable provider configuration (e.g. razorpay without keys).
const { configError: paymentsConfigError, providerName } = require('./lib/payments');
if (paymentsConfigError()) {
  console.error(`FATAL: ${paymentsConfigError()}. Refusing to start.`);
  process.exit(1);
}

const { pool } = require('./db');
const { authenticate } = require('./middleware/auth');

const isDevLike = () => ['development', 'test'].includes(process.env.NODE_ENV);

const app = express();
app.set('trust proxy', 1); // Railway reverse proxy → correct client IP for rate limiting
const PORT = process.env.PORT || 4000;

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

const allowedOrigins = [
  'http://localhost:5173',
  ...(process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
];
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl, health checks, server-to-server
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Disposition'],
}));

// Razorpay webhooks are verified against the RAW body, so this path gets express.raw BEFORE express.json.
app.use('/api/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

// Keyed by IP + email: behind the Vercel /api rewrite many users can share an
// edge IP, so a per-IP-only limit would lock out everyone at a demo or an office.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip || '')}:${String(req.body?.email || '').toLowerCase().trim()}`,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isDevLike,
});
const inviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isDevLike,
});
// Lister self sign-up: 5 per hour per IP (v1.3).
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many sign-ups from this network. Please try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isDevLike,
});
// Public empty-leg booking requests: 5 per hour per IP + email (SPEC v1.1).
const publicRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip || '')}:${String(req.body?.email || '').toLowerCase().trim()}`,
  message: { error: 'Too many requests. Please try again in an hour or contact us directly.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isDevLike,
});
// Public read endpoints: generous per-IP cap on top of the global API limiter.
const publicReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isDevLike,
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isDevLike,
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok', version: APP_VERSION });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'unreachable', error: err.message, version: APP_VERSION });
  }
});

app.use('/api', apiLimiter);

// Public auth endpoints
const authRoutes = require('./routes/auth');
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/accept-invite', inviteLimiter);
app.use('/api/auth/invite', inviteLimiter);
app.post('/api/auth/register', registerLimiter);
app.use('/api/auth', authRoutes);

// Public empty-leg deals (no auth; whitelisted fields only)
app.post('/api/public/empty-legs/:id/request', publicRequestLimiter);
app.use('/api/public', publicReadLimiter);
app.use('/api/public/empty-legs', require('./routes/publicEmptyLegs'));

// Payment provider webhooks (no auth; HMAC-verified raw body)
const paymentsRoutes = require('./routes/payments');
app.post('/api/payments/webhook/razorpay', paymentsRoutes.webhookHandler);

// Everything else requires a valid JWT
const ref = require('./routes/reference');
const mount = (path, router) => app.use(path, authenticate, router);
mount('/api/members', require('./routes/members'));
mount('/api/users', require('./routes/users'));
mount('/api/airports', ref.airports);
mount('/api/aircraft', ref.aircraft);
mount('/api/crew', ref.crew);
mount('/api/maintenance', ref.maintenance);
mount('/api/settings', ref.settings);
mount('/api/quote-requests', require('./routes/quoteRequests'));
mount('/api/quotes', require('./routes/quotes'));
mount('/api/charters', require('./routes/charters'));
mount('/api/pilot', require('./routes/pilot'));
mount('/api/invoices', require('./routes/invoices'));
mount('/api/dashboard', require('./routes/dashboard'));
mount('/api/empty-legs', require('./routes/emptyLegs'));
mount('/api/lister', require('./routes/lister'));
mount('/api/listers', require('./routes/listers'));
mount('/api/payments', paymentsRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler: HttpError/pricing errors carry .status; anything else is a 500.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(`[ERROR] ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message, ...(err.extra || {}) });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Meridian Charters API v${APP_VERSION} listening on :${PORT} (payments: ${providerName()})`));
  // v1.2: payment deadlines + reminders every 5 minutes (idempotent; safe with several instances).
  require('./lib/payments/deadlines').startDeadlineJob();
}

module.exports = app;
