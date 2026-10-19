const { pool } = require('../db');

// Charter statuses that occupy an aircraft.
const BUSY_STATUSES = ['accepted', 'confirmed', 'manifest_complete', 'flown'];

/*
 * Empty-leg exemption (SPEC v1.1 "Conflicts"): a charter derived from an empty leg flies inside its
 * source charter's dates on the same aircraft with the same crew. When checking charter X we compute
 * its "family root" — X's source charter if X is derived, else X itself (or an explicit sourceCharterId
 * for a charter that does not exist yet) — and ignore the root and every charter derived from the root.
 * Manual empty legs have no source charter, so their charters are checked normally.
 *   $A = excludeCharterId, $B = explicit sourceCharterId
 */
const ROOT_SQL = (a, b) => `COALESCE($${b}::uuid,
    (SELECT el.source_charter_id FROM charters x JOIN empty_legs el ON el.id = x.empty_leg_id WHERE x.id = $${a}::uuid),
    $${a}::uuid)`;
const NOT_FAMILY = (alias, a, b) => `NOT COALESCE((
    ${alias}.id = ${ROOT_SQL(a, b)}
    OR EXISTS (SELECT 1 FROM empty_legs fel WHERE fel.id = ${alias}.empty_leg_id AND fel.source_charter_id = ${ROOT_SQL(a, b)})
  ), false)`;

/**
 * Aircraft conflicts for an inclusive date range.
 * opts.sourceCharterId: treat the range as belonging to a (not yet created) charter derived from that source.
 * → [{ kind:'charter'|'maintenance', ref (id), label, starts_on, ends_on }]
 */
async function conflicts(aircraft_id, starts_on, ends_on, excludeCharterId = null, db = pool, opts = {}) {
  const ch = await db.query(
    `SELECT c.id, c.charter_no, c.starts_on, c.ends_on, m.contact_name
       FROM charters c JOIN members m ON m.id = c.member_id
      WHERE c.aircraft_id = $1 AND c.status = ANY($2)
        AND c.starts_on <= $4 AND c.ends_on >= $3
        AND ($5::uuid IS NULL OR c.id <> $5::uuid)
        AND ${NOT_FAMILY('c', 5, 6)}
      ORDER BY c.starts_on`,
    [aircraft_id, BUSY_STATUSES, starts_on, ends_on, excludeCharterId, opts.sourceCharterId || null]
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
 * The empty-leg source ↔ derived pair is exempt (see above).
 * → [{ crew_id, name, charter_no }]
 */
async function crewConflicts(crewIds, starts_on, ends_on, excludeCharterId, db = pool, opts = {}) {
  const ids = crewIds.filter(Boolean);
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT cm.id AS crew_id, cm.name, c.charter_no
       FROM charters c
       JOIN crew_members cm ON cm.id IN (c.captain_id, c.first_officer_id, c.cabin_crew_id)
      WHERE cm.id = ANY($1::uuid[])
        AND c.status NOT IN ('cancelled','closed')
        AND c.starts_on <= $3 AND c.ends_on >= $2
        AND ($4::uuid IS NULL OR c.id <> $4::uuid)
        AND ${NOT_FAMILY('c', 4, 5)}`,
    [ids, starts_on, ends_on, excludeCharterId || null, opts.sourceCharterId || null]
  );
  return rows;
}

module.exports = { conflicts, crewConflicts, BUSY_STATUSES };
