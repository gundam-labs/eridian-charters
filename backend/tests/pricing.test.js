const test = require('node:test');
const assert = require('node:assert/strict');
const { priceQuote, haversineNm, ceil10 } = require('../src/lib/pricing');
const { resolveSsl } = require('../src/lib/dbSsl');
const { parseIST, istDate } = require('../src/lib/time');

const airports = {
  DEL: { code: 'DEL', lat: 28.5562, lon: 77.1, landing_fee_inr: 22000, handling_fee_inr: 38000 },
  BOM: { code: 'BOM', lat: 19.0896, lon: 72.8656, landing_fee_inr: 20000, handling_fee_inr: 35000 },
  GOI: { code: 'GOI', lat: 15.3808, lon: 73.8314, landing_fee_inr: 12000, handling_fee_inr: 20000 },
  JAI: { code: 'JAI', lat: 26.8242, lon: 75.8122, landing_fee_inr: 10000, handling_fee_inr: 18000 },
};
const settings = { gst_rate_pct: 12, night_halt_fee_inr: 25000, positioning_rate_pct: 100, taxi_allowance_hours: 0.3 };
const jet = { seats: 10, home_base: 'BOM', cruise_speed_kts: 450, hourly_rate_inr: 340000 };

const items = (r, code) => r.line_items.filter((li) => li.code === code);
const sum = (r) => r.line_items.reduce((s, li) => s + li.amount, 0);

test('haversine and ceil10 helpers', () => {
  const d = haversineNm(airports.BOM, airports.DEL);
  assert.ok(d > 600 && d < 630, `BOM-DEL ≈ 614 nm, got ${d}`);
  assert.equal(ceil10(1.21), 1.3);
  assert.equal(ceil10(1.2), 1.2);
  assert.equal(ceil10(0.3000000000004), 0.3);
});

test('single leg from home base: no positioning out (only the ferry home)', () => {
  const r = priceQuote({ legs: [{ from: 'BOM', to: 'DEL', depart_at: '2026-12-01T09:00' }], aircraft: jet, airports, settings, pax: 4 });
  // Starts at home base → no positioning out. One-way to DEL → aircraft ferries back to BOM.
  assert.equal(r.positioning.length, 1);
  assert.equal(r.positioning[0].from, 'DEL');
  assert.equal(r.positioning[0].to, 'BOM');
  assert.equal(r.positioning[0].depart_at, '2026-12-01T11:42:00+05:30');
  const pos = items(r, 'POSITIONING')[0];
  assert.equal(pos.qty, 1.7);
  assert.equal(r.legs[0].distance_nm, Math.round(haversineNm(airports.BOM, airports.DEL)));
  const expectedHours = ceil10(haversineNm(airports.BOM, airports.DEL) / 450 + 0.3);
  assert.equal(r.legs[0].flight_hours, expectedHours); // 1.7
  assert.equal(r.legs[0].depart_at, '2026-12-01T09:00:00+05:30');
  assert.equal(r.legs[0].arrive_at, '2026-12-01T10:42:00+05:30');
  const flight = items(r, 'FLIGHT')[0];
  assert.deepEqual(flight, { code: 'FLIGHT', description: 'Flight time', qty: 1.7, unit: 'hr', rate: 340000, amount: 578000 });
  assert.deepEqual(items(r, 'LANDING').map((l) => l.description), ['Landing fee – DEL', 'Landing fee – BOM']);
  assert.deepEqual(items(r, 'HANDLING').map((l) => l.description), ['Handling – BOM', 'Handling – DEL']);
  assert.equal(items(r, 'NIGHT_HALT').length, 0);
  assert.equal(r.subtotal, 578000 + 578000 + 22000 + 20000 + 35000 + 38000);
  assert.equal(r.subtotal, sum(r));
});

