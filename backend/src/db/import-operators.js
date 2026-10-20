/**
 * import-operators.js — load the DGCA list of non-scheduled operators into charter_operators /
 * operator_aircraft. Real public data (not demo), so it runs on every deploy, and is idempotent:
 *
 *  - skipped when this list version is already imported (data_imports), unless --force;
 *  - operators are upserted by AOP number; only DGCA-sourced columns are updated — enrichment
 *    columns (website, notes) are never touched;
 *  - operators missing from a newer list are kept but flagged in_latest_list = false;
 *  - an aircraft is upserted by registration and moves to whichever operator now lists it; aircraft
 *    an operator no longer lists are removed.
 *
 * To load a new list: parse it with scripts/parse_dgca_nsop.py into seed-data/, update DGCA_FILE below.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const DGCA_FILE = 'dgca-nsop-operators-2026-08-31.json';
const IMPORT_NAME = 'dgca_nsop_operators';

async function importOperators({ pool, withTransaction }, { force = false, file = DGCA_FILE } = {}) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-data', file), 'utf8'));
  const version = data.as_of;
  const prev = (await pool.query('SELECT version FROM data_imports WHERE name = $1', [IMPORT_NAME])).rows[0];
  if (prev && prev.version === version && !force) return { skipped: true, version };

  return withTransaction(async (client) => {
    let inserted = 0;
    let updated = 0;
    let aircraft = 0;
    const seen = [];
    for (const o of data.operators) {
      const { rows } = await client.query(
        `INSERT INTO charter_operators (aop_no, name, address, pincode, phone, fax, emails, aop_valid_until, fleet_type, aircraft_count,
           source, source_as_of, source_sno, in_latest_list)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'dgca_nsop',$11,$12,true)
         ON CONFLICT (aop_no) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address, pincode = EXCLUDED.pincode,
           phone = EXCLUDED.phone, fax = EXCLUDED.fax, emails = EXCLUDED.emails, aop_valid_until = EXCLUDED.aop_valid_until,
           fleet_type = EXCLUDED.fleet_type, aircraft_count = EXCLUDED.aircraft_count, source_as_of = EXCLUDED.source_as_of,
           source_sno = EXCLUDED.source_sno, in_latest_list = true, updated_at = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [o.aop_no, o.name, o.address, o.pincode, o.phone, o.fax, o.emails, o.aop_valid_until, o.fleet_type, o.aircraft_count,
          version, o.sno]);
      const op = rows[0];
      if (op.inserted) inserted += 1; else updated += 1;
      seen.push(op.id);
      const regs = [];
      for (const a of o.aircraft) {
        await client.query(
          `INSERT INTO operator_aircraft (operator_id, registration, kind, model, seats, role, seats_raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (registration) DO UPDATE SET operator_id = EXCLUDED.operator_id, kind = EXCLUDED.kind, model = EXCLUDED.model,
             seats = EXCLUDED.seats, role = EXCLUDED.role, seats_raw = EXCLUDED.seats_raw`,
          [op.id, a.registration, a.kind, a.model, a.seats, a.role, a.seats_raw]);
        regs.push(a.registration);
        aircraft += 1;
      }
      await client.query('DELETE FROM operator_aircraft WHERE operator_id = $1 AND NOT (registration = ANY($2))', [op.id, regs]);
    }
    const dropped = (await client.query(
      `UPDATE charter_operators SET in_latest_list = false, updated_at = now()
        WHERE source = 'dgca_nsop' AND in_latest_list AND NOT (id = ANY($1)) RETURNING id`, [seen])).rowCount;
    const detail = { source: data.source, file, operators: data.operators.length, inserted, updated, aircraft, dropped };
    await client.query(
      `INSERT INTO data_imports (name, version, detail, imported_at) VALUES ($1,$2,$3, now())
       ON CONFLICT (name) DO UPDATE SET version = EXCLUDED.version, detail = EXCLUDED.detail, imported_at = now()`,
      [IMPORT_NAME, version, JSON.stringify(detail)]);
    return { skipped: false, version, ...detail };
  });
}

async function main() {
  const db = require('./index');
  await db.initDB();
  const result = await importOperators(db, { force: process.argv.includes('--force') });
  console.log(result.skipped
    ? `Charter operators: DGCA list ${result.version} already imported`
    : `Charter operators: imported DGCA list ${result.version} — ${result.operators} operators (${result.inserted} new, ${result.updated} updated), ${result.aircraft} aircraft, ${result.dropped} no longer listed`);
  await db.pool.end();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error('Operator import failed:', err.message || err);
    process.exit(1);
  });
}

module.exports = { importOperators, DGCA_FILE };
