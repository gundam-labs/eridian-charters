const { pool, withTransaction } = require('../db');
const { asyncRouter, HttpError, isUuid } = require('../lib/http');
const { requireRole, isStaff } = require('../middleware/auth');
const { logEvent } = require('../lib/events');
const { conflicts, crewConflicts } = require('../lib/availability');
const { maskId, isMasked, publicAircraft } = require('../lib/serialize');
const { parseIST, toISTISO, isDateStr } = require('../lib/time');
const { sendCharterConfirmed, sendCharterCancelled } = require('../lib/email');

const router = asyncRouter();

const ID_TYPES = ['passport', 'aadhaar', 'driving_licence', 'voter_id', 'pan'];

const CHARTER_SELECT = `SELECT c.*,
  m.member_no, m.contact_name AS member_name, m.company AS member_company, m.email AS member_email,
  q.quote_no, q.request_id,
  json_build_object('id', a.id, 'registration', a.registration, 'type', a.type, 'seats', a.seats, 'home_base', a.home_base,
                    'hourly_rate_inr', a.hourly_rate_inr::float8, 'partner_name', a.partner_name, 'status', a.status) AS aircraft,
  a.registration AS aircraft_registration, a.type AS aircraft_type, a.seats AS aircraft_seats,
  cap.name AS captain_name, fo.name AS first_officer_name, cc.name AS cabin_crew_name,
  (SELECT count(*)::int FROM passengers p WHERE p.charter_id = c.id) AS passenger_count
  FROM charters c
  JOIN members m ON m.id = c.member_id
  JOIN quotes q ON q.id = c.quote_id
  JOIN aircraft a ON a.id = c.aircraft_id
  LEFT JOIN crew_members cap ON cap.id = c.captain_id
  LEFT JOIN crew_members fo ON fo.id = c.first_officer_id
  LEFT JOIN crew_members cc ON cc.id = c.cabin_crew_id`;

// Pilot visibility: charter has the current user's crew record in any crew slot.
const PILOT_CLAUSE = (p) => `EXISTS (SELECT 1 FROM crew_members pc WHERE pc.user_id = $${p} AND pc.id IN (c.captain_id, c.first_officer_id, c.cabin_crew_id))`;

function shapeCharter(c, user) {
  const out = { ...c };
  if (!isStaff(user)) {
    out.aircraft = publicAircraft(c.aircraft);
    delete out.ops_notes;
    if (user.role === 'member') delete out.defects;
  }
  return out;
}

async function loadCharter(id, user, db = pool) {
  if (!isUuid(id)) throw new HttpError(404, 'Charter not found');
  const c = (await db.query(`${CHARTER_SELECT} WHERE c.id = $1`, [id])).rows[0];
  if (!c) throw new HttpError(404, 'Charter not found');
  if (user.role === 'member' && c.member_id !== user.member_id) throw new HttpError(404, 'Charter not found');
  if (user.role === 'pilot') {
    const ok = (await db.query(`SELECT 1 FROM charters c WHERE c.id = $1 AND ${PILOT_CLAUSE(2)}`, [id, user.id])).rows.length;
    if (!ok) throw new HttpError(404, 'Charter not found');
  }
  return c;
}

async function isAssignedPilot(charterId, userId, db = pool) {
  return (await db.query(`SELECT 1 FROM charters c WHERE c.id = $1 AND ${PILOT_CLAUSE(2)}`, [charterId, userId])).rows.length > 0;
}

async function passengersFor(charterId, user, db = pool) {
  const { rows } = await db.query('SELECT id, full_name, id_type, id_number, nationality, phone, created_at FROM passengers WHERE charter_id = $1 ORDER BY created_at, full_name', [charterId]);
  if (isStaff(user)) return rows;
  return rows.map((p) => ({ ...p, id_number: maskId(p.id_number) }));
}

