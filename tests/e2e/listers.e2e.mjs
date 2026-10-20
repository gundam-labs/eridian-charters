// Browser E2E for listers: an operator signs up, drafts a flight while pending, sales approves them,
// they publish, a public visitor requests it, and the operator confirms the request.
// Usage: BASE_UI_URL=http://localhost:5173 node --test tests/e2e/listers.e2e.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_UI_URL || 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH || '/opt/google/chrome/chrome';
const SHOTS = process.env.SHOT_DIR || '/tmp/claude-0/pw/listers-e2e';
const PW = 'Meridian@2026';
mkdirSync(SHOTS, { recursive: true });

const IGNORED = /fonts\.(googleapis|gstatic)\.com|ERR_TUNNEL_CONNECTION_FAILED/;

function watch(page, problems, label) {
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORED.test(m.text())) problems.push(`${label} console: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message.slice(0, 200)}`));
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) problems.push(`${label} ${r.status()} ${r.url()}`); });
}

async function login(page, email, password = PW) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', password);
  await page.click('form.stack-form button.btn-primary');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

const istInput = (days, hhmm) => {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + days * 86400000));
  return `${d}T${hhmm}`;
};

test('lister signs up, gets approved, publishes and confirms a request', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const problems = [];
  const stamp = Date.now();
  const email = `e2e.operator.${stamp}@example.in`;
  const company = `E2E Air ${stamp}`;
  try {
    // 1. Sign up from the login page link, on a phone.
    const lc = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const l = await lc.newPage(); watch(l, problems, 'lister');
    await l.goto(`${BASE}/login`);
    await l.click('a[href="/register"]');
    await l.waitForSelector('.reg-types');
    await l.check('input[name=lister_type][value=operator]');
    await l.fill('#r-name', 'Esha Operator');
    await l.fill('#r-company', company);
    await l.fill('#r-nsop', 'NSOP-42/2021');
    await l.fill('#r-email', email);
    await l.fill('#r-phone', '+91 90000 12345');
    await l.fill('#r-city', 'Delhi');
    await l.fill('#r-pan', 'AAACE1234E');
    await l.fill('#r-tan', 'DELE12345E');
    await l.fill('#r-pw', 'Sup3rSecret!x');
    await l.fill('#r-pw2', 'Sup3rSecret!x');
    await l.screenshot({ path: `${SHOTS}/1-register.png`, fullPage: true });
    await l.check('.el-terms input[type=checkbox]');
    await l.click('button:has-text("Create account")');
    await l.waitForURL((u) => u.pathname === '/l');
    await l.waitForSelector('text=We’re verifying your account');

    // 2. Draft a flight while pending (publishing is not offered yet).
    await l.click('button:has-text("Post an empty leg")');
    await l.selectOption('#n-from', 'DEL');
    await l.selectOption('#n-to', 'UDR');
    await l.fill('#n-e', istInput(4, '08:00'));
    await l.fill('#n-l', istInput(4, '10:00'));
    await l.fill('#n-ac', 'Citation XLS');
    await l.fill('#n-seats', '8');
    await l.fill('#n-reg', 'VT-EEE');
    await l.fill('#n-price', '110000');
    await l.fill('#n-list', '300000');
    await l.screenshot({ path: `${SHOTS}/2-new-listing.png`, fullPage: true });
    await l.click('.modal button.btn-primary:has-text("Save draft")');
    await l.waitForSelector('tr:has-text("DEL → UDR")');
    assert.ok(await l.locator('tr:has-text("DEL → UDR") button:has-text("Publish")').isDisabled(), 'publish disabled while pending');
    await l.screenshot({ path: `${SHOTS}/3-pending-listings.png`, fullPage: true });

    // 3. Sales approves the lister.
    const sc = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const s = await sc.newPage(); watch(s, problems, 'sales');
    await login(s, 'sales@meridian.test');
    await s.click('nav a:has-text("Listers")');
    const row = s.locator('tr', { hasText: company });
    await row.waitFor();
    await s.screenshot({ path: `${SHOTS}/4-sales-listers.png` });
    await row.locator('button:has-text("Review")').click();
    assert.ok((await s.textContent('.modal')).includes('AAACE1234E'), 'PAN shown to the reviewer');
    await s.click('.modal button:has-text("Approve")');
    await s.waitForSelector(`text=${company} approved`);

    // 4. Lister publishes.
    await l.reload();
    await l.locator('tr:has-text("DEL → UDR") button:has-text("Publish")').click();
    await l.waitForSelector('tr:has-text("DEL → UDR") .pill:has-text("Published")');

    // 5. Public visitor finds it (operator shown, registration hidden) and requests it.
    const pc = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await pc.newPage(); watch(p, problems, 'public');
    await p.goto(`${BASE}/empty-legs`);
    const card = p.locator('[data-testid=el-card]', { hasText: company });
    await card.waitFor();
    assert.ok(!(await p.textContent('body')).includes('VT-EEE'), 'registration must not be public');
    await card.click();
    await p.waitForSelector('form.el-form');
    assert.ok((await p.textContent('body')).includes(`operated by ${company}`), 'marketplace terms name the operator');
    await p.fill('#r-name', 'Riya Traveller');
    await p.fill('#r-email', `e2e.riya.${stamp}@example.in`);
    await p.fill('#r-phone', '+91 90000 54321');
    await p.check('.el-terms input[type=checkbox]');
    await p.click('button.el-submit');
    await p.waitForFunction(() => /ELB-\d{4}-\d{4}/.test(document.body.innerText));
    const bookingNo = (await p.textContent('body')).match(/ELB-\d{4}-\d{4}/)[0];
    await p.screenshot({ path: `${SHOTS}/5-public-requested.png`, fullPage: true });

    // 6. Lister confirms; contact details appear.
    await l.click('nav a:has-text("Requests")');
    const req = l.locator('tr', { hasText: bookingNo });
    await req.waitFor();
    assert.ok((await req.textContent()).includes('Contact details shared once you confirm'));
    await req.locator('button:has-text("Confirm")').click();
    await l.click('.modal button:has-text("Confirm booking")');
    await l.waitForSelector(`tr:has-text("${bookingNo}") >> text=e2e.riya.${stamp}@example.in`);
    await l.screenshot({ path: `${SHOTS}/6-lister-confirmed.png`, fullPage: true });

    assert.deepEqual(problems, []);
  } catch (err) {
    for (const ctx of browser.contexts()) for (const [i, pg] of ctx.pages().entries()) await pg.screenshot({ path: `${SHOTS}/fail-${i}.png`, fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
});
