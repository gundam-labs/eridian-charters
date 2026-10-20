// End-to-end browser test: drives the whole charter lifecycle through the UI.
// Run: BASE_UI_URL=http://localhost:5173 node --test tests/e2e/lifecycle.e2e.mjs
// The API is only called directly to read state for assertions (and to pick free dates).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const BASE = (process.env.BASE_UI_URL || 'http://localhost:5173').replace(/\/$/, '');
const CHROME = process.env.CHROME_PATH || '/opt/google/chrome/chrome';
const SHOTS = process.env.E2E_SHOTS || '/tmp/claude-0/pw/e2e';
const PASSWORD = 'Meridian@2026';
const HEADLESS = process.env.HEADED !== '1';

const USERS = {
  member: 'arjun.mehra@example.in',
  other: 'rajiv.malhotra@example.in',
  sales: 'sales@meridian.test',
  ops: 'ops@meridian.test',
  pilot: 'pilot1@meridian.test',
};
const ROUTE = { from: 'DEL', to: 'BOM' };

fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

let browser;
const problems = [];
// Responses the test deliberately provokes (e.g. a member opening someone else's trip).
const expected = new Set();

// ── API helpers (read-only, for assertions) ─────────────────────────────────
const tokens = {};
async function token(who) {
  if (tokens[who]) return tokens[who];
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: USERS[who], password: PASSWORD }),
  });
  assert.equal(r.status, 200, `API login for ${who}`);
  tokens[who] = (await r.json()).token;
  return tokens[who];
}
async function apiGet(who, path) {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${await token(who)}` } });
  assert.ok(r.ok, `GET ${path} as ${who} → ${r.status}`);
  return r.json();
}

// ── Browser helpers ─────────────────────────────────────────────────────────
function watch(page, label) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    const url = m.location()?.url || '';
    if (/fonts\.(googleapis|gstatic)\.com/.test(url + text) || /ERR_TUNNEL_CONNECTION_FAILED/.test(text)) return;
    // Chrome logs "Failed to load resource" for every non-2xx; those are judged by the response handler below.
    if (/Failed to load resource: the server responded with a status of/.test(text) && url.includes('/api/')) return;
    problems.push(`[${label}] console error: ${text} ${url}`);
  });
  page.on('pageerror', (e) => problems.push(`[${label}] page error: ${e.message}`));
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/')) return;
    const s = r.status();
    const key = `${r.request().method()} ${u.pathname} ${s}`;
    if (s >= 500) problems.push(`[${label}] ${key}`);
    else if (s >= 400 && !expected.has(key)) problems.push(`[${label}] unexpected ${key}`);
  });
}

async function session(who, label, viewport = { width: 1360, height: 900 }) {
  const context = await browser.newContext({ viewport, baseURL: BASE });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  watch(page, label);
  context.on('page', (p) => watch(p, `${label}:popup`));
  page.on('dialog', (d) => d.accept());
  await page.goto('/login');
  await page.locator('#email').fill(USERS[who]);
  await page.locator('#pw').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  return { context, page };
}

let shotNo = 0;
async function shot(page, name) {
  shotNo += 1;
  await page.screenshot({ path: `${SHOTS}/${String(shotNo).padStart(2, '0')}-${name}.png`, fullPage: true });
}

function assertClean(step) {
  assert.deepEqual(problems, [], `${step}: browser problems\n${problems.join('\n')}`);
}

// ── Dates ───────────────────────────────────────────────────────────────────
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };

/** First date ≥ today+21 whose ±2 day window has no live charter (keeps aircraft and crew free across reruns). */
async function pickDates() {
  const live = (await apiGet('ops', '/api/charters')).filter((c) => !['cancelled', 'closed'].includes(c.status));
  let d = addDays(ymd(new Date()), 21);
  for (let i = 0; i < 60; i++, d = addDays(d, 1)) {
    const lo = addDays(d, -2), hi = addDays(d, 4);
    if (!live.some((c) => c.starts_on <= hi && c.ends_on >= lo)) return d;
  }
  throw new Error('No free window found in the next 3 months');
}

// ── Test ────────────────────────────────────────────────────────────────────
before(async () => {
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'], headless: HEADLESS });
});
after(async () => { await browser?.close(); });

test('charter lifecycle through the UI', { timeout: 240_000 }, async (t) => {
  const outDate = await pickDates();
  const retDate = addDays(outDate, 2);
  const ctx = {};
  let failed = false;
  // Steps depend on each other: once one fails, skip the rest instead of piling up noise.
  const step = (name, fn) => t.test(name, async (st) => {
    if (failed) { st.skip('earlier step failed'); return; }
    try { await fn(st); } catch (e) { failed = true; throw e; }
  });

  await step('1. member submits a 2-leg quote request', async () => {
    const { context, page } = await session('member', 'member');
    ctx.member = { context, page };
    await page.getByRole('link', { name: 'Request a quote' }).first().click();
    await page.getByTestId('leg-from-0').selectOption(ROUTE.from);
    await page.getByTestId('leg-to-0').selectOption(ROUTE.to);
    await page.getByTestId('leg-depart-0').fill(`${outDate}T09:00`);
    await page.getByRole('button', { name: /Add return leg/ }).click();
    await assert.doesNotReject(page.getByTestId('leg-from-1').waitFor());
    assert.equal(await page.getByTestId('leg-from-1').inputValue(), ROUTE.to);
    assert.equal(await page.getByTestId('leg-to-1').inputValue(), ROUTE.from);
    assert.equal(await page.getByTestId('leg-depart-1').inputValue(), `${addDays(outDate, 1)}T17:00`);
    await page.getByTestId('leg-depart-1').fill(`${retDate}T17:00`);
    await page.getByTestId('pax-input').fill('3');
    await page.locator('textarea').first().fill('E2E lifecycle test');
    await shot(page, 'member-request-form');
    await page.getByRole('button', { name: 'Submit request' }).click();
    await page.waitForURL(/\/m\/requests\/[0-9a-f-]{36}\?created=1/);
    ctx.requestId = page.url().match(/requests\/([0-9a-f-]{36})/)[1];
    await page.getByText('Request received').waitFor();
    const rq = await apiGet('member', `/api/quote-requests/${ctx.requestId}`);
    const req = rq.request || rq;
    ctx.requestNo = req.request_no;
    assert.equal(req.pax, 3);
    assert.equal(req.legs.length, 2);
    assert.equal(req.status, 'open');
    await shot(page, 'member-request-created');
    assertClean('step 1');
  });

  await step('2. sales builds and sends a quote', async () => {
    const { context, page } = await session('sales', 'sales');
    ctx.sales = { context, page };
    await page.goto('/s/requests');
    await page.getByRole('link', { name: ctx.requestNo }).click();
    await page.waitForURL(`**/s/requests/${ctx.requestId}`);
    await page.getByRole('button', { name: 'Build a quote' }).first().click();
    const free = page.locator('[data-testid="aircraft-option"][data-busy="false"]');
    await free.first().waitFor();
    // Wait for availability to load (it may sort busy aircraft down), then prefer one based at the origin.
    await page.waitForLoadState('networkidle');
    const options = await free.evaluateAll((els) => els.map((e) => ({ reg: e.dataset.reg, text: e.textContent })));
    const pick = options.find((o) => o.text.includes(`base ${ROUTE.from}`)) || options[0];
    ctx.registration = pick.reg;
    await page.locator(`[data-testid="aircraft-option"][data-reg="${pick.reg}"]`).click();
    const total = page.getByTestId('preview-total');
    await total.waitFor();
    const lines = page.getByTestId('preview-lines');
    await lines.getByText('Flight time').waitFor();
    assert.ok(await lines.getByText(`Landing fee – ${ROUTE.to}`).count() >= 1, 'landing fee line');
    assert.ok(await lines.getByText(`Handling – ${ROUTE.from}`).count() >= 1, 'handling line');
    assert.match(await total.textContent(), /₹\s?[\d,]+/);
    await shot(page, 'sales-quote-builder');
    await page.getByRole('button', { name: 'Send to member' }).click();
    await page.getByText(/sent to the member/).waitFor();
    const rq = await apiGet('sales', `/api/quote-requests/${ctx.requestId}`);
    const quotes = rq.quotes || rq.request?.quotes;
    const q = quotes.find((x) => x.status === 'sent');
    assert.ok(q, 'a sent quote exists');
    ctx.quoteId = q.id; ctx.quoteNo = q.quote_no; ctx.quoteTotal = q.total;
    assert.equal((rq.request || rq).status, 'quoted');
    await shot(page, 'sales-quote-sent');
    assertClean('step 2');
  });

  await step('3. member views quote, opens PDF, accepts', async () => {
    const { page, context } = ctx.member;
    await page.goto(`/m/requests/${ctx.requestId}`);
    const card = page.locator(`[data-testid="quote-card"][data-quote-no="${ctx.quoteNo}"]`);
    await card.waitFor();
    await card.getByRole('cell', { name: 'Flight time', exact: true }).waitFor(); // breakdown open by default for sent quotes
    const pdfResp = page.waitForResponse((r) => r.url().endsWith(`/api/quotes/${ctx.quoteId}/pdf`));
    const popup = context.waitForEvent('page');
    await card.getByRole('button', { name: 'Quote PDF' }).click();
    const resp = await pdfResp;
    assert.equal(resp.status(), 200);
    assert.match(resp.headers()['content-type'] || '', /application\/pdf/);
    const body = await resp.body();
    assert.equal(body.subarray(0, 5).toString(), '%PDF-');
    const p = await popup;
    await p.waitForURL(/^blob:/);
    await p.close();
    assert.equal(await page.getByRole('alert').count(), 0, 'no PDF error shown');
    await shot(page, 'member-quote');
    await card.getByRole('button', { name: 'Accept quote' }).click();
    await page.waitForURL(/\/m\/trips\/[0-9a-f-]{36}\?booked=1/);
    ctx.charterId = page.url().match(/trips\/([0-9a-f-]{36})/)[1];
    await page.getByText('Your charter is booked').waitFor();
    const ch = await apiGet('ops', `/api/charters/${ctx.charterId}`);
    assert.equal(ch.status, 'accepted');
    assert.equal(ch.invoice?.status, 'unpaid');
    ctx.charterNo = ch.charter_no; ctx.startsOn = ch.starts_on; ctx.endsOn = ch.ends_on;
    await shot(page, 'member-trip-booked');
    assertClean('step 3');
  });

  await step('4. ops assigns crew, confirms, checks fleet calendar', async () => {
    const { context, page } = await session('ops', 'ops');
    ctx.ops = { context, page };
    const crew = await apiGet('ops', '/api/crew');
    const captain = crew.find((c) => c.user_email === USERS.pilot || c.email === USERS.pilot)
      || crew.find((c) => c.user_id && c.crew_role === 'captain' && /Vikrant/.test(c.name));
    assert.ok(captain, 'crew record linked to pilot1');
    await page.goto('/o/charters');
    await page.getByText(ctx.charterNo).first().click();
    await page.waitForURL(`**/o/charters/${ctx.charterId}`);
    await page.getByTestId('assign-captain').selectOption(captain.id);
    const foOpts = await page.getByTestId('assign-first_officer').locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
    assert.ok(foOpts.length > 0, 'first officers listed');
    await page.getByTestId('assign-first_officer').selectOption(foOpts[0]);
    await page.getByRole('button', { name: 'Save assignment' }).click();
    await page.getByText('Assignment saved.').waitFor();
    await page.getByRole('button', { name: 'Confirm charter' }).click();
    await page.getByText('Charter confirmed').waitFor();
    const ch = await apiGet('ops', `/api/charters/${ctx.charterId}`);
    assert.equal(ch.status, 'confirmed');
    assert.equal(ch.captain_id, captain.id);
    await shot(page, 'ops-charter-confirmed');

    await page.goto('/o/calendar');
    await page.getByRole('button', { name: 'Next →' }).waitFor();
    // Page forward until the charter's first day is in view (14-day windows).
    for (let i = 0; i < 6; i++) {
      if (await page.locator(`tr[data-reg="${ctx.registration}"] td[data-date="${ctx.startsOn}"]`).count()) break;
      await page.getByRole('button', { name: 'Next →' }).click();
      await page.waitForLoadState('networkidle');
    }
    const row = page.locator(`tr[data-reg="${ctx.registration}"]`);
    for (let d = ctx.startsOn; d <= ctx.endsOn; d = addDays(d, 1)) {
      const cell = row.locator(`td[data-date="${d}"]`);
      if (!(await cell.count())) continue; // block may straddle the window edge
      assert.match(await cell.getAttribute('class'), /\bcharter\b/, `calendar cell ${d} is charter`);
    }
    assert.match(await row.locator(`td[data-date="${ctx.startsOn}"]`).getAttribute('class'), /\bcharter\b/);
    await row.locator(`td[data-date="${ctx.startsOn}"] button`).click();
    await page.getByRole('dialog').getByText(ctx.charterNo).waitFor();
    await shot(page, 'ops-fleet-calendar');
    await page.getByRole('dialog').getByRole('link', { name: 'Open charter' }).waitFor();
    await page.getByRole('dialog').locator('.form-actions').getByRole('button', { name: 'Close' }).click();
    assertClean('step 4');
  });

  await step('5. member enters and submits the manifest', async () => {
    const { page } = ctx.member;
    await page.goto(`/m/trips/${ctx.charterId}`);
    await page.getByTestId('pax-name-0').waitFor();
    await page.getByTestId('pax-name-0').fill('Arjun Mehra');
    await page.getByTestId('pax-id-0').fill('Z1234567');
    await page.getByRole('button', { name: '+ Add passenger' }).click();
    await page.getByTestId('pax-name-1').fill('Kavya Mehra');
    await page.getByTestId('pax-id-1').fill('Z7654321');
    await shot(page, 'member-manifest');
    await page.getByRole('button', { name: 'Submit manifest' }).click();
    await page.getByText('Manifest submitted').waitFor();
    const ch = await apiGet('ops', `/api/charters/${ctx.charterId}`);
    assert.equal(ch.status, 'manifest_complete');
    assert.deepEqual(ch.passengers.map((p) => p.full_name).sort(), ['Arjun Mehra', 'Kavya Mehra']);
    assert.ok(ch.passengers.some((p) => p.id_number === 'Z1234567'), 'full ID stored');
    await page.reload();
    await page.getByRole('cell', { name: 'Kavya Mehra' }).waitFor();
    await shot(page, 'member-manifest-submitted');
    assertClean('step 5');
  });

  await step('5b. member pays the invoice in test mode', async () => {
    const { page } = ctx.member;
    await page.goto(`/m/trips/${ctx.charterId}`);
    const card = page.getByTestId('payment-card');
    await card.waitFor();
    await card.getByRole('tab', { name: /Card, UPI or netbanking/ }).click();
    await card.getByTestId('pay-online').click();
    await page.getByTestId('mock-checkout').waitFor();
    await shot(page, 'member-pay-test-mode');
    await page.getByTestId('mock-pay').click();
    await page.getByText('Payment received').waitFor();
    const ch = await apiGet('ops', `/api/charters/${ctx.charterId}`);
    assert.equal(ch.invoice?.status ?? ch.payment_status, 'paid');
    await shot(page, 'member-paid');
    assertClean('step 5b');
  });

  await step('6. pilot logs block times on a phone-width screen', async () => {
    const { context, page } = await session('pilot', 'pilot', { width: 390, height: 844 });
    ctx.pilot = { context, page };
    const card = page.locator(`a[href="/p/flights/${ctx.charterId}"]`);
    await card.waitFor();
    assert.match(await card.textContent(), new RegExp(ctx.registration));
    const nav = await page.getByRole('link', { name: 'My flights' }).boundingBox();
    assert.ok(nav && nav.x >= 0 && nav.x + nav.width <= 390, `"My flights" nav link fits the 390px viewport (${JSON.stringify(nav)})`);
    await shot(page, 'pilot-my-flights');
    await card.click();
    await page.waitForURL(`**/p/flights/${ctx.charterId}`);
    await page.getByText('Kavya Mehra').waitFor();
    const html = await page.content();
    assert.ok(!html.includes('Z1234567') && !html.includes('Z7654321'), 'no full ID numbers on pilot screen');
    const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    assert.ok(noHScroll, 'no horizontal scroll at 390px');
    const legs = [[`${outDate}T09:05`, `${outDate}T11:20`], [`${retDate}T17:10`, `${retDate}T19:25`]];
    for (let i = 0; i < legs.length; i++) {
      await page.getByTestId(`block-off-${i}`).fill(legs[i][0]);
      await page.getByTestId(`block-on-${i}`).fill(legs[i][1]);
    }
    await shot(page, 'pilot-flight-log');
    await page.getByRole('button', { name: 'Submit flight log' }).click();
    await page.getByText('Flight log submitted').waitFor();
    const ch = await apiGet('ops', `/api/charters/${ctx.charterId}`);
    assert.equal(ch.status, 'closed', 'paid in advance, so the trip closes on landing');
    assert.equal(ch.legs[0].block_off.slice(0, 16), `${outDate}T09:05`);
    assert.equal(ch.legs[1].block_on.slice(0, 16), `${retDate}T19:25`);
    await shot(page, 'pilot-flight-logged');
    assertClean('step 6');
  });

  await step('7. sales sees the online payment; charter closed', async () => {
    const { page } = ctx.sales;
    const ch0 = await apiGet('ops', `/api/charters/${ctx.charterId}`);
    const invNo = ch0.invoice.invoice_no;
    await page.goto('/s/invoices');
    const row = page.locator(`[data-testid="invoice-row"][data-invoice-no="${invNo}"]`);
    await row.getByText('Paid', { exact: true }).waitFor();
    await shot(page, 'sales-invoice-paid');
    await page.goto(`/o/charters/${ctx.charterId}`);
    await page.locator('.page-head .pill', { hasText: 'Closed' }).waitFor();
    await shot(page, 'sales-charter-closed');
    assert.equal(ch0.status, 'closed');
    assert.equal(ch0.invoice.status, 'paid');
    await ctx.member.page.goto(`/m/trips/${ctx.charterId}`);
    await ctx.member.page.locator('.page-head .pill', { hasText: 'Closed' }).waitFor();
    assertClean('step 7');
  });

  await step("8. another member cannot open arjun's trip", async () => {
    expected.add(`GET /api/charters/${ctx.charterId} 404`);
    const { context, page } = await session('other', 'rajiv');
    await page.goto(`/m/trips/${ctx.charterId}`);
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').textContent(), /not found/i);
    const html = await page.content();
    assert.ok(!html.includes(ctx.charterNo) && !html.includes('Kavya Mehra'), 'no trip details leaked');
    await shot(page, 'other-member-denied');
    await context.close();
    assertClean('step 8');
  });

  for (const k of ['member', 'sales', 'ops', 'pilot']) await ctx[k]?.context.close();
});
