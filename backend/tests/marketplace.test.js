/**
 * v1.6 marketplace against a running API (BASE_URL, default http://localhost:4000), mock payments, seeded data.
 * Payment hold → lister confirm captures (commission, payout pending) → competing hold released;
 * decline releases; deadline passes → released; operator cancels a booked flight → 100% refund;
 * flown → payout due → finance marks paid; staff cancel with traveller policy; route alerts; DGCA aircraft check.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const PASSWORD = process.env.DEMO_PASSWORD || 'Meridian@2026';

async function api(token, method, p, body) {
  const res = await fetch(`${BASE_URL}/api${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.data)); return r.data; };
const login = async (email) => ok(await api(null, 'POST', '/auth/login', { email, password: PASSWORD })).token;
const run = Date.now().toString(36);
const istDay = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + n * 86400000));

async function db(sql, params) {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}

const traveller = (n, over = {}) => ({ name: `Traveller ${n}`, email: `t${n}-${run}@example.in`, phone: '+91 99000 1234' + n, pax: 2, accept_terms: true, ...over });

async function newListing(op, over = {}) {
  const l = ok(await api(op, 'POST', '/lister/empty-legs', {
    from_code: 'DEL', to_code: 'JAI', depart_earliest: `${istDay(6)}T09:00`, depart_latest: `${istDay(6)}T11:00`,
    aircraft_type: 'Citation XLS', seats: 8, price_inr: 100000, list_price_inr: 250000, ...over,
  }), 201);
  ok(await api(op, 'POST', `/lister/empty-legs/${l.id}/publish`));
  return l;
}

/** Request + pay (mock). → { token, booking_no, view } */
async function requestAndPay(legId, who, method = 'upi') {
  const r = ok(await api(null, 'POST', `/public/empty-legs/${legId}/request`, who), 201);
  assert.ok(r.booking_token, 'token returned');
  assert.equal(r.payment.provider, 'mock');
  const view = ok(await api(null, 'POST', `/public/bookings/${r.booking_token}/mock-pay`, { method }));
  return { token: r.booking_token, booking_no: r.booking_no, payment: r.payment, view };
}

