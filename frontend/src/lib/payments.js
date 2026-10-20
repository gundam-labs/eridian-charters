import api from '../api';
import { fmtDateTime, fmtDate } from './format';

/** UPI per-payment limit for travel merchants (₹5 lakh); above this we recommend bank transfer. */
export const UPI_LIMIT_INR = 500000;

export const PAY_STATUS_LABEL = {
  unpaid: 'Unpaid',
  partially_paid: 'Part paid',
  paid: 'Paid',
  refunded: 'Refunded',
  cancelled: 'Cancelled',
};

export const METHOD_LABEL = {
  card: 'Card', upi: 'UPI', netbanking: 'Netbanking', wallet: 'Wallet', bank_transfer: 'Bank transfer', emi: 'EMI', other: 'Other',
};
export const methodLabel = (m) => METHOD_LABEL[m] || (m ? String(m).replace(/_/g, ' ') : '—');

const n = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));

/** Normalise an invoice's money fields (NUMERIC columns may arrive as strings). */
export function invoiceMoney(inv) {
  if (!inv) return { total: 0, paid: 0, balance: 0 };
  const total = n(inv.total) ?? 0;
  const paid = n(inv.amount_paid) ?? (inv.status === 'paid' ? total : 0);
  let balance = n(inv.balance);
  if (balance === null) balance = ['paid', 'cancelled', 'refunded'].includes(inv.status) ? 0 : Math.max(0, total - paid);
  return { total, paid, balance };
}

export const isPayable = (inv) => !!inv && ['unpaid', 'partially_paid'].includes(inv.status) && invoiceMoney(inv).balance > 0;

/** Payment status of a charter, derived from its invoice (or a server-provided payment_status). */
export function charterPaymentStatus(c) {
  return c?.payment_status || c?.invoice?.status || c?.invoice_status || null;
}

/** "Fri 6 Nov, 09:30 IST" / time-left text for an invoice deadline. */
export function dueInfo(inv, now = Date.now()) {
  if (!inv) return null;
  const at = inv.due_at ? new Date(inv.due_at) : inv.due_on ? new Date(`${inv.due_on}T23:59:00+05:30`) : null;
  if (!at || isNaN(at)) return null;
  const label = inv.due_at ? `${fmtDateTime(inv.due_at)} IST` : fmtDate(inv.due_on, { year: false });
  const ms = at.getTime() - now;
  let left, urgency;
  if (ms <= 0) { left = 'deadline passed'; urgency = 'over'; }
  else {
    const mins = Math.floor(ms / 60000);
    const hrs = Math.floor(mins / 60);
    const days = Math.floor(hrs / 24);
    if (days >= 2) left = `${days} days left`;
    else if (hrs >= 1) left = `${hrs} hour${hrs === 1 ? '' : 's'} left`;
    else left = `${Math.max(1, mins)} min left`;
    urgency = hrs < 6 ? 'urgent' : hrs < 48 ? 'soon' : 'ok';
  }
  return { at, label, left, urgency };
}

/** GET /api/payments/config once per page load. */
let configPromise = null;
export function getPaymentsConfig() {
  if (!configPromise) {
    configPromise = api.get('/api/payments/config').then(r => r.data || { provider: 'mock' })
      .catch(e => { configPromise = null; throw e; });
  }
  return configPromise;
}

/** Inject Razorpay Checkout once, on demand. */
let rzpPromise = null;
export function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (!rzpPromise) {
    rzpPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.async = true;
      s.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error('Razorpay Checkout failed to load')));
      s.onerror = () => { rzpPromise = null; s.remove(); reject(new Error('Could not load Razorpay Checkout — check your connection and try again.')); };
      document.head.appendChild(s);
    });
  }
  return rzpPromise;
}

/** Card/UPI/netbanking fee absorbed by Meridian, for display. */
export const paymentFee = (p) => n(p?.fee);

/** Unwrap GET /api/invoices/:id which may be flat or {invoice, payments, refunds}. */
export function normInvoice(d) {
  if (!d) return null;
  if (d.invoice) return { ...d.invoice, payments: d.payments ?? d.invoice.payments ?? [], refunds: d.refunds ?? d.invoice.refunds ?? [] };
  return { ...d, payments: d.payments ?? [], refunds: d.refunds ?? [] };
}
