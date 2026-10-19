/**
 * Email: SendGrid over HTTP (fetch) when SENDGRID_API_KEY is set; otherwise logs to console.
 * Every attempt is recorded in email_log (status sent|logged|failed). Never throws.
 */
const { pool } = require('../db');

const FROM = process.env.EMAIL_FROM || 'Meridian Charters <noreply@meridian.test>';
const APP_URL = () => (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(title, bodyHtml) {
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#0b1b33">
  <div style="background:#0b1b33;padding:20px;border-radius:8px;margin-bottom:20px;text-align:center">
    <h1 style="color:#c9a24a;margin:0;font-size:22px;letter-spacing:1px">Meridian Charters</h1>
  </div>
  <h2 style="font-size:18px">${esc(title)}</h2>
  ${bodyHtml}
  <p style="color:#64748b;font-size:12px;margin-top:32px">Meridian Charters — members-only private aviation.</p>
</body></html>`;
}

async function sendEmail({ to, subject, html, text, type = 'general' }) {
  let status = 'logged';
  let error = null;
  try {
    if (process.env.SENDGRID_API_KEY) {
      const fromEmail = FROM.match(/<(.+)>/)?.[1] || FROM;
      const fromName = FROM.match(/^(.*?)\s*</)?.[1] || 'Meridian Charters';
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SENDGRID_API_KEY}` },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: fromEmail, name: fromName },
          subject,
          content: [
            { type: 'text/plain', value: text || subject },
            { type: 'text/html', value: html || `<p>${esc(text || subject)}</p>` },
          ],
        }),
      });
      if (!res.ok) throw new Error(`SendGrid ${res.status}: ${(await res.text()).slice(0, 300)}`);
      status = 'sent';
      console.log(`[Email] sent ${type} to ${to}`);
    } else {
      console.log(`[Email] (no SENDGRID_API_KEY) ${type} → ${to}: ${subject}${text ? `\n  ${text}` : ''}`);
    }
  } catch (err) {
    status = 'failed';
    error = err.message;
    console.error(`[Email] failed ${type} to ${to}:`, err.message);
  }
  try {
    await pool.query('INSERT INTO email_log (to_email, subject, type, status, error) VALUES ($1,$2,$3,$4,$5)', [to, subject, type, status, error]);
  } catch (_) { /* non-critical */ }
  return { ok: status !== 'failed', status };
}

// ── Templates ────────────────────────────────────────────────────────────────
function sendInvite({ to, name, inviteUrl }) {
  return sendEmail({
    to, type: 'invite', subject: 'Your Meridian Charters account',
    text: `Hello ${name || ''}, set your password here: ${inviteUrl} (valid 72 hours)`,
    html: layout('Welcome aboard', `<p>Hello ${esc(name)},</p><p>An account has been created for you. Set your password to sign in (link valid 72 hours):</p>
      <p style="text-align:center;margin:28px 0"><a href="${esc(inviteUrl)}" style="background:#c9a24a;color:#0b1b33;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold">Set password</a></p>
      <p style="font-size:12px;color:#64748b">${esc(inviteUrl)}</p>`),
  });
}

function sendQuoteSent({ to, name, quote, request }) {
  const url = `${APP_URL()}/m/requests/${request.id}`;
  return sendEmail({
    to, type: 'quote_sent', subject: `Your charter quote ${quote.quote_no}`,
    text: `Hello ${name}, your quote ${quote.quote_no} is ready: ${url}`,
    html: layout(`Quote ${quote.quote_no}`, `<p>Hello ${esc(name)},</p><p>Your quote for request ${esc(request.request_no)} is ready. Total ${esc(formatINR(quote.total))} incl. GST, valid until ${esc(quote.valid_until_display)} IST.</p><p><a href="${esc(url)}">View and accept your quote</a></p>`),
  });
}

function sendCharterAccepted({ to, name, charter, invoice }) {
  return sendEmail({
    to, type: 'charter_accepted', subject: `Charter ${charter.charter_no} booked`,
    text: `Hello ${name}, charter ${charter.charter_no} is booked. Invoice ${invoice.invoice_no} for ${formatINR(invoice.total)} is due ${invoice.due_on}.`,
    html: layout(`Charter ${charter.charter_no} booked`, `<p>Hello ${esc(name)},</p><p>Thank you — your charter <b>${esc(charter.charter_no)}</b> (${esc(charter.starts_on)} to ${esc(charter.ends_on)}) is booked.</p><p>Invoice ${esc(invoice.invoice_no)} for ${esc(formatINR(invoice.total))} is due on ${esc(invoice.due_on)}.</p><p>Please add your passenger manifest in <a href="${esc(APP_URL())}/m/trips/${esc(charter.id)}">My trips</a>.</p>`),
  });
}

function sendCharterConfirmed({ to, name, charter }) {
  return sendEmail({
    to, type: 'charter_confirmed', subject: `Charter ${charter.charter_no} confirmed`,
    text: `Hello ${name}, ops has confirmed charter ${charter.charter_no}.`,
    html: layout(`Charter ${charter.charter_no} confirmed`, `<p>Hello ${esc(name)},</p><p>Your aircraft and crew are confirmed for charter <b>${esc(charter.charter_no)}</b> starting ${esc(charter.starts_on)}.</p><p>Please make sure your passenger manifest is complete: <a href="${esc(APP_URL())}/m/trips/${esc(charter.id)}">My trips</a>.</p>`),
  });
}

function sendCharterCancelled({ to, name, charter, reason }) {
  return sendEmail({
    to, type: 'charter_cancelled', subject: `Charter ${charter.charter_no} cancelled`,
    text: `Hello ${name}, charter ${charter.charter_no} has been cancelled. Reason: ${reason}`,
    html: layout(`Charter ${charter.charter_no} cancelled`, `<p>Hello ${esc(name)},</p><p>Charter <b>${esc(charter.charter_no)}</b> has been cancelled.</p><p>Reason: ${esc(reason)}</p>`),
  });
}

function formatINR(n) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(n) || 0);
}

module.exports = { sendEmail, sendInvite, sendQuoteSent, sendCharterAccepted, sendCharterConfirmed, sendCharterCancelled, formatINR, APP_URL };
