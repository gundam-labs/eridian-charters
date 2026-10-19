/** Reference data: airports, aircraft (+availability), crew, maintenance, settings. */
const { pool, getSettings } = require('../db');
const { asyncRouter, HttpError, isUuid } = require('../lib/http');
const { requireRole, isStaff, STAFF } = require('../middleware/auth');
const { logEvent } = require('../lib/events');
const { publicAircraft } = require('../lib/serialize');
const { BUSY_STATUSES } = require('../lib/availability');
const { isDateStr, addDays, daysBetween } = require('../lib/time');

const num = (v, name, { min = -Infinity, int = false } = {}) => {
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) throw new HttpError(400, `${name} must be a valid ${int ? 'integer' : 'number'}`);
  return n;
};

// ── Airports ────────────────────────────────────────────────────────────────
const airports = asyncRouter();

airports.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM airports ORDER BY code');
  res.json(rows);
});

function airportData(b, partial) {
  const out = {};
  if (b.name !== undefined) { if (!String(b.name).trim()) throw new HttpError(400, 'name is required'); out.name = String(b.name).trim(); }
  if (b.city !== undefined) { if (!String(b.city).trim()) throw new HttpError(400, 'city is required'); out.city = String(b.city).trim(); }
  if (b.lat !== undefined) { out.lat = num(b.lat, 'lat'); if (Math.abs(out.lat) > 90) throw new HttpError(400, 'lat out of range'); }
  if (b.lon !== undefined) { out.lon = num(b.lon, 'lon'); if (Math.abs(out.lon) > 180) throw new HttpError(400, 'lon out of range'); }
  if (b.landing_fee_inr !== undefined) out.landing_fee_inr = num(b.landing_fee_inr, 'landing_fee_inr', { min: 0 });
  if (b.handling_fee_inr !== undefined) out.handling_fee_inr = num(b.handling_fee_inr, 'handling_fee_inr', { min: 0 });
  if (!partial) for (const f of ['name', 'city', 'lat', 'lon']) if (out[f] === undefined) throw new HttpError(400, `${f} is required`);
  return out;
}

airports.post('/', requireRole('admin'), async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new HttpError(400, 'code must be a 3-letter IATA code');
  const d = airportData(req.body || {}, false);
  const exists = await pool.query('SELECT 1 FROM airports WHERE code = $1', [code]);
  if (exists.rows.length) throw new HttpError(409, 'Airport already exists');
  const { rows } = await pool.query(
    'INSERT INTO airports (code, name, city, lat, lon, landing_fee_inr, handling_fee_inr) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [code, d.name, d.city, d.lat, d.lon, d.landing_fee_inr || 0, d.handling_fee_inr || 0]);
  await logEvent({ entity_type: 'airport', entity_id: '00000000-0000-0000-0000-000000000000', action: 'created', actor_user_id: req.user.id, detail: { code } });
  res.status(201).json(rows[0]);
});

airports.patch('/:code', requireRole('admin'), async (req, res) => {
  const code = String(req.params.code).toUpperCase();
  const d = airportData(req.body || {}, true);
  if (!Object.keys(d).length) throw new HttpError(400, 'No fields to update');
  const sets = Object.keys(d).map((k, i) => `${k} = $${i + 2}`);
  const { rows } = await pool.query(`UPDATE airports SET ${sets.join(', ')} WHERE code = $1 RETURNING *`, [code, ...Object.values(d)]);
  if (!rows[0]) throw new HttpError(404, 'Airport not found');
  await logEvent({ entity_type: 'airport', entity_id: '00000000-0000-0000-0000-000000000000', action: 'updated', actor_user_id: req.user.id, detail: { code, fields: Object.keys(d) } });
  res.json(rows[0]);
});

// ── Aircraft ────────────────────────────────────────────────────────────────
const aircraft = asyncRouter();

aircraft.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM aircraft ORDER BY registration');
  if (isStaff(req.user)) return res.json(rows);
  // members (and pilots): type/seats/home_base only — no rates, no partner
  res.json(rows.filter((a) => a.status === 'active').map(publicAircraft));
});