test('round trip from home base: no positioning at all', () => {
  const r = priceQuote({
    legs: [{ from: 'BOM', to: 'DEL', depart_at: '2026-12-01T09:00' }, { from: 'DEL', to: 'BOM', depart_at: '2026-12-01T17:00' }],
    aircraft: jet, airports, settings,
  });
  assert.equal(r.positioning.length, 0);
  assert.equal(items(r, 'POSITIONING').length, 0);
  assert.equal(items(r, 'FLIGHT')[0].qty, 3.4);
  assert.equal(items(r, 'NIGHT_HALT').length, 0);
  assert.equal(r.starts_on, '2026-12-01');
  assert.equal(r.ends_on, '2026-12-01');
  assert.deepEqual(r.warnings, []);
});

test('leg away from home base: positioning out and back', () => {
  const r = priceQuote({ legs: [{ from: 'DEL', to: 'JAI', depart_at: '2026-12-05T10:00' }], aircraft: jet, airports, settings });
  assert.equal(r.positioning.length, 2);
  const [out, back] = r.positioning;
  assert.equal(out.from, 'BOM'); assert.equal(out.to, 'DEL');
  // arrives exactly 1h before the passenger departure
  assert.equal(out.arrive_at, '2026-12-05T09:00:00+05:30');
  assert.equal(back.from, 'JAI'); assert.equal(back.to, 'BOM');
  assert.equal(Date.parse(back.depart_at) - Date.parse(r.legs[0].arrive_at), 3600 * 1000);
  const pos = items(r, 'POSITIONING')[0];
  assert.equal(pos.qty, Math.round((out.flight_hours + back.flight_hours) * 10) / 10);
  assert.equal(pos.rate, 340000);
  assert.equal(pos.amount, Math.round(pos.qty * 340000));
  // landings: DEL (pos out), JAI (pax), BOM (pos back)
  assert.deepEqual(items(r, 'LANDING').map((l) => l.description), ['Landing fee – DEL', 'Landing fee – JAI', 'Landing fee – BOM']);
  // handling only for passenger airports
  assert.deepEqual(items(r, 'HANDLING').map((l) => l.description), ['Handling – DEL', 'Handling – JAI']);
});

test('positioning rate percentage applies', () => {
  const r = priceQuote({ legs: [{ from: 'DEL', to: 'JAI', depart_at: '2026-12-05T10:00' }], aircraft: jet, airports, settings: { ...settings, positioning_rate_pct: 50 } });
  assert.equal(items(r, 'POSITIONING')[0].rate, 170000);
});

test('multi-day trip with night halt', () => {
  const r = priceQuote({
    legs: [
      { from: 'BOM', to: 'GOI', depart_at: '2026-12-10T09:00' },
      { from: 'GOI', to: 'BOM', depart_at: '2026-12-13T16:00' },
    ],
    aircraft: jet, airports, settings,
  });
  assert.equal(r.positioning.length, 0);
  const nh = items(r, 'NIGHT_HALT');
  assert.equal(nh.length, 1);
  assert.deepEqual(nh[0], { code: 'NIGHT_HALT', description: 'Night halt (crew and aircraft)', qty: 3, unit: 'night', rate: 25000, amount: 75000 });
  assert.equal(r.starts_on, '2026-12-10');
  assert.equal(r.ends_on, '2026-12-13');
  // handling once per distinct airport
  assert.equal(items(r, 'HANDLING').length, 2);
  assert.equal(items(r, 'LANDING').length, 2);
});

test('no night halt when the aircraft returns home between legs', () => {
  const r = priceQuote({
    legs: [
      { from: 'BOM', to: 'GOI', depart_at: '2026-12-10T09:00' },
      { from: 'GOI', to: 'BOM', depart_at: '2026-12-10T18:00' },
      { from: 'BOM', to: 'DEL', depart_at: '2026-12-12T09:00' },
    ],
    aircraft: jet, airports, settings,
  });
  assert.equal(items(r, 'NIGHT_HALT').length, 0);
});

test('night halt uses IST calendar dates, not UTC', () => {
  // Arrive 23:00 IST on the 10th (17:30Z), depart 01:00 IST on the 11th (19:30Z, still the 10th in UTC)
  const r = priceQuote({
    legs: [
      { from: 'BOM', to: 'GOI', depart_at: '2026-12-10T22:00' },
      { from: 'GOI', to: 'BOM', depart_at: '2026-12-11T01:00' },
    ],
    aircraft: jet, airports, settings,
  });
  assert.equal(items(r, 'NIGHT_HALT')[0].qty, 1);
});

