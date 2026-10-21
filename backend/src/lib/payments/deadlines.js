/**
 * Payment deadline enforcement (SPEC v1.2). Runs every 5 minutes from index.js and (throttled) on charter/invoice reads.
 *  - Charters in accepted|confirmed|manifest_complete whose invoice is not fully paid and due_at has passed
 *    → cancelled "Not paid by the deadline" (aircraft released, empty-leg cascade, part payments refunded in full, email).
 *  - Reminder emails at due_at − 48h and due_at − 6h, once each (tracked as invoice events).
 * Safe under concurrency: one scheduled runner at a time (advisory lock); each cancellation re-checks the invoice
 * under row locks; reminders lock the invoice row with FOR UPDATE SKIP LOCKED and record the event before emailing.
 */
const { pool, withTransaction } = require('../../db');
const { logEvent } = require('../events');
const { cancelCharter } = require('../cancellation');
const { sendPaymentReminder } = require('../email');

const LOCK_KEY = 72019001; // arbitrary, app-wide
const DEADLINE_REASON = 'Not paid by the deadline';
const ACTIVE = ['accepted', 'confirmed', 'manifest_complete'];

async function cancelOverdue(now, charterId) {
  const params = [now, ACTIVE];
  if (charterId) params.push(charterId);
  const { rows } = await pool.query(
    `SELECT c.id FROM charters c JOIN invoices i ON i.charter_id = c.id
      WHERE c.status = ANY($2) AND i.status IN ('unpaid','partially_paid') AND i.due_at IS NOT NULL AND i.due_at < $1
        ${charterId ? 'AND c.id = $3' : ''}
      ORDER BY i.due_at LIMIT 100`, params);
  const cancelled = [];
  for (const r of rows) {
    try {
      const out = await cancelCharter({ charterId: r.id, reason: DEADLINE_REASON, actorUserId: null, byMember: false, requestedPct: 100, onlyIfOverdueAt: now });
      if (!out.skipped) cancelled.push({ id: r.id, charter_no: out.charter.charter_no, refund: out.refund });
    } catch (err) {
      if (err.status !== 409 && err.status !== 404) console.error('[Deadlines] cancel failed', r.id, err.message);
    }
  }
  return cancelled;
}

async function sendReminders(now, charterId) {
  const params = [now, ACTIVE];
  if (charterId) params.push(charterId);
  const { rows } = await pool.query(
    `SELECT i.id FROM invoices i JOIN charters c ON c.id = i.charter_id
      WHERE c.status = ANY($2) AND i.status IN ('unpaid','partially_paid') AND i.due_at > $1 AND i.due_at - interval '48 hours' <= $1
        ${charterId ? 'AND c.id = $3' : ''}`, params);
  const sent = [];
  for (const r of rows) {
    const due = await withTransaction(async (client) => {
      const inv = (await client.query(
        `SELECT i.*, c.charter_no, c.id AS charter_id, m.email, m.contact_name
           FROM invoices i JOIN charters c ON c.id = i.charter_id JOIN members m ON m.id = i.member_id
          WHERE i.id = $1 AND i.status IN ('unpaid','partially_paid') FOR UPDATE OF i SKIP LOCKED`, [r.id])).rows[0];
      if (!inv) return null;
      const kind = new Date(inv.due_at).getTime() - 6 * 3600 * 1000 <= new Date(now).getTime() ? '6h' : '48h';
      const done = await client.query(
        `SELECT 1 FROM events WHERE entity_type = 'invoice' AND entity_id = $1 AND action = 'payment_reminder' AND detail->>'kind' = $2`, [inv.id, kind]);
      if (done.rows.length) return null;
      await logEvent({ entity_type: 'invoice', entity_id: inv.id, action: 'payment_reminder', detail: { kind, due_at: inv.due_at } }, client);
      return { inv, kind };
    });
    if (due) {
      await sendPaymentReminder({ to: due.inv.email, name: due.inv.contact_name, invoice: due.inv, kind: due.kind });
      sent.push({ invoice_id: due.inv.id, kind: due.kind });
    }
  }
  return sent;
}

/**
 * One pass. Options (tests/dev only): now — evaluate as of this instant; charterId — limit to one charter.
 * Without a charterId only one runner across all instances proceeds (pg_try_advisory_lock).
 */
async function runDeadlines({ now = null, charterId = null } = {}) {
  const at = now ? new Date(now) : new Date();
  if (charterId) {
    return { cancelled: await cancelOverdue(at, charterId), reminders: await sendReminders(at, charterId) };
  }
  const client = await pool.connect();
  try {
    const got = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY])).rows[0].ok;
    if (!got) return { skipped: true, cancelled: [], reminders: [] };
    try {
      return { cancelled: await cancelOverdue(at, null), reminders: await sendReminders(at, null) };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

// Throttled run for read paths ("plus on charter/invoice reads"): at most once a minute per process; never throws.
let lastRun = 0;
let running = null;
async function runDeadlinesThrottled() {
  if (running) return running;
  if (Date.now() - lastRun < 60 * 1000) return null;
  lastRun = Date.now();
  running = runDeadlines().catch((err) => { console.error('[Deadlines] run failed:', err.message); return null; })
    .finally(() => { running = null; });
  return running;
}

/** Start the 5-minute scheduler. → interval handle. */
function startDeadlineJob(intervalMs = 5 * 60 * 1000) {
  const tick = () => runDeadlines()
    .then((r) => { if (r.cancelled?.length || r.reminders?.length) console.log(`[Deadlines] cancelled ${r.cancelled.length}, reminders ${r.reminders.length}`); })
    .catch((err) => console.error('[Deadlines] run failed:', err.message))
    // v1.6: marketplace checkouts, confirmation deadlines and payouts on the same schedule.
    .then(() => require('../marketplace').runMarketplaceJobs())
    .then((m) => { if (m && (m.expired || m.timed_out.length || m.completed)) console.log(`[Marketplace] expired ${m.expired}, timed out ${m.timed_out.length}, completed ${m.completed}`); });
  setTimeout(tick, 5000).unref();
  const h = setInterval(tick, intervalMs);
  h.unref();
  return h;
}

module.exports = { runDeadlines, runDeadlinesThrottled, startDeadlineJob, DEADLINE_REASON };
