/**
 * End-to-end lifecycle against a running API (BASE_URL, default http://localhost:4000) with seeded demo data.
 * member requests → sales quotes & sends → member accepts → ops assigns + confirms → member manifest → pilot logs flight
 * → sales marks invoice paid → charter closed. Plus visibility checks (other member, pilot masking).
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
  const data = type.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, type };
}

async function login(email) {
  const r = await api(null, 'POST', '/auth/login', { email, password: PASSWORD });
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.data)}`);
  return r.data;
}

const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };

// IST calendar arithmetic without relying on server TZ
const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

test('full charter lifecycle', async (t) => {
  const health = await fetch(`${BASE_URL}/health`).then((r) => r.json());
  assert.equal(health.status, 'ok');

  const arjun = await login('arjun.mehra@example.in');
  const rajiv = await login('rajiv.malhotra@example.in');
  const sales = await login('sales@meridian.test');
  const ops = await login('ops@meridian.test');
  const pilot = await login('pilot1@meridian.test');
  assert.equal(arjun.user.role, 'member');
  assert.equal(arjun.user.member_no, 'MC-1001');

  // Dates far in the future; randomised so repeated runs do not collide on crew/aircraft.
  const offset = 120 + Math.floor(Math.random() * 400);
  const day1 = addDays(istToday(), offset);
  const day2 = addDays(day1, 2);

  // Find an aircraft (≥ 4 seats, active) free for the whole window incl. a day of slack for positioning.
  const avail = ok(await api(ops.token, 'GET', `/aircraft/availability?from=${addDays(day1, -1)}&to=${addDays(day2, 1)}`));
  const free = avail.aircraft.filter((a) => a.status === 'active' && a.seats >= 4 && a.cells.every((c) => c.state === 'free'));
  assert.ok(free.length, 'no free aircraft');
  const aircraft = free.find((a) => a.home_base === 'BOM') || free[0];

  // 1. Member creates a quote request
  const request = ok(await api(arjun.token, 'POST', '/quote-requests', {
    legs: [
      { from: 'BOM', to: 'GOI', depart_at: `${day1}T09:00` },
      { from: 'GOI', to: 'BOM', depart_at: `${day2}T17:00` },
    ],
    pax: 4,
    notes: 'Lifecycle test',
  }), 201);
  assert.match(request.request_no, /^RQ-\d{4}-\d{4}$/);
  assert.equal(request.status, 'open');
  assert.equal(request.legs[0].depart_at, `${day1}T09:00:00+05:30`);

  // Validation: past departure rejected
  const bad = await api(arjun.token, 'POST', '/quote-requests', { legs: [{ from: 'BOM', to: 'GOI', depart_at: '2020-01-01T09:00' }], pax: 2 });
  assert.equal(bad.status, 400);

  // 2. Sales previews, creates and sends a quote
  const preview = ok(await api(sales.token, 'POST', '/quotes/preview', { request_id: request.id, aircraft_id: aircraft.id }));
  assert.ok(preview.total > 0);
  assert.deepEqual(preview.conflicts, []);
  assert.ok(preview.line_items.some((li) => li.code === 'NIGHT_HALT' && li.qty === 2));

  const draft = ok(await api(sales.token, 'POST', '/quotes', { request_id: request.id, aircraft_id: aircraft.id, adjustment_inr: -10000, adjustment_note: 'Test discount' }), 201);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.total, draft.subtotal + draft.gst_amount);
  assert.equal(draft.subtotal, preview.subtotal - 10000);

  // Member cannot see drafts
  assert.equal((await api(arjun.token, 'GET', `/quotes/${draft.id}`)).status, 404);
  // Member cannot create quotes
  assert.equal((await api(arjun.token, 'POST', '/quotes', { request_id: request.id, aircraft_id: aircraft.id })).status, 403);

  const sent = ok(await api(sales.token, 'POST', `/quotes/${draft.id}/send`, {}));
  assert.equal(sent.status, 'sent');
  assert.ok(sent.valid_until);

  // Member sees the quote without rates/partner
  const memberQuote = ok(await api(arjun.token, 'GET', `/quotes/${draft.id}`));
  assert.equal(memberQuote.aircraft.hourly_rate_inr, undefined);
  assert.equal(memberQuote.aircraft.partner_name, undefined);
  assert.ok(memberQuote.line_items.length > 0);
  const reqAfterSend = ok(await api(arjun.token, 'GET', `/quote-requests/${request.id}`));
  assert.equal(reqAfterSend.status, 'quoted');

  // Quote PDF
  const qpdf = await api(arjun.token, 'GET', `/quotes/${draft.id}/pdf`);
  assert.equal(qpdf.status, 200);
  assert.match(qpdf.type, /application\/pdf/);
  assert.equal(qpdf.data.subarray(0, 4).toString(), '%PDF');

  // Rajiv cannot see or accept Arjun's quote
  assert.ok([403, 404].includes((await api(rajiv.token, 'GET', `/quotes/${draft.id}`)).status));
  assert.ok([403, 404].includes((await api(rajiv.token, 'POST', `/quotes/${draft.id}/accept`)).status));

  // 3. Member accepts
  const accepted = ok(await api(arjun.token, 'POST', `/quotes/${draft.id}/accept`));
  const { charter, invoice } = accepted;
  assert.equal(charter.status, 'accepted');
  assert.match(charter.charter_no, /^CH-\d{4}-\d{4}$/);
  assert.equal(invoice.status, 'unpaid');
  assert.match(invoice.invoice_no, /^INV-\d{4}-\d{4}$/);
  assert.equal(invoice.total, sent.total);
  assert.equal(charter.starts_on <= day1, true);
  // Accepting twice is a 409
  assert.equal((await api(arjun.token, 'POST', `/quotes/${draft.id}/accept`)).status, 409);

  // Other member cannot read the charter or invoice
  assert.ok([403, 404].includes((await api(rajiv.token, 'GET', `/charters/${charter.id}`)).status));
  assert.ok([403, 404].includes((await api(rajiv.token, 'GET', `/invoices/${invoice.id}/pdf`)).status));
  const rajivList = ok(await api(rajiv.token, 'GET', '/charters'));
  assert.ok(!rajivList.some((c) => c.id === charter.id));

  // Manifest submit before confirmation → 409
  const early = await api(arjun.token, 'POST', `/charters/${charter.id}/manifest/submit`);
  assert.equal(early.status, 409);
  assert.equal(early.data.error, 'Ops must confirm the flight first');

  // 4. Ops assigns crew (captain linked to pilot1) and confirms
  const crew = ok(await api(ops.token, 'GET', '/crew'));
  const pilotUserId = pilot.user.id;
  const captain = crew.find((c) => c.crew_role === 'captain' && c.user_id === pilotUserId);
  assert.ok(captain, 'pilot1 is linked to a captain');
  // Members/pilots cannot assign
  assert.equal((await api(arjun.token, 'POST', `/charters/${charter.id}/assign`, { captain_id: captain.id })).status, 403);
  // Confirm without crew → 409
  assert.equal((await api(ops.token, 'POST', `/charters/${charter.id}/confirm`)).status, 409);

  const fos = crew.filter((c) => c.crew_role === 'first_officer' && c.is_active);
  const cabin = crew.filter((c) => c.crew_role === 'cabin_crew' && c.is_active);
  let confirmed = null;
  for (let i = 0; i < fos.length && !confirmed; i++) {
    ok(await api(ops.token, 'POST', `/charters/${charter.id}/assign`, { captain_id: captain.id, first_officer_id: fos[i].id, cabin_crew_id: cabin[i % cabin.length].id }));
    const r = await api(ops.token, 'POST', `/charters/${charter.id}/confirm`);
    if (r.status === 200) confirmed = r.data;
    else assert.equal(r.status, 409, JSON.stringify(r.data));
  }
  assert.ok(confirmed, 'could not confirm with any first officer');
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.captain_id, captain.id);

  // 5. Member adds 2 passengers and submits the manifest
  const withPax = ok(await api(arjun.token, 'PUT', `/charters/${charter.id}/passengers`, {
    passengers: [
      { full_name: 'Arjun Mehra', id_type: 'passport', id_number: 'K98765432' },
      { full_name: 'Nandini Mehra', id_type: 'aadhaar', id_number: '123456789012', phone: '+91 90000 00099' },
    ],
  }));
  assert.equal(withPax.passengers.length, 2);
  assert.equal(withPax.passengers[0].id_number, 'XXXX5432'); // member sees masked
  // Re-saving masked values keeps stored numbers
  ok(await api(arjun.token, 'PUT', `/charters/${charter.id}/passengers`, {
    passengers: withPax.passengers.map(({ full_name, id_type, id_number, nationality, phone }) => ({ full_name, id_type, id_number, nationality, phone })),
  }));
  const opsView = ok(await api(ops.token, 'GET', `/charters/${charter.id}`));
  assert.deepEqual(opsView.passengers.map((p) => p.id_number).sort(), ['123456789012', 'K98765432']);

  const submitted = ok(await api(arjun.token, 'POST', `/charters/${charter.id}/manifest/submit`));
  assert.equal(submitted.status, 'manifest_complete');
  // Member can no longer edit the manifest
  assert.equal((await api(arjun.token, 'PUT', `/charters/${charter.id}/passengers`, { passengers: [] })).status, 409);

  // 6. Pilot sees the flight, masked ids; logs the flight
  const flights = ok(await api(pilot.token, 'GET', '/pilot/flights'));
  const flight = flights.find((f) => f.id === charter.id);
  assert.ok(flight, 'pilot sees assigned charter');
  assert.equal(flight.pax_count, 2);
  assert.ok(flight.passengers.every((p) => p.id_number === undefined));
  const pilotView = ok(await api(pilot.token, 'GET', `/charters/${charter.id}`));
  assert.ok(pilotView.passengers.length === 2);
  for (const p of pilotView.passengers) assert.match(p.id_number, /^XXXX.{4}$/);
  assert.equal(pilotView.aircraft.hourly_rate_inr, undefined);
  // pilot2 is not assigned
  const pilot2 = await login('pilot2@meridian.test');
  const p2 = await api(pilot2.token, 'GET', `/charters/${charter.id}`);
  assert.ok([403, 404].includes(p2.status));

  const legs = pilotView.legs.map((l, index) => {
    const off = new Date(Date.parse(l.depart_at) + 5 * 60000);
    const on = new Date(off.getTime() + l.flight_hours * 3600000);
    return { index, block_off: off.toISOString(), block_on: on.toISOString() };
  });
  // block_on before block_off rejected
  assert.equal((await api(pilot.token, 'POST', `/charters/${charter.id}/flight-log`, { legs: [{ index: 0, block_off: legs[0].block_on, block_on: legs[0].block_off }] })).status, 400);
  const flown = ok(await api(pilot.token, 'POST', `/charters/${charter.id}/flight-log`, { legs, defects: 'None' }));
  assert.equal(flown.status, 'flown');
  assert.ok(flown.legs.every((l) => l.block_off && l.block_on));

  // 7. Sales marks invoice paid → charter closed
  assert.equal((await api(arjun.token, 'POST', `/invoices/${invoice.id}/mark-paid`, {})).status, 403);
  const paid = ok(await api(sales.token, 'POST', `/invoices/${invoice.id}/mark-paid`, { paid_on: istToday(), payment_ref: 'NEFT-TEST-1' }));
  assert.equal(paid.status, 'paid');

  const final = ok(await api(arjun.token, 'GET', `/charters/${charter.id}`));
  assert.equal(final.status, 'closed');
  assert.equal(final.invoice.status, 'paid');
  assert.ok(final.events.some((e) => e.action === 'closed'));

  // Invoice PDF
  const ipdf = await api(arjun.token, 'GET', `/invoices/${invoice.id}/pdf`);
  assert.equal(ipdf.status, 200);
  assert.equal(ipdf.data.subarray(0, 4).toString(), '%PDF');

  // Request is closed
  const reqFinal = ok(await api(arjun.token, 'GET', `/quote-requests/${request.id}`));
  assert.equal(reqFinal.status, 'closed');
});

test('role guards on staff endpoints', async () => {
  const arjun = await login('arjun.mehra@example.in');
  const pilot = await login('pilot1@meridian.test');
  assert.equal((await api(arjun.token, 'GET', '/members')).status, 403);
  assert.equal((await api(arjun.token, 'GET', '/dashboard')).status, 403);
  assert.equal((await api(pilot.token, 'GET', '/invoices')).status, 403);
  assert.equal((await api(pilot.token, 'GET', '/quotes')).status, 403);
  assert.equal((await api(null, 'GET', '/charters')).status, 401);
  const acs = ok(await api(arjun.token, 'GET', '/aircraft'));
  assert.ok(acs.length > 0);
  assert.ok(acs.every((a) => a.hourly_rate_inr === undefined && a.partner_name === undefined));
  const md = ok(await api(arjun.token, 'GET', '/dashboard/member'));
  assert.ok('upcoming_charters' in md);
});