async function detail(id, user) {
  const c = await loadCharter(id, user);
  const passengers = await passengersFor(c.id, user);
  const invoice = user.role === 'pilot' ? null : (await pool.query('SELECT * FROM invoices WHERE charter_id = $1', [c.id])).rows[0] || null;
  const events = (await pool.query(
    `SELECT e.id, e.entity_type, e.action, e.detail, e.created_at, u.name AS actor_name, u.role AS actor_role
       FROM events e LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE (e.entity_type = 'charter' AND e.entity_id = $1) OR (e.entity_type = 'invoice' AND e.entity_id = $2)
      ORDER BY e.created_at`, [c.id, invoice?.id || '00000000-0000-0000-0000-000000000000'])).rows;
  return { ...shapeCharter(c, user), passengers, invoice, events };
}

// ── List ────────────────────────────────────────────────────────────────────
router.get('/', requireRole('member', 'pilot', 'sales', 'ops'), async (req, res) => {
  const params = [];
  const where = [];
  if (req.user.role === 'member') { params.push(req.user.member_id); where.push(`c.member_id = $${params.length}`); }
  if (req.user.role === 'pilot') { params.push(req.user.id); where.push(PILOT_CLAUSE(params.length)); }
  if (req.query.status) {
    const st = String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean);
    params.push(st); where.push(`c.status = ANY($${params.length})`);
  }
  if (req.query.from) { if (!isDateStr(req.query.from)) throw new HttpError(400, 'from must be YYYY-MM-DD'); params.push(req.query.from); where.push(`c.ends_on >= $${params.length}`); }
  if (req.query.to) { if (!isDateStr(req.query.to)) throw new HttpError(400, 'to must be YYYY-MM-DD'); params.push(req.query.to); where.push(`c.starts_on <= $${params.length}`); }
  if (req.query.member_id && isStaff(req.user)) {
    if (!isUuid(req.query.member_id)) throw new HttpError(400, 'Invalid member_id');
    params.push(req.query.member_id); where.push(`c.member_id = $${params.length}`);
  }
  const { rows } = await pool.query(`${CHARTER_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.starts_on, c.charter_no`, params);
  res.json(rows.map((c) => shapeCharter(c, req.user)));
});

router.get('/:id', requireRole('member', 'pilot', 'sales', 'ops'), async (req, res) => {
  res.json(await detail(req.params.id, req.user));
});

// ── Assign aircraft / crew ──────────────────────────────────────────────────
async function checkCrew(id, role, label, db) {
  if (!id) return null;
  if (!isUuid(id)) throw new HttpError(400, `Invalid ${label}`);
  const cm = (await db.query('SELECT * FROM crew_members WHERE id = $1', [id])).rows[0];
  if (!cm) throw new HttpError(400, `Unknown ${label}`);
  if (!cm.is_active) throw new HttpError(400, `${cm.name} is inactive`);
  if (cm.crew_role !== role) throw new HttpError(400, `${cm.name} is not a ${role.replace('_', ' ')}`);
  return cm;
}

