/**
 * v1.1 empty legs against a running API (BASE_URL, default http://localhost:4000) with seeded demo data.
 * charter with positioning → confirm generates draft legs → publish → public list/detail (no internals)
 * → honeypot no-op → public requests → sales confirm (new member + charter + invoice + invite) → competing request rejected
 * → member instant booking (+ 409 on a second attempt) → derived charter confirms without a false conflict
 * → cancelling a source charter withdraws its unbooked legs → dashboard block.
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
  const data = type.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

async function login(email) {
  const r = await api(null, 'POST', '/auth/login', { email, password: PASSWORD });
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.data)}`);
  return r.data;
}

const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };

const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

const FORBIDDEN_KEYS = ['registration', 'hourly_rate', 'partner', 'aircraft_id', 'source_charter', 'member', 'guest', 'booking'];
/** Fail if any key (at any depth) contains a forbidden fragment, or the JSON mentions a registration. */
function assertNoInternals(json, label) {
  const walk = (v, path) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        for (const bad of FORBIDDEN_KEYS) assert.ok(!k.toLowerCase().includes(bad), `${label}: internal key ${path}.${k}`);
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(json, '$');
  const text = JSON.stringify(json);
  assert.ok(!/VT-[A-Z]{3}/.test(text), `${label}: registration leaked`);
  for (const p of ['Aravalli', 'Konkan Air', 'Deccan Jet', 'Coromandel']) assert.ok(!text.includes(p), `${label}: partner leaked`);
}

let S; // shared sessions
async function sessions() {
  if (S) return S;
  S = {
    arjun: await login('arjun.mehra@example.in'),
    rajiv: await login('rajiv.malhotra@example.in'),
    sales: await login('sales@meridian.test'),
    ops: await login('ops@meridian.test'),
  };
  return S;
}

/**
 * Member request → quote → accept → ops assigns free crew → confirm.
 * Uses an aircraft based away from both airports of a one-way trip, so it has positioning out AND back.
 */
async function confirmedCharterWithPositioning(dayOffset) {
  const { arjun, sales, ops } = await sessions();
  const day = addDays(istToday(), dayOffset);
  const avail = ok(await api(ops.token, 'GET', `/aircraft/availability?from=${addDays(day, -1)}&to=${addDays(day, 1)}`));
  const aircraft = avail.aircraft.find((a) => a.status === 'active' && a.seats >= 4 && !['GOI', 'JAI'].includes(a.home_base) && a.cells.every((c) => c.state === 'free'));
  assert.ok(aircraft, 'no free aircraft');
  const request = ok(await api(arjun.token, 'POST', '/quote-requests', { legs: [{ from: 'GOI', to: 'JAI', depart_at: `${day}T12:00` }], pax: 3, notes: 'Empty-leg test' }), 201);
  const quote = ok(await api(sales.token, 'POST', '/quotes', { request_id: request.id, aircraft_id: aircraft.id }), 201);
  assert.equal(quote.positioning.length, 2, 'expected positioning out and back');
  ok(await api(sales.token, 'POST', `/quotes/${quote.id}/send`, {}));
  const { charter } = ok(await api(arjun.token, 'POST', `/quotes/${quote.id}/accept`));

  const crew = ok(await api(ops.token, 'GET', '/crew'));
  const caps = crew.filter((c) => c.crew_role === 'captain' && c.is_active);
  const fos = crew.filter((c) => c.crew_role === 'first_officer' && c.is_active);
  let confirmed = null;
  for (let i = 0; i < Math.min(caps.length, fos.length) && !confirmed; i++) {
    ok(await api(ops.token, 'POST', `/charters/${charter.id}/assign`, { captain_id: caps[i].id, first_officer_id: fos[i].id }));
    const r = await api(ops.token, 'POST', `/charters/${charter.id}/confirm`);
    if (r.status === 200) confirmed = r.data;
    else assert.equal(r.status, 409, JSON.stringify(r.data));
  }
  assert.ok(confirmed, 'could not confirm source charter');
  return { charter: confirmed, quote, aircraft };
}

