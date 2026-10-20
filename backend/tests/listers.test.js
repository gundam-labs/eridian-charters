/**
 * v1.3 listers against a running API (BASE_URL, default http://localhost:4000) with seeded demo data.
 * sign-up (validation, duplicate, honeypot) → pending lister drafts but cannot publish → staff approve → publish
 * → public sees it ("operated by", no registration) → member cannot instant-book it → public requests
 * → staff cannot confirm it → lister sees requests without contact details → lister confirms (contact revealed,
 * competing request rejected, no Meridian charter) → isolation between listers and from staff APIs
 * → suspend takes listings down.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const PASSWORD = process.env.DEMO_PASSWORD || 'Meridian@2026';

async function api(token, method, path, body) {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('application/json') ? await res.json() : await res.text() };
}
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
const login = async (email) => ok(await api(null, 'POST', '/auth/login', { email, password: PASSWORD })).token;

const run = Date.now().toString(36);
const istDay = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
};

const signup = (over = {}) => ({
  name: 'Test Operator', email: `op-${run}@example.in`, password: 'Sup3rSecret!x', lister_type: 'operator',
  company: 'Test Air Pvt Ltd', phone: '+91 98765 43210', city: 'Mumbai', nsop_permit_no: 'NSOP-99/2024', pan: 'aaach 1234k', tan: 'MUMT12345A',
  accept_terms: true, ...over,
});

const listing = (over = {}) => ({
  from_code: 'DEL', to_code: 'JAI', depart_earliest: `${istDay(5)}T09:00`, depart_latest: `${istDay(5)}T11:00`,
  aircraft_type: 'Citation CJ3', registration: 'vt-tst', seats: 7, price_inr: 95000, list_price_inr: 240000,
  operator_name: 'Test Air', ...over,
});

test('listers: sign-up, approval, listing, requests and isolation', async () => {
  // ── Sign-up validation ──
  assert.equal((await api(null, 'POST', '/auth/register', signup({ lister_type: 'pilot' }))).status, 400);
  assert.equal((await api(null, 'POST', '/auth/register', signup({ nsop_permit_no: '' }))).status, 400, 'operator needs NSOP permit');
  assert.equal((await api(null, 'POST', '/auth/register', signup({ lister_type: 'agent', company: '' }))).status, 400, 'agent needs company');
  assert.equal((await api(null, 'POST', '/auth/register', signup({ password: 'short' }))).status, 400);
  assert.equal((await api(null, 'POST', '/auth/register', signup({ accept_terms: false }))).status, 400);
  assert.equal((await api(null, 'POST', '/auth/register', signup({ gstin: 'NOT-A-GSTIN' }))).status, 400);
  // PAN / TAN
  assert.equal((await api(null, 'POST', '/auth/register', signup({ pan: '' }))).status, 400, 'operator needs PAN');
  assert.equal((await api(null, 'POST', '/auth/register', signup({ lister_type: 'agent', nsop_permit_no: '', pan: '' }))).status, 400, 'agent needs PAN');
  assert.equal((await api(null, 'POST', '/auth/register', signup({ pan: 'ABCDE12345' }))).status, 400, 'bad PAN format');
  assert.equal((await api(null, 'POST', '/auth/register', signup({ tan: 'ABC123' }))).status, 400, 'bad TAN format');
  assert.equal((await api(null, 'POST', '/auth/register', signup({ gstin: '27ZZZCH1234K1Z5' }))).status, 400, 'GSTIN must embed the PAN');
  const hp = await api(null, 'POST', '/auth/register', signup({ email: `bot-${run}@example.in`, website: 'http://spam' }));
  assert.equal(hp.status, 202);
  assert.equal((await api(null, 'POST', '/auth/login', { email: `bot-${run}@example.in`, password: 'Sup3rSecret!x' })).status, 401, 'honeypot creates nothing');

  const reg = ok(await api(null, 'POST', '/auth/register', signup({ gstin: '27AAACH1234K1Z5' })), 201);
  assert.equal(reg.user.role, 'lister');
  assert.equal(reg.user.lister_status, 'pending');
  const op = reg.token;
  assert.equal((await api(null, 'POST', '/auth/register', signup({ email: `OP-${run}@example.in` }))).status, 409, 'duplicate email (case-insensitive)');
  assert.equal((await api(null, 'POST', '/auth/register', signup({ email: 'sales@meridian.test' }))).status, 409, 'staff email taken');

  // Flyer needs neither company nor permit.
  const flyer = ok(await api(null, 'POST', '/auth/register', signup({ email: `flyer-${run}@example.in`, lister_type: 'flyer', company: '', nsop_permit_no: '', pan: '', tan: '' })), 201).token;

  // ── Pending: can draft, cannot publish ──
  const draft = ok(await api(op, 'POST', '/lister/empty-legs', listing()), 201);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.aircraft_registration, 'VT-TST');
  assert.ok(draft.flight_hours > 0 && draft.distance_nm > 0);
  assert.equal(draft.savings_pct, 60);
  assert.equal((await api(op, 'POST', `/lister/empty-legs/${draft.id}/publish`)).status, 403);
  // validation
  assert.equal((await api(op, 'POST', '/lister/empty-legs', listing({ to_code: 'DEL' }))).status, 400);
  assert.equal((await api(op, 'POST', '/lister/empty-legs', listing({ seats: 0 }))).status, 400);
  assert.equal((await api(op, 'POST', '/lister/empty-legs', listing({ price_inr: -5 }))).status, 400);
  assert.equal((await api(op, 'POST', '/lister/empty-legs', listing({ depart_earliest: `${istDay(-1)}T09:00`, depart_latest: `${istDay(-1)}T10:00` }))).status, 400);
  // No "usual price" → no savings claim.
  const plain = ok(await api(op, 'POST', '/lister/empty-legs', listing({ list_price_inr: undefined, from_code: 'BOM', to_code: 'PNQ' })), 201);
  assert.equal(plain.list_price_inr, plain.price_inr);
  assert.equal(plain.savings_pct, 0);

  // ── Lister cannot reach staff or member APIs ──
  for (const path of ['/members', '/empty-legs', '/empty-legs/bookings', '/charters', '/invoices', '/listers', '/users', '/settings', '/dashboard']) {
    assert.equal((await api(op, 'GET', path)).status, 403, `lister must not read ${path}`);
  }

  // ── Staff review ──
  const sales = await login('sales@meridian.test');
  const ops = await login('ops@meridian.test');
  assert.equal((await api(ops, 'GET', '/listers')).status, 403, 'ops does not review listers');
  const pending = ok(await api(sales, 'GET', '/listers?status=pending'));
  const me = pending.find((l) => l.email === `op-${run}@example.in`);
  assert.ok(me, 'new lister in the pending queue');
  assert.equal(me.pan, 'AAACH1234K', 'PAN normalised (spaces removed, upper case)');
  assert.equal(me.tan, 'MUMT12345A');
  assert.equal(ok(await api(op, 'GET', '/lister/me')).pan, 'AAACH1234K');
  assert.equal((await api(op, 'PATCH', '/lister/me', { pan: 'AAACZ9999Z' })).status, 400, 'PAN change must still match the GSTIN');
  assert.equal((await api(op, 'PATCH', '/lister/me', { pan: '' })).status, 400, 'operator cannot remove PAN');
  assert.equal((await api(sales, 'POST', `/listers/${me.id}/reject`, {})).status, 400, 'reject needs a reason');
  assert.equal(ok(await api(sales, 'POST', `/listers/${me.id}/approve`)).status, 'approved');
  assert.equal((await api(sales, 'POST', `/listers/${me.id}/approve`)).status, 409);

  // ── Publish → public ──
  const pub = ok(await api(op, 'POST', `/lister/empty-legs/${draft.id}/publish`));
  assert.equal(pub.status, 'published');
  const publicLeg = ok(await api(null, 'GET', `/public/empty-legs/${draft.id}`));
  assert.equal(publicLeg.operated_by, 'Test Air');
  assert.equal(publicLeg.marketplace, true);
  assert.equal(publicLeg.aircraft_type, 'Citation CJ3');
  assert.ok(!JSON.stringify(publicLeg).includes('VT-TST'), 'registration never public');
  assert.ok(!Object.keys(publicLeg).some((k) => k.includes('lister')), 'no lister internals');

  // Staff can see but not edit or publish a lister's flight.
  const staffList = ok(await api(sales, 'GET', '/empty-legs?source=listers'));
  assert.ok(staffList.some((l) => l.id === draft.id));
  assert.ok(staffList.every((l) => l.lister_id));
  assert.equal((await api(sales, 'PATCH', `/empty-legs/${draft.id}`, { price_inr: 1000 })).status, 409);

  // Member: listed but request-only.
  const arjun = await login('arjun.mehra@example.in');
  const mine = ok(await api(arjun, 'GET', '/empty-legs')).find((l) => l.id === draft.id);
  assert.equal(mine.can_book, false);
  assert.equal(mine.request_only, true);
  assert.equal((await api(arjun, 'POST', `/empty-legs/${draft.id}/book`, { pax: 2 })).status, 409);

  // ── Public requests ──
  const reqA = { name: 'Asha Rao', email: `asha-${run}@example.in`, phone: '+91 99000 11122', pax: 4, accept_terms: true, message: 'Two bags each' };
  const reqB = { name: 'Dev Shah', email: `dev-${run}@example.in`, phone: '+91 99000 33344', pax: 2, accept_terms: true };
  ok(await api(null, 'POST', `/public/empty-legs/${draft.id}/request`, reqA), 201);
  ok(await api(null, 'POST', `/public/empty-legs/${draft.id}/request`, reqB), 201);

  // Another lister sees nothing of it.
  assert.equal(ok(await api(flyer, 'GET', '/lister/bookings')).length, 0);
  assert.equal((await api(flyer, 'GET', `/lister/empty-legs/${draft.id}`)).status, 404);
  assert.equal((await api(flyer, 'PATCH', `/lister/empty-legs/${draft.id}`, { price_inr: 1 })).status, 404);

  const reqs = ok(await api(op, 'GET', '/lister/bookings?status=requested'));
  assert.equal(reqs.length, 2);
  const a = reqs.find((r) => r.customer.name === 'Asha Rao');
  assert.equal(a.customer.email, null, 'contact hidden before confirming');
  assert.equal(a.customer.phone, null);

  // Staff cannot confirm a lister's request; seats cannot drop under a pending request.
  const staffReq = ok(await api(sales, 'GET', `/empty-legs/bookings?empty_leg_id=${draft.id}`))[0];
  assert.equal(staffReq.marketplace, true);
  assert.equal((await api(sales, 'POST', `/empty-legs/bookings/${staffReq.id}/confirm`)).status, 409);
  assert.equal((await api(op, 'PATCH', `/lister/empty-legs/${draft.id}`, { seats: 3 })).status, 409);

  // ── Lister confirms ──
  const conf = ok(await api(op, 'POST', `/lister/bookings/${a.id}/confirm`));
  assert.equal(conf.status, 'confirmed');
  assert.equal(conf.customer.email, `asha-${run}@example.in`, 'contact revealed after confirming');
  const after = ok(await api(op, 'GET', '/lister/bookings'));
  assert.equal(after.find((r) => r.customer.name === 'Dev Shah').status, 'rejected');
  const legAfter = ok(await api(op, 'GET', `/lister/empty-legs/${draft.id}`));
  assert.equal(legAfter.status, 'booked');
  assert.equal((await api(null, 'GET', `/public/empty-legs/${draft.id}`)).status, 404);
  const charters = ok(await api(sales, 'GET', '/charters'));
  assert.ok(!charters.some((c) => c.empty_leg_id === draft.id), 'no Meridian charter for a lister leg');

  // ── Suspend takes everything down ──
  const third = ok(await api(op, 'POST', '/lister/empty-legs', listing({ from_code: 'HYD', to_code: 'BLR' })), 201);
  ok(await api(op, 'POST', `/lister/empty-legs/${third.id}/publish`));
  ok(await api(null, 'POST', `/public/empty-legs/${third.id}/request`, { ...reqB, email: `dev2-${run}@example.in` }), 201);
  assert.equal(ok(await api(sales, 'POST', `/listers/${me.id}/suspend`, { reason: 'Permit under review' })).status, 'suspended');
  assert.equal(ok(await api(op, 'GET', `/lister/empty-legs/${third.id}`)).status, 'withdrawn');
  assert.equal(ok(await api(op, 'GET', `/lister/empty-legs/${plain.id}`)).status, 'withdrawn');
  assert.equal((await api(null, 'GET', `/public/empty-legs/${third.id}`)).status, 404);
  assert.equal((await api(op, 'POST', '/lister/empty-legs', listing())).status, 403);
  const me2 = ok(await api(op, 'GET', '/lister/me'));
  assert.equal(me2.status, 'suspended');

  // Profile edit by a rejected lister puts them back in the queue.
  const flyerId = ok(await api(flyer, 'GET', '/lister/me')).id;
  ok(await api(sales, 'POST', `/listers/${flyerId}/reject`, { reason: 'Please add your city' }));
  assert.equal(ok(await api(flyer, 'PATCH', '/lister/me', { city: 'Pune' })).status, 'pending');
});