aircraft.get('/availability', requireRole(...STAFF), async (req, res) => {
  const { from, to } = req.query;
  if (!isDateStr(from) || !isDateStr(to)) throw new HttpError(400, 'from and to must be YYYY-MM-DD');
  const span = daysBetween(from, to) + 1;
  if (span < 1) throw new HttpError(400, 'to must be on or after from');
  if (span > 62) throw new HttpError(400, 'Maximum range is 62 days');
  const days = Array.from({ length: span }, (_, i) => addDays(from, i));
  const ac = (await pool.query('SELECT id, registration, type, seats, home_base, status FROM aircraft ORDER BY registration')).rows;
  const ch = (await pool.query(
    `SELECT c.id, c.aircraft_id, c.charter_no, c.status, c.starts_on, c.ends_on, m.contact_name
       FROM charters c JOIN members m ON m.id = c.member_id
      WHERE c.status = ANY($1) AND c.starts_on <= $3 AND c.ends_on >= $2`, [BUSY_STATUSES, from, to])).rows;
  const mb = (await pool.query(
    'SELECT id, aircraft_id, starts_on, ends_on, reason FROM maintenance_blocks WHERE starts_on <= $2 AND ends_on >= $1', [from, to])).rows;
  res.json({
    days,
    aircraft: ac.map((a) => ({
      ...a,
      cells: days.map((date) => {
        if (a.status === 'inactive') return { date, state: 'inactive', label: 'Inactive' };
        const m = mb.find((x) => x.aircraft_id === a.id && x.starts_on <= date && x.ends_on >= date);
        if (m) return { date, state: 'maintenance', ref: m.id, label: m.reason || 'Maintenance' };
        const c = ch.find((x) => x.aircraft_id === a.id && x.starts_on <= date && x.ends_on >= date);
        if (c) return { date, state: 'charter', ref: c.id, label: `${c.charter_no} · ${c.contact_name}` };
        return { date, state: 'free' };
      }),
    })),
  });
});

async function aircraftData(b, partial) {
  const out = {};
  if (b.registration !== undefined) {
    out.registration = String(b.registration).trim().toUpperCase();
    if (!/^VT-[A-Z]{3}$/.test(out.registration)) throw new HttpError(400, 'registration must look like VT-ABC');
  }
  if (b.type !== undefined) { if (!String(b.type).trim()) throw new HttpError(400, 'type is required'); out.type = String(b.type).trim(); }
  if (b.seats !== undefined) out.seats = num(b.seats, 'seats', { min: 1, int: true });
  if (b.cruise_speed_kts !== undefined) out.cruise_speed_kts = num(b.cruise_speed_kts, 'cruise_speed_kts', { min: 1, int: true });
  if (b.hourly_rate_inr !== undefined) out.hourly_rate_inr = num(b.hourly_rate_inr, 'hourly_rate_inr', { min: 0 });
  if (b.home_base !== undefined) {
    out.home_base = String(b.home_base).toUpperCase();
    const ok = await pool.query('SELECT 1 FROM airports WHERE code = $1', [out.home_base]);
    if (!ok.rows.length) throw new HttpError(400, `Unknown airport: ${out.home_base}`);
  }
  if (b.partner_name !== undefined) out.partner_name = b.partner_name || null;
  if (b.notes !== undefined) out.notes = b.notes || null;
  if (b.status !== undefined) {
    if (!['active', 'inactive'].includes(b.status)) throw new HttpError(400, 'status must be active or inactive');
    out.status = b.status;
  }
  if (!partial) for (const f of ['registration', 'type', 'seats', 'home_base', 'cruise_speed_kts', 'hourly_rate_inr']) if (out[f] === undefined) throw new HttpError(400, `${f} is required`);
  return out;
}

