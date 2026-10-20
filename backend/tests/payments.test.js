/**
 * v1.2 payments against a running API (BASE_URL, default http://localhost:4000) with seeded demo data and
 * PAYMENTS_PROVIDER=mock (the default). NODE_ENV must be development or test (uses POST /payments/run-deadlines).
 *
 * pay order → mock complete / signed webhook → invoice paid; webhook replay is a no-op; tampered signature → 401;
 * flight log refused before payment; bank transfer via virtual account (stable account, oldest invoice first,
 * partial → partially_paid); refund policy (>7d 100%, 48h–7d 50%, <48h 0%) and ops refund_pct;
 * deadline job (reminder once, auto-cancel + full refund of part payments); dashboard block; config has no secrets.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const PASSWORD = process.env.DEMO_PASSWORD || 'Meridian@2026';
const MOCK_WEBHOOK_SECRET = process.env.MOCK_WEBHOOK_SECRET || 'mock_webhook_secret';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

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
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };

async function login(email) {
  return ok(await api(null, 'POST', '/auth/login', { email, password: PASSWORD }));
}

/** POST a webhook with the exact raw body we signed. */
async function postWebhook(raw, { signature, eventId }) {
  const res = await fetch(`${BASE_URL}/api/payments/webhook/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature, ...(eventId ? { 'x-razorpay-event-id': eventId } : {}) },
    body: raw,
  });
  return { status: res.status, data: await res.json() };
}
const sign = (raw) => crypto.createHmac('sha256', MOCK_WEBHOOK_SECRET).update(raw).digest('hex');

// IST helpers
const istLocal = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 16); // 'YYYY-MM-DDTHH:mm' in IST
const istDate = (ms) => istLocal(ms).slice(0, 10);
const close = (a, b, tol = 1) => Math.abs(Number(a) - Number(b)) <= tol;

let S;
async function sessions() {
  if (S) return S;
  S = {
    arjun: await login('arjun.mehra@example.in'),
    rajiv: await login('rajiv.malhotra@example.in'),
    sales: await login('sales@meridian.test'),
    ops: await login('ops@meridian.test'),
    pilot: await login('pilot1@meridian.test'),
  };
  return S;
}

/**
 * Create a charter through the API: quote request → quote → send → accept.
 * departMs: first departure instant. memberToken: member creating/accepting (or null → sales on behalf of memberId).
 */
async function bookCharter({ departMs, memberToken = null, memberId = null, pax = 2 }) {
  const { sales, ops } = await sessions();
  const avail = ok(await api(ops.token, 'GET', `/aircraft/availability?from=${istDate(departMs - DAY)}&to=${istDate(departMs + DAY)}`));
  const free = avail.aircraft.filter((a) => a.status === 'active' && a.seats >= pax && a.cells.every((c) => c.state === 'free'));
  assert.ok(free.length, `no free aircraft around ${istDate(departMs)}`);
  const ac = free[Math.floor(Math.random() * free.length)];
  const legs = [{ from: ac.home_base, to: 'GOI', depart_at: istLocal(departMs) }];
  const reqBody = { legs, pax, notes: 'Payments test' };
  const request = memberToken
    ? ok(await api(memberToken, 'POST', '/quote-requests', reqBody), 201)
    : ok(await api(sales.token, 'POST', '/quote-requests', { ...reqBody, member_id: memberId }), 201);
  const quote = ok(await api(sales.token, 'POST', '/quotes', { request_id: request.id, aircraft_id: ac.id }), 201);
  ok(await api(sales.token, 'POST', `/quotes/${quote.id}/send`, {}));
  const accepted = ok(await api(memberToken || sales.token, 'POST', `/quotes/${quote.id}/accept`));
  return { ...accepted, aircraft: ac };
}

/** Member (or staff) pays the full balance via the mock Checkout flow. */
async function payFull(token, invoiceId, method = 'card') {
  const order = ok(await api(token, 'POST', `/invoices/${invoiceId}/pay`));
  return ok(await api(token, 'POST', '/payments/mock/complete', { order_id: order.order_id, method }));
}

const farOffset = () => (200 + Math.floor(Math.random() * 500)) * DAY;

test('config exposes no secrets', async () => {
  const { arjun, sales } = await sessions();
  for (const t of [arjun, sales]) {
    const cfg = ok(await api(t.token, 'GET', '/payments/config'));
    assert.equal(cfg.provider, 'mock');
    assert.equal(cfg.key_id, null);
    const text = JSON.stringify(cfg).toLowerCase();
    assert.ok(!text.includes('secret'));
    assert.ok(!text.includes(MOCK_WEBHOOK_SECRET));
  }
  assert.equal((await api(null, 'GET', '/payments/config')).status, 401);
});

test('pay order → mock complete / signed webhook → paid; replay no-op; tampered → 401; flight log needs payment', async () => {
  const { arjun, rajiv, sales, ops, pilot } = await sessions();
  const { charter, invoice } = await bookCharter({ departMs: Date.now() + farOffset(), memberToken: arjun.token, pax: 2 });
  assert.ok(invoice.due_at, 'invoice has due_at');
  assert.ok(close(Date.parse(invoice.due_at), Date.parse(charter.legs[0].depart_at) - DAY, 1000), 'due 24h before first departure');

  const inv0 = ok(await api(arjun.token, 'GET', `/invoices/${invoice.id}`));
  assert.equal(inv0.amount_paid, 0);
  assert.equal(inv0.balance, invoice.total);
  assert.deepEqual(inv0.payments, []);

  // Confirm + manifest so the only thing missing before the flight log is payment.
  const crew = ok(await api(ops.token, 'GET', '/crew'));
  const captain = crew.find((c) => c.crew_role === 'captain' && c.user_id === pilot.user.id);
  const fos = crew.filter((c) => c.crew_role === 'first_officer' && c.is_active);
  let confirmed = null;
  for (let i = 0; i < fos.length && !confirmed; i++) {
    ok(await api(ops.token, 'POST', `/charters/${charter.id}/assign`, { captain_id: captain.id, first_officer_id: fos[i].id }));
    const r = await api(ops.token, 'POST', `/charters/${charter.id}/confirm`);
    if (r.status === 200) confirmed = r.data;
  }
  assert.ok(confirmed, 'could not confirm');
  ok(await api(arjun.token, 'PUT', `/charters/${charter.id}/passengers`, { passengers: [{ full_name: 'Arjun Mehra', id_type: 'passport', id_number: 'K98765432' }] }));
  const mc = ok(await api(arjun.token, 'POST', `/charters/${charter.id}/manifest/submit`));
  assert.equal(mc.payment_status, 'unpaid');
  const legs = mc.legs.map((l, index) => ({ index, block_off: l.depart_at, block_on: l.arrive_at }));
  const refused = await api(pilot.token, 'POST', `/charters/${charter.id}/flight-log`, { legs });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error, 'Charter not paid');

  // Order for the balance; reused on a second click; other members cannot pay it.
  const order = ok(await api(arjun.token, 'POST', `/invoices/${invoice.id}/pay`));
  assert.equal(order.provider, 'mock');
  assert.equal(order.currency, 'INR');
  assert.equal(order.amount_paise, Math.round(invoice.total * 100));
  assert.equal(order.invoice_no, invoice.invoice_no);
  assert.ok(order.prefill && order.prefill.email === 'arjun.mehra@example.in');
  assert.ok(order.description);
  assert.equal(ok(await api(arjun.token, 'POST', `/invoices/${invoice.id}/pay`)).order_id, order.order_id);
  assert.equal((await api(rajiv.token, 'POST', `/invoices/${invoice.id}/pay`)).status, 404);
  assert.equal((await api(rajiv.token, 'POST', '/payments/mock/complete', { order_id: order.order_id, method: 'card' })).status, 404);

  // A Razorpay-shaped payment.captured event for this order.
  const paymentId = `pay_test_${crypto.randomBytes(6).toString('hex')}`;
  const event = {
    entity: 'event', account_id: 'acc_test', event: 'payment.captured', contains: ['payment'], created_at: Math.floor(Date.now() / 1000),
    payload: { payment: { entity: { id: paymentId, entity: 'payment', amount: order.amount_paise, currency: 'INR', status: 'captured', order_id: order.order_id, method: 'card', fee: 1000, tax: 153, card: { last4: '1111', network: 'Visa' } } } },
  };
  const raw = JSON.stringify(event);
  const eventId = `evt_test_${crypto.randomBytes(6).toString('hex')}`;

  // Tampered signature / tampered body → 401, nothing applied
  const sig = sign(raw);
  const badSig = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
  assert.equal((await postWebhook(raw, { signature: badSig, eventId })).status, 401);
  assert.equal((await postWebhook(raw.replace(`"amount":${order.amount_paise}`, '"amount":100'), { signature: sig, eventId })).status, 401);
  assert.equal((await postWebhook(raw, { signature: '', eventId })).status, 401);
  assert.equal(ok(await api(arjun.token, 'GET', `/invoices/${invoice.id}`)).status, 'unpaid');

  // Valid → paid
  const first = await postWebhook(raw, { signature: sig, eventId });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const paid = ok(await api(arjun.token, 'GET', `/invoices/${invoice.id}`));
  assert.equal(paid.status, 'paid');
  assert.equal(paid.amount_paid, invoice.total);
  assert.equal(paid.balance, 0);
  assert.equal(paid.payments.length, 1);
  assert.equal(paid.payments[0].method, 'card');
  assert.equal(paid.payments[0].fee, undefined, 'members do not see fees');
  const staffView = ok(await api(sales.token, 'GET', `/invoices/${invoice.id}`));
  assert.equal(staffView.payments[0].fee, 10);

  // Replay: same event id → duplicate no-op; same payment under a new event id → still a no-op
  const replay = await postWebhook(raw, { signature: sig, eventId });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.duplicate, true);
  assert.equal((await postWebhook(raw, { signature: sig, eventId: `${eventId}_again` })).status, 200);
  const after = ok(await api(sales.token, 'GET', `/invoices/${invoice.id}`));
  assert.equal(after.amount_paid, invoice.total);
  assert.equal(after.payments.length, 1);
  // Paid order cannot be completed again; paid invoice cannot be paid again
  assert.equal((await api(arjun.token, 'POST', '/payments/mock/complete', { order_id: order.order_id, method: 'upi' })).status, 409);
  assert.equal((await api(arjun.token, 'POST', `/invoices/${invoice.id}/pay`)).status, 409);

  // Checkout verification: bad signature rejected
  assert.equal((await api(arjun.token, 'POST', '/payments/verify', { razorpay_order_id: order.order_id, razorpay_payment_id: paymentId, razorpay_signature: 'deadbeef' })).status, 400);

  // Now the flight can be logged; paid + flown → closed
  const flown = ok(await api(pilot.token, 'POST', `/charters/${charter.id}/flight-log`, { legs }));
  assert.equal(flown.status, 'closed');
  assert.equal(flown.payment_status, 'paid');
});

test('mock checkout + verify endpoint, and manual mark-paid records a payment', async () => {
  const { arjun, sales } = await sessions();
  const a = await bookCharter({ departMs: Date.now() + farOffset(), memberToken: arjun.token });
  const done = await payFull(arjun.token, a.invoice.id, 'upi');
  assert.equal(done.invoice.status, 'paid');
  // Verifying an already-applied Checkout payment is idempotent
  const v = ok(await api(arjun.token, 'POST', '/payments/verify', { razorpay_order_id: done.order_id, razorpay_payment_id: done.payment_id, razorpay_signature: done.checkout_signature }));
  assert.equal(v.invoice.status, 'paid');
  assert.equal(v.invoice.payments.length, 1);

  const b = await bookCharter({ departMs: Date.now() + farOffset(), memberToken: arjun.token });
  const mp = ok(await api(sales.token, 'POST', `/invoices/${b.invoice.id}/mark-paid`, { payment_ref: 'NEFT-TEST-99' }));
  assert.equal(mp.status, 'paid');
  assert.equal(mp.payment_ref, 'NEFT-TEST-99');
  assert.equal(mp.payments.length, 1);
  assert.equal(mp.payments[0].provider, 'manual');
  assert.equal(mp.payments[0].method, 'bank_transfer');

  const list = ok(await api(sales.token, 'GET', '/payments'));
  assert.ok(Array.isArray(list.payments));
  assert.ok(list.payments.some((p) => p.invoice_id === b.invoice.id && p.invoice_no && p.member_no));
  assert.ok(list.totals.amount > 0);
  assert.equal((await api(arjun.token, 'GET', '/payments')).status, 403);
});

test('bank transfer: stable virtual account, oldest invoice first, partial → partially_paid, deadline cancels and refunds', async () => {
  const { arjun, sales, ops } = await sessions();
  // Arjun's own account is stable across calls
  const mine1 = ok(await api(arjun.token, 'GET', '/members/me/bank-transfer'));
  const mine2 = ok(await api(arjun.token, 'GET', '/members/me/bank-transfer'));
  assert.deepEqual(mine1, mine2);
  assert.match(mine1.account_number, /^2223330\d{9}$/);
  assert.equal(mine1.ifsc, 'RATN0VAAPIS');
  assert.ok(mine1.account_name && mine1.bank_name);

  // A fresh member with two charters (sales books on their behalf)
  const tag = crypto.randomBytes(4).toString('hex');
  const member = ok(await api(sales.token, 'POST', '/members', { contact_name: `Test Payer ${tag}`, email: `payer.${tag}@example.in`, city: 'Mumbai' }), 201);
  const base = Date.now() + farOffset();
  const A = await bookCharter({ departMs: base, memberId: member.id });
  const B = await bookCharter({ departMs: base + 5 * DAY, memberId: member.id });

  const acct = ok(await api(sales.token, 'GET', `/members/${member.id}/bank-transfer`));
  assert.deepEqual(ok(await api(ops.token, 'GET', `/members/${member.id}/bank-transfer`)), acct);
  assert.notEqual(acct.account_number, mine1.account_number);
  assert.equal((await api(arjun.token, 'GET', `/members/${member.id}/bank-transfer`)).status, 403);

  // Members cannot simulate transfers
  assert.equal((await api(arjun.token, 'POST', '/payments/mock/bank-transfer', { member_id: member.id, amount: 1000 })).status, 403);

  // Part payment lands on the oldest open invoice (A)
  const part = ok(await api(sales.token, 'POST', '/payments/mock/bank-transfer', { member_id: member.id, amount: 100000 }));
  assert.equal(part.applied, true);
  assert.equal(part.invoice.id, A.invoice.id);
  assert.equal(part.invoice.status, 'partially_paid');
  assert.equal(part.invoice.amount_paid, 100000);
  assert.equal(part.invoice.balance, Math.round((A.invoice.total - 100000) * 100) / 100);
  assert.equal(part.invoice.payments[0].method, 'bank_transfer');
  assert.equal(part.invoice.payments[0].fee, 0);
  assert.equal(ok(await api(sales.token, 'GET', `/invoices/${B.invoice.id}`)).status, 'unpaid');

  // Deadline: reminder at due − 48h (once), then auto-cancel after due_at with the part payment refunded in full
  const dueA = Date.parse(A.invoice.due_at);
  const r1 = ok(await api(ops.token, 'POST', '/payments/run-deadlines', { charter_id: A.charter.id, now: new Date(dueA - 47 * HOUR).toISOString() }));
  assert.deepEqual(r1.reminders.map((r) => r.kind), ['48h']);
  assert.equal(r1.cancelled.length, 0);
  const r2 = ok(await api(ops.token, 'POST', '/payments/run-deadlines', { charter_id: A.charter.id, now: new Date(dueA - 46 * HOUR).toISOString() }));
  assert.equal(r2.reminders.length, 0, 'reminder sent once');
  const r3 = ok(await api(ops.token, 'POST', '/payments/run-deadlines', { charter_id: A.charter.id, now: new Date(dueA + 60 * 1000).toISOString() }));
  assert.equal(r3.cancelled.length, 1);
  assert.equal(r3.cancelled[0].refund.pct, 100);
  assert.equal(r3.cancelled[0].refund.amount, 100000);
  const cA = ok(await api(ops.token, 'GET', `/charters/${A.charter.id}`));
  assert.equal(cA.status, 'cancelled');
  assert.equal(cA.cancel_reason, 'Not paid by the deadline');
  const iA = ok(await api(sales.token, 'GET', `/invoices/${A.invoice.id}`));
  assert.equal(iA.status, 'refunded');
  assert.equal(iA.refunds.reduce((s, r) => s + r.amount, 0), 100000);
  assert.equal(iA.payments[0].status, 'refunded');
  // Aircraft released: running again is a no-op
  assert.equal(ok(await api(ops.token, 'POST', '/payments/run-deadlines', { charter_id: A.charter.id, now: new Date(dueA + 120 * 1000).toISOString() })).cancelled.length, 0);

  // Next transfer goes to B (now the oldest open invoice) and pays it in full
  const full = ok(await api(sales.token, 'POST', '/payments/mock/bank-transfer', { member_id: member.id, amount: B.invoice.total }));
  assert.equal(full.invoice.id, B.invoice.id);
  assert.equal(full.invoice.status, 'paid');
  // No open invoice left: the credit is recorded as an error for sales, not applied
  const stray = ok(await api(sales.token, 'POST', '/payments/mock/bank-transfer', { invoice_id: B.invoice.id, amount: 500 }));
  assert.equal(stray.applied, false);
  assert.match(stray.error, /No open invoice/);
});

test('deadline job auto-cancels a fully unpaid charter', async () => {
  const { arjun, ops } = await sessions();
  const C = await bookCharter({ departMs: Date.now() + farOffset(), memberToken: arjun.token });
  const due = Date.parse(C.invoice.due_at);
  // Not yet due → nothing happens
  assert.equal(ok(await api(ops.token, 'POST', '/payments/run-deadlines', { charter_id: C.charter.id, now: new Date(due - 60 * 1000).toISOString() })).cancelled.length, 0);
  const r = ok(await api(ops.token, 'POST', '/payments/run-deadlines', { charter_id: C.charter.id, now: new Date(due + 60 * 1000).toISOString() }));
  assert.equal(r.cancelled.length, 1);
  assert.equal(r.cancelled[0].refund.amount, 0);
  const c = ok(await api(arjun.token, 'GET', `/charters/${C.charter.id}`));
  assert.equal(c.status, 'cancelled');
  assert.equal(c.cancel_reason, 'Not paid by the deadline');
  assert.equal(c.invoice.status, 'cancelled');
  // Members cannot run the job
  assert.equal((await api(arjun.token, 'POST', '/payments/run-deadlines', {})).status, 403);
});

test('cancellation refund policy: member >7d 100%, 48h–7d 50%, <48h 0%; ops refund_pct', async () => {
  const { arjun, ops } = await sessions();
  const cases = [
    { label: '>7 days', departMs: Date.now() + 10 * DAY + 3 * HOUR, pct: 100, status: 'refunded' },
    { label: '48h–7d', departMs: Date.now() + 4 * DAY + 3 * HOUR, pct: 50, status: 'refunded' },
    { label: '<48h', departMs: Date.now() + 30 * HOUR, pct: 0, status: 'cancelled' },
  ];
  for (const k of cases) {
    const { charter, invoice } = await bookCharter({ departMs: k.departMs, memberToken: arjun.token });
    await payFull(arjun.token, invoice.id, 'netbanking');
    const q = ok(await api(arjun.token, 'GET', `/charters/${charter.id}/cancellation-quote`));
    assert.equal(q.pct, k.pct, k.label);
    assert.equal(q.amount_paid, invoice.total, k.label);
    assert.ok(close(q.refund_amount, (invoice.total * k.pct) / 100, 0.01), k.label);
    const out = ok(await api(arjun.token, 'POST', `/charters/${charter.id}/cancel`, { reason: `Test ${k.label}`, refund_pct: 100 /* ignored for members */ }));
    assert.equal(out.status, 'cancelled', k.label);
    assert.equal(out.refund.pct, k.pct, k.label);
    assert.ok(close(out.refund.amount, (invoice.total * k.pct) / 100, 0.01), k.label);
    const inv = ok(await api(arjun.token, 'GET', `/invoices/${invoice.id}`));
    assert.equal(inv.status, k.status, k.label);
    assert.ok(close(inv.refunds.reduce((s, r) => s + r.amount, 0), out.refund.amount, 0.01), k.label);
    assert.ok(inv.refunds.every((r) => r.status === 'processed'), k.label);
  }

  // Operator cancellation: chosen refund_pct (default 100); invalid pct rejected
  const { charter, invoice } = await bookCharter({ departMs: Date.now() + farOffset(), memberToken: arjun.token });
  await payFull(arjun.token, invoice.id, 'card');
  assert.equal(ok(await api(ops.token, 'GET', `/charters/${charter.id}/cancellation-quote`)).pct, 100);
  const q25 = ok(await api(ops.token, 'GET', `/charters/${charter.id}/cancellation-quote?refund_pct=25`));
  assert.ok(close(q25.refund_amount, invoice.total * 0.25, 0.01));
  assert.equal((await api(ops.token, 'POST', `/charters/${charter.id}/cancel`, { reason: 'Aircraft AOG', refund_pct: 150 })).status, 400);
  assert.equal(ok(await api(ops.token, 'GET', `/charters/${charter.id}`)).status, 'accepted', 'invalid pct leaves the charter untouched');
  const out = ok(await api(ops.token, 'POST', `/charters/${charter.id}/cancel`, { reason: 'Aircraft AOG', refund_pct: 25 }));
  assert.equal(out.refund.pct, 25);
  assert.ok(close(out.refund.amount, invoice.total * 0.25, 0.01));
  assert.equal(out.invoice.status, 'refunded');
});

test('dashboard payments block', async () => {
  const { sales, arjun } = await sessions();
  const d = ok(await api(sales.token, 'GET', '/dashboard'));
  assert.ok(d.payments, 'payments block');
  for (const k of ['collected_30d', 'fees_30d', 'unpaid_due_48h_count', 'unpaid_due_48h_amount']) assert.equal(typeof d.payments[k], 'number', k);
  assert.ok(d.payments.collected_30d > 0);
  assert.ok(d.payments.fees_30d > 0);
  const md = ok(await api(arjun.token, 'GET', '/dashboard/member'));
  assert.ok('unpaid_invoices' in md);
});
