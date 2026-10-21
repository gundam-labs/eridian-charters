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
  const payBy = invoice.due_at ? `${fmtWindow(invoice.due_at)} IST` : invoice.due_on;
  const tripUrl = `${APP_URL()}/m/trips/${charter.id}`;
  return sendEmail({
    to, type: 'charter_accepted', subject: `Charter ${charter.charter_no} booked`,
    text: `Hello ${name}, charter ${charter.charter_no} is booked. Invoice ${invoice.invoice_no} for ${formatINR(invoice.total)} must be paid in full by ${payBy}, otherwise the booking is cancelled automatically. Pay: ${tripUrl}`,
    html: layout(`Charter ${charter.charter_no} booked`, `<p>Hello ${esc(name)},</p><p>Thank you — your charter <b>${esc(charter.charter_no)}</b> (${esc(charter.starts_on)} to ${esc(charter.ends_on)}) is booked.</p><p>Invoice ${esc(invoice.invoice_no)} for ${esc(formatINR(invoice.total))} must be paid in full <b>by ${esc(payBy)}</b> (24 hours before departure); unpaid bookings are released automatically. You can pay by bank transfer, card, UPI or netbanking from <a href="${esc(tripUrl)}">My trips</a>.</p><p>Please also add your passenger manifest there.</p>`),
  });
}

function sendCharterConfirmed({ to, name, charter }) {
  return sendEmail({
    to, type: 'charter_confirmed', subject: `Charter ${charter.charter_no} confirmed`,
    text: `Hello ${name}, ops has confirmed charter ${charter.charter_no}.`,
    html: layout(`Charter ${charter.charter_no} confirmed`, `<p>Hello ${esc(name)},</p><p>Your aircraft and crew are confirmed for charter <b>${esc(charter.charter_no)}</b> starting ${esc(charter.starts_on)}.</p><p>Please make sure your passenger manifest is complete: <a href="${esc(APP_URL())}/m/trips/${esc(charter.id)}">My trips</a>.</p>`),
  });
}

function sendCharterCancelled({ to, name, charter, reason, refund = null }) {
  const refundLine = refund && refund.amount > 0
    ? `A refund of ${formatINR(refund.amount)} (${refund.pct}% of the amount paid) has been initiated to your original payment method; it usually arrives within 5–7 working days.`
    : '';
  return sendEmail({
    to, type: 'charter_cancelled', subject: `Charter ${charter.charter_no} cancelled`,
    text: `Hello ${name}, charter ${charter.charter_no} has been cancelled. Reason: ${reason}. ${refundLine}`.trim(),
    html: layout(`Charter ${charter.charter_no} cancelled`, `<p>Hello ${esc(name)},</p><p>Charter <b>${esc(charter.charter_no)}</b> has been cancelled.</p><p>Reason: ${esc(reason)}</p>${refundLine ? `<p>${esc(refundLine)}</p>` : ''}`),
  });
}

// ── Payments (v1.2) ──────────────────────────────────────────────────────────
const METHOD_LABEL = { card: 'Card', upi: 'UPI', netbanking: 'Netbanking', wallet: 'Wallet', bank_transfer: 'Bank transfer', emi: 'EMI', other: 'Other' };

function sendPaymentReceipt({ to, name, receipt: r }) {
  const balance = Math.max(0, Number(r.total) - Number(r.amount_paid));
  const statusLine = r.status === 'paid' ? `Invoice ${r.invoice_no} is now paid in full.` : `Remaining balance: ${formatINR(balance)}${r.due_at ? `, due by ${fmtWindow(r.due_at)} IST` : ''}.`;
  return sendEmail({
    to, type: 'payment_receipt', subject: `Payment received — ${r.invoice_no}`,
    text: `Hello ${name}, we received ${formatINR(r.amount)} (${METHOD_LABEL[r.method] || r.method}, ref ${r.provider_payment_id}) for invoice ${r.invoice_no} / charter ${r.charter_no}. ${statusLine}`,
    html: layout('Payment received', `<p>Hello ${esc(name)},</p><p>Thank you — we received <b>${esc(formatINR(r.amount))}</b> by ${esc(METHOD_LABEL[r.method] || r.method)} (reference ${esc(r.provider_payment_id)}) for invoice <b>${esc(r.invoice_no)}</b>, charter ${esc(r.charter_no)}.</p><p>${esc(statusLine)}</p>`),
  });
}