router.post('/:id/assign', requireRole('ops'), async (req, res) => {
  const c = await loadCharter(req.params.id, req.user);
  if (!['accepted', 'confirmed', 'manifest_complete'].includes(c.status)) throw new HttpError(409, `Cannot assign crew to a charter that is ${c.status}`);
  const b = req.body || {};
  const captain_id = b.captain_id !== undefined ? b.captain_id || null : c.captain_id;
  const first_officer_id = b.first_officer_id !== undefined ? b.first_officer_id || null : c.first_officer_id;
  const cabin_crew_id = b.cabin_crew_id !== undefined ? b.cabin_crew_id || null : c.cabin_crew_id;
  await checkCrew(captain_id, 'captain', 'captain_id', pool);
  await checkCrew(first_officer_id, 'first_officer', 'first_officer_id', pool);
  await checkCrew(cabin_crew_id, 'cabin_crew', 'cabin_crew_id', pool);
  let aircraft_id = c.aircraft_id;
  const warnings = [];
  if (b.aircraft_id && b.aircraft_id !== c.aircraft_id) {
    if (!isUuid(b.aircraft_id)) throw new HttpError(400, 'Invalid aircraft_id');
    const ac = (await pool.query('SELECT * FROM aircraft WHERE id = $1', [b.aircraft_id])).rows[0];
    if (!ac) throw new HttpError(400, 'Unknown aircraft');
    if (ac.status !== 'active') throw new HttpError(409, `${ac.registration} is inactive`);
    if (ac.seats < c.pax) throw new HttpError(409, `${ac.registration} has ${ac.seats} seats — charter has ${c.pax} passengers`);
    if (ac.seats < c.passenger_count) throw new HttpError(409, `${ac.registration} has ${ac.seats} seats — manifest has ${c.passenger_count} passengers`);
    const cf = await conflicts(ac.id, c.starts_on, c.ends_on, c.id);
    if (cf.length) return res.status(409).json({ error: `${ac.registration} is not available for these dates`, conflicts: cf });
    aircraft_id = ac.id;
    warnings.push('Aircraft changed — price not recalculated');
  }
  const crewBusy = await crewConflicts([captain_id, first_officer_id, cabin_crew_id], c.starts_on, c.ends_on, c.id);
  if (crewBusy.length) warnings.push(...crewBusy.map((x) => `${x.name} is also assigned to ${x.charter_no}`));
  await withTransaction(async (client) => {
    await client.query(
      'UPDATE charters SET aircraft_id=$2, captain_id=$3, first_officer_id=$4, cabin_crew_id=$5, ops_notes=COALESCE($6, ops_notes) WHERE id=$1',
      [c.id, aircraft_id, captain_id, first_officer_id, cabin_crew_id, b.ops_notes !== undefined ? String(b.ops_notes) : null]);
    await logEvent({ entity_type: 'charter', entity_id: c.id, action: 'crew_assigned', actor_user_id: req.user.id,
      detail: { aircraft_id, captain_id, first_officer_id, cabin_crew_id, aircraft_changed: aircraft_id !== c.aircraft_id } }, client);
  });
  res.json({ ...(await detail(c.id, req.user)), warnings });
});

// ── Confirm ─────────────────────────────────────────────────────────────────
router.post('/:id/confirm', requireRole('ops'), async (req, res) => {
  const c = await loadCharter(req.params.id, req.user);
  if (c.status !== 'accepted') throw new HttpError(409, `Cannot confirm a charter that is ${c.status}`);
  if (!c.captain_id || !c.first_officer_id) throw new HttpError(409, 'Assign a captain and first officer before confirming');
  if (c.aircraft.status === 'inactive') throw new HttpError(409, 'Aircraft is inactive');
  const cf = await conflicts(c.aircraft_id, c.starts_on, c.ends_on, c.id);
  if (cf.length) return res.status(409).json({ error: `Aircraft ${c.aircraft_registration} has conflicts for these dates`, conflicts: cf });
  const crewBusy = await crewConflicts([c.captain_id, c.first_officer_id, c.cabin_crew_id], c.starts_on, c.ends_on, c.id);
  if (crewBusy.length) {
    const x = crewBusy[0];
    return res.status(409).json({ error: `${x.name} is already assigned to ${x.charter_no} on these dates`, conflicts: crewBusy });
  }
  await withTransaction(async (client) => {
    const upd = await client.query(`UPDATE charters SET status='confirmed', confirmed_at=now() WHERE id=$1 AND status='accepted' RETURNING id`, [c.id]);
    if (!upd.rows.length) throw new HttpError(409, 'Charter changed — reload and try again');
    await logEvent({ entity_type: 'charter', entity_id: c.id, action: 'confirmed', actor_user_id: req.user.id }, client);
  });
  await sendCharterConfirmed({ to: c.member_email, name: c.member_name, charter: c });
  res.json(await detail(c.id, req.user));
});