aircraft.post('/', requireRole('ops'), async (req, res) => {
  const d = await aircraftData(req.body || {}, false);
  const dup = await pool.query('SELECT 1 FROM aircraft WHERE registration = $1', [d.registration]);
  if (dup.rows.length) throw new HttpError(409, 'Registration already exists');
  const cols = Object.keys(d);
  const { rows } = await pool.query(`INSERT INTO aircraft (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, Object.values(d));
  await logEvent({ entity_type: 'aircraft', entity_id: rows[0].id, action: 'created', actor_user_id: req.user.id, detail: { registration: d.registration } });
  res.status(201).json(rows[0]);
});

aircraft.patch('/:id', requireRole('ops'), async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'Aircraft not found');
  const d = await aircraftData(req.body || {}, true);
  if (!Object.keys(d).length) throw new HttpError(400, 'No fields to update');
  if (d.registration) {
    const dup = await pool.query('SELECT 1 FROM aircraft WHERE registration = $1 AND id <> $2', [d.registration, req.params.id]);
    if (dup.rows.length) throw new HttpError(409, 'Registration already exists');
  }
  const sets = Object.keys(d).map((k, i) => `${k} = $${i + 2}`);
  const { rows } = await pool.query(`UPDATE aircraft SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [req.params.id, ...Object.values(d)]);
  if (!rows[0]) throw new HttpError(404, 'Aircraft not found');
  await logEvent({ entity_type: 'aircraft', entity_id: rows[0].id, action: 'updated', actor_user_id: req.user.id, detail: d });
  res.json(rows[0]);
});

// ── Crew ────────────────────────────────────────────────────────────────────
const crew = asyncRouter();
const CREW_ROLES = ['captain', 'first_officer', 'cabin_crew'];
const CREW_SELECT = `SELECT cm.*, u.email AS user_email, u.name AS user_name FROM crew_members cm LEFT JOIN users u ON u.id = cm.user_id`;

crew.get('/', requireRole(...STAFF), async (req, res) => {
  const { rows } = await pool.query(`${CREW_SELECT} ORDER BY cm.crew_role, cm.name`);
  res.json(rows);
});

async function crewData(b, partial) {
  const out = {};
  if (b.name !== undefined) { if (!String(b.name).trim()) throw new HttpError(400, 'name is required'); out.name = String(b.name).trim(); }
  if (b.crew_role !== undefined) { if (!CREW_ROLES.includes(b.crew_role)) throw new HttpError(400, `crew_role must be one of ${CREW_ROLES.join(', ')}`); out.crew_role = b.crew_role; }
  if (b.base !== undefined) {
    out.base = b.base ? String(b.base).toUpperCase() : null;
    if (out.base && !(await pool.query('SELECT 1 FROM airports WHERE code = $1', [out.base])).rows.length) throw new HttpError(400, `Unknown airport: ${out.base}`);
  }
  if (b.licence_no !== undefined) out.licence_no = b.licence_no || null;
  if (b.user_id !== undefined) {
    out.user_id = b.user_id || null;
    if (out.user_id) {
      if (!isUuid(out.user_id)) throw new HttpError(400, 'Invalid user_id');
      const u = (await pool.query('SELECT role FROM users WHERE id = $1', [out.user_id])).rows[0];
      if (!u) throw new HttpError(400, 'Unknown user');
      if (u.role !== 'pilot') throw new HttpError(400, 'Only pilot users can be linked to crew');
    }
  }
  if (b.is_active !== undefined) { if (typeof b.is_active !== 'boolean') throw new HttpError(400, 'is_active must be boolean'); out.is_active = b.is_active; }
  if (!partial) for (const f of ['name', 'crew_role']) if (out[f] === undefined) throw new HttpError(400, `${f} is required`);
  return out;
}

crew.post('/', requireRole('ops'), async (req, res) => {
  const d = await crewData(req.body || {}, false);
  const cols = Object.keys(d);
  const { rows } = await pool.query(`INSERT INTO crew_members (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(d));
  await logEvent({ entity_type: 'crew', entity_id: rows[0].id, action: 'created', actor_user_id: req.user.id, detail: d });
  res.status(201).json((await pool.query(`${CREW_SELECT} WHERE cm.id = $1`, [rows[0].id])).rows[0]);
});

crew.patch('/:id', requireRole('ops'), async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'Crew member not found');
  const d = await crewData(req.body || {}, true);
  if (!Object.keys(d).length) throw new HttpError(400, 'No fields to update');
  const sets = Object.keys(d).map((k, i) => `${k} = $${i + 2}`);
  const { rows } = await pool.query(`UPDATE crew_members SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, [req.params.id, ...Object.values(d)]);
  if (!rows[0]) throw new HttpError(404, 'Crew member not found');
  await logEvent({ entity_type: 'crew', entity_id: rows[0].id, action: 'updated', actor_user_id: req.user.id, detail: d });
  res.json((await pool.query(`${CREW_SELECT} WHERE cm.id = $1`, [rows[0].id])).rows[0]);
});