function sendPaymentReminder({ to, name, invoice, kind }) {
  const balance = Math.max(0, Number(invoice.total) - Number(invoice.amount_paid || 0));
  const url = `${APP_URL()}/m/trips/${invoice.charter_id}`;
  const by = `${fmtWindow(invoice.due_at)} IST`;
  return sendEmail({
    to, type: `payment_reminder_${kind}`, subject: `${kind === '6h' ? 'Final reminder' : 'Reminder'}: pay ${invoice.invoice_no} by ${by}`,
    text: `Hello ${name}, ${formatINR(balance)} is due on invoice ${invoice.invoice_no} (charter ${invoice.charter_no}) by ${by}. Unpaid charters are cancelled automatically at the deadline. Pay: ${url}`,
    html: layout('Payment reminder', `<p>Hello ${esc(name)},</p><p><b>${esc(formatINR(balance))}</b> is due on invoice ${esc(invoice.invoice_no)} for charter ${esc(invoice.charter_no)} <b>by ${esc(by)}</b>.</p><p>Charters not paid in full by the deadline are cancelled automatically and the aircraft is released.</p><p><a href="${esc(url)}">Pay now</a></p>`),
  });
}

// ── Empty legs (v1.1) ────────────────────────────────────────────────────────
const legRoute = (leg) => `${leg.from_city || leg.from_code} (${leg.from_code}) → ${leg.to_city || leg.to_code} (${leg.to_code})`;
const legWindow = (leg) => `${fmtWindow(leg.depart_earliest)} – ${fmtWindow(leg.depart_latest).slice(-5)} IST`;
function fmtWindow(d) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(d));
}

const PAY_NOTE = 'Once confirmed, payment in full is due 24 hours before departure — for late bookings, within 2 hours of confirmation.';