test('empty legs: generation, public listing, requests, bookings, conflicts, cancellation', async () => {
  const { arjun, rajiv, sales, ops } = await sessions();
  const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const offset = 150 + Math.floor(Math.random() * 400);

  // 1. Confirming a charter with positioning generates draft empty legs
  const { charter: source, quote } = await confirmedCharterWithPositioning(offset);
  assert.equal(source.status, 'confirmed');
  assert.equal(source.empty_legs.length, 2);
  assert.deepEqual(source.empty_legs.map((l) => l.source_leg).sort(), ['positioning_back', 'positioning_out']);
  for (const l of source.empty_legs) {
    assert.equal(l.status, 'draft');
    assert.match(l.leg_no, /^EL-\d{4}-\d{4}$/);
    assert.ok(l.price_inr > 0 && l.price_inr < l.list_price_inr);
    assert.equal(l.price_inr % 1000, 0);
  }
  const out = source.empty_legs.find((l) => l.source_leg === 'positioning_out');
  const back = source.empty_legs.find((l) => l.source_leg === 'positioning_back');
  // Window never overlaps the passenger leg
  const paxDepart = Date.parse(quote.legs[0].depart_at);
  const paxArrive = Date.parse(quote.legs[0].arrive_at);
  assert.ok(Date.parse(out.depart_latest) + out.flight_hours * 3600000 <= paxDepart);
  assert.ok(Date.parse(back.depart_earliest) >= paxArrive);
  // Re-generating is a no-op
  const regen = ok(await api(ops.token, 'POST', `/empty-legs/generate/${source.id}`));
  assert.equal(regen.created, 0);
  // Drafts are not public
  assert.equal((await api(null, 'GET', `/public/empty-legs/${out.id}`)).status, 404);
  // Members cannot publish
  assert.equal((await api(arjun.token, 'POST', `/empty-legs/${out.id}/publish`)).status, 403);

  // 2. Publish both
  for (const l of [out, back]) {
    const p = ok(await api(sales.token, 'POST', `/empty-legs/${l.id}/publish`));
    assert.equal(p.status, 'published');
  }
  assert.equal((await api(sales.token, 'POST', `/empty-legs/${out.id}/publish`)).status, 409);

  // 3. Public list/detail: no auth, no internals
  const list = ok(await api(null, 'GET', '/public/empty-legs'));
  assert.ok(list.some((l) => l.id === out.id) && list.some((l) => l.id === back.id));
  assertNoInternals(list, 'public list');
  const pub = list.find((l) => l.id === out.id);
  for (const k of ['leg_no', 'from_code', 'from_city', 'to_code', 'to_city', 'depart_earliest', 'depart_latest', 'flight_hours', 'aircraft_type', 'seats', 'price_inr', 'list_price_inr', 'savings_pct']) {
    assert.ok(k in pub, `public leg missing ${k}`);
  }
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].depart_earliest <= list[i].depart_earliest, 'soonest first');
  const filtered = ok(await api(null, 'GET', `/public/empty-legs?from=${pub.from_code}&month=${pub.depart_earliest && new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(new Date(pub.depart_earliest))}`));
  assert.ok(filtered.some((l) => l.id === out.id) && filtered.every((l) => l.from_code === pub.from_code));
  assert.equal((await api(null, 'GET', '/public/empty-legs?month=2026-13')).status, 400);
  const detail = ok(await api(null, 'GET', `/public/empty-legs/${out.id}`));
  assertNoInternals(detail, 'public detail');
  // Member view: same shape + can_book, still no internals
  const memberList = ok(await api(arjun.token, 'GET', '/empty-legs'));
  const ml = memberList.find((l) => l.id === back.id);
  assert.equal(ml.can_book, true);
  const { can_book, status, ...mlRest } = ml;
  assertNoInternals(mlRest, 'member list');

  // 4. Honeypot filled → 202 and nothing stored
  const before = ok(await api(sales.token, 'GET', `/empty-legs/bookings?empty_leg_id=${out.id}`)).length;
  const bot = await api(null, 'POST', `/public/empty-legs/${out.id}/request`, {
    name: 'Bot', email: `bot.${runId}@example.in`, phone: '+91 90000 00000', pax: 2, accept_terms: true, website: 'http://spam.example',
  });
  assert.equal(bot.status, 202);
  assert.equal(ok(await api(sales.token, 'GET', `/empty-legs/bookings?empty_leg_id=${out.id}`)).length, before);

  // Validation
  const base = { name: 'Neel Test', email: `neel.${runId}@example.in`, phone: '+91 98765 43210', pax: 2, accept_terms: true, website: '' };
  assert.equal((await api(null, 'POST', `/public/empty-legs/${out.id}/request`, { ...base, email: 'nope' })).status, 400);
  assert.equal((await api(null, 'POST', `/public/empty-legs/${out.id}/request`, { ...base, accept_terms: false })).status, 400);
  assert.equal((await api(null, 'POST', `/public/empty-legs/${out.id}/request`, { ...base, pax: 99 })).status, 400);
  assert.equal((await api(null, 'POST', `/public/empty-legs/${out.id}/request`, { ...base, phone: 'abc' })).status, 400);

  // 5. Two public requests on the out leg; sales confirms the second → new member + charter + invoice + invite_url
  const r1 = ok(await api(null, 'POST', `/public/empty-legs/${out.id}/request`, base), 201);
  assert.match(r1.booking_no, /^ELB-\d{4}-\d{4}$/);
  assert.deepEqual(Object.keys(r1), ['booking_no']);
  const guestEmail = `Meera.${runId}@Example.in`;
  const r2 = ok(await api(null, 'POST', `/public/empty-legs/${out.id}/request`, {
    ...base, name: 'Meera Guest', email: guestEmail, company: 'Guest Ventures LLP', pax: 3, message: 'Flexible on time',
  }), 201);
  const pending = ok(await api(sales.token, 'GET', '/empty-legs/bookings?status=requested'));
  const b1 = pending.find((b) => b.booking_no === r1.booking_no);
  const b2 = pending.find((b) => b.booking_no === r2.booking_no);
  assert.ok(b1 && b2);
  assert.equal(b2.leg.leg_no, out.leg_no);
  assert.equal((await api(ops.token, 'POST', `/empty-legs/bookings/${b2.id}/confirm`)).status, 403);
  const conf = ok(await api(sales.token, 'POST', `/empty-legs/bookings/${b2.id}/confirm`));
  assert.equal(conf.booking.status, 'confirmed');
  assert.equal(conf.member.email, guestEmail.toLowerCase());
  assert.equal(conf.member.source, 'empty_leg_public');
  assert.equal(conf.member.member_type, 'corporate');
  assert.equal(conf.member.tier, 'silver');
  assert.match(conf.member.member_no, /^MC-\d+$/);
  assert.equal(conf.charter.status, 'accepted');
  assert.equal(conf.charter.empty_leg_id, out.id);
  assert.equal(conf.charter.quote_id, null);
  assert.equal(conf.charter.pax, 3);
  assert.equal(conf.invoice.status, 'unpaid');
  assert.equal(conf.invoice.subtotal, out.price_inr);
  assert.equal(conf.invoice.total, conf.invoice.subtotal + conf.invoice.gst_amount);
  assert.match(conf.invite_url, /\/invite\/[A-Za-z0-9_-]+$/);
  const token = conf.invite_url.split('/invite/')[1];
  const inv = ok(await api(null, 'GET', `/auth/invite/${token}`));
  assert.equal(inv.email, guestEmail.toLowerCase());
  // The competing request was rejected; the leg is booked; confirming again is a 409
  const b1After = ok(await api(sales.token, 'GET', `/empty-legs/bookings?empty_leg_id=${out.id}`)).find((b) => b.id === b1.id);
  assert.equal(b1After.status, 'rejected');
  assert.equal(b1After.reject_reason, 'Booked by another customer');
  assert.equal((await api(sales.token, 'POST', `/empty-legs/bookings/${b1.id}/confirm`)).status, 409);
  assert.equal(ok(await api(sales.token, 'GET', `/empty-legs/${out.id}`)).status, 'booked');
  assert.equal((await api(null, 'GET', `/public/empty-legs/${out.id}`)).status, 404);
  // The new member can set a password and sees the trip
  const acc = ok(await api(null, 'POST', '/auth/accept-invite', { token, password: 'EmptyLeg@2026!' }));
  const guestTrips = ok(await api(acc.token, 'GET', '/charters'));
  assert.ok(guestTrips.some((c) => c.id === conf.charter.id && c.origin === `Empty leg ${out.leg_no}`));
  const guestTrip = ok(await api(acc.token, 'GET', `/charters/${conf.charter.id}`));
  assert.equal(guestTrip.empty_leg.leg_no, out.leg_no);
  assert.equal(guestTrip.empty_legs, undefined);
  assert.equal(guestTrip.aircraft.hourly_rate_inr, undefined);

  // 6. Member instant booking on the back leg; a second attempt is 409
  assert.equal((await api(sales.token, 'POST', `/empty-legs/${back.id}/book`, { pax: 2 })).status, 403);
  assert.equal((await api(rajiv.token, 'POST', `/empty-legs/${back.id}/book`, { pax: 99 })).status, 400);
  const booked = ok(await api(arjun.token, 'POST', `/empty-legs/${back.id}/book`, { pax: 2 }), 201);
  assert.equal(booked.booking.status, 'confirmed');
  assert.equal(booked.booking.channel, 'member');
  assert.equal(booked.charter.status, 'accepted');
  assert.equal(booked.charter.empty_leg_id, back.id);
  assert.equal(booked.invoice.subtotal, back.price_inr);
  // Crew copied from the source charter
  assert.equal(booked.charter.captain_id, source.captain_id);
  assert.equal(booked.charter.first_officer_id, source.first_officer_id);
  const second = await api(rajiv.token, 'POST', `/empty-legs/${back.id}/book`, { pax: 2 });
  assert.equal(second.status, 409);
  // Concurrent attempts on an already-booked leg: all 409
  const race = await Promise.all([1, 2, 3].map(() => api(arjun.token, 'POST', `/empty-legs/${back.id}/book`, { pax: 1 })));
  assert.ok(race.every((r) => r.status === 409));

  // 7. Derived charter confirms (no false aircraft/crew conflict with its source), and vice-versa views
  const derivedConfirmed = ok(await api(ops.token, 'POST', `/charters/${booked.charter.id}/confirm`));
  assert.equal(derivedConfirmed.status, 'confirmed');
  assert.equal(derivedConfirmed.empty_leg.id, back.id);
  assert.deepEqual(derivedConfirmed.empty_legs, []);
  const guestConfirmed = ok(await api(ops.token, 'POST', `/charters/${conf.charter.id}/confirm`));
  assert.equal(guestConfirmed.status, 'confirmed');
  // Re-assigning crew on the source does not flag the derived charters
  const reassigned = ok(await api(ops.token, 'POST', `/charters/${source.id}/assign`, { captain_id: source.captain_id, first_officer_id: source.first_officer_id }));
  assert.ok(!reassigned.warnings.some((w) => w.includes(conf.charter.charter_no) || w.includes(booked.charter.charter_no)), JSON.stringify(reassigned.warnings));
  const srcDetail = ok(await api(ops.token, 'GET', `/charters/${source.id}`));
  assert.ok(srcDetail.empty_legs.every((l) => l.status === 'booked'));
  // Members' charter list shows the origin
  const arjunTrips = ok(await api(arjun.token, 'GET', '/charters'));
  assert.equal(arjunTrips.find((c) => c.id === booked.charter.id).origin, `Empty leg ${back.leg_no}`);

  // 8. Cancelling a source charter withdraws its unbooked legs and cancels pending requests
  const { charter: source2 } = await confirmedCharterWithPositioning(offset + 7);
  const [l2a, l2b] = source2.empty_legs;
  ok(await api(sales.token, 'POST', `/empty-legs/${l2a.id}/publish`));
  ok(await api(null, 'POST', `/public/empty-legs/${l2a.id}/request`, { ...base, email: `late.${runId}@example.in` }), 201);
  ok(await api(ops.token, 'POST', `/charters/${source2.id}/cancel`, { reason: 'Client cancelled' }));
  for (const l of [l2a, l2b]) {
    const after = ok(await api(sales.token, 'GET', `/empty-legs/${l.id}`));
    assert.equal(after.status, 'withdrawn');
    assert.equal(after.withdrawn_reason, 'Source charter cancelled');
    assert.ok(after.bookings.every((b) => b.status === 'cancelled'));
  }
  assert.equal((await api(null, 'GET', `/public/empty-legs/${l2a.id}`)).status, 404);

  // Cancelling the first source keeps its sold derived charters but flags them for ops
  ok(await api(ops.token, 'POST', `/charters/${source.id}/cancel`, { reason: 'Owner recalled aircraft' }));
  const flagged = ok(await api(ops.token, 'GET', `/charters/${booked.charter.id}`));
  assert.equal(flagged.status, 'confirmed');
  assert.match(flagged.ops_notes, new RegExp(`Source charter ${source.charter_no} was cancelled`));

  // 9. Dashboard empty_legs block
  const dash = ok(await api(ops.token, 'GET', '/dashboard'));
  for (const k of ['published', 'pending_requests', 'booked_90d', 'revenue_recovered_90d_inr', 'positioning_hours_sold_pct_90d']) {
    assert.equal(typeof dash.empty_legs[k], 'number', k);
  }
  assert.ok(dash.empty_legs.booked_90d >= 2);
  assert.ok(dash.empty_legs.revenue_recovered_90d_inr >= out.price_inr + back.price_inr);
});

