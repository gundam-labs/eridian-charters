const { Pool, types } = require('pg');
const { resolveSsl } = require('../lib/dbSsl');

// DATE (oid 1082) stays a 'YYYY-MM-DD' string — never a JS Date at server-local midnight.
types.setTypeParser(1082, (val) => val);
// NUMERIC (oid 1700) → JS number. All money is NUMERIC(14,2), well within double precision.
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveSsl(process.env.DATABASE_URL),
  max: parseInt(process.env.DB_POOL_SIZE || '10', 10),
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => console.error('[DB] idle client error:', err.message));

/** Run fn(client) inside BEGIN/COMMIT; ROLLBACK on any error. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

const DEFAULT_SETTINGS = {
  gst_rate_pct: '12', // PLACEHOLDER — confirm with accountant
  night_halt_fee_inr: '25000',
  quote_validity_hours: '48',
  invoice_due_days: '7',
  positioning_rate_pct: '100',
  taxi_allowance_hours: '0.3',
  manifest_cutoff_hours: '24',
};

// Idempotent schema. Safe to run on every deploy.
const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS members (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_no     TEXT UNIQUE NOT NULL,
  member_type   TEXT NOT NULL DEFAULT 'individual' CHECK (member_type IN ('individual','corporate','agent')),
  contact_name  TEXT NOT NULL,
  company       TEXT,
  city          TEXT,
  email         TEXT UNIQUE NOT NULL,
  phone         TEXT,
  gstin         TEXT,
  tier          TEXT NOT NULL DEFAULT 'silver' CHECK (tier IN ('silver','gold','platinum')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  member_since  TEXT,
  past_charters INT NOT NULL DEFAULT 0,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('admin','sales','ops','pilot','member')),
  member_id         UUID REFERENCES members(id),
  password_hash     TEXT,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  invite_token_hash TEXT,
  invite_expires_at TIMESTAMPTZ,
  last_login_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_member ON users(member_id);
CREATE INDEX IF NOT EXISTS idx_users_invite ON users(invite_token_hash);

CREATE TABLE IF NOT EXISTS airports (
  code             TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  city             TEXT NOT NULL,
  lat              NUMERIC(9,6) NOT NULL,
  lon              NUMERIC(9,6) NOT NULL,
  landing_fee_inr  NUMERIC(14,2) NOT NULL DEFAULT 0,
  handling_fee_inr NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS aircraft (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration     TEXT UNIQUE NOT NULL,
  type             TEXT NOT NULL,
  seats            INT NOT NULL CHECK (seats > 0),
  home_base        TEXT NOT NULL REFERENCES airports(code),
  cruise_speed_kts INT NOT NULL CHECK (cruise_speed_kts > 0),
  hourly_rate_inr  NUMERIC(14,2) NOT NULL,
  partner_name     TEXT,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crew_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  crew_role  TEXT NOT NULL CHECK (crew_role IN ('captain','first_officer','cabin_crew')),
  base       TEXT REFERENCES airports(code),
  licence_no TEXT,
  user_id    UUID REFERENCES users(id),
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crew_user ON crew_members(user_id);

CREATE TABLE IF NOT EXISTS quote_requests (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_no TEXT UNIQUE NOT NULL,
  member_id  UUID NOT NULL REFERENCES members(id),
  legs       JSONB NOT NULL,
  pax        INT NOT NULL,
  notes      TEXT,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','quoted','closed','cancelled')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qr_member ON quote_requests(member_id);

CREATE TABLE IF NOT EXISTS quotes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_no        TEXT UNIQUE NOT NULL,
  request_id      UUID NOT NULL REFERENCES quote_requests(id),
  member_id       UUID NOT NULL REFERENCES members(id),
  aircraft_id     UUID NOT NULL REFERENCES aircraft(id),
  legs            JSONB NOT NULL,
  positioning     JSONB NOT NULL DEFAULT '[]'::jsonb,
  line_items      JSONB NOT NULL DEFAULT '[]'::jsonb,
  adjustment_inr  NUMERIC(14,2) NOT NULL DEFAULT 0,
  adjustment_note TEXT,
  subtotal        NUMERIC(14,2) NOT NULL DEFAULT 0,
  gst_rate_pct    NUMERIC(5,2) NOT NULL DEFAULT 0,
  gst_amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
  total           NUMERIC(14,2) NOT NULL DEFAULT 0,
  starts_on       DATE,
  ends_on         DATE,
  valid_hours     INT,
  valid_until     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','declined','expired','withdrawn')),
  sent_at         TIMESTAMPTZ,
  decided_at      TIMESTAMPTZ,
  decline_reason  TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quotes_request ON quotes(request_id);
CREATE INDEX IF NOT EXISTS idx_quotes_member ON quotes(member_id);

CREATE TABLE IF NOT EXISTS charters (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  charter_no       TEXT UNIQUE NOT NULL,
  quote_id         UUID UNIQUE NOT NULL REFERENCES quotes(id),
  member_id        UUID NOT NULL REFERENCES members(id),
  aircraft_id      UUID NOT NULL REFERENCES aircraft(id),
  legs             JSONB NOT NULL,
  starts_on        DATE NOT NULL,
  ends_on          DATE NOT NULL,
  pax              INT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','confirmed','manifest_complete','flown','closed','cancelled')),
  captain_id       UUID REFERENCES crew_members(id),
  first_officer_id UUID REFERENCES crew_members(id),
  cabin_crew_id    UUID REFERENCES crew_members(id),
  ops_notes        TEXT,
  defects          TEXT,
  confirmed_at     TIMESTAMPTZ,
  flown_at         TIMESTAMPTZ,
  closed_at        TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ,
  cancel_reason    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_charters_member ON charters(member_id);
CREATE INDEX IF NOT EXISTS idx_charters_aircraft_dates ON charters(aircraft_id, starts_on, ends_on);

CREATE TABLE IF NOT EXISTS passengers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  charter_id  UUID NOT NULL REFERENCES charters(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  id_type     TEXT NOT NULL CHECK (id_type IN ('passport','aadhaar','driving_licence','voter_id','pan')),
  id_number   TEXT NOT NULL,
  nationality TEXT NOT NULL DEFAULT 'Indian',
  phone       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_passengers_charter ON passengers(charter_id);

CREATE TABLE IF NOT EXISTS invoices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no   TEXT UNIQUE NOT NULL,
  charter_id   UUID UNIQUE NOT NULL REFERENCES charters(id),
  member_id    UUID NOT NULL REFERENCES members(id),
  subtotal     NUMERIC(14,2) NOT NULL,
  gst_rate_pct NUMERIC(5,2) NOT NULL,
  gst_amount   NUMERIC(14,2) NOT NULL,
  total        NUMERIC(14,2) NOT NULL,
  issued_on    DATE NOT NULL,
  due_on       DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid','cancelled')),
  paid_on      DATE,
  payment_ref  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoices_member ON invoices(member_id);

CREATE TABLE IF NOT EXISTS maintenance_blocks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aircraft_id UUID NOT NULL REFERENCES aircraft(id),
  starts_on   DATE NOT NULL,
  ends_on     DATE NOT NULL,
  reason      TEXT,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS idx_maint_aircraft ON maintenance_blocks(aircraft_id, starts_on, ends_on);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sequences (
  name       TEXT PRIMARY KEY,
  year       INT NOT NULL,
  next       INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   TEXT NOT NULL,
  entity_id     UUID NOT NULL,
  action        TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id),
  detail        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS email_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email   TEXT NOT NULL,
  subject    TEXT,
  type       TEXT,
  status     TEXT NOT NULL CHECK (status IN ('sent','logged','failed')),
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function initDB() {
  await pool.query(SCHEMA);
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [key, value]);
  }
  console.log('[DB] schema ready');
}

/** Settings as { key: number|string } (numeric strings become numbers). */
async function getSettings(db = pool) {
  const { rows } = await db.query('SELECT key, value FROM settings');
  const out = {};
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) out[k] = Number(v);
  for (const r of rows) out[r.key] = r.value !== '' && !isNaN(Number(r.value)) ? Number(r.value) : r.value;
  return out;
}

module.exports = { pool, initDB, withTransaction, getSettings, DEFAULT_SETTINGS };