function sendEmptyLegRequestAck({ to, name, booking, leg, hold = null }) {
  // Marketplace legs (posted by an outside lister) are confirmed by that operator, not by Meridian.
  const who = leg.lister_id ? (leg.operator_name || leg.lister_company || 'the operator') : 'Meridian Charters';
  const payNote = leg.lister_id
    ? (hold
      ? `We are holding ${formatINR(hold.amount)} (incl. GST) on your payment method. You are charged only if ${who} confirms${booking.respond_by ? ` by ${fmtWindow(booking.respond_by)} IST` : ''}; otherwise the hold is released automatically.`
      : `${who} will confirm the price, payment terms and exact departure time with you directly.`)
    : PAY_NOTE;
  const track = booking.access_token ? `${APP_URL()}/b/${booking.access_token}` : null;
  return sendEmail({
    to, type: 'empty_leg_request', subject: `We received your empty-leg request ${booking.booking_no}`,
    text: `Hello ${name}, thank you for your request ${booking.booking_no} for ${legRoute(leg)} departing ${legWindow(leg)}. The booking is confirmed only when ${who} confirms it. ${payNote}`,
    html: layout('Request received', `<p>Hello ${esc(name)},</p><p>Thank you — we have received your request <b>${esc(booking.booking_no)}</b> for the empty leg <b>${esc(legRoute(leg))}</b>, departing ${esc(legWindow(leg))}, for ${esc(booking.pax)} passenger(s).</p>
      <p>Empty legs depend on the operator's main charter and may be retimed or withdrawn; the booking is confirmed only when ${esc(who)} confirms it.</p>
      <p>${esc(payNote)}</p>${track ? `<p><a href="${esc(track)}">Follow your request</a></p>` : ''}`),
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
  const payBy = invoice.due_at ? `${fmtWindow(invoice.due_at)} IST` : invoice.due_on;
  const late = invoice.due_at && new Date(invoice.due_at).getTime() - Date.now() <= 2.5 * 3600 * 1000;
  const payLine = `Payment in full is due by ${payBy}${late ? ' — this is a late booking, so please pay within 2 hours' : ''}; unpaid bookings are released automatically.`;
  return sendEmail({
    to, type: 'empty_leg_booked', subject: `Empty leg confirmed — charter ${charter.charter_no}`,
    text: `Hello ${name}, your empty-leg booking ${booking.booking_no} (${legRoute(leg)}, ${legWindow(leg)}) is confirmed as charter ${charter.charter_no}. Invoice ${invoice.invoice_no} for ${formatINR(invoice.total)}. ${payLine}${inviteUrl ? ` Set your password to manage the trip: ${inviteUrl} (valid 72 hours)` : ` Add your passengers: ${tripUrl}`}`,
    html: layout(`Charter ${charter.charter_no} confirmed`, `<p>Hello ${esc(name)},</p><p>Your empty-leg booking <b>${esc(booking.booking_no)}</b> — ${esc(legRoute(leg))}, departing ${esc(legWindow(leg))} — is confirmed as charter <b>${esc(charter.charter_no)}</b>.</p>
      <p>Invoice ${esc(invoice.invoice_no)} for ${esc(formatINR(invoice.total))} (incl. GST). ${esc(payLine)}</p>
      ${inviteUrl ? `<p>We have created a Meridian Charters account for you. Set your password (link valid 72 hours) to add your passenger manifest:</p>
      <p style="text-align:center;margin:28px 0"><a href="${esc(inviteUrl)}" style="background:#c9a24a;color:#0b1b33;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold">Set password</a></p>
      <p style="font-size:12px;color:#64748b">${esc(inviteUrl)}</p>` : `<p>Please add your passenger manifest in <a href="${esc(tripUrl)}">My trips</a>.</p>`}
      <p style="font-size:12px;color:#64748b">Empty legs depend on the operator's main charter and may be retimed; our ops team will confirm the exact departure time.</p>`),
  });
}

async function sendEmptyLegRequestClosed({ to, name, booking, leg, reason }) {
  // v1.6: a held payment on this request has been released — say so.
  let holdLine = '';
  try {
    const bp = (await pool.query(`SELECT amount, status, provider FROM booking_payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1`, [booking.id])).rows[0];
    if (bp && bp.status === 'released') {
      holdLine = `You have not been charged: the hold of ${formatINR(bp.amount)} on your payment method has been released${bp.provider === 'razorpay' ? ' and your bank returns it automatically' : ''}.`;
    }
  } catch (_) { /* best effort */ }
  return sendEmail({
    to, type: 'empty_leg_request_closed', subject: `Your empty-leg request ${booking.booking_no}`,
    text: `Hello ${name}, unfortunately we cannot confirm your request ${booking.booking_no} for ${legRoute(leg)}. Reason: ${reason}${holdLine ? ` ${holdLine}` : ''}`,
    html: layout('About your request', `<p>Hello ${esc(name)},</p><p>Unfortunately we cannot confirm your request <b>${esc(booking.booking_no)}</b> for ${esc(legRoute(leg))} (${esc(legWindow(leg))}).</p><p>Reason: ${esc(reason)}</p>${holdLine ? `<p>${esc(holdLine)}</p>` : ''}
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

// ── Listers (operators, agents, private flyers who post their own empty legs) ──
const LISTER_TYPE_LABELS = { operator: 'Charter operator', agent: 'Travel agent', flyer: 'Private flyer' };

function sendListerWelcome({ to, name }) {
  return sendEmail({
    to, type: 'lister_welcome', subject: 'Your empty-leg lister account is under review',
    text: `Hello ${name}, thank you for registering to list empty legs. Our team will verify your details, usually within one working day. You can already sign in and prepare draft listings; they go live once your account is approved. ${APP_URL()}/l`,
    html: layout('Thanks for registering', `<p>Hello ${esc(name)},</p><p>Thank you for registering to list empty legs. Our team will verify your details, usually within one working day.</p>
      <p>You can already sign in and prepare draft listings; they go live as soon as your account is approved.</p>
      <p><a href="${esc(APP_URL())}/l">Open your lister account</a></p>`),
  });
}

function sendListerAdminNotice({ to, lister }) {
  const url = `${APP_URL()}/s/listers`;
  return sendEmail({
    to, type: 'lister_signup', subject: `New lister to verify — ${lister.company || lister.name}`,
    text: `${lister.name} <${lister.email}>, ${lister.phone} registered as ${LISTER_TYPE_LABELS[lister.lister_type] || lister.lister_type}${lister.company ? ` (${lister.company})` : ''}. Review: ${url}`,
    html: layout('New lister registration', `<p><b>${esc(lister.name)}</b>${lister.company ? ` (${esc(lister.company)})` : ''} — ${esc(lister.email)}, ${esc(lister.phone)}</p>
      <p>Type: ${esc(LISTER_TYPE_LABELS[lister.lister_type] || lister.lister_type)}${lister.nsop_permit_no ? ` · NSOP permit ${esc(lister.nsop_permit_no)}` : ''}</p>
      <p><a href="${esc(url)}">Review listers</a></p>`),
  });
}

function sendListerDecision({ to, name, status, reason }) {
  const titles = { approved: 'Your lister account is approved', rejected: 'About your lister registration', suspended: 'Your lister account is suspended' };
  const body = {
    approved: 'Your account is approved. You can now publish empty legs; they appear on the public deals page straight away.',
    rejected: `We could not approve your registration${reason ? `: ${reason}` : '.'} You can update your details from your account and we will review them again.`,
    suspended: `Your account has been suspended${reason ? `: ${reason}` : '.'} Your listings have been taken down. Reply to this email if you think this is a mistake.`,
  }[status];
  return sendEmail({
    to, type: `lister_${status}`, subject: titles[status],
    text: `Hello ${name}, ${body} ${APP_URL()}/l`,
    html: layout(titles[status], `<p>Hello ${esc(name)},</p><p>${esc(body)}</p><p><a href="${esc(APP_URL())}/l">Open your lister account</a></p>`),
  });
}

function sendListerRequestNotice({ to, booking, leg, hold = null }) {
  const url = `${APP_URL()}/l/requests`;
  const deadline = booking.respond_by ? ` Please confirm or decline by ${fmtWindow(booking.respond_by)} IST, or the request lapses.` : '';
  const paid = hold ? ` Payment of ${formatINR(hold.amount)} is held and is charged when you confirm.` : '';
  return sendEmail({
    to, type: 'lister_request', subject: `New booking request ${booking.booking_no} — ${leg.leg_no}`,
    text: `${booking.guest_name} requested your empty leg ${leg.leg_no} ${legRoute(leg)} for ${booking.pax} pax.${paid}${deadline} Confirm or decline: ${url}`,
    html: layout(`New request on ${leg.leg_no}`, `<p><b>${esc(booking.guest_name)}</b>${booking.guest_company ? ` (${esc(booking.guest_company)})` : ''} requested your empty leg <b>${esc(legRoute(leg))}</b>, ${esc(legWindow(leg))}, for ${esc(booking.pax)} passenger(s).</p>
      ${booking.message ? `<p>Message: ${esc(booking.message)}</p>` : ''}
      ${paid ? `<p>${esc(paid.trim())}</p>` : ''}${deadline ? `<p><b>${esc(deadline.trim())}</b></p>` : ''}
      <p>Their contact details are shared with you when you confirm.</p><p><a href="${esc(url)}">Confirm or decline</a></p>`),
  });
}

function sendListerBookingConfirmed({ to, name, booking, leg, lister, payment = null }) {
  const who = leg.operator_name || lister.company || lister.name;
  const contact = [lister.name, lister.phone, lister.email].filter(Boolean).join(' · ');
  const paid = payment
    ? `Your payment of ${formatINR(payment.amount)} (incl. GST) has now been charged. They will contact you about passenger details and the exact departure time.`
    : 'They will contact you to arrange payment, passenger details and the exact departure time.';
  return sendEmail({
    to, type: 'empty_leg_booked_lister', subject: `Empty leg confirmed — ${booking.booking_no}`,
    text: `Hello ${name}, ${who} has confirmed your empty-leg booking ${booking.booking_no} (${legRoute(leg)}, ${legWindow(leg)}). ${paid} Contact: ${contact}`,
    html: layout('Your empty leg is confirmed', `<p>Hello ${esc(name)},</p><p><b>${esc(who)}</b> has confirmed your booking <b>${esc(booking.booking_no)}</b> — ${esc(legRoute(leg))}, departing ${esc(legWindow(leg))}, for ${esc(booking.pax)} passenger(s).</p>
      <p>${esc(paid)}</p>
      <p>Operator contact: ${esc(contact)}</p>
      <p style="font-size:12px;color:#64748b">This flight is operated by ${esc(who)}, not by Meridian Charters.${payment ? ' Meridian Charters collects the payment on the operator’s behalf.' : ' Payment and the flight itself are arranged directly with them.'}</p>`),
  });
}

function sendMarketplaceCancelled({ to, name, booking, leg, reason, refund }) {
  const money = refund && refund.amount > 0
    ? `We have refunded ${formatINR(refund.amount)} (${refund.pct}%) to your original payment method; it usually reaches you in 5–7 working days.`
    : 'No refund applies under the cancellation terms.';
  return sendEmail({
    to, type: 'empty_leg_cancelled', subject: `Your empty-leg flight ${booking.booking_no} is cancelled`,
    text: `Hello ${name}, your flight ${booking.booking_no} (${legRoute(leg)}, ${legWindow(leg)}) has been cancelled. Reason: ${reason}. ${money}`,
    html: layout('Flight cancelled', `<p>Hello ${esc(name)},</p><p>Your flight <b>${esc(booking.booking_no)}</b> — ${esc(legRoute(leg))}, ${esc(legWindow(leg))} — has been cancelled.</p>
      <p>Reason: ${esc(reason)}</p><p>${esc(money)}</p>
      <p>See other available flights at <a href="${esc(APP_URL())}/empty-legs">our empty-leg deals</a>.</p>`),
  });
}

function sendRouteAlert({ to, name, legs, unsubscribeUrl }) {
  const lines = legs.map((l) => `${legRoute(l)} — ${legWindow(l)} — ${formatINR(l.price_inr)} + GST: ${APP_URL()}/empty-legs/${l.id}`);
  return sendEmail({
    to, type: 'route_alert', subject: legs.length === 1 ? `New empty leg: ${legRoute(legs[0])}` : `${legs.length} new empty legs on your routes`,
    text: `Hello ${name || ''}, new flights match your route alert:\n${lines.join('\n')}\nStop these alerts: ${unsubscribeUrl}`,
    html: layout('New flights on your route', `<p>Hello ${esc(name || '')},</p><p>New empty-leg flights match your alert:</p>
      <ul>${legs.map((l) => `<li><a href="${esc(APP_URL())}/empty-legs/${esc(l.id)}"><b>${esc(legRoute(l))}</b></a> — ${esc(legWindow(l))} — ${esc(formatINR(l.price_inr))} + GST</li>`).join('')}</ul>
      <p>Empty legs go quickly — request soon.</p>
      <p style="font-size:12px;color:#64748b"><a href="${esc(unsubscribeUrl)}">Stop these alerts</a></p>`),
  });
}

function sendListerLegWithdrawn({ to, name, leg, reason }) {
  return sendEmail({
    to, type: 'lister_leg_withdrawn', subject: `Your listing ${leg.leg_no} was taken down`,
    text: `Hello ${name}, our team withdrew your empty leg ${leg.leg_no} (${legRoute(leg)}). Reason: ${reason}`,
    html: layout('Listing withdrawn', `<p>Hello ${esc(name)},</p><p>Our team withdrew your empty leg <b>${esc(leg.leg_no)}</b> (${esc(legRoute(leg))}).</p><p>Reason: ${esc(reason)}</p>`),
  });
}

module.exports = { sendMarketplaceCancelled, sendRouteAlert, sendListerWelcome, sendListerAdminNotice, sendListerDecision, sendListerRequestNotice, sendListerBookingConfirmed, sendListerLegWithdrawn, LISTER_TYPE_LABELS, sendEmail, sendInvite, sendPaymentReceipt, sendPaymentReminder, sendEmptyLegRequestAck, sendEmptyLegSalesNotice, sendEmptyLegBooked, sendEmptyLegRequestClosed, sendSourceCancelledWarning, sendQuoteSent, sendCharterAccepted, sendCharterConfirmed, sendCharterCancelled, formatINR, APP_URL };