test('marketplace: hold, capture, release, refunds, payouts, alerts, DGCA check', async () => {
  const op = await login('ops@skyhopaviation.example.in');
  const sales = await login('sales@meridian.test');

  // ── Price: base + GST, shown publicly before paying ──
  const leg = await newListing(op);
  const pub = ok(await api(null, 'GET', `/public/empty-legs/${leg.id}`));
  assert.equal(pub.pay_on_request, true);
  assert.equal(pub.total_inr, 100000 + (100000 * pub.gst_rate_pct) / 100);

  // ── Request starts a hold; the lister sees nothing until it is authorised ──
  const r1 = ok(await api(null, 'POST', `/public/empty-legs/${leg.id}/request`, traveller(1)), 201);
  assert.equal(r1.payment.amount, pub.total_inr);
  assert.equal(ok(await api(null, 'GET', `/public/bookings/${r1.booking_token}`)).status, 'pending_payment');
  assert.equal(ok(await api(op, 'GET', '/lister/bookings')).filter((b) => b.booking_no === r1.booking_no).length, 0, 'unpaid request hidden from lister');
  assert.equal((await api(null, 'GET', '/public/bookings/not-a-real-token-at-all-xx')).status, 404);

  const v1 = ok(await api(null, 'POST', `/public/bookings/${r1.booking_token}/mock-pay`, { method: 'card' }));
  assert.equal(v1.status, 'requested');
  assert.equal(v1.payment.status, 'authorized');
  assert.ok(v1.respond_by, 'deadline set');
  assert.equal((await api(null, 'POST', `/public/bookings/${r1.booking_token}/mock-pay`, {})).status, 409, 'cannot pay twice');

  // A second traveller also holds payment for the same flight.
  const p2 = await requestAndPay(leg.id, traveller(2));
  assert.equal(p2.view.status, 'requested');

  const reqs = ok(await api(op, 'GET', '/lister/bookings?status=requested'));
  const a = reqs.find((b) => b.booking_no === r1.booking_no);
  assert.equal(a.payment.status, 'authorized');
  assert.equal(a.payment.amount, pub.total_inr);
  assert.ok(a.respond_by);

  // ── Confirm captures; commission 10% of base; the other hold is released ──
  const conf = ok(await api(op, 'POST', `/lister/bookings/${a.id}/confirm`));
  assert.equal(conf.status, 'confirmed');
  assert.equal(conf.payment.status, 'captured');
  assert.equal(conf.payment.commission, 10000);
  assert.equal(conf.payment.payout, pub.total_inr - 10000);
  assert.equal(conf.payment.payout_status, 'pending');
  const other = ok(await api(null, 'GET', `/public/bookings/${p2.token}`));
  assert.equal(other.status, 'rejected');
  assert.equal(other.payment.status, 'released', 'competing hold released');

  // ── Decline releases ──
  const leg2 = await newListing(op, { from_code: 'BOM', to_code: 'GOI' });
  const p3 = await requestAndPay(leg2.id, traveller(3));
  const b3 = ok(await api(op, 'GET', '/lister/bookings?status=requested')).find((b) => b.booking_no === p3.booking_no);
  ok(await api(op, 'POST', `/lister/bookings/${b3.id}/reject`, { reason: 'Crew not available' }));
  assert.equal(ok(await api(null, 'GET', `/public/bookings/${p3.token}`)).payment.status, 'released');

  // ── Deadline passes → request lapses, hold released, lister can no longer confirm ──
  const p4 = await requestAndPay(leg2.id, traveller(4));
  const b4 = ok(await api(op, 'GET', '/lister/bookings?status=requested')).find((b) => b.booking_no === p4.booking_no);
  await db(`UPDATE empty_leg_bookings SET respond_by = now() - interval '1 minute' WHERE id = $1`, [b4.id]);
  assert.equal((await api(op, 'POST', `/lister/bookings/${b4.id}/confirm`)).status, 409);
  await new Promise((r) => setTimeout(r, 31000)); // the jobs run at most every 30 s on read paths
  ok(await api(op, 'GET', '/lister/bookings'));
  const lapsed = ok(await api(null, 'GET', `/public/bookings/${p4.token}`));
  assert.equal(lapsed.status, 'rejected');
  assert.match(lapsed.reject_reason, /did not confirm in time/);
  assert.equal(lapsed.payment.status, 'released');

  // ── Operator cancels a booked flight (main charter changed) → 100% refund, payout cancelled ──
  const leg3 = await newListing(op, { from_code: 'BLR', to_code: 'HYD' });
  const p5 = await requestAndPay(leg3.id, traveller(5));
  const b5 = ok(await api(op, 'GET', '/lister/bookings?status=requested')).find((b) => b.booking_no === p5.booking_no);
  ok(await api(op, 'POST', `/lister/bookings/${b5.id}/confirm`));
  assert.equal((await api(op, 'POST', `/lister/bookings/${b5.id}/cancel`, { reason_type: 'bogus', reason: 'x' })).status, 400);
  const c5 = ok(await api(op, 'POST', `/lister/bookings/${b5.id}/cancel`, { reason_type: 'charter_change', reason: 'Main charter moved to Friday' }));
  assert.equal(c5.status, 'cancelled');
  assert.equal(c5.payment.status, 'refunded');
  assert.equal(c5.payment.refunded, c5.payment.amount);
  assert.equal(c5.payment.payout_status, 'cancelled');

  // ── Flown → payout due → finance marks paid ──
  assert.equal((await api(op, 'POST', `/lister/bookings/${a.id}/complete`)).status, 409, 'not before departure');
  await db(`UPDATE empty_legs SET depart_earliest = now() - interval '3 hours', depart_latest = now() - interval '2 hours' WHERE id = $1`, [leg.id]);
  const flown = ok(await api(op, 'POST', `/lister/bookings/${a.id}/complete`));
  assert.equal(flown.status, 'completed');
  assert.equal(flown.payment.payout_status, 'due');
  const mine = ok(await api(op, 'GET', '/lister/payouts'));
  assert.equal(mine.linked_account, false);
  assert.ok(mine.totals.due >= pub.total_inr - 10000);
  const po = ok(await api(sales, 'GET', '/marketplace/payouts?payout_status=due')).payouts.find((p) => p.booking_no === r1.booking_no);
  assert.ok(po);
  assert.equal((await api(sales, 'POST', `/marketplace/payouts/${po.id}/transfer`)).status, 409, 'no linked account');
  assert.equal((await api(sales, 'POST', `/marketplace/payouts/${po.id}/mark-paid`, {})).status, 400);
  assert.equal(ok(await api(sales, 'POST', `/marketplace/payouts/${po.id}/mark-paid`, { reference: 'UTR123456789' })).payout_status, 'paid');
  assert.equal((await api(op, 'GET', '/marketplace/payouts')).status, 403, 'listers cannot see all payouts');

  // Linked Route account → automatic transfer on completion.
  const listerId = ok(await api(op, 'GET', '/lister/me')).id;
  assert.equal((await api(sales, 'PATCH', `/listers/${listerId}`, { razorpay_account_id: 'nope' })).status, 400);
  ok(await api(sales, 'PATCH', `/listers/${listerId}`, { razorpay_account_id: 'acc_TestSkyHop1234' }));
  const leg4 = await newListing(op, { from_code: 'MAA', to_code: 'BLR' });
  const p6 = await requestAndPay(leg4.id, traveller(6));
  const b6 = ok(await api(op, 'GET', '/lister/bookings?status=requested')).find((b) => b.booking_no === p6.booking_no);
  ok(await api(op, 'POST', `/lister/bookings/${b6.id}/confirm`));
  await db(`UPDATE empty_legs SET depart_earliest = now() - interval '3 hours', depart_latest = now() - interval '2 hours' WHERE id = $1`, [leg4.id]);
  const t6 = ok(await api(op, 'POST', `/lister/bookings/${b6.id}/complete`));
  assert.equal(t6.payment.payout_status, 'transferred');
  ok(await api(sales, 'PATCH', `/listers/${listerId}`, { razorpay_account_id: '' }));

  // ── Staff cancel on the traveller's behalf: policy refund (>72h → 80%) ──
  const leg5 = await newListing(op, { from_code: 'HYD', to_code: 'GOI' });
  const p7 = await requestAndPay(leg5.id, traveller(7));
  const b7 = ok(await api(op, 'GET', '/lister/bookings?status=requested')).find((b) => b.booking_no === p7.booking_no);
  ok(await api(op, 'POST', `/lister/bookings/${b7.id}/confirm`));
  const sc = ok(await api(sales, 'POST', `/marketplace/bookings/${b7.id}/cancel`, { who: 'traveller', reason: 'Traveller plans changed' }));
  assert.equal(sc.refund.pct, 80);
  const v7 = ok(await api(null, 'GET', `/public/bookings/${p7.token}`));
  assert.equal(v7.payment.status, 'partially_refunded');
  assert.equal(v7.payment.refunded, Math.round(v7.payment.amount * 0.8 * 100) / 100);
  const po7 = ok(await api(sales, 'GET', '/marketplace/payouts')).payouts.find((p) => p.booking_no === p7.booking_no);
  const kept = v7.payment.amount - v7.payment.refunded;
  assert.equal(po7.payout, Math.round((kept - Math.round(kept * (100000 / v7.payment.amount) * 0.1 * 100) / 100) * 100) / 100, 'payout on what was kept');

  // ── Unfinished checkout expires; a late authorisation is released at once ──
  const leg6 = await newListing(op, { from_code: 'GOI', to_code: 'BOM' });
  const r8 = ok(await api(null, 'POST', `/public/empty-legs/${leg6.id}/request`, traveller(8)), 201);
  await db(`UPDATE empty_leg_bookings SET status = 'expired' WHERE access_token = $1`, [r8.booking_token]);
  const late = ok(await api(null, 'POST', `/public/bookings/${r8.booking_token}/mock-pay`, {}));
  assert.equal(late.status, 'expired');
  assert.equal(late.payment.status, 'released');

  // ── Route alerts ──
  assert.equal((await api(null, 'POST', '/public/route-alerts', { email: 'x' })).status, 400);
  assert.equal((await api(null, 'POST', '/public/route-alerts', { email: `al-${run}@example.in` })).status, 400, 'needs a city');
  ok(await api(null, 'POST', '/public/route-alerts', { email: `al-${run}@example.in`, name: 'Alert Fan', from_code: 'PNQ', to_code: 'DEL' }), 201);
  assert.equal(ok(await api(null, 'POST', '/public/route-alerts', { email: `al-${run}@example.in`, from_code: 'PNQ', to_code: 'DEL' })).existing, true);
  await newListing(op, { from_code: 'PNQ', to_code: 'DEL' });
  await new Promise((r) => setTimeout(r, 1500));
  const sent = await db(`SELECT subject FROM email_log WHERE to_email = $1 AND type = 'route_alert'`, [`al-${run}@example.in`]);
  assert.equal(sent.length, 1, 'alert emailed once');
  assert.match(sent[0].subject, /PNQ/);
  const demand = ok(await api(sales, 'GET', '/marketplace/route-demand'));
  assert.ok(demand.some((d) => d.from_code === 'PNQ' && d.to_code === 'DEL' && d.live_matches >= 1));
  const tok = (await db(`SELECT token FROM route_alerts WHERE email = $1`, [`al-${run}@example.in`]))[0].token;
  ok(await api(null, 'POST', `/public/route-alerts/stop/${tok}`));
  assert.equal((await db(`SELECT active FROM route_alerts WHERE token = $1`, [tok]))[0].active, false);

  // ── DGCA aircraft check ──
  const look = ok(await api(op, 'GET', '/lister/aircraft-lookup?registration=vt-ztt'));
  assert.equal(look.found, true);
  assert.equal(look.operator.name, 'Zest Aviation Pvt. Ltd.');
  assert.equal(look.check, 'other_operator');
  assert.equal(ok(await api(op, 'GET', '/lister/aircraft-lookup?registration=VT-QQQ')).check, 'not_listed');
  const withReg = ok(await api(op, 'POST', '/lister/empty-legs', {
    from_code: 'DEL', to_code: 'BOM', depart_earliest: `${istDay(8)}T09:00`, aircraft_type: 'Challenger 650', registration: 'VT-ZTT', seats: 10, price_inr: 300000,
  }), 201);
  assert.equal(withReg.dgca_check, 'other_operator');
  assert.equal(withReg.operator_name, 'Zest Aviation Pvt. Ltd.', '"Operated by" defaults to the DGCA holder');
  assert.equal((await api(op, 'POST', '/lister/empty-legs', {
    from_code: 'DEL', to_code: 'BOM', depart_earliest: `${istDay(8)}T09:00`, aircraft_type: 'B737', registration: 'VT-AFO', seats: 10, price_inr: 300000,
  })).status, 400, 'cargo aircraft refused');
});
