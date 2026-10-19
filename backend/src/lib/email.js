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

// ── Empty legs (v1.1) ────────────────────────────────────────────────────────
const legRoute = (leg) => `${leg.from_city || leg.from_code} (${leg.from_code}) → ${leg.to_city || leg.to_code} (${leg.to_code})`;
const legWindow = (leg) => `${fmtWindow(leg.depart_earliest)} – ${fmtWindow(leg.depart_latest).slice(-5)} IST`;
function fmtWindow(d) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(d));
}

function sendEmptyLegRequestAck({ to, name, booking, leg }) {
  return sendEmail({
    to, type: 'empty_leg_request', subject: `We received your empty-leg request ${booking.booking_no}`,
    text: `Hello ${name}, thank you for your request ${booking.booking_no} for ${legRoute(leg)} departing ${legWindow(leg)}. Our team will confirm availability shortly. The booking is confirmed only when Meridian Charters confirms it.`,
    html: layout('Request received', `<p>Hello ${esc(name)},</p><p>Thank you — we have received your request <b>${esc(booking.booking_no)}</b> for the empty leg <b>${esc(legRoute(leg))}</b>, departing ${esc(legWindow(leg))}, for ${esc(booking.pax)} passenger(s).</p>
      <p>Our charter team will review it and get back to you shortly. Empty legs depend on the operator's main charter and may be retimed or withdrawn; the booking is confirmed only when Meridian Charters confirms it.</p>`),
  });
}

function sendEmptyLegSalesNotice({ to, booking, leg }) {
  const url = `${APP_URL()}/s/empty-legs`;
  return sendEmail({
    to, type: 'empty_leg_request_sales', subject: `New empty-leg request ${booking.booking_no} — ${leg.leg_no}`,
    text: `${booking.guest_name} <${booking.guest_email}>, ${booking.guest_phone} requested ${leg.leg_no} ${legRoute(leg)} for ${booking.pax} pax. Review: ${url}`,
    html: layout(`New request ${booking.booking_no}`, `<p><b>${esc(booking.guest_name)}</b>${booking.guest_company ? ` (${esc(booking.guest_company)})` : ''} — ${esc(booking.guest_email)}, ${esc(booking.guest_phone)}</p>
      <p>Empty leg ${esc(leg.leg_no)}: ${esc(legRoute(leg))}, ${esc(legWindow(leg))}, ${esc(booking.pax)} pax.</p>${booking.message ? `<p>Message: ${esc(booking.message)}</p>` : ''}
      <p><a href="${esc(url)}">Review requests</a></p>`),
  });
}

function sendEmptyLegBooked({ to, name, booking, leg, charter, invoice, inviteUrl = null }) {
  const tripUrl = `${APP_URL()}/m/trips/${charter.id}`;
  return sendEmail({
    to, type: 'empty_leg_booked', subject: `Empty leg confirmed — charter ${charter.charter_no}`,
    text: `Hello ${name}, your empty-leg booking ${booking.booking_no} (${legRoute(leg)}, ${legWindow(leg)}) is confirmed as charter ${charter.charter_no}. Invoice ${invoice.invoice_no} for ${formatINR(invoice.total)} is due ${invoice.due_on}.${inviteUrl ? ` Set your password to manage the trip: ${inviteUrl} (valid 72 hours)` : ` Add your passengers: ${tripUrl}`}`,
    html: layout(`Charter ${charter.charter_no} confirmed`, `<p>Hello ${esc(name)},</p><p>Your empty-leg booking <b>${esc(booking.booking_no)}</b> — ${esc(legRoute(leg))}, departing ${esc(legWindow(leg))} — is confirmed as charter <b>${esc(charter.charter_no)}</b>.</p>
      <p>Invoice ${esc(invoice.invoice_no)} for ${esc(formatINR(invoice.total))} (incl. GST) is due on ${esc(invoice.due_on)}.</p>
      ${inviteUrl ? `<p>We have created a Meridian Charters account for you. Set your password (link valid 72 hours) to add your passenger manifest:</p>
      <p style="text-align:center;margin:28px 0"><a href="${esc(inviteUrl)}" style="background:#c9a24a;color:#0b1b33;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold">Set password</a></p>
      <p style="font-size:12px;color:#64748b">${esc(inviteUrl)}</p>` : `<p>Please add your passenger manifest in <a href="${esc(tripUrl)}">My trips</a>.</p>`}
      <p style="font-size:12px;color:#64748b">Empty legs depend on the operator's main charter and may be retimed; our ops team will confirm the exact departure time.</p>`),
  });
}

function sendEmptyLegRequestClosed({ to, name, booking, leg, reason }) {
  return sendEmail({
    to, type: 'empty_leg_request_closed', subject: `Your empty-leg request ${booking.booking_no}`,
    text: `Hello ${name}, unfortunately we cannot confirm your request ${booking.booking_no} for ${legRoute(leg)}. Reason: ${reason}`,
    html: layout('About your request', `<p>Hello ${esc(name)},</p><p>Unfortunately we cannot confirm your request <b>${esc(booking.booking_no)}</b> for ${esc(legRoute(leg))} (${esc(legWindow(leg))}).</p><p>Reason: ${esc(reason)}</p>
      <p>See other available flights at <a href="${esc(APP_URL())}/empty-legs">our empty-leg deals</a>.</p>`),
  });
}

function sendSourceCancelledWarning({ to, sourceCharterNo, derived }) {
  return sendEmail({
    to, type: 'empty_leg_source_cancelled', subject: `Source charter ${sourceCharterNo} cancelled — check ${derived.charter_no}`,
    text: `Source charter ${sourceCharterNo} was cancelled. Charter ${derived.charter_no} (empty leg ${derived.leg_no}) was sold on its positioning flight — confirm this flight is still operating.`,
    html: layout('Empty-leg charter needs attention', `<p>Source charter <b>${esc(sourceCharterNo)}</b> was cancelled.</p><p>Charter <b>${esc(derived.charter_no)}</b> was sold on its positioning flight (empty leg ${esc(derived.leg_no)}). Confirm this flight is still operating.</p>`),
  });
}

function formatINR(n) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(n) || 0);
}

module.exports = { sendEmail, sendInvite, sendEmptyLegRequestAck, sendEmptyLegSalesNotice, sendEmptyLegBooked, sendEmptyLegRequestClosed, sendSourceCancelledWarning, sendQuoteSent, sendCharterAccepted, sendCharterConfirmed, sendCharterCancelled, formatINR, APP_URL };
