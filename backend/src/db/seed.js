/**
 * Demo seed — idempotent (checks natural keys before inserting; safe to run repeatedly).
 * Refuses to run unless SEED_DEMO=true or NODE_ENV=development.
 * Demo password for all seeded users: Meridian@2026
 * Sample flow data is placed relative to today's date in IST.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool, initDB, getSettings, withTransaction } = require('./index');
const { priceQuote } = require('../lib/pricing');
const { nextNumber } = require('../lib/numbers');
const { todayIST, addDays, parseIST, toISTISO } = require('../lib/time');
const { generateForCharter, bookLegTx, findOrCreateMemberForBooking } = require('../lib/emptyLegs');
const { priceEmptyLeg } = require('../lib/pricing');

if (process.env.SEED_DEMO !== 'true' && process.env.NODE_ENV !== 'development') {
  console.error('Refusing to seed: set SEED_DEMO=true or NODE_ENV=development');
  process.exit(1);
}

const PASSWORD = 'Meridian@2026';

const AIRPORTS = [
  ['DEL', 'Indira Gandhi International', 'New Delhi', 28.5562, 77.1000, 25000, 40000],
  ['BOM', 'Chhatrapati Shivaji Maharaj International', 'Mumbai', 19.0896, 72.8656, 24000, 38000],
  ['BLR', 'Kempegowda International', 'Bengaluru', 13.1986, 77.7066, 20000, 32000],
  ['HYD', 'Rajiv Gandhi International', 'Hyderabad', 17.2403, 78.4294, 18000, 30000],
  ['MAA', 'Chennai International', 'Chennai', 12.9941, 80.1709, 18000, 30000],
  ['CCU', 'Netaji Subhas Chandra Bose International', 'Kolkata', 22.6547, 88.4467, 16000, 28000],
  ['GOI', 'Goa International (Dabolim)', 'Goa', 15.3808, 73.8314, 14000, 25000],
  ['COK', 'Cochin International', 'Kochi', 10.1520, 76.4019, 13000, 24000],
  ['AMD', 'Sardar Vallabhbhai Patel International', 'Ahmedabad', 23.0772, 72.6347, 12000, 22000],
  ['JAI', 'Jaipur International', 'Jaipur', 26.8242, 75.8122, 11000, 20000],
  ['UDR', 'Maharana Pratap Airport', 'Udaipur', 24.6177, 73.8961, 9000, 18000],
  ['PNQ', 'Pune Airport', 'Pune', 18.5821, 73.9197, 10000, 18000],
  ['IXC', 'Chandigarh International', 'Chandigarh', 30.6735, 76.7885, 9000, 16000],
  ['LKO', 'Chaudhary Charan Singh International', 'Lucknow', 26.7606, 80.8893, 8000, 15000],
];

const TYPES = [
  { type: 'Bombardier Challenger 350', seats: 10, kts: 450, rate: 340000 },
  { type: 'Embraer Praetor 600', seats: 12, kts: 466, rate: 360000 },
  { type: 'Gulfstream G280', seats: 10, kts: 459, rate: 380000 },
];
const BASES = ['DEL', 'BOM', 'BLR', 'HYD'];
const PARTNERS = ['Aravalli Aviation Holdings', 'Konkan Air Assets', 'Deccan Jet Partners', 'Coromandel Leasing'];

const CAPTAINS = ['Capt. Vikrant Rathore', 'Capt. Sunita Krishnan', 'Capt. Aarav Malhotra', 'Capt. Deepa Nair', 'Capt. Harpreet Gill', 'Capt. Rahul Deshmukh', 'Capt. Shalini Rao', 'Capt. Kabir Anand', 'Capt. Mohan Pillai', 'Capt. Ishita Sen'];
const FOS = ['FO Nikhil Bhatia', 'FO Aditi Sharma', 'FO Pranav Hegde', 'FO Zoya Khan', 'FO Rohit Chauhan', 'FO Tara Menon', 'FO Yash Patil', 'FO Ritika Bose', 'FO Arjun Varghese', 'FO Neel Kothari'];
const CABIN = ['Ananya Das', 'Simran Kaur', 'Leela Thomas', 'Priyanka Jain', 'Rhea Fernandes', 'Kunal Mehta', 'Sana Mirza', 'Divya Iyer', 'Karthik Raman', 'Maya Joshi'];

async function seedAirports() {
  for (const [code, name, city, lat, lon, landing, handling] of AIRPORTS) {
    await pool.query(
      `INSERT INTO airports (code, name, city, lat, lon, landing_fee_inr, handling_fee_inr)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (code) DO NOTHING`, [code, name, city, lat, lon, landing, handling]);
  }
}

async function seedAircraft() {
  for (let i = 0; i < 20; i++) {
    const reg = `VT-MC${String.fromCharCode(65 + i)}`; // VT-MCA … VT-MCT
    const t = TYPES[i % 3];
    await pool.query(
      `INSERT INTO aircraft (registration, type, seats, home_base, cruise_speed_kts, hourly_rate_inr, partner_name, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active') ON CONFLICT (registration) DO NOTHING`,
      [reg, t.type, t.seats, BASES[i % 4], t.kts, t.rate, PARTNERS[i % 4]]);
  }
}

// v1.2: a 20-jet operator rosters ~2 crews per aircraft. Appended, so existing indices (pilot links) are unchanged.
CAPTAINS.push('Capt. Rajesh Kulkarni', 'Capt. Meghna Batra', 'Capt. Sandeep Grewal', 'Capt. Nandita Bose', 'Capt. Faisal Siddiqui',
  'Capt. Lavanya Prakash', 'Capt. Tejas Shetty', 'Capt. Anjali Thakur', 'Capt. Varun Khurana', 'Capt. Revathi Subramanian');
FOS.push('FO Aniket Pawar', 'FO Bhavna Choudhary', 'FO Siddhant Rawat', 'FO Ira Mukherjee', 'FO Harsh Vardhan',
  'FO Pallavi Kini', 'FO Jatin Arora', 'FO Swati Nambiar', 'FO Mihir Jain', 'FO Gauri Sawant');
CABIN.push('Tanya Lobo', 'Ashwin Kumar', 'Nikita Rana', 'Joel D\'Souza', 'Fatima Sheikh', 'Rohan Pinto', 'Shruti Hegde', 'Varsha Menon');

async function seedCrew() {
  const rows = [
    ...CAPTAINS.map((n, i) => [n, 'captain', BASES[i % 4], `CPL-ATPL-${1101 + i}`]),
    ...FOS.map((n, i) => [n, 'first_officer', BASES[i % 4], `CPL-${2201 + i}`]),
    ...CABIN.map((n, i) => [n, 'cabin_crew', BASES[i % 4], null]),
  ];
  for (const [name, role, base, lic] of rows) {
    const exists = await pool.query('SELECT 1 FROM crew_members WHERE name = $1 AND crew_role = $2', [name, role]);
    if (!exists.rows.length) {
      await pool.query('INSERT INTO crew_members (name, crew_role, base, licence_no) VALUES ($1,$2,$3,$4)', [name, role, base, lic]);
    }
  }
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines.shift().split(',');
  return lines.map((line) => {
    // simple CSV with optional double-quoted fields
    const cells = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === ',' && !q) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(header.map((h, i) => [h.trim(), (cells[i] ?? '').trim()]));
  });
}

async function seedMembers() {
  const rows = parseCsv(fs.readFileSync(path.join(__dirname, 'seed-data', 'members.csv'), 'utf8'));
  for (const r of rows) {
    await pool.query(
      `INSERT INTO members (member_no, member_type, contact_name, company, city, email, phone, tier, status, member_since, past_charters)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (member_no) DO NOTHING`,
      [r.member_no, r.member_type.toLowerCase(), r.contact_name, r.company || null, r.city, r.email.toLowerCase(), r.phone,
        r.tier.toLowerCase(), r.status.toLowerCase(), r.member_since, parseInt(r.past_charters, 10) || 0]);
  }
  // Keep the MC-#### counter ahead of imported members.
  await pool.query(
    `INSERT INTO sequences (name, year, next)
     SELECT 'MC', 0, COALESCE(MAX(substring(member_no FROM 4)::int), 1000) + 1 FROM members WHERE member_no ~ '^MC-[0-9]+$'
     ON CONFLICT (name) DO UPDATE SET next = GREATEST(sequences.next, EXCLUDED.next)`);
  return rows.length;
}

async function seedUsers() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const member = async (no) => (await pool.query('SELECT id, contact_name FROM members WHERE member_no = $1', [no])).rows[0];
  const arjun = await member('MC-1001');
  const rajiv = await member('MC-1011');
  const users = [
    ['admin@meridian.test', 'Asha Verma', 'admin', null],
    ['sales@meridian.test', 'Rohan Kapoor', 'sales', null],
    ['ops@meridian.test', 'Meenakshi Iyer', 'ops', null],
    ['pilot1@meridian.test', CAPTAINS[0], 'pilot', null],
    ['pilot2@meridian.test', CAPTAINS[1], 'pilot', null],
    ['arjun.mehra@example.in', arjun.contact_name, 'member', arjun.id],
    ['rajiv.malhotra@example.in', rajiv.contact_name, 'member', rajiv.id],
  ];
  for (const [email, name, role, member_id] of users) {
    await pool.query(
      `INSERT INTO users (email, name, role, member_id, password_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO NOTHING`,
      [email, name, role, member_id, hash]);
  }
  // Link pilots to the first two captains (only if not linked yet).
  for (const [email, capName] of [['pilot1@meridian.test', CAPTAINS[0]], ['pilot2@meridian.test', CAPTAINS[1]]]) {
    await pool.query(
      `UPDATE crew_members SET user_id = (SELECT id FROM users WHERE email = $1)
        WHERE name = $2 AND crew_role = 'captain' AND user_id IS NULL`, [email, capName]);
  }
}

// ── Sample flow data ────────────────────────────────────────────────────────
async function ctx() {
  const airports = (await pool.query('SELECT * FROM airports')).rows;
  const settings = await getSettings();
  const users = Object.fromEntries((await pool.query('SELECT email, id FROM users')).rows.map((u) => [u.email, u.id]));
  const ac = Object.fromEntries((await pool.query('SELECT * FROM aircraft')).rows.map((a) => [a.registration, a]));
  const crew = Object.fromEntries((await pool.query('SELECT * FROM crew_members')).rows.map((c) => [c.name, c]));
  const members = Object.fromEntries((await pool.query('SELECT id, member_no FROM members')).rows.map((m) => [m.member_no, m.id]));
  return { airports, settings, users, ac, crew, members };
}

const at = (dayOffset, hhmm) => `${addDays(todayIST(), dayOffset)}T${hhmm}`;
const normLegs = (legs) => legs.map((l) => ({ ...l, depart_at: toISTISO(parseIST(l.depart_at)) }));

// Natural key for demo requests: the seed_key recorded on the request's 'created' event.
async function findRequest(key) {
  return (await pool.query(
    `SELECT r.* FROM quote_requests r JOIN events e ON e.entity_type = 'quote_request' AND e.entity_id = r.id AND e.action = 'created'
      WHERE e.detail->>'seed_key' = $1 LIMIT 1`, [key])).rows[0];
}

async function createRequest(c, key, memberNo, legs, pax, note, createdBy, status = 'open') {
  const existing = await findRequest(key);
  if (existing) return { request: existing, created: false };
  const request_no = await nextNumber('RQ');
  const { rows } = await pool.query(
    `INSERT INTO quote_requests (request_no, member_id, legs, pax, notes, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [request_no, c.members[memberNo], JSON.stringify(normLegs(legs)), pax, note, status, createdBy]);
  await pool.query(`INSERT INTO events (entity_type, entity_id, action, actor_user_id, detail) VALUES ('quote_request',$1,'created',$2,$3)`,
    [rows[0].id, createdBy, JSON.stringify({ request_no, seed: true, seed_key: key })]);
  return { request: rows[0], created: true };
}

async function createQuote(c, request, reg, status, { adjustment_inr = 0, adjustment_note = null, sentAgoHours = 2 } = {}) {
  const existing = (await pool.query('SELECT * FROM quotes WHERE request_id = $1 LIMIT 1', [request.id])).rows[0];
  if (existing) return existing;
  const aircraft = c.ac[reg];
  const priced = priceQuote({ legs: request.legs, aircraft, airports: c.airports, settings: c.settings, adjustment_inr, adjustment_note, pax: request.pax });
  const quote_no = await nextNumber('Q');
  const validHours = c.settings.quote_validity_hours;
  const { rows } = await pool.query(
    `INSERT INTO quotes (quote_no, request_id, member_id, aircraft_id, legs, positioning, line_items, adjustment_inr, adjustment_note,
       subtotal, gst_rate_pct, gst_amount, total, starts_on, ends_on, valid_hours, valid_until, status, sent_at, decided_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             now() - make_interval(hours => $17) + make_interval(hours => $16), $18,
             now() - make_interval(hours => $17), CASE WHEN $18 = 'accepted' THEN now() - make_interval(hours => $17 - 1) END, $19)
     RETURNING *`,
    [quote_no, request.id, request.member_id, aircraft.id, JSON.stringify(priced.legs), JSON.stringify(priced.positioning),
      JSON.stringify(priced.line_items), adjustment_inr, adjustment_note, priced.subtotal, priced.gst_rate_pct, priced.gst_amount,
      priced.total, priced.starts_on, priced.ends_on, validHours, sentAgoHours, status, c.users['sales@meridian.test']]);
  await pool.query(`INSERT INTO events (entity_type, entity_id, action, actor_user_id, detail) VALUES ('quote',$1,'sent',$2,$3)`,
    [rows[0].id, c.users['sales@meridian.test'], JSON.stringify({ quote_no, seed: true })]);
  return rows[0];
}

// Aircraft/crew clashes for seeding: any non-cancelled charter (closed included — the seed must not
// double-book history either) or maintenance block overlapping the dates.
async function aircraftClash(aircraftId, starts, ends) {
  const ch = await pool.query(
    `SELECT charter_no FROM charters WHERE aircraft_id = $1 AND status <> 'cancelled' AND starts_on <= $3 AND ends_on >= $2`, [aircraftId, starts, ends]);
  const mb = await pool.query(`SELECT id FROM maintenance_blocks WHERE aircraft_id = $1 AND starts_on <= $3 AND ends_on >= $2`, [aircraftId, starts, ends]);
  return ch.rows.map((r) => r.charter_no).concat(mb.rows.length ? ['maintenance'] : []);
}

async function crewBusy(crewId, starts, ends) {
  const { rows } = await pool.query(
    `SELECT 1 FROM charters WHERE status <> 'cancelled' AND starts_on <= $3 AND ends_on >= $2
        AND $1 IN (captain_id, first_officer_id, cabin_crew_id) LIMIT 1`, [crewId, starts, ends]);
  return rows.length > 0;
}

/** First free captain / first officer / cabin crew for the dates, preferring the aircraft's home base. */
async function pickCrew(homeBase, starts, ends) {
  const out = [];
  for (const role of ['captain', 'first_officer', 'cabin_crew']) {
    const { rows } = await pool.query(
      `SELECT id, name FROM crew_members WHERE crew_role = $1 AND is_active ORDER BY (base = $2) DESC, name`, [role, homeBase]);
    let chosen = null;
    for (const r of rows) if (!(await crewBusy(r.id, starts, ends))) { chosen = r.name; break; }
    out.push(chosen);
  }
  return out;
}

