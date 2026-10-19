const { pool } = require('../db');

// Charter statuses that occupy an aircraft.
const BUSY_STATUSES = ['accepted', 'confirmed', 'manifest_complete', 'flown'];

/**
 * Aircraft conflicts for an inclusive date range.
 * → [{ kind:'charter'|'maintenance', ref (id), label, starts_on, ends_on }]
 */
async function conflicts(aircraft_id, starts_on, ends_on, excludeCharterId = null, db = pool) {
  const ch = await db.query(
    `SELECT c.id, c.charter_no, c.starts_on, c.ends_on, m.contact_name
       FROM charters c JOIN members m ON m.id = c.member_id
      WHERE c.aircraft_id = $1 AND c.status = ANY($2)
        AND c.starts_on <= $4 AND c.ends_on >= $3
        AND ($5::uuid IS NULL OR c.id <> $5::uuid)
      ORDER BY c.starts_on`,
    [aircraft_id, BUSY_STATUSES, starts_on, ends_on, excludeCharterId]
  );
  const mb = await db.query(
    `SELECT id, starts_on, ends_on, reason FROM maintenance_blocks
      WHERE aircraft_id = $1 AND starts_on <= $3 AND ends_on >= $2 ORDER BY starts_on`,
    [aircraft_id, starts_on, ends_on]
  );
  return [
    ...ch.rows.map((r) => ({ kind: 'charter', ref: r.id, label: `${r.charter_no} · ${r.contact_name}`, starts_on: r.starts_on, ends_on: r.ends_on })),
    ...mb.rows.map((r) => ({ kind: 'maintenance', ref: r.id, label: `Maintenance${r.reason ? ` · ${r.reason}` : ''}`, starts_on: r.starts_on, ends_on: r.ends_on })),
  ];
}

/**
 * Crew members (of the given ids) already assigned to another non-cancelled, non-closed charter overlapping the dates.
 * → [{ crew_id, name, charter_no }]
 */
async function crewConflicts(crewIds, starts_on, ends_on, excludeCharterId, db = pool) {
  const ids = crewIds.filter(Boolean);
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT cm.id AS crew_id, cm.name, c.charter_no
       FROM charters c
       JOIN crew_members cm ON cm.id IN (c.captain_id, c.first_officer_id, c.cabin_crew_id)
      WHERE cm.id = ANY($1::uuid[])
        AND c.status NOT IN ('cancelled','closed')
        AND c.starts_on <= $3 AND c.ends_on >= $2
        AND c.id <> $4`,
    [ids, starts_on, ends_on, excludeCharterId]
  );
  return rows;
}

module.exports = { conflicts, crewConflicts, BUSY_STATUSES };
