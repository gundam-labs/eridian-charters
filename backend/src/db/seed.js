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
const { pool, initDB, getSettings } = require('./index');
const { priceQuote } = require('../lib/pricing');
const { nextNumber } = require('../lib/numbers');
const { todayIST, addDays, parseIST, toISTISO } = require('../lib/time');

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

async function createCharter(c, key, { memberNo, legs, pax, reg, status, crew, passengers = [], invoiceStatus = 'unpaid', issuedOffset = 0, flown = false, defects = null }) {
  const { request } = await createRequest(c, key, memberNo, legs, pax, 'Demo charter', c.users['sales@meridian.test'], 'closed');
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
       defects, confirmed_at, flown_at, closed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
       CASE WHEN $9 IN ('confirmed','manifest_complete','flown','closed') THEN now() END,
       CASE WHEN $9 IN ('flown','closed') THEN now() END,
       CASE WHEN $9 = 'closed' THEN now() END)
     RETURNING *`,
    [charter_no, quote.id, quote.member_id, quote.aircraft_id, JSON.stringify(cLegs), quote.starts_on, quote.ends_on, pax, status,
      crewId(crew?.[0]), crewId(crew?.[1]), crewId(crew?.[2]), defects]);
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
      addDays(issued, Number(c.settings.invoice_due_days) || 7), invoiceStatus,
      invoiceStatus === 'paid' ? addDays(issued, 2) : null, invoiceStatus === 'paid' ? 'NEFT-DEMO-0001' : null])).rows[0];
  await pool.query(`INSERT INTO events (entity_type, entity_id, action, actor_user_id, detail) VALUES ('invoice',$1,'issued',$2,$3)`,
    [inv.id, ops, JSON.stringify({ invoice_no, seed: true })]);
  if (invoiceStatus === 'paid') {
    await pool.query(`INSERT INTO events (entity_type, entity_id, action, actor_user_id, detail) VALUES ('invoice',$1,'paid',$2,$3)`,
      [inv.id, c.users['sales@meridian.test'], JSON.stringify({ seed: true })]);
  }
  if (status === 'closed') await ev('closed', { reason: 'invoice paid' });
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

async function main() {
  console.log('Meridian Charters — demo seed');
  await initDB(); // also inserts default settings if missing
  await seedAirports();
  await seedAircraft();
  await seedCrew();
  const n = await seedMembers();
  await seedUsers();
  await seedFlows();
  const counts = (await pool.query(`SELECT
    (SELECT count(*) FROM airports) airports, (SELECT count(*) FROM aircraft) aircraft, (SELECT count(*) FROM crew_members) crew,
    (SELECT count(*) FROM members) members, (SELECT count(*) FROM users) users, (SELECT count(*) FROM quote_requests) requests,
    (SELECT count(*) FROM quotes) quotes, (SELECT count(*) FROM charters) charters, (SELECT count(*) FROM invoices) invoices,
    (SELECT count(*) FROM maintenance_blocks) maintenance`)).rows[0];
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
