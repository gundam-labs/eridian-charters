/**
 * Payments provider selection (SPEC v1.2). PAYMENTS_PROVIDER = 'mock' (default) | 'razorpay'.
 * With razorpay selected the server refuses to start unless all three Razorpay secrets are set.
 */
const razorpay = require('./razorpay');
const mock = require('./mock');

const PROVIDERS = { razorpay, mock };

const providerName = () => String(process.env.PAYMENTS_PROVIDER || 'mock').trim().toLowerCase() || 'mock';

/** The active provider module. */
function provider() {
  return PROVIDERS[providerName()] || mock;
}

/** Provider module that owns an existing payment row ('manual' → null: refunds are made by hand). */
function providerFor(name) {
  return PROVIDERS[name] || null;
}

/** → null when the configuration is usable, else an error message for a FATAL exit. */
function configError() {
  const name = providerName();
  if (!PROVIDERS[name]) return `PAYMENTS_PROVIDER must be 'razorpay' or 'mock' (got '${name}')`;
  if (name === 'razorpay') {
    const missing = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'].filter((k) => !process.env[k]);
    if (missing.length) return `PAYMENTS_PROVIDER=razorpay requires ${missing.join(', ')}`;
  }
  return null;
}

module.exports = { provider, providerFor, providerName, configError, PROVIDERS };
