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
  empty_leg_discount_pct: '60',
  empty_leg_auto_publish: 'false',
  empty_leg_min_notice_hours: '6',
  payment_due_hours_before_departure: '24',
  refund_full_days: '7',
  refund_half_hours: '48',
  refund_half_pct: '50',
  empty_leg_payment_window_hours: '2',
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
  quote_id         UUID UNIQUE REFERENCES quotes(id),
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

// v1.1 — Empty legs. Written to upgrade an existing v1.0 database in place:
// every statement is idempotent (IF NOT EXISTS / DROP NOT NULL / guarded constraints).
const SCHEMA_V11 = `
CREATE TABLE IF NOT EXISTS empty_legs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  leg_no            TEXT UNIQUE NOT NULL,
  source_charter_id UUID REFERENCES charters(id),
  source_leg        TEXT CHECK (source_leg IN ('positioning_out','positioning_back')),
  aircraft_id       UUID NOT NULL REFERENCES aircraft(id),
  from_code         TEXT NOT NULL REFERENCES airports(code),
  to_code           TEXT NOT NULL REFERENCES airports(code),
  depart_earliest   TIMESTAMPTZ NOT NULL,
  depart_latest     TIMESTAMPTZ NOT NULL,
  flight_hours      NUMERIC(5,1) NOT NULL,
  distance_nm       INT NOT NULL,
  seats             INT NOT NULL,
  list_price_inr    NUMERIC(14,2) NOT NULL,
  price_inr         NUMERIC(14,2) NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','booked','withdrawn','expired')),
  notes             TEXT,
  published_at      TIMESTAMPTZ,
  booked_at         TIMESTAMPTZ,
  withdrawn_reason  TEXT,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (depart_latest >= depart_earliest)
);
CREATE INDEX IF NOT EXISTS idx_empty_legs_status ON empty_legs(status, depart_earliest);
CREATE INDEX IF NOT EXISTS idx_empty_legs_source ON empty_legs(source_charter_id);
-- one generated leg per charter + positioning direction
CREATE UNIQUE INDEX IF NOT EXISTS uq_empty_legs_source_leg ON empty_legs(source_charter_id, source_leg) WHERE source_charter_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS empty_leg_bookings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_no    TEXT UNIQUE NOT NULL,
  empty_leg_id  UUID NOT NULL REFERENCES empty_legs(id),
  member_id     UUID REFERENCES members(id),
  channel       TEXT NOT NULL CHECK (channel IN ('member','public')),
  guest_name    TEXT NOT NULL,
  guest_email   TEXT NOT NULL,
  guest_phone   TEXT,
  guest_company TEXT,
  pax           INT NOT NULL CHECK (pax > 0),
  message       TEXT,
  status        TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','confirmed','rejected','cancelled')),
  charter_id    UUID REFERENCES charters(id),
  decided_by    UUID REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  reject_reason TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_elb_leg ON empty_leg_bookings(empty_leg_id, status);

ALTER TABLE charters ALTER COLUMN quote_id DROP NOT NULL;
ALTER TABLE charters ADD COLUMN IF NOT EXISTS empty_leg_id UUID REFERENCES empty_legs(id);
-- an empty leg is sold once
CREATE UNIQUE INDEX IF NOT EXISTS uq_charters_empty_leg ON charters(empty_leg_id) WHERE empty_leg_id IS NOT NULL;

ALTER TABLE members ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'invited';

DO $$ BEGIN
  ALTER TABLE members ADD CONSTRAINT members_source_check CHECK (source IN ('invited','empty_leg_public'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE charters ADD CONSTRAINT charters_origin_check CHECK (num_nonnulls(quote_id, empty_leg_id) = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`;

