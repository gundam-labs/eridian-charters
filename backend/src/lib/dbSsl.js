/**
 * Decide the pg `ssl` option from the connection target (pure; unit-testable).
 *  - no URL, PGSSLMODE=disable, localhost/127.0.0.1/::1, or *.railway.internal → no TLS
 *  - anything else (e.g. Railway's public TCP proxy) → TLS without CA verification
 */
function resolveSsl(databaseUrl, env = process.env) {
  if (!databaseUrl) return false;
  if (String(env.PGSSLMODE || '').toLowerCase() === 'disable') return false;
  let host;
  try { host = new URL(databaseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return false; }
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  if (host.endsWith('.railway.internal')) return false;
  return { rejectUnauthorized: false };
}

module.exports = { resolveSsl };