async function createCharter(c, key, { memberNo, legs, pax, reg, status, crew, passengers = [], invoiceStatus = 'unpaid', issuedOffset = 0, flown = false, defects = null, note = 'Demo charter', cancelReason = null, quiet = false }) {
  // Natural key: the request's seed_key. Look the charter up before pricing anything new.
  const prior = await findRequest(key);
  if (prior) {
    const ch = (await pool.query('SELECT c.* FROM charters c JOIN quotes q ON q.id = c.quote_id WHERE q.request_id = $1', [prior.id])).rows[0];
    if (ch) return ch;
  }
  // Dates (incl. positioning) before writing anything, so a clash skips the whole charter.
  const priced0 = priceQuote({ legs: normLegs(legs), aircraft: c.ac[reg], airports: c.airports, settings: c.settings });
  if (status !== 'cancelled' && !prior) {
    const clash = await aircraftClash(c.ac[reg].id, priced0.starts_on, priced0.ends_on);
    if (clash.length) {
      if (!quiet) console.warn(`  [seed] skip ${key}: ${reg} busy ${priced0.starts_on}..${priced0.ends_on} (${clash.join(', ')})`);
      return null;
    }
  }
  if (crew === 'auto') {
    crew = status === 'accepted' || status === 'cancelled' ? null : await pickCrew(c.ac[reg].home_base, priced0.starts_on, priced0.ends_on);
    if (crew && (!crew[0] || !crew[1])) {
      if (!quiet) console.warn(`  [seed] skip ${key}: no free crew ${priced0.starts_on}..${priced0.ends_on}`);
      return null;
    }
  }
  const { request } = await createRequest(c, key, memberNo, legs, pax, note, c.users['sales@meridian.test'], 'closed');
  const quote = await createQuote(c, request, reg, 'accepted', { sentAgoHours: 24 * Math.max(1, -issuedOffset + 1) });
  const existing = (await pool.query('SELECT * FROM charters WHERE quote_id = $1', [quote.id])).rows[0];
  if (existing) return existing;
  let cLegs = quote.legs;
  if (flown) {
    cLegs = cLegs.map((l) => {
      const off = Date.parse(l.depart_at) + 10 * 60000;
      return { ...l, block_off: toISTISO(off), block_on: toISTISO(off + Math.round(l.flight_hours * 3600000)) };
    });
  }
  const charter_no = await nextNumber('CH');
  const crewId = (n) => (n ? c.crew[n].id : null);
  const ops = c.users['ops@meridian.test'];
  const { rows } = await pool.query(
    `INSERT INTO charters (charter_no, quote_id, member_id, aircraft_id, legs, starts_on, ends_on, pax, status, captain_id, first_officer_id, cabin_crew_id,
       defects, confirmed_at, flown_at, closed_at, cancelled_at, cancel_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
       CASE WHEN $9 IN ('confirmed','manifest_complete','flown','closed') THEN now() END,
       CASE WHEN $9 IN ('flown','closed') THEN now() END,
       CASE WHEN $9 = 'closed' THEN now() END,
       CASE WHEN $9 = 'cancelled' THEN now() END, $14)
     RETURNING *`,
    [charter_no, quote.id, quote.member_id, quote.aircraft_id, JSON.stringify(cLegs), quote.starts_on, quote.ends_on, pax, status,
      crewId(crew?.[0]), crewId(crew?.[1]), crewId(crew?.[2]), defects, status === 'cancelled' ? cancelReason || 'Plans changed' : null]);
  const ch = rows[0];
  const ev = async (action, detail = {}) => pool.query(
    `INSERT INTO events (entity_type, entity_id, action, actor_user_id, detail) VALUES ('charter',$1,$2,$3,$4)`, [ch.id, action, ops, JSON.stringify({ ...detail, seed: true })]);
  await ev('accepted', { charter_no });
  if (crew) await ev('crew_assigned');
  if (['confirmed', 'manifest_complete', 'flown', 'closed'].includes(status)) await ev('confirmed');
  for (const p of passengers) {
    await pool.query('INSERT INTO passengers (charter_id, full_name, id_type, id_number, nationality, phone) VALUES ($1,$2,$3,$4,$5,$6)',
      [ch.id, p[0], p[1], p[2], p[3] || 'Indian', p[4] || null]);
  }
  if (passengers.length) await ev('manifest_updated', { count: passengers.length });
  if (['manifest_complete', 'flown', 'closed'].includes(status)) await ev('manifest_submitted');
  if (['flown', 'closed'].includes(status)) await ev('flown');
  const invoice_no = await nextNumber('INV');
  const issued = addDays(todayIST(), issuedOffset);
  const inv = (await pool.query(
    `INSERT INTO invoices (invoice_no, charter_id, member_id, subtotal, gst_rate_pct, gst_amount, total, issued_on, due_on, status, paid_on, payment_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [invoice_no, ch.id, quote.member_id, quote.subtotal, quote.gst_rate_pct, quote.gst_amount, quote.total, issued,
      addDays(issued, Number(c.settings.invoice_due_days) || 7), status === 'cancelled' ? 'cancelled' : invoiceStatus,
      invoiceStatus === 'paid' ? addDays(issued, 2) : null, invoiceStatus === 'paid' ? 'NEFT-DEMO-0001' : null])).rows[0];
  await pool.query(`INSERT INTO events (entity_type, entity_id, action, actor_user_id, detail) VALUES ('invoice',$1,'issued',$2,$3)`,
    [inv.id, ops, JSON.stringify({ invoice_no, seed: true })]);
  if (invoiceStatus === 'paid') {
    await pool.query(`INSERT INTO events (entity_type, entity_id, action, actor_user_id, detail) VALUES ('invoice',$1,'paid',$2,$3)`,
      [inv.id, c.users['sales@meridian.test'], JSON.stringify({ seed: true })]);
  }
  if (status === 'closed') await ev('closed', { reason: 'invoice paid' });
  if (status === 'cancelled') {
    await ev('cancelled', { reason: cancelReason || 'Plans changed' });
    await pool.query(`INSERT INTO events (entity_type, entity_id, action, actor_user_id, detail) VALUES ('invoice',$1,'cancelled',$2,$3)`,
      [inv.id, ops, JSON.stringify({ reason: 'charter cancelled', seed: true })]);
  }
  return ch;
}

async function seedFlows() {
  const c = await ctx();
  const sales = c.users['sales@meridian.test'];

  // 2 open requests
  await createRequest(c, 'open-1', 'MC-1001', [
    { from: 'BOM', to: 'UDR', depart_at: at(21, '09:00') },
    { from: 'UDR', to: 'BOM', depart_at: at(24, '17:30') },
  ], 6, 'Family trip to Udaipur, two nights.', c.users['arjun.mehra@example.in']);
  await createRequest(c, 'open-2', 'MC-1013', [
    { from: 'DEL', to: 'IXC', depart_at: at(14, '08:00') },
  ], 3, 'Board meeting, one-way.', sales);

  // 1 sent quote (request → quoted)
  const { request: sentReq } = await createRequest(c, 'sent-1', 'MC-1011', [
    { from: 'BOM', to: 'GOI', depart_at: at(30, '10:00') },
    { from: 'GOI', to: 'BOM', depart_at: at(33, '16:00') },
  ], 8, 'Offsite in Goa for leadership team.', c.users['rajiv.malhotra@example.in'], 'quoted');
  await createQuote(c, sentReq, 'VT-MCB', 'sent', { adjustment_inr: -50000, adjustment_note: 'Platinum loyalty discount' });

  // 1 accepted charter (awaiting ops confirmation)
  await createCharter(c, 'accepted-1', {
    memberNo: 'MC-1001', reg: 'VT-MCB', pax: 4, status: 'accepted',
    legs: [{ from: 'BOM', to: 'BLR', depart_at: at(10, '07:30') }, { from: 'BLR', to: 'BOM', depart_at: at(10, '19:00') }],
  });

  // 1 confirmed charter with manifest (pilot1's captain)
  await createCharter(c, 'confirmed-1', {
    memberNo: 'MC-1011', reg: 'VT-MCA', pax: 3, status: 'confirmed', crew: [CAPTAINS[0], FOS[0], CABIN[0]],
    legs: [{ from: 'DEL', to: 'JAI', depart_at: at(5, '09:00') }, { from: 'JAI', to: 'DEL', depart_at: at(6, '18:00') }],
    passengers: [
      ['Rajiv Malhotra', 'passport', 'Z1234567'],
      ['Anjali Malhotra', 'aadhaar', '432187659012'],
      ['Dev Malhotra', 'pan', 'ABCPM1234K'],
    ],
  });

  // 1 flown charter with unpaid invoice (pilot1's captain)
  await createCharter(c, 'flown-1', {
    memberNo: 'MC-1014', reg: 'VT-MCD', pax: 5, status: 'flown', crew: [CAPTAINS[0], FOS[3], CABIN[3]], flown: true, issuedOffset: -10,
    legs: [{ from: 'HYD', to: 'GOI', depart_at: at(-3, '10:00') }, { from: 'GOI', to: 'HYD', depart_at: at(-2, '15:00') }],
    passengers: [
      ['Lakshmi Varma', 'passport', 'M7654321'],
      ['Suresh Varma', 'aadhaar', '998877665544'],
      ['Kiran Rao', 'driving_licence', 'TS0920190012345'],
      ['Padma Reddy', 'voter_id', 'ABC1234567'],
      ['Arvind Kumar', 'pan', 'AKPPK9876Q'],
    ],
    defects: 'Cabin reading light seat 3A inoperative.',
  });

  // 1 closed charter (paid)
  await createCharter(c, 'closed-1', {
    memberNo: 'MC-1005', reg: 'VT-MCC', pax: 2, status: 'closed', crew: [CAPTAINS[2], FOS[2], null], flown: true, invoiceStatus: 'paid', issuedOffset: -30,
    legs: [{ from: 'DEL', to: 'BLR', depart_at: at(-20, '11:00') }, { from: 'BLR', to: 'DEL', depart_at: at(-18, '12:00') }],
    passengers: [['Vikram Sethi', 'passport', 'P5556667'], ['Rina Sethi', 'passport', 'P5556668']],
  });

  // 1 maintenance block (covers today)
  const mbAc = c.ac['VT-MCH'];
  const exists = await pool.query(`SELECT 1 FROM maintenance_blocks WHERE aircraft_id = $1 AND reason LIKE '%[demo]%'`, [mbAc.id]);
  if (!exists.rows.length) {
    const { rows } = await pool.query(
      `INSERT INTO maintenance_blocks (aircraft_id, starts_on, ends_on, reason, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [mbAc.id, addDays(todayIST(), -1), addDays(todayIST(), 4), 'Scheduled A-check [demo]', c.users['ops@meridian.test']]);
    await pool.query(`INSERT INTO events (entity_type, entity_id, action, actor_user_id, detail) VALUES ('maintenance',$1,'created',$2,$3)`,
      [rows[0].id, c.users['ops@meridian.test'], JSON.stringify({ seed: true })]);
  }
}

// ── v1.1 richer demo: a busy fleet + empty legs ─────────────────────────────
// Every item has a stable natural key (seed_key on the request event, a [seed:…] tag in notes/reason,
// guest email for public requests), so re-running never duplicates anything.

async function seedMaintenance(c, reg, startOffset, endOffset, reason) {
  const ac = c.ac[reg];
  const exists = await pool.query('SELECT 1 FROM maintenance_blocks WHERE aircraft_id = $1 AND reason = $2', [ac.id, reason]);
  if (exists.rows.length) return;
  const starts = addDays(todayIST(), startOffset);
  const ends = addDays(todayIST(), endOffset);
  const clash = await aircraftClash(ac.id, starts, ends);
  if (clash.length) { console.warn(`  [seed] skip maintenance ${reg}: busy (${clash.join(', ')})`); return; }
  const { rows } = await pool.query(
    'INSERT INTO maintenance_blocks (aircraft_id, starts_on, ends_on, reason, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [ac.id, starts, ends, reason, c.users['ops@meridian.test']]);
  await pool.query(`INSERT INTO events (entity_type, entity_id, action, actor_user_id, detail) VALUES ('maintenance',$1,'created',$2,$3)`,
    [rows[0].id, c.users['ops@meridian.test'], JSON.stringify({ seed: true })]);
}

const PAX = {
  oberoi: [['Karan Oberoi', 'passport', 'N4455667'], ['Ritu Oberoi', 'passport', 'N4455668'], ['Sameer Khanna', 'aadhaar', '556677889900'],
    ['Alisha Dutta', 'pan', 'BCDPD4321L'], ['Naveen Rao', 'driving_licence', 'MH0220150098765'], ['Farah Ali', 'passport', 'R1239876']],
  deshpande: [['Tanvi Deshpande', 'passport', 'T7788990'], ['Omkar Joshi', 'aadhaar', '665544332211'], ['Leena Shah', 'pan', 'CDEPS5678M'],
    ['Rohit Kamat', 'voter_id', 'MHV1234567'], ['Esha Pai', 'passport', 'T7788991']],
  joshi: [['Aditya Joshi', 'passport', 'J1122334'], ['Mitali Joshi', 'aadhaar', '112233445566'], ['Varun Saini', 'pan', 'DEFPS6789N'], ['Kriti Bajaj', 'passport', 'J1122335']],
};

async function seedRichFlows() {
  const c = await ctx();
  const sales = c.users['sales@meridian.test'];
  await seedMaintenance(c, 'VT-MCK', -20, -17, 'Avionics software update [seed:mb-mck]');
  await seedMaintenance(c, 'VT-MCQ', 12, 15, 'Engine borescope inspection [seed:mb-mcq]');

  const L = (from, to, day, hhmm) => ({ from, to, depart_at: at(day, hhmm) });
  const plan = [
    // ── Past: closed (paid) and flown (unpaid)
    ['v11-p01', { memberNo: 'MC-1012', reg: 'VT-MCE', pax: 6, status: 'closed', invoiceStatus: 'paid', issuedOffset: -65, flown: true, legs: [L('DEL', 'BOM', -58, '08:00'), L('BOM', 'DEL', -56, '18:00')] }],
    ['v11-p02', { memberNo: 'MC-1004', reg: 'VT-MCG', pax: 4, status: 'closed', invoiceStatus: 'paid', issuedOffset: -58, flown: true, legs: [L('BLR', 'GOI', -52, '10:00'), L('GOI', 'BLR', -50, '16:00')] }],
    ['v11-p03', { memberNo: 'MC-1017', reg: 'VT-MCF', pax: 8, status: 'closed', invoiceStatus: 'paid', issuedOffset: -54, flown: true, legs: [L('BOM', 'UDR', -47, '09:30'), L('UDR', 'BOM', -45, '17:00')] }],
    ['v11-p04', { memberNo: 'MC-1015', reg: 'VT-MCL', pax: 3, status: 'closed', invoiceStatus: 'paid', issuedOffset: -46, flown: true, legs: [L('HYD', 'DEL', -41, '07:00')] }],
    ['v11-p05', { memberNo: 'MC-1020', reg: 'VT-MCI', pax: 7, status: 'closed', invoiceStatus: 'paid', issuedOffset: -42, flown: true, legs: [L('DEL', 'COK', -36, '08:00'), L('COK', 'DEL', -33, '15:00')] }],
    ['v11-p06', { memberNo: 'MC-1021', reg: 'VT-MCJ', pax: 9, status: 'closed', invoiceStatus: 'paid', issuedOffset: -35, flown: true, legs: [L('BOM', 'JAI', -30, '11:00'), L('JAI', 'BOM', -29, '17:00')] }],
    ['v11-p07', { memberNo: 'MC-1002', reg: 'VT-MCO', pax: 5, status: 'closed', invoiceStatus: 'paid', issuedOffset: -30, flown: true, legs: [L('MAA', 'GOI', -25, '09:00'), L('GOI', 'MAA', -23, '16:00')] }],
    ['v11-p08', { memberNo: 'MC-1024', reg: 'VT-MCM', pax: 4, status: 'closed', invoiceStatus: 'paid', issuedOffset: -24, flown: true, legs: [L('DEL', 'LKO', -18, '08:30'), L('LKO', 'DEL', -18, '19:00')] }],
    ['v11-p09', { memberNo: 'MC-1007', reg: 'VT-MCP', pax: 2, status: 'flown', issuedOffset: -20, flown: true, legs: [L('HYD', 'BOM', -14, '09:00'), L('BOM', 'HYD', -12, '18:00')] }],
    ['v11-p10', { memberNo: 'MC-1010', reg: 'VT-MCS', pax: 6, status: 'flown', issuedOffset: -15, flown: true, legs: [L('BLR', 'COK', -9, '10:00'), L('COK', 'BLR', -7, '15:00')] }],
    ['v11-p11', { memberNo: 'MC-1018', reg: 'VT-MCQ', pax: 5, status: 'closed', invoiceStatus: 'paid', issuedOffset: -12, flown: true, legs: [L('DEL', 'AMD', -6, '07:30'), L('AMD', 'DEL', -6, '20:00')] }],
    ['v11-c01', { memberNo: 'MC-1016', reg: 'VT-MCN', pax: 4, status: 'cancelled', issuedOffset: -20, cancelReason: 'Event postponed by the client', legs: [L('BOM', 'GOI', -11, '10:00'), L('GOI', 'BOM', -10, '18:00')] }],
    // ── Upcoming
    ['v11-f01', { memberNo: 'MC-1013', reg: 'VT-MCR', pax: 6, status: 'manifest_complete', passengers: PAX.oberoi, legs: [L('BOM', 'DEL', 2, '09:00'), L('DEL', 'BOM', 3, '17:00')] }],
    ['v11-f02', { memberNo: 'MC-1006', reg: 'VT-MCN', pax: 8, status: 'confirmed', legs: [L('PNQ', 'GOI', 4, '10:00'), L('GOI', 'PNQ', 6, '16:00')] }],
    ['v11-f14', { memberNo: 'MC-1015', reg: 'VT-MCO', pax: 4, status: 'manifest_complete', passengers: PAX.joshi, legs: [L('BLR', 'BOM', 5, '08:00'), L('BOM', 'BLR', 5, '20:00')] }],
    ['v11-f03', { memberNo: 'MC-1019', reg: 'VT-MCI', pax: 10, status: 'confirmed', legs: [L('BOM', 'GOI', 8, '10:00'), L('GOI', 'BOM', 10, '15:00')] }],
    ['v11-f08', { memberNo: 'MC-1008', reg: 'VT-MCD', pax: 3, status: 'accepted', legs: [L('HYD', 'MAA', 9, '08:00'), L('MAA', 'HYD', 9, '19:00')] }],
    ['v11-f04', { memberNo: 'MC-1014', reg: 'VT-MCT', pax: 7, status: 'confirmed', legs: [L('CCU', 'DEL', 11, '09:00')] }],
    ['v11-f05', { memberNo: 'MC-1022', reg: 'VT-MCK', pax: 5, status: 'manifest_complete', passengers: PAX.deshpande, legs: [L('MAA', 'COK', 14, '09:00'), L('COK', 'MAA', 16, '17:00')] }],
    ['v11-c02', { memberNo: 'MC-1010', reg: 'VT-MCS', pax: 5, status: 'cancelled', issuedOffset: -3, cancelReason: 'Client travel plans changed', legs: [L('BLR', 'GOI', 15, '10:00'), L('GOI', 'BLR', 17, '16:00')] }],
    ['v11-f06', { memberNo: 'MC-1011', reg: 'VT-MCA', pax: 4, status: 'confirmed', legs: [L('LKO', 'BOM', 17, '10:00'), L('BOM', 'LKO', 19, '16:00')] }],
    ['v11-f07', { memberNo: 'MC-1005', reg: 'VT-MCJ', pax: 6, status: 'confirmed', legs: [L('DEL', 'GOI', 20, '09:00'), L('GOI', 'DEL', 23, '15:00')] }],
    ['v11-f09', { memberNo: 'MC-1025', reg: 'VT-MCE', pax: 2, status: 'accepted', legs: [L('DEL', 'BLR', 25, '09:00'), L('BLR', 'DEL', 27, '18:00')] }],
    ['v11-f13', { memberNo: 'MC-1017', reg: 'VT-MCF', pax: 9, status: 'confirmed', legs: [L('BOM', 'COK', 26, '10:00'), L('COK', 'BOM', 28, '15:00')] }],
    ['v11-f10', { memberNo: 'MC-1003', reg: 'VT-MCG', pax: 4, status: 'accepted', legs: [L('BLR', 'DEL', 30, '10:00'), L('DEL', 'BLR', 32, '17:00')] }],
    ['v11-f11', { memberNo: 'MC-1012', reg: 'VT-MCL', pax: 6, status: 'confirmed', legs: [L('HYD', 'GOI', 35, '09:00'), L('GOI', 'HYD', 38, '16:00')] }],
    ['v11-f12', { memberNo: 'MC-1020', reg: 'VT-MCM', pax: 8, status: 'accepted', legs: [L('DEL', 'UDR', 42, '09:30'), L('UDR', 'DEL', 44, '17:00')] }],
  ];
  const charters = {};
  for (const [key, spec] of plan) charters[key] = await createCharter(c, key, { crew: 'auto', ...spec });

  // ── Open requests (~8 total) and sent quotes (~6 total, two expiring within 24h)
  const openReqs = [
    ['v11-open-1', 'MC-1002', [L('MAA', 'BLR', 12, '08:00'), L('BLR', 'MAA', 12, '19:00')], 4, 'Day trip for a site visit.'],
    ['v11-open-2', 'MC-1018', [L('AMD', 'DEL', 18, '07:00')], 6, 'Steel expo, one-way.'],
    ['v11-open-3', 'MC-1022', [L('BOM', 'UDR', 27, '10:00'), L('UDR', 'BOM', 29, '16:00')], 12, 'Destination wedding scouting, full aircraft.'],
    ['v11-open-4', 'MC-1008', [L('DEL', 'IXC', 9, '09:00'), L('IXC', 'DEL', 9, '18:30')], 2, null],
    ['v11-open-5', 'MC-1016', [L('BOM', 'CCU', 33, '08:30'), L('CCU', 'BOM', 35, '17:00')], 5, 'Film festival screening.'],
    ['v11-open-6', 'MC-1025', [L('DEL', 'GOI', 40, '11:00')], 3, 'Prefer Gulfstream if available.'],
  ];
  for (const [key, no, legs, pax, note] of openReqs) await createRequest(c, key, no, legs, pax, note, sales);
  const sentQuotes = [
    ['v11-sent-1', 'MC-1013', [L('DEL', 'BOM', 22, '08:00'), L('BOM', 'DEL', 23, '18:00')], 5, 'VT-MCE', 30, 'Board meeting in Mumbai.'],
    ['v11-sent-2', 'MC-1006', [L('PNQ', 'BLR', 19, '09:00')], 4, 'VT-MCC', 40, 'One-way, flexible by an hour.'],
    ['v11-sent-3', 'MC-1021', [L('JAI', 'UDR', 28, '10:00'), L('UDR', 'JAI', 30, '15:00')], 8, 'VT-MCI', 6, 'Royal Route Tours group.'],
    ['v11-sent-4', 'MC-1004', [L('BLR', 'GOI', 36, '10:00'), L('GOI', 'BLR', 38, '16:00')], 6, 'VT-MCS', 10, 'Long weekend.'],
    ['v11-sent-5', 'MC-1024', [L('LKO', 'DEL', 16, '07:30'), L('DEL', 'LKO', 16, '20:00')], 3, 'VT-MCQ', 2, 'Trustee meeting.'],
  ];
  for (const [key, no, legs, pax, reg, sentAgo, note] of sentQuotes) {
    const { request } = await createRequest(c, key, no, legs, pax, note, c.users['sales@meridian.test'], 'quoted');
    await createQuote(c, request, reg, 'sent', { sentAgoHours: sentAgo });
  }

  await seedEmptyLegs(c, charters);
}

async function seedEmptyLegs(c, charters) {
  const ops = c.users['ops@meridian.test'];
  const sales = c.users['sales@meridian.test'];
  const legEvent = (id, action, actor, detail = {}) => pool.query(
    `INSERT INTO events (entity_type, entity_id, action, actor_user_id, detail) VALUES ('empty_leg',$1,$2,$3,$4)`, [id, action, actor, JSON.stringify({ ...detail, seed: true })]);

  // Generate draft legs for every seeded upcoming charter with positioning (idempotent per charter + source_leg).
  for (const ch of Object.values(charters)) {
    if (!ch || !['accepted', 'confirmed', 'manifest_complete'].includes(ch.status)) continue;
    await withTransaction((client) => generateForCharter(ch, ops, client));
  }
  const findLeg = async (key, source_leg) => {
    if (!charters[key]) return null;
    return (await pool.query('SELECT * FROM empty_legs WHERE source_charter_id = $1 AND source_leg = $2', [charters[key].id, source_leg])).rows[0] || null;
  };
  // Seed only moves legs out of 'draft', so reruns (or legs staff already handled) are left alone.
  const publish = async (leg) => {
    if (!leg || leg.status !== 'draft') return leg;
    const r = (await pool.query(`UPDATE empty_legs SET status = 'published', published_at = now() WHERE id = $1 AND status = 'draft' AND depart_latest > now() + interval '6 hours' RETURNING *`, [leg.id])).rows[0];
    if (r) await legEvent(r.id, 'published', sales);
    return r || leg;
  };
  const withdraw = async (leg, reason) => {
    if (!leg || leg.status !== 'draft') return;
    await pool.query(`UPDATE empty_legs SET status = 'withdrawn', withdrawn_reason = $2 WHERE id = $1`, [leg.id, reason]);
    await legEvent(leg.id, 'withdrawn', ops, { reason });
  };

  const states = [
    ['v11-f02', 'positioning_out', 'published'], ['v11-f02', 'positioning_back', 'published'],
    ['v11-f03', 'positioning_out', 'published'], ['v11-f03', 'positioning_back', 'published'],
    ['v11-f04', 'positioning_out', 'published'], ['v11-f04', 'positioning_back', 'member_booked'],
    ['v11-f05', 'positioning_out', 'published'], ['v11-f05', 'positioning_back', 'withdrawn'],
    ['v11-f06', 'positioning_out', 'public_booked'], ['v11-f06', 'positioning_back', 'published'],
    ['v11-f07', 'positioning_out', 'published'], ['v11-f07', 'positioning_back', 'draft'],
  ];
  const legs = {};
  for (const [key, src, state] of states) {
    let leg = await findLeg(key, src);
    if (!leg) continue;
    if (state === 'withdrawn') await withdraw(leg, 'Aircraft needed for a maintenance ferry');
    else if (state !== 'draft') leg = await publish(leg);
    legs[`${key}:${src}`] = { leg, state };
  }

  // Two manual published legs on popular routes + one manual draft.
  const manual = [
    ['seed:manual-del-jai', 'VT-MCQ', 'DEL', 'JAI', 9, '10:00', '14:00', 'published'],
    ['seed:manual-bom-goi', 'VT-MCB', 'BOM', 'GOI', 16, '08:00', '12:00', 'published'],
    ['seed:manual-blr-cok', 'VT-MCC', 'BLR', 'COK', 19, '09:00', '13:00', 'draft'],
  ];
  for (const [tag, reg, from, to, day, t1, t2, state] of manual) {
    const ac = c.ac[reg];
    let leg = (await pool.query(`SELECT * FROM empty_legs WHERE notes LIKE $1`, [`%[${tag}]%`])).rows[0];
    if (!leg) {
      const price = priceEmptyLeg({ from, to, aircraft: ac, airports: c.airports, settings: c.settings });
      const leg_no = await nextNumber('EL');
      leg = (await pool.query(
        `INSERT INTO empty_legs (leg_no, aircraft_id, from_code, to_code, depart_earliest, depart_latest, flight_hours, distance_nm, seats,
           list_price_inr, price_inr, status, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft',$12,$13) RETURNING *`,
        [leg_no, ac.id, from, to, parseIST(at(day, t1)), parseIST(at(day, t2)), price.flight_hours, price.distance_nm, ac.seats,
          price.list_price_inr, price.price_inr, `Ferry flight after maintenance — flexible within the window [${tag}]`, ops])).rows[0];
      await legEvent(leg.id, 'created', ops, { leg_no, manual: true });
    }
    if (state === 'published') leg = await publish(leg);
    legs[tag] = { leg, state };
  }

  const request = async (leg, guest) => {
    if (!leg || leg.status !== 'published') return null;
    const existing = (await pool.query('SELECT * FROM empty_leg_bookings WHERE lower(guest_email) = $1 AND empty_leg_id = $2', [guest.email, leg.id])).rows[0];
    if (existing) return existing;
    const booking_no = await nextNumber('ELB');
    const row = (await pool.query(
      `INSERT INTO empty_leg_bookings (booking_no, empty_leg_id, channel, guest_name, guest_email, guest_phone, guest_company, pax, message, status, created_at)
       VALUES ($1,$2,'public',$3,$4,$5,$6,$7,$8,'requested', now() - make_interval(hours => $9)) RETURNING *`,
      [booking_no, leg.id, guest.name, guest.email, guest.phone, guest.company || null, guest.pax, guest.message || null, guest.agoHours || 3])).rows[0];
    await pool.query(`INSERT INTO events (entity_type, entity_id, action, detail) VALUES ('empty_leg_booking',$1,'requested',$2)`,
      [row.id, JSON.stringify({ booking_no, channel: 'public', seed: true })]);
    return row;
  };

  // Member instant booking (Arjun Mehra) on a published generated leg.
  const mb = legs['v11-f04:positioning_back'];
  if (mb && mb.leg.status === 'published') {
    const member = (await pool.query(`SELECT * FROM members WHERE member_no = 'MC-1001'`)).rows[0];
    await withTransaction((client) => bookLegTx(client, { legId: mb.leg.id, member, pax: 4, channel: 'member', actorUserId: c.users['arjun.mehra@example.in'], message: 'Seed: member instant booking' }));
  }

  // Public request confirmed by sales (creates a new member); a competing request on the same leg is auto-rejected.
  const pb = legs['v11-f06:positioning_out'];
  if (pb && pb.leg.status === 'published') {
    await request(pb.leg, { name: 'Ishaan Mehta', email: 'ishaan.mehta@example.in', phone: '+91 98200 11223', pax: 2, agoHours: 30 });
    const rhea = await request(pb.leg, { name: 'Rhea Kapur', email: 'rhea.kapur@example.in', phone: '+91 98100 44556', company: 'Lumen Studio LLP', pax: 5,
      message: 'Team offsite — can we leave around 7?', agoHours: 26 });
    if (rhea && rhea.status === 'requested') {
      await withTransaction(async (client) => {
        const b = (await client.query('SELECT * FROM empty_leg_bookings WHERE id = $1 FOR UPDATE', [rhea.id])).rows[0];
        const { member } = await findOrCreateMemberForBooking(client, b, sales);
        await bookLegTx(client, { legId: b.empty_leg_id, member, pax: b.pax, channel: 'public', actorUserId: sales, bookingId: b.id });
      });
    }
  }

  // Three pending public requests.
  await request(legs['v11-f03:positioning_out']?.leg, { name: 'Vivek Anand', email: 'vivek.anand@example.in', phone: '+91 99300 77889', pax: 3, message: 'Is a 6am departure possible?', agoHours: 5 });
  await request(legs['seed:manual-del-jai']?.leg, { name: 'Shreya Ghosh', email: 'shreya.ghosh@example.in', phone: '+91 98300 66554', pax: 2, agoHours: 2 });
  await request(legs['v11-f06:positioning_back']?.leg, { name: 'Kabir Sood', email: 'kabir.sood@example.in', phone: '+91 98110 22334', company: 'Sood & Rao Advisory', pax: 6, message: 'Client visit, returning same week.', agoHours: 1 });
}

// ── v1.2: 90 days of flying history so fleet utilisation reads like a busy operator ──
// Deterministic per aircraft (fixed PRNG seed), natural key 'v12-h-<REG>-<n>' on the request's seed event.
// Trips start and end at the aircraft's home base (no positioning), so each occupies exactly its own days.
// Anything that would clash with an existing charter, maintenance block or busy crew is skipped, so this is
// safe on a v1.0-seeded DB and on one that already ran the v1.1 seed.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HISTORY_DESTS = {
  DEL: ['BOM', 'BLR', 'GOI', 'JAI', 'UDR', 'IXC', 'LKO', 'AMD', 'CCU', 'HYD', 'COK'],
  BOM: ['DEL', 'GOI', 'UDR', 'BLR', 'HYD', 'AMD', 'JAI', 'COK', 'PNQ', 'CCU'],
  BLR: ['BOM', 'DEL', 'GOI', 'COK', 'HYD', 'MAA', 'PNQ', 'CCU'],
  HYD: ['DEL', 'BOM', 'GOI', 'BLR', 'MAA', 'COK', 'CCU', 'AMD'],
};
const HISTORY_TIMES = ['07:30', '08:00', '09:00', '10:00', '11:00'];
const RETURN_TIMES = ['15:00', '16:00', '17:30', '18:00', '19:00'];
const GUEST_NAMES = ['Aarti Shah', 'Nikhil Batra', 'Sonia Dsouza', 'Rakesh Iyer', 'Gita Menon', 'Prakash Rao', 'Hema Pillai', 'Zubin Irani',
  'Anil Chopra', 'Kavita Bhat', 'Sunil Nair', 'Radhika Sen', 'Vinod Kumar', 'Mira Gill', 'Ajay Tandon', 'Seema Arora'];

async function seedHistory() {
  const c = await ctx();
  const members = (await pool.query(`SELECT member_no FROM members WHERE status = 'active' AND member_no ~ '^MC-10[0-2][0-9]$' ORDER BY member_no`)).rows.map((r) => r.member_no);
  const regs = Object.keys(c.ac).filter((r) => /^VT-MC[A-T]$/.test(r)).sort();
  let made = 0;
  for (const [ai, reg] of regs.entries()) {
    const ac = c.ac[reg];
    const rand = prng(1000 + ai * 7919);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    let day = -90 + Math.floor(rand() * 3);
    for (let n = 1; day <= -2; n++) {
      const len = pick([1, 2, 2, 3, 3, 3, 4, 4, 5]); // calendar days away from base
      const endDay = day + len - 1;
      if (endDay > -1) break;
      const dests = HISTORY_DESTS[ac.home_base];
      const a = pick(dests);
      const legs = [{ from: ac.home_base, to: a, depart_at: at(day, pick(HISTORY_TIMES)) }];
      if (len >= 3 && rand() < 0.35) {
        const b = pick(dests.filter((x) => x !== a));
        legs.push({ from: a, to: b, depart_at: at(day + 1, pick(HISTORY_TIMES)) });
        legs.push({ from: b, to: ac.home_base, depart_at: at(endDay, pick(RETURN_TIMES)) });
      } else {
        legs.push({ from: a, to: ac.home_base, depart_at: at(endDay, pick(RETURN_TIMES)) });
      }
      const pax = 2 + Math.floor(rand() * Math.max(1, ac.seats - 2));
      const memberNo = pick(members);
      // Paid and closed, except some trips in the last two weeks still awaiting payment.
      const recent = endDay >= -14;
      const paid = !recent || rand() < 0.4;
      const issuedOffset = day - 3 - Math.floor(rand() * 10);
      const paxNames = Array.from({ length: Math.min(pax, 3) }, (_, i) => [GUEST_NAMES[(ai * 3 + n + i) % GUEST_NAMES.length], 'aadhaar', String(400000000000 + ai * 100000 + n * 10 + i)]);
      const gap = pick([0, 1, 1, 1, 2, 2, 3, 4]);
      const key = `v12-h-${reg}-${n}`;
      const ch = await createCharter(c, key, {
        memberNo, reg, pax, legs, crew: 'auto', flown: true, passengers: paxNames, issuedOffset,
        status: paid ? 'closed' : 'flown', invoiceStatus: paid ? 'paid' : 'unpaid', note: 'Demo history',
        quiet: true,
      });
      if (ch) made++;
      day = endDay + 1 + gap;
    }
  }
  return made;
}

async function main() {
  console.log('Meridian Charters — demo seed');
  await initDB(); // also inserts default settings if missing
  await seedAirports();
  await seedAircraft();
  await seedCrew();
  const n = await seedMembers();
  await seedUsers();
  await seedFlows();
  await seedRichFlows();
  await seedHistory();
  const counts = (await pool.query(`SELECT
    (SELECT count(*) FROM airports) airports, (SELECT count(*) FROM aircraft) aircraft, (SELECT count(*) FROM crew_members) crew,
    (SELECT count(*) FROM members) members, (SELECT count(*) FROM users) users, (SELECT count(*) FROM quote_requests) requests,
    (SELECT count(*) FROM quotes) quotes, (SELECT count(*) FROM charters) charters, (SELECT count(*) FROM invoices) invoices,
    (SELECT count(*) FROM maintenance_blocks) maintenance, (SELECT count(*) FROM empty_legs) empty_legs,
    (SELECT count(*) FROM empty_leg_bookings) empty_leg_bookings`)).rows[0];
  console.log(`CSV members: ${n}`);
  console.log('Totals:', counts);
  console.log(`Demo password for all seeded users: ${PASSWORD}`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('Seed failed:', err);
  try { await pool.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
