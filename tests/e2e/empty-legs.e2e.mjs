// Browser E2E for empty legs: a public visitor requests a deal, sales confirms it
// (new member + invite), and a member books another deal instantly.
// Usage: BASE_UI_URL=http://localhost:5173 node --test tests/e2e/empty-legs.e2e.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_UI_URL || 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH || '/opt/google/chrome/chrome';
const SHOTS = process.env.SHOT_DIR || '/tmp/claude-0/pw/el-e2e';
const PW = 'Meridian@2026';
mkdirSync(SHOTS, { recursive: true });

const IGNORED = /fonts\.(googleapis|gstatic)\.com|ERR_TUNNEL_CONNECTION_FAILED/;

function watch(page, problems, label) {
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORED.test(m.text())) problems.push(`${label} console: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message.slice(0, 200)}`));
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) problems.push(`${label} ${r.status()} ${r.url()}`); });
}

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', PW);
  await page.click('form.stack-form button.btn-primary');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

test('public request → sales confirm, and member instant booking', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const problems = [];
  try {
    // 1. Public visitor on a phone, not logged in.
    const pub = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await pub.newPage(); watch(p, problems, 'public');
    await p.goto(`${BASE}/empty-legs`);
    await p.waitForSelector('[data-testid=el-card]');
    const cards = await p.$$('[data-testid=el-card]');
    assert.ok(cards.length >= 2, `expected at least two published deals, got ${cards.length}`);
    const body = await p.textContent('body');
    assert.ok(!/VT-[A-Z]{3}/.test(body), 'public page must not show aircraft registrations');
    await p.screenshot({ path: `${SHOTS}/1-public-list.png`, fullPage: true });

    // open the LAST card (keeps the first ones free for the member test)
    await cards[cards.length - 1].click();
    await p.waitForSelector('form.el-form');
    const stamp = Date.now();
    const email = `e2e.guest.${stamp}@example.in`;
    await p.fill('#r-name', 'Test Guest');
    await p.fill('#r-email', email);
    await p.fill('#r-phone', '+91 90000 99999');
    await p.fill('#r-company', 'E2E Ventures');
    await p.check('.el-terms input[type=checkbox]');
    await p.click('button.el-submit');
    await p.waitForFunction(() => /ELB-\d{4}-\d{4}/.test(document.body.innerText));
    const bookingNo = (await p.textContent('body')).match(/ELB-\d{4}-\d{4}/)[0];
    await p.screenshot({ path: `${SHOTS}/2-public-requested.png`, fullPage: true });
    await pub.close();

    // 2. Sales confirms the request.
    const s = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const sp = await s.newPage(); watch(sp, problems, 'sales');
    await login(sp, 'sales@meridian.test');
    await sp.goto(`${BASE}/s/empty-legs`);
    await sp.click('button[role=tab]:has-text("Requests")');
    const row = sp.locator('tr', { hasText: bookingNo });
    await row.waitFor();
    await row.locator('button:has-text("Confirm")').click();
    await sp.click('button:has-text("Confirm booking")');
    await sp.waitForFunction(() => /\/invite\/[A-Za-z0-9_-]{16,}/.test(document.body.innerText) || [...document.querySelectorAll('input')].some((i) => /\/invite\//.test(i.value)));
    await sp.screenshot({ path: `${SHOTS}/3-sales-confirmed.png` });

    // the API agrees: booking confirmed with a charter
    const token = await sp.evaluate(() => localStorage.getItem('meridian_token'));
    const res = await sp.request.get(`${BASE}/api/empty-legs/bookings`, { headers: { Authorization: `Bearer ${token}` } });
    const bookings = await res.json();
    const mine = bookings.find((b) => b.booking_no === bookingNo);
    assert.equal(mine.status, 'confirmed');
    assert.ok(mine.charter_id, 'confirmed booking should have a charter');

    // dashboard shows the empty-legs card
    await sp.goto(`${BASE}/s`);
    await sp.waitForSelector('text=Empty legs');
    await sp.screenshot({ path: `${SHOTS}/4-dashboard.png`, fullPage: true });
    await s.close();

    // 3. Member books a deal instantly.
    const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mp = await m.newPage(); watch(mp, problems, 'member');
    await login(mp, 'arjun.mehra@example.in');
    await mp.goto(`${BASE}/m/empty-legs`);
    await mp.waitForSelector('button:has-text("Book now")');
    await mp.locator('button:has-text("Book now"):not([disabled])').first().click();
    await mp.check('.el-terms input[type=checkbox]');
    await mp.click('button:has-text("+ GST")');
    await mp.waitForURL(/\/m\/trips\/[0-9a-f-]{36}/);
    await mp.waitForSelector('text=Empty-leg deal');
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `trip page scrolls sideways on a phone by ${overflow}px`);
    await mp.screenshot({ path: `${SHOTS}/5-member-trip.png`, fullPage: true });
    await m.close();

    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});
