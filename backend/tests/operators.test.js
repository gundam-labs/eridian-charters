/**
 * v1.4 charter operator directory against a running API (BASE_URL, default http://localhost:4000) after
 * `npm run import:operators`. Checks the imported DGCA list against figures read off the PDF, access
 * control, search, the operator detail, and the lister-permit match.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const PASSWORD = process.env.DEMO_PASSWORD || 'Meridian@2026';
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/db/seed-data/dgca-nsop-operators-2026-08-31.json'), 'utf8'));

async function api(token, method, p, body) {
  const res = await fetch(`${BASE_URL}/api${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.data)); return r.data; };
const login = async (email) => ok(await api(null, 'POST', '/auth/login', { email, password: PASSWORD })).token;

test('extracted DGCA data is internally consistent', () => {
  const ops = DATA.operators;
  assert.equal(ops.length, 139);
  assert.deepEqual(ops.map((o) => o.sno), Array.from({ length: 139 }, (_, i) => i + 1), 'S.No. 1–139 with no gaps');
  for (const o of ops) {
    assert.equal(o.aircraft.length, o.aircraft_count, `${o.name}: aircraft rows match the stated count`);
    assert.match(o.aop_no, /^#\d{1,2}\/\d{4}$/, o.name);
    assert.match(o.aop_valid_until, /^\d{4}-\d{2}-\d{2}$/, o.name);
    assert.ok(o.emails.length >= 1, `${o.name}: has an email`);
    for (const e of o.emails) assert.match(e, /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i, `${o.name}: ${e}`);
    assert.ok(!/Aerokalinga/.test(o.address) || o.sno === 1, `${o.name}: no bleed-through of the repeated first row`);
    for (const a of o.aircraft) assert.match(a.registration, /^VT-[A-Z]{3}$/);
  }
  const regs = ops.flatMap((o) => o.aircraft.map((a) => a.registration));
  assert.equal(new Set(regs).size, regs.length, 'registrations are unique');
  assert.equal(regs.length, 471);
});

test('directory API: access, search, detail and lister match', async () => {
  const admin = await login('admin@meridian.test');
  const sales = await login('sales@meridian.test');
  const ops = await login('ops@meridian.test');
  const lister = await login('ops@skyhopaviation.example.in');
  assert.equal((await api(ops, 'GET', '/operators')).status, 403);
  assert.equal((await api(lister, 'GET', '/operators')).status, 403);
  assert.equal((await api(null, 'GET', '/operators')).status, 401);

  const all = ok(await api(admin, 'GET', '/operators'));
  assert.equal(all.operators.length, 139);
  assert.equal(all.totals.aircraft, 471);
  assert.equal(all.source.as_of, '2026-08-31');
  ok(await api(sales, 'GET', '/operators'));

  // Spot checks against the PDF.
  const heligo = ok(await api(admin, 'GET', '/operators?q=Heligo')).operators;
  assert.equal(heligo.length, 1);
  assert.equal(heligo[0].aop_no, '#01/2009');
  assert.equal(heligo[0].aircraft_count, 16);
  const detail = ok(await api(admin, 'GET', `/operators/${heligo[0].id}`));
  assert.equal(detail.aircraft.length, 16);
  assert.ok(detail.aircraft.some((a) => a.registration === 'VT-HLJ' && a.model === 'AS 365 N3' && a.seats === 11));
  assert.deepEqual(detail.emails, ['am@heligo.in']);

  const byReg = ok(await api(admin, 'GET', '/operators?q=VT-ZTT')).operators;
  assert.deepEqual(byReg.map((o) => o.name), ['Zest Aviation Pvt. Ltd.']);
  const balloons = ok(await api(admin, 'GET', '/operators?fleet_type=hot_air_balloon')).operators;
  assert.deepEqual(balloons.map((o) => o.name), ['E-Factor Adventure Tourism (P) Ltd.']);
  assert.equal((await api(admin, 'GET', '/operators?fleet_type=jets')).status, 400);
  assert.equal(ok(await api(admin, 'GET', '/operators?q=%25')).operators.length, 0, 'LIKE wildcards are escaped');

  // A lister who registers with a DGCA permit number (written their own way) is matched.
  const run = Date.now().toString(36);
  ok(await api(null, 'POST', '/auth/register', {
    name: 'Zest Ops', email: `zest-${run}@example.in`, password: 'Sup3rSecret!x', lister_type: 'operator', company: 'Zest Aviation',
    phone: '+91 98765 11111', nsop_permit_no: 'NSOP 7/2012', accept_terms: true,
  }), 201);
  const pend = ok(await api(admin, 'GET', '/listers?status=pending')).find((l) => l.email === `zest-${run}@example.in`);
  assert.equal(pend.dgca_operator?.name, 'Zest Aviation Pvt. Ltd.');
  const zest = ok(await api(admin, 'GET', `/operators/${pend.dgca_operator.id}`));
  assert.ok(zest.listers.some((l) => l.email === `zest-${run}@example.in`));
  const sky = ok(await api(admin, 'GET', '/listers')).find((l) => l.email === 'ops@skyhopaviation.example.in');
  assert.equal(sky.dgca_operator, null, 'fictional demo permit matches nothing');
});
