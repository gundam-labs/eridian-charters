/**
 * Mock provider (SPEC v1.2) — same interface as razorpay.js, no network. Used for local dev, tests and the
 * live demo until Razorpay keys exist. Webhooks are signed with the mock webhook secret and verified with
 * exactly the same HMAC code as Razorpay's, so the webhook path is exercised for real.
 */
const crypto = require('crypto');
const { HttpError } = require('../http');
const { hmacHex, verifyHmac } = require('./signature');

const webhookSecret = () => process.env.MOCK_WEBHOOK_SECRET || 'mock_webhook_secret';
const keySecret = () => process.env.MOCK_KEY_SECRET || 'mock_key_secret';

const rid = (prefix) => `${prefix}_mock_${crypto.randomBytes(7).toString('hex')}`;
const digits = (n) => Array.from(crypto.randomBytes(n), (b) => String(b % 10)).join('');

/** 2% + 18% GST on the fee for card/UPI/netbanking (and wallet/emi); 0 for bank transfer. → { fee, tax } in paise. */
function mockFee(amount_paise, method) {
  if (method === 'bank_transfer') return { fee: 0, tax: 0 };
  const base = Math.round(amount_paise * 0.02);
  const tax = Math.round(base * 0.18);
  return { fee: base + tax, tax };
}

// Payments "captured" by the mock in this process, so fetchPayment() works like the real API.
const payments = new Map();

module.exports = {
  name: 'mock',
  keyId: () => null,
  mockFee,
  webhookSecret,

  async createOrder({ amount_paise, receipt, notes }) {
    if (!Number.isInteger(amount_paise) || amount_paise < 100) throw new HttpError(502, 'Payment provider error: amount must be at least 100 paise');
    return { id: rid('order'), entity: 'order', amount: amount_paise, currency: 'INR', receipt, notes, status: 'created', created_at: Math.floor(Date.now() / 1000) };
  },

  async fetchPayment(id) {
    const p = payments.get(id);
    if (!p) throw new HttpError(502, 'Payment provider error: The id provided does not exist');
    return p;
  },

  async createVirtualAccount({ name, notes }) {
    // `name` is the account description; the beneficiary name shown to payers is the merchant's.
    return { id: rid('va'), account_number: `2223330${digits(9)}`, ifsc: 'RATN0VAAPIS', bank_name: 'RBL Bank', name: 'Meridian Charters', description: name, notes };
  },

  async refund(payment_id, amount_paise, notes) {
    return { id: rid('rfnd'), entity: 'refund', payment_id, amount: amount_paise, notes, status: 'processed', created_at: Math.floor(Date.now() / 1000) };
  },

  verifyWebhook(rawBody, signature) {
    return verifyHmac(webhookSecret(), rawBody, signature);
  },

  verifyCheckout(order_id, payment_id, signature) {
    if (!order_id || !payment_id) return false;
    return verifyHmac(keySecret(), `${order_id}|${payment_id}`, signature);
  },

  // ── Mock-only helpers ──────────────────────────────────────────────────────
  /** Build a Razorpay-shaped captured payment entity and remember it for fetchPayment(). */
  capturedPayment({ amount_paise, order_id = null, method, notes = {} }) {
    const { fee, tax } = mockFee(amount_paise, method);
    const p = {
      id: rid('pay'), entity: 'payment', amount: amount_paise, currency: 'INR', status: 'captured', order_id, method,
      captured: true, fee, tax, notes, created_at: Math.floor(Date.now() / 1000),
      ...(method === 'upi' ? { vpa: 'test@upi' } : {}),
      ...(method === 'netbanking' ? { bank: 'HDFC' } : {}),
      ...(method === 'bank_transfer' ? { bank_transfer_ref: `UTR${digits(12)}` } : {}),
    };
    payments.set(p.id, p);
    return p;
  },
  /** Sign a raw webhook body with the mock webhook secret (X-Razorpay-Signature value). */
  signWebhook: (raw) => hmacHex(webhookSecret(), raw),
  /** Checkout signature for an order/payment pair (what Razorpay Checkout would hand the browser). */
  signCheckout: (order_id, payment_id) => hmacHex(keySecret(), `${order_id}|${payment_id}`),
  newEventId: () => `evt_mock_${crypto.randomBytes(8).toString('hex')}`,
};
