// Railway pre-deploy hook: seeds demo data only when SEED_DEMO=true.
// The seed is idempotent, so redeploys of a demo environment are safe.
// Without SEED_DEMO=true this exits 0 and does nothing, so a production
// deploy never gets demo users.
if (process.env.SEED_DEMO !== 'true') {
  console.log('SEED_DEMO is not true; skipping demo seed.');
  process.exit(0);
}
require('./seed');
