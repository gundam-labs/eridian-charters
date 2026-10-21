/**
 * Route alerts (v1.6): a traveller saves a route (from and/or to, optional dates) and is emailed when a
 * matching empty leg is published. One email per alert per flight (route_alert_hits). No account needed;
 * each alert has a secret token for its unsubscribe link.
 */
const crypto = require('crypto');
const { pool } = require('../db');
const { HttpError } = require('./http');
const { logEvent } = require('./events');

const MAX_ACTIVE_PER_EMAIL = 10;

async function createAlert(b) {
  const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  const email = clean(b.email, 254).toLowerCase();
  if (!/^[^@\s<>"',;]+@[^@\s<>"',;]+\.[^@\s<>"',;]{2,}$/.test(email)) throw new HttpError(400, 'Please enter a valid email address');
  const name = clean(b.name, 120) || null;
  const code = (v) => { const c = clean(v, 3).toUpperCase(); return /^[A-Z]{3}$/.test(c) ? c : null; };
  const from_code = code(b.from_code);
  const to_code = code(b.to_code);
  if (!from_code && !to_code) throw new HttpError(400, 'Choose at least a departure or an arrival city');
  if (from_code && from_code === to_code) throw new HttpError(400, 'From and to must be different');
  const date = (v) => { const d = clean(v, 10); if (!d) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, 'Dates must be YYYY-MM-DD'); return d; };
  const date_from = date(b.date_from);
  const date_to = date(b.date_to);
  if (date_from && date_to && date_to < date_from) throw new HttpError(400, 'The end date must be on or after the start date');
  const known = (await pool.query('SELECT code FROM airports WHERE code = ANY($1)', [[from_code, to_code].filter(Boolean)])).rows.map((r) => r.code);
  for (const c of [from_code, to_code].filter(Boolean)) if (!known.includes(c)) throw new HttpError(400, `Unknown airport ${c}`);
  const active = (await pool.query('SELECT count(*)::int AS n FROM route_alerts WHERE email = $1 AND active', [email])).rows[0].n;
  if (active >= MAX_ACTIVE_PER_EMAIL) throw new HttpError(409, `You already have ${MAX_ACTIVE_PER_EMAIL} active alerts — stop one from an alert email first`);
  const dup = (await pool.query(
    `SELECT id FROM route_alerts WHERE email = $1 AND active AND from_code IS NOT DISTINCT FROM $2 AND to_code IS NOT DISTINCT FROM $3
       AND date_from IS NOT DISTINCT FROM $4 AND date_to IS NOT DISTINCT FROM $5`, [email, from_code, to_code, date_from, date_to])).rows[0];
  if (dup) return { id: dup.id, existing: true };
  const token = crypto.randomBytes(24).toString('base64url');
  const row = (await pool.query(
    `INSERT INTO route_alerts (email, name, from_code, to_code, date_from, date_to, token) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [email, name, from_code, to_code, date_from, date_to, token])).rows[0];
  await logEvent({ entity_type: 'route_alert', entity_id: row.id, action: 'created', detail: { from_code, to_code, date_from, date_to } });
  // A new alert also matches flights that are already listed.
  matchExisting(row.id).catch((err) => console.error('[RouteAlerts] initial match failed:', err.message));
  return { id: row.id, existing: false };
}

async function unsubscribe(token) {
  const row = (await pool.query(`UPDATE route_alerts SET active = false WHERE token = $1 RETURNING from_code, to_code`, [String(token || '')])).rows[0];
  if (!row) throw new HttpError(404, 'This alert link is not valid');
  return row;
}

const MATCH_SQL = `
  (a.from_code IS NULL OR a.from_code = el.from_code) AND (a.to_code IS NULL OR a.to_code = el.to_code)
  AND (a.date_from IS NULL OR (el.depart_latest AT TIME ZONE 'Asia/Kolkata')::date >= a.date_from)
  AND (a.date_to IS NULL OR (el.depart_earliest AT TIME ZONE 'Asia/Kolkata')::date <= a.date_to)`;

/** Email every active alert matching these (published) legs, once per alert per leg. */
async function notify(where, params) {
  const { LEG_SELECT } = require('./emptyLegs');
  const { sendRouteAlert, APP_URL } = require('./email');
  const pairs = (await pool.query(
    `INSERT INTO route_alert_hits (alert_id, empty_leg_id)
     SELECT a.id, el.id FROM route_alerts a JOIN empty_legs el ON ${MATCH_SQL}
      WHERE a.active AND el.status = 'published' AND ${where}
     ON CONFLICT DO NOTHING RETURNING alert_id, empty_leg_id`, params)).rows;
  const byAlert = new Map();
  for (const p of pairs) byAlert.set(p.alert_id, [...(byAlert.get(p.alert_id) || []), p.empty_leg_id]);
  for (const [alertId, legIds] of byAlert) {
    const a = (await pool.query('SELECT * FROM route_alerts WHERE id = $1', [alertId])).rows[0];
    const legs = (await pool.query(`${LEG_SELECT} WHERE el.id = ANY($1) ORDER BY el.depart_earliest`, [legIds])).rows;
    await sendRouteAlert({ to: a.email, name: a.name, legs, unsubscribeUrl: `${APP_URL()}/alerts/stop/${a.token}` });
  }
  return pairs.length;
}

/** Call after a leg is published. Never throws. */
async function notifyForLeg(legId) {
  try {
    return await notify('el.id = $1', [legId]);
  } catch (err) {
    console.error('[RouteAlerts] notify failed:', err.message);
    return 0;
  }
}

const matchExisting = (alertId) => notify('a.id = $1', [alertId]);

/** Staff: demand by route (active alerts), most wanted first. */
async function demandSummary() {
  return (await pool.query(
    `SELECT a.from_code, a.to_code, fa.city AS from_city, ta.city AS to_city, count(*)::int AS alerts,
            count(DISTINCT a.email)::int AS travellers, max(a.created_at) AS latest,
            (SELECT count(*)::int FROM empty_legs el WHERE el.status = 'published'
               AND (a.from_code IS NULL OR el.from_code = a.from_code) AND (a.to_code IS NULL OR el.to_code = a.to_code)) AS live_matches
       FROM route_alerts a LEFT JOIN airports fa ON fa.code = a.from_code LEFT JOIN airports ta ON ta.code = a.to_code
      WHERE a.active GROUP BY a.from_code, a.to_code, fa.city, ta.city ORDER BY alerts DESC, latest DESC LIMIT 200`)).rows;
}

module.exports = { createAlert, unsubscribe, notifyForLeg, demandSummary };