// ── Passengers (replace list) ───────────────────────────────────────────────
router.put('/:id/passengers', requireRole('member', 'ops'), async (req, res) => {
  const c = await loadCharter(req.params.id, req.user);
  const allowed = req.user.role === 'member' ? ['accepted', 'confirmed'] : ['accepted', 'confirmed', 'manifest_complete'];
  if (!allowed.includes(c.status)) throw new HttpError(409, `Manifest cannot be edited while the charter is ${c.status}`);
  const list = req.body?.passengers;
  if (!Array.isArray(list)) throw new HttpError(400, 'passengers must be an array');
  if (list.length > c.aircraft_seats) throw new HttpError(400, `Too many passengers — ${c.aircraft_registration} has ${c.aircraft_seats} seats`);
  const clean = list.map((p, i) => {
    const n = i + 1;
    const full_name = String(p?.full_name || '').trim();
    const id_type = String(p?.id_type || '').trim();
    const id_number = String(p?.id_number || '').trim();
    if (!full_name) throw new HttpError(400, `Passenger ${n}: full_name is required`);
    if (!ID_TYPES.includes(id_type)) throw new HttpError(400, `Passenger ${n}: id_type must be one of ${ID_TYPES.join(', ')}`);
    if (!id_number) throw new HttpError(400, `Passenger ${n}: id_number is required`);
    return { full_name, id_type, id_number, nationality: String(p?.nationality || '').trim() || 'Indian', phone: p?.phone ? String(p.phone).trim() : null };
  });
  await withTransaction(async (client) => {
    await client.query('SELECT id FROM charters WHERE id = $1 FOR UPDATE', [c.id]);
    const existing = (await client.query('SELECT full_name, id_type, id_number FROM passengers WHERE charter_id = $1', [c.id])).rows;
    for (const [i, p] of clean.entries()) {
      if (isMasked(p.id_number)) {
        // Masked value echoed back from the UI: keep the stored number for the same passenger.
        const match = existing.find((e) => e.full_name.toLowerCase() === p.full_name.toLowerCase() && maskId(e.id_number) === p.id_number.toUpperCase().replace(/^X+/, 'XXXX'))
          || existing.find((e) => e.full_name.toLowerCase() === p.full_name.toLowerCase());
        if (!match) throw new HttpError(400, `Passenger ${i + 1}: enter the full ID number`);
        p.id_number = match.id_number;
      }
    }
    await client.query('DELETE FROM passengers WHERE charter_id = $1', [c.id]);
    for (const p of clean) {
      await client.query(
        'INSERT INTO passengers (charter_id, full_name, id_type, id_number, nationality, phone) VALUES ($1,$2,$3,$4,$5,$6)',
        [c.id, p.full_name, p.id_type, p.id_number, p.nationality, p.phone]);
    }
    await logEvent({ entity_type: 'charter', entity_id: c.id, action: 'manifest_updated', actor_user_id: req.user.id, detail: { count: clean.length } }, client);
  });
  res.json(await detail(c.id, req.user));
});

// ── Submit manifest ─────────────────────────────────────────────────────────
router.post('/:id/manifest/submit', requireRole('member', 'ops'), async (req, res) => {
  const c = await loadCharter(req.params.id, req.user);
  if (c.status === 'accepted') throw new HttpError(409, 'Ops must confirm the flight first');
  if (c.status !== 'confirmed') throw new HttpError(409, `Cannot submit the manifest while the charter is ${c.status}`);
  if (c.passenger_count < 1) throw new HttpError(409, 'Add at least one passenger before submitting');
  if (c.passenger_count > c.aircraft_seats) throw new HttpError(409, `Too many passengers — ${c.aircraft_registration} has ${c.aircraft_seats} seats`);
  await withTransaction(async (client) => {
    const upd = await client.query(`UPDATE charters SET status='manifest_complete' WHERE id=$1 AND status='confirmed' RETURNING id`, [c.id]);
    if (!upd.rows.length) throw new HttpError(409, 'Charter changed — reload and try again');
    await logEvent({ entity_type: 'charter', entity_id: c.id, action: 'manifest_submitted', actor_user_id: req.user.id, detail: { passengers: c.passenger_count } }, client);
  });
  res.json(await detail(c.id, req.user));
});