test('empty legs: manual create, edit, withdraw, role guards', async () => {
  const { arjun, sales, ops } = await sessions();
  const day = addDays(istToday(), 300 + Math.floor(Math.random() * 200));
  const avail = ok(await api(ops.token, 'GET', `/aircraft/availability?from=${day}&to=${addDays(day, 1)}`));
  const ac = avail.aircraft.find((a) => a.status === 'active' && a.cells.every((c) => c.state === 'free'));
  assert.equal((await api(arjun.token, 'POST', '/empty-legs', {})).status, 403);
  assert.equal((await api(sales.token, 'POST', '/empty-legs', { aircraft_id: ac.id, from_code: 'DEL', to_code: 'DEL', depart_earliest: `${day}T09:00` })).status, 400);
  const leg = ok(await api(sales.token, 'POST', '/empty-legs', {
    aircraft_id: ac.id, from_code: 'DEL', to_code: 'JAI', depart_earliest: `${day}T09:00`, depart_latest: `${day}T12:00`, notes: 'test manual',
  }), 201);
  assert.equal(leg.status, 'draft');
  assert.equal(leg.source_charter_id, null);
  assert.ok(leg.list_price_inr > leg.price_inr);
  const edited = ok(await api(ops.token, 'PATCH', `/empty-legs/${leg.id}`, { price_inr: 123000, depart_latest: `${day}T13:00` }));
  assert.equal(edited.price_inr, 123000);
  assert.equal((await api(ops.token, 'PATCH', `/empty-legs/${leg.id}`, { depart_latest: `${day}T08:00` })).status, 400);
  assert.equal((await api(ops.token, 'POST', `/empty-legs/${leg.id}/withdraw`, {})).status, 400);
  const w = ok(await api(ops.token, 'POST', `/empty-legs/${leg.id}/withdraw`, { reason: 'test' }));
  assert.equal(w.status, 'withdrawn');
  assert.equal((await api(ops.token, 'PATCH', `/empty-legs/${leg.id}`, { price_inr: 1 })).status, 409);
  assert.equal((await api(sales.token, 'POST', `/empty-legs/${leg.id}/publish`)).status, 409);
  assert.equal((await api(arjun.token, 'GET', '/empty-legs/bookings')).status, 403);
  assert.equal((await api(arjun.token, 'GET', `/empty-legs/${leg.id}`)).status, 404);
  assert.equal((await api(null, 'GET', '/empty-legs')).status, 401);
});
