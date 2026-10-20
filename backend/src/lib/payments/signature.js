/** HMAC-SHA256 helpers shared by the Razorpay and mock providers. Constant-time comparison. */
const crypto = require('crypto');

const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

/** True when `signature` (hex) equals HMAC-SHA256(secret, data). Never throws. */
function safeEqualHex(expectedHex, signature) {
  if (typeof signature !== 'string' || !/^[0-9a-f]+$/i.test(signature)) return false;
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(signature.toLowerCase(), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Webhook: HMAC of the RAW request body (Buffer or string) with the webhook secret. */
function verifyHmac(secret, data, signature) {
  if (!secret || data == null) return false;
  return safeEqualHex(hmacHex(secret, data), signature);
}

module.exports = { hmacHex, safeEqualHex, verifyHmac };