// ── Flight log ──────────────────────────────────────────────────────────────
router.post('/:id/flight-log', requireRole('pilot', 'ops'), async (req, res) => {
  const c = await loadCharter(req.params.id, req.user);
  if (req.user.role === 'pilot' && !(await isAssignedPilot(c.id, req.user.id))) throw new HttpError(403, 'You are not assigned to this charter');
  if (c.status !== 'manifest_complete') throw new HttpError(409, `Cannot log a flight for a charter that is ${c.status}`);
  const entries = req.body?.legs;
  if (!Array.isArray(entries)) throw new HttpError(400, 'legs must be an array');
  const legs = c.legs.map((l) => ({ ...l }));
  for (const e of entries) {
    const idx = Number(e?.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= legs.length) throw new HttpError(400, `Invalid leg index ${e?.index}`);
    const off = parseIST(e.block_off);
    const on = parseIST(e.block_on);
    if (!off || !on) throw new HttpError(400, `Leg ${idx + 1}: block_off and block_on are required`);
    if (on <= off) throw new HttpError(400, `Leg ${idx + 1}: block_on must be after block_off`);
    legs[idx].block_off = toISTISO(off);
    legs[idx].block_on = toISTISO(on);
  }
  const missing = legs.findIndex((l) => !l.block_off || !l.block_on);
  if (missing !== -1) throw new HttpError(400, `Leg ${missing + 1}: block_off and block_on are required`);
  const defects = req.body?.defects ? String(req.body.defects).slice(0, 4000) : null;
  await withTransaction(async (client) => {
    const upd = await client.query(
      `UPDATE charters SET legs=$2, defects=$3, status='flown', flown_at=now() WHERE id=$1 AND status='manifest_complete' RETURNING id`,
      [c.id, JSON.stringify(legs), defects]);
    if (!upd.rows.length) throw new HttpError(409, 'Charter changed — reload and try again');
    await logEvent({ entity_type: 'charter', entity_id: c.id, action: 'flown', actor_user_id: req.user.id, detail: { defects: !!defects } }, client);
    // If the invoice is already paid, the charter closes as soon as it is flown.
    const inv = (await client.query(`SELECT status FROM invoices WHERE charter_id = $1`, [c.id])).rows[0];
    if (inv?.status === 'paid') {
      await client.query(`UPDATE charters SET status='closed', closed_at=now() WHERE id=$1`, [c.id]);
      await logEvent({ entity_type: 'charter', entity_id: c.id, action: 'closed', actor_user_id: req.user.id, detail: { reason: 'invoice already paid' } }, client);
    }
  });
  res.json(await detail(c.id, req.user));
});

// ── Cancel ──────────────────────────────────────────────────────────────────
router.post('/:id/cancel', requireRole('member', 'ops'), async (req, res) => {
  const c = await loadCharter(req.params.id, req.user);
  if (!['accepted', 'confirmed', 'manifest_complete'].includes(c.status)) throw new HttpError(409, `Cannot cancel a charter that is ${c.status}`);
  const reason = String(req.body?.reason || '').trim();
  if (!reason) throw new HttpError(400, 'A cancellation reason is required');
  await withTransaction(async (client) => {
    const upd = await client.query(
      `UPDATE charters SET status='cancelled', cancelled_at=now(), cancel_reason=$2 WHERE id=$1 AND status IN ('accepted','confirmed','manifest_complete') RETURNING id`,
      [c.id, reason.slice(0, 1000)]);
    if (!upd.rows.length) throw new HttpError(409, 'Charter changed — reload and try again');
    await logEvent({ entity_type: 'charter', entity_id: c.id, action: 'cancelled', actor_user_id: req.user.id, detail: { reason } }, client);
    const inv = await client.query(`UPDATE invoices SET status='cancelled' WHERE charter_id=$1 AND status <> 'cancelled' RETURNING id`, [c.id]);
    for (const i of inv.rows) await logEvent({ entity_type: 'invoice', entity_id: i.id, action: 'cancelled', actor_user_id: req.user.id, detail: { reason: 'charter cancelled' } }, client);
  });
  await sendCharterCancelled({ to: c.member_email, name: c.member_name, charter: c, reason });
  res.json(await detail(c.id, req.user));
});

module.exports = router;
module.exports.CHARTER_SELECT = CHARTER_SELECT;
module.exports.PILOT_CLAUSE = PILOT_CLAUSE;