// v1.2 — Payments (Razorpay). Upgrades a v1.1 database in place; every statement is idempotent.
const SCHEMA_V12 = `
CREATE TABLE IF NOT EXISTS payment_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        UUID NOT NULL REFERENCES invoices(id),
  provider          TEXT NOT NULL CHECK (provider IN ('razorpay','mock')),
  provider_order_id TEXT UNIQUE NOT NULL,
  amount            NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  status            TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','expired','failed')),
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_orders_invoice ON payment_orders(invoice_id, status);

CREATE TABLE IF NOT EXISTS virtual_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id      UUID UNIQUE NOT NULL REFERENCES members(id),
  provider       TEXT NOT NULL CHECK (provider IN ('razorpay','mock')),
  provider_va_id TEXT UNIQUE NOT NULL,
  account_number TEXT NOT NULL,
  ifsc           TEXT NOT NULL,
  bank_name      TEXT,
  account_name   TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id          UUID NOT NULL REFERENCES invoices(id),
  provider            TEXT NOT NULL CHECK (provider IN ('razorpay','mock','manual')),
  provider_payment_id TEXT UNIQUE NOT NULL,
  provider_order_id   TEXT,
  virtual_account_id  UUID REFERENCES virtual_accounts(id),
  method              TEXT NOT NULL CHECK (method IN ('card','upi','netbanking','wallet','bank_transfer','emi','other')),
  amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  fee                 NUMERIC(14,2) NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'captured' CHECK (status IN ('captured','refunded','partially_refunded')),
  captured_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw                 JSONB,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_captured ON payments(captured_at);

CREATE TABLE IF NOT EXISTS refunds (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id         UUID NOT NULL REFERENCES payments(id),
  provider_refund_id TEXT UNIQUE,
  amount             NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  reason             TEXT,
  policy_pct         NUMERIC(5,2),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','failed')),
  error              TEXT,
  created_by         UUID REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds(payment_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     TEXT NOT NULL,
  event_id     TEXT UNIQUE NOT NULL,
  event_type   TEXT,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_invoices_due ON invoices(status, due_at);

-- Extend the status CHECK only when the current definition lacks the new states (no rewrite on reruns).
DO $$
DECLARE def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'invoices'::regclass AND conname = 'invoices_status_check';
  IF def IS NULL OR def NOT LIKE '%partially_paid%' OR def NOT LIKE '%refunded%' THEN
    ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
    ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
      CHECK (status IN ('unpaid','partially_paid','paid','cancelled','refunded'));
  END IF;
END $$;

-- Back-fill: invoices already paid (manual mark-paid before v1.2) were paid in full.
UPDATE invoices SET amount_paid = total WHERE status = 'paid' AND amount_paid = 0;

-- Back-fill due_at = first passenger departure − 24h. Open invoices whose deadline would already have
-- passed at upgrade time get a grace deadline (24h from now, but never after departure) instead of being
-- auto-cancelled by the first run of the deadline job.
UPDATE invoices i SET due_at = CASE
    WHEN i.status IN ('unpaid','partially_paid') AND (c.legs->0->>'depart_at')::timestamptz - interval '24 hours' <= now()
      THEN LEAST(now() + interval '24 hours', (c.legs->0->>'depart_at')::timestamptz)
    ELSE (c.legs->0->>'depart_at')::timestamptz - interval '24 hours'
  END
  FROM charters c
 WHERE c.id = i.charter_id AND i.due_at IS NULL AND c.legs->0->>'depart_at' IS NOT NULL;
`;

