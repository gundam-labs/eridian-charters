const { pool } = require('../db');
const { todayIST } = require('./time');

/**
 * nextNumber('Q', client) → 'Q-2026-0001'. Per-prefix counter that resets each IST year.
 * Atomic: the row is created if missing, then incremented with UPDATE … RETURNING (row lock).
 * Pass a transaction client so the number is rolled back with the rest of the work.
 */
async function nextNumber(prefix, db = pool) {
  const year = parseInt(todayIST().slice(0, 4), 10);
  await db.query('INSERT INTO sequences (name, year, next) VALUES ($1,$2,1) ON CONFLICT (name) DO NOTHING', [prefix, year]);
  const { rows } = await db.query(
    `UPDATE sequences
        SET next = CASE WHEN year = $2 THEN next + 1 ELSE 2 END,
            year = $2
      WHERE name = $1
  RETURNING next - 1 AS n`,
    [prefix, year]
  );
  return `${prefix}-${year}-${String(rows[0].n).padStart(4, '0')}`;
}

/** nextMemberNo(client) → 'MC-1001', 'MC-1002', … (no year component). */
async function nextMemberNo(db = pool) {
  await db.query(
    `INSERT INTO sequences (name, year, next)
     VALUES ('MC', 0, GREATEST(1001, COALESCE((SELECT MAX(substring(member_no FROM 4)::int) + 1 FROM members WHERE member_no ~ '^MC-[0-9]+$'), 1001)))
     ON CONFLICT (name) DO NOTHING`
  );
  const { rows } = await db.query("UPDATE sequences SET next = next + 1 WHERE name = 'MC' RETURNING next - 1 AS n");
  return `MC-${rows[0].n}`;
}

module.exports = { nextNumber, nextMemberNo };