// ── Maintenance ─────────────────────────────────────────────────────────────
const maintenance = asyncRouter();
const MB_SELECT = `SELECT mb.*, a.registration, a.type AS aircraft_type FROM maintenance_blocks mb JOIN aircraft a ON a.id = mb.aircraft_id`;

maintenance.get('/', requireRole(...STAFF), async (req, res) => {
  const { aircraft_id } = req.query;
  if (aircraft_id && !isUuid(aircraft_id)) throw new HttpError(400, 'Invalid aircraft_id');
  const { rows } = await pool.query(`${MB_SELECT} ${aircraft_id ? 'WHERE mb.aircraft_id = $1' : ''} ORDER BY mb.starts_on DESC`, aircraft_id ? [aircraft_id] : []);
  res.json(rows);
});

maintenance.post('/', requireRole('ops'), async (req, res) => {
  const { aircraft_id, starts_on, ends_on, reason, force } = req.body || {};
  if (!isUuid(aircraft_id)) throw new HttpError(400, 'aircraft_id is required');
  if (!isDateStr(starts_on) || !isDateStr(ends_on)) throw new HttpError(400, 'starts_on and ends_on must be YYYY-MM-DD');
  if (ends_on < starts_on) throw new HttpError(400, 'ends_on must be on or after starts_on');
  const ac = (await pool.query('SELECT id FROM aircraft WHERE id = $1', [aircraft_id])).rows[0];
  if (!ac) throw new HttpError(400, 'Unknown aircraft');
  const overlaps = (await pool.query(
    `SELECT charter_no, starts_on, ends_on FROM charters
      WHERE aircraft_id = $1 AND status <> 'cancelled' AND starts_on <= $3 AND ends_on >= $2`, [aircraft_id, starts_on, ends_on])).rows;
  if (overlaps.length && force !== true) {
    return res.status(409).json({ error: `Overlaps charter ${overlaps.map((o) => o.charter_no).join(', ')} — pass force:true to override`, conflicts: overlaps });
  }
  const { rows } = await pool.query(
    'INSERT INTO maintenance_blocks (aircraft_id, starts_on, ends_on, reason, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [aircraft_id, starts_on, ends_on, reason || null, req.user.id]);
  await logEvent({ entity_type: 'maintenance', entity_id: rows[0].id, action: 'created', actor_user_id: req.user.id, detail: { aircraft_id, starts_on, ends_on, reason, forced: !!(overlaps.length && force) } });
  res.status(201).json((await pool.query(`${MB_SELECT} WHERE mb.id = $1`, [rows[0].id])).rows[0]);
});

maintenance.delete('/:id', requireRole('ops'), async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'Maintenance block not found');
  const { rows } = await pool.query('DELETE FROM maintenance_blocks WHERE id = $1 RETURNING *', [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Maintenance block not found');
  await logEvent({ entity_type: 'maintenance', entity_id: rows[0].id, action: 'deleted', actor_user_id: req.user.id, detail: rows[0] });
  res.json({ ok: true });
});

// ── Settings ────────────────────────────────────────────────────────────────
const settings = asyncRouter();

settings.get('/', requireRole(...STAFF), async (req, res) => {
  const { rows } = await pool.query('SELECT key, value FROM settings ORDER BY key');
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

settings.patch('/', requireRole('admin'), async (req, res) => {
  const body = req.body || {};
  const keys = Object.keys(body);
  if (!keys.length) throw new HttpError(400, 'No settings to update');
  const known = await getSettings();
  for (const k of keys) {
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(k)) throw new HttpError(400, `Invalid key: ${k}`);
    if (typeof known[k] === 'number' && !Number.isFinite(Number(body[k]))) throw new HttpError(400, `${k} must be a number`);
    if (body[k] === null || typeof body[k] === 'object') throw new HttpError(400, `${k} must be a string or number`);
  }
  for (const k of keys) {
    await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, String(body[k])]);
  }
  await logEvent({ entity_type: 'settings', entity_id: '00000000-0000-0000-0000-000000000000', action: 'updated', actor_user_id: req.user.id, detail: body });
  const { rows } = await pool.query('SELECT key, value FROM settings ORDER BY key');
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

module.exports = { airports, aircraft, crew, maintenance, settings };