// v1.3 — Listers: charter operators, travel agents and private flyers who sign up themselves and post
// their own empty legs. Upgrades a v1.2 database in place; every statement is idempotent.
const SCHEMA_V13 = `
DO $$
DECLARE def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'users'::regclass AND conname = 'users_role_check';
  IF def IS NULL OR def NOT LIKE '%lister%' THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','sales','ops','pilot','member','lister'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS listers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID UNIQUE NOT NULL REFERENCES users(id),
  lister_type     TEXT NOT NULL CHECK (lister_type IN ('operator','agent','flyer')),
  company         TEXT,
  phone           TEXT NOT NULL,
  city            TEXT,
  gstin           TEXT,
  nsop_permit_no  TEXT,
  about           TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','suspended')),
  decided_by      UUID REFERENCES users(id),
  decided_at      TIMESTAMPTZ,
  decision_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_listers_status ON listers(status, created_at);

-- Lister legs fly aircraft outside the Meridian fleet: no aircraft_id, free-text aircraft details instead.
ALTER TABLE empty_legs ALTER COLUMN aircraft_id DROP NOT NULL;
ALTER TABLE empty_legs ADD COLUMN IF NOT EXISTS lister_id UUID REFERENCES listers(id);
ALTER TABLE empty_legs ADD COLUMN IF NOT EXISTS ext_aircraft_type TEXT;
ALTER TABLE empty_legs ADD COLUMN IF NOT EXISTS ext_registration TEXT;
ALTER TABLE empty_legs ADD COLUMN IF NOT EXISTS operator_name TEXT;
CREATE INDEX IF NOT EXISTS idx_empty_legs_lister ON empty_legs(lister_id, status);

DO $$ BEGIN
  ALTER TABLE empty_legs ADD CONSTRAINT empty_legs_owner_check CHECK (num_nonnulls(aircraft_id, lister_id) = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`;

// v1.4 — Charter operator directory: the DGCA list of non-scheduled operators (NSOP holders) and their
// registered aircraft, imported from the published list. Enrichment columns are ours and never overwritten.
const SCHEMA_V14 = `
CREATE TABLE IF NOT EXISTS charter_operators (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aop_no          TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  address         TEXT,
  pincode         TEXT,
  phone           TEXT,
  fax             TEXT,
  emails          TEXT[] NOT NULL DEFAULT '{}',
  aop_valid_until DATE,
  fleet_type      TEXT CHECK (fleet_type IN ('fixed_wing','rotary_wing','mixed','hot_air_balloon')),
  aircraft_count  INT NOT NULL DEFAULT 0,
  source          TEXT NOT NULL DEFAULT 'dgca_nsop',
  source_as_of    DATE,
  source_sno      INT,
  in_latest_list  BOOLEAN NOT NULL DEFAULT true,
  -- enrichment (filled in later by our team; the import never touches these)
  website         TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_charter_operators_name ON charter_operators(lower(name));

CREATE TABLE IF NOT EXISTS operator_aircraft (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id   UUID NOT NULL REFERENCES charter_operators(id) ON DELETE CASCADE,
  registration  TEXT UNIQUE NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('fixed_wing','rotary_wing','hot_air_balloon')),
  model         TEXT NOT NULL,
  seats         INT,
  role          TEXT NOT NULL DEFAULT 'passenger' CHECK (role IN ('passenger','aerial_work','cargo')),
  seats_raw     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_operator_aircraft_operator ON operator_aircraft(operator_id);

CREATE TABLE IF NOT EXISTS data_imports (
  name        TEXT PRIMARY KEY,
  version     TEXT NOT NULL,
  detail      JSONB,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function initDB() {
  await pool.query(SCHEMA);
  await pool.query(SCHEMA_V11);
  await pool.query(SCHEMA_V12);
  await pool.query(SCHEMA_V13);
  await pool.query(SCHEMA_V14);
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [key, value]);
  }
  console.log('[DB] schema ready');
}

/** Settings as { key: number|string } (numeric strings become numbers). */
async function getSettings(db = pool) {
  const { rows } = await db.query('SELECT key, value FROM settings');
  const out = {};
  const conv = (v) => (v !== '' && !isNaN(Number(v)) ? Number(v) : v);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) out[k] = conv(v);
  for (const r of rows) out[r.key] = conv(r.value);
  return out;
}

module.exports = { pool, initDB, withTransaction, getSettings, DEFAULT_SETTINGS };
