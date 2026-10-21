/**
 * Razorpay provider (SPEC v1.2) — plain fetch against https://api.razorpay.com/v1 with HTTP Basic auth.
 * No SDK. Errors become HttpError(502) with the provider's description only (never credentials).
 */
const { HttpError } = require('../http');
const { hmacHex, verifyHmac } = require('./signature');

const API = 'https://api.razorpay.com/v1';
const TIMEOUT_MS = 15000;

const cfg = () => ({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
  webhook_secret: process.env.RAZORPAY_WEBHOOK_SECRET,
});

async function call(method, path, body) {
  const { key_id, key_secret } = cfg();
  const auth = Buffer.from(`${key_id}:${key_secret}`).toString('base64');
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new HttpError(502, `Payment provider error: ${err.name === 'TimeoutError' ? 'timed out' : 'unreachable'}`);
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON */ }
  if (!res.ok) {
    const desc = data?.error?.description || data?.error?.code || `HTTP ${res.status}`;
    throw new HttpError(502, `Payment provider error: ${String(desc).slice(0, 200)}`);
  }
  return data;
}

module.exports = {
  name: 'razorpay',
  keyId: () => cfg().key_id,

  async createOrder({ amount_paise, receipt, notes }) {
    return call('POST', '/orders', { amount: amount_paise, currency: 'INR', receipt, notes, payment_capture: 1 });
  },

  /**
   * Order whose payment is only authorised (held) — captured later with capture(), or auto-refunded by Razorpay
   * when holdMinutes pass without a capture. Razorpay allows up to 7200 minutes (5 days).
   */
  async createHoldOrder({ amount_paise, receipt, notes, holdMinutes }) {
    return call('POST', '/orders', {
      amount: amount_paise, currency: 'INR', receipt, notes,
      payment: { capture: 'manual', capture_options: { manual_expiry_period: Math.min(7200, Math.max(12, Math.round(holdMinutes))), refund_speed: 'optimum' } },
    });
  },

  /** Capture an authorised payment. → payment entity (status 'captured'). */
  async capture(payment_id, amount_paise) {
    return call('POST', `/payments/${encodeURIComponent(payment_id)}/capture`, { amount: amount_paise, currency: 'INR' });
  },

  /**
   * Release a hold. Razorpay has no void call for authorised payments: they are refunded automatically when the
   * order's manual_expiry_period passes. → { released: false, note } so callers record that the bank releases it.
   */
  async release() {
    return { released: false, note: 'Released automatically by Razorpay when the hold expires' };
  },

  /** Route: transfer part of a captured payment to a linked account (the lister). → transfer entity. */
  async transfer(payment_id, { account, amount_paise, notes }) {
    const r = await call('POST', `/payments/${encodeURIComponent(payment_id)}/transfers`, {
      transfers: [{ account, amount: amount_paise, currency: 'INR', notes }],
    });
    return (r.items || [])[0] || r;
  },

  /** → Razorpay payment entity (amount, status, method, fee, tax, order_id, …). */
  async fetchPayment(id) {
    return call('GET', `/payments/${encodeURIComponent(id)}`);
  },

  /** → { id, account_number, ifsc, bank_name, name } */
  async createVirtualAccount({ name, notes }) {
    const va = await call('POST', '/virtual_accounts', {
      receivers: { types: ['bank_account'] },
      description: String(name || 'Meridian Charters').slice(0, 2048),
      notes,
    });
    const ba = (va.receivers || []).find((r) => r.entity === 'bank_account') || {};
    return { id: va.id, account_number: ba.account_number, ifsc: ba.ifsc, bank_name: ba.bank_name, name: ba.name || va.name };
  },

  /** → { id, status ('pending'|'processed'|'failed'), amount } */
  async refund(payment_id, amount_paise, notes) {
    return call('POST', `/payments/${encodeURIComponent(payment_id)}/refund`, { amount: amount_paise, notes });
  },

  verifyWebhook(rawBody, signature) {
    return verifyHmac(cfg().webhook_secret, rawBody, signature);
  },

  verifyCheckout(order_id, payment_id, signature) {
    if (!order_id || !payment_id) return false;
    return verifyHmac(cfg().key_secret, `${order_id}|${payment_id}`, signature);
  },

  // exposed for symmetry with mock (not used for live traffic)
  _sign: (data) => hmacHex(cfg().webhook_secret, data),
};
