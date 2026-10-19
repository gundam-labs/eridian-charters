/**
 * migrate.js — apply the idempotent schema (CREATE ... IF NOT EXISTS) and default settings.
 * Railway preDeployCommand. Never drops data. Ends the pool so the process exits promptly.
 */
require('dotenv').config({ quiet: true });

async function main() {
  console.log('Meridian Charters — schema migration');
  const { initDB, pool } = require('./index');
  await initDB();
  console.log('Migration complete');
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err.message || err);
  if (err.code) console.error('  Code:', err.code);
  if (err.detail) console.error('  Detail:', err.detail);
  process.exit(1);
});