test('adjustment line (negative) and GST maths', () => {
  const base = priceQuote({ legs: [{ from: 'BOM', to: 'DEL', depart_at: '2026-12-01T09:00' }], aircraft: jet, airports, settings });
  const r = priceQuote({ legs: [{ from: 'BOM', to: 'DEL', depart_at: '2026-12-01T09:00' }], aircraft: jet, airports, settings, adjustment_inr: -12345, adjustment_note: 'Loyalty discount' });
  const adj = items(r, 'ADJUSTMENT');
  assert.equal(adj.length, 1);
  assert.equal(adj[0].description, 'Loyalty discount');
  assert.equal(adj[0].amount, -12345);
  assert.equal(r.subtotal, base.subtotal - 12345);
  assert.equal(r.subtotal, sum(r));
  assert.equal(r.gst_rate_pct, 12);
  assert.equal(r.gst_amount, Math.round(r.subtotal * 0.12));
  assert.equal(r.total, r.subtotal + r.gst_amount);
  // default description
  const r2 = priceQuote({ legs: [{ from: 'BOM', to: 'DEL', depart_at: '2026-12-01T09:00' }], aircraft: jet, airports, settings, adjustment_inr: 5000 });
  assert.equal(items(r2, 'ADJUSTMENT')[0].description, 'Adjustment');
  // zero adjustment omitted
  assert.equal(items(base, 'ADJUSTMENT').length, 0);
});

test('GST rounds to whole rupees', () => {
  const r = priceQuote({ legs: [{ from: 'BOM', to: 'DEL', depart_at: '2026-12-01T09:00' }], aircraft: jet, airports, settings: { ...settings, gst_rate_pct: 18 }, adjustment_inr: 3 });
  assert.equal(r.gst_amount, Math.round(r.subtotal * 0.18));
  assert.ok(Number.isInteger(r.gst_amount));
  assert.ok(r.line_items.every((li) => Number.isInteger(li.amount)));
});

test('pax > seats warning', () => {
  const r = priceQuote({ legs: [{ from: 'BOM', to: 'DEL', depart_at: '2026-12-01T09:00' }], aircraft: jet, airports, settings, pax: 11 });
  assert.deepEqual(r.warnings, ['Passengers exceed aircraft seats']);
  const ok = priceQuote({ legs: [{ from: 'BOM', to: 'DEL', depart_at: '2026-12-01T09:00' }], aircraft: jet, airports, settings, pax: 10 });
  assert.deepEqual(ok.warnings, []);
});

test('unknown airport throws a 400', () => {
  assert.throws(
    () => priceQuote({ legs: [{ from: 'BOM', to: 'XXX', depart_at: '2026-12-01T09:00' }], aircraft: jet, airports, settings }),
    (err) => err.status === 400 && /Unknown airport/.test(err.message)
  );
});

test('accepts full ISO depart_at with offset', () => {
  const a = priceQuote({ legs: [{ from: 'BOM', to: 'DEL', depart_at: '2026-12-01T03:30:00Z' }], aircraft: jet, airports, settings });
  assert.equal(a.legs[0].depart_at, '2026-12-01T09:00:00+05:30');
});

test('IST helpers and SSL policy', () => {
  assert.equal(parseIST('2026-12-01T00:30').toISOString(), '2026-11-30T19:00:00.000Z');
  assert.equal(istDate(new Date('2026-11-30T19:00:00Z')), '2026-12-01');
  assert.equal(parseIST('garbage'), null);
  assert.equal(resolveSsl('postgres://u:p@localhost:5432/db', {}), false);
  assert.equal(resolveSsl('postgres://u:p@127.0.0.1/db', {}), false);
  assert.equal(resolveSsl('postgres://u:p@postgres.railway.internal:5432/railway', {}), false);
  assert.deepEqual(resolveSsl('postgres://u:p@roundhouse.proxy.rlwy.net:12345/railway', {}), { rejectUnauthorized: false });
  assert.equal(resolveSsl('postgres://u:p@db.example.com/db', { PGSSLMODE: 'disable' }), false);
});
