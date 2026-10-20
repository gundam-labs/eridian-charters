/**
 * Lister verification (v1.3, admin and sales): review self-registered operators, travel agents and private
 * flyers, then approve, reject or suspend them. Suspending takes the lister's open listings down.
 */
const { pool, withTransaction } = require('../db');
const { asyncRouter, HttpError, isUuid } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { logEvent } = require('../lib/events');
const { sendListerDecision, sendEmptyLegRequestClosed } = require('../lib/email');

const router = asyncRouter();
router.use(requireRole('sales'));

const STATUSES = ['pending', 'approved', 'rejected', 'suspended'];
const SELECT = `SELECT l.*, u.name, u.email, u.is_active, u.last_login_at, d.name AS decided_by_name,
  (SELECT count(*)::int FROM empty_legs el WHERE el.lister_id = l.id) AS listings_count,
  (SELECT count(*)::int FROM empty_legs el WHERE el.lister_id = l.id AND el.status = 'published') AS live_count,
  (SELECT count(*)::int FROM empty_legs el WHERE el.lister_id = l.id AND el.status = 'booked') AS booked_count
  FROM listers l JOIN users u ON u.id = l.user_id LEFT JOIN users d ON d.id = l.decided_by`;

router.get('/', async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.status) {
    const st = String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean);
    if (st.some((s) => !STATUSES.includes(s))) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`);
    params.push(st); where = 'WHERE l.status = ANY($1)';
  }
  const { rows } = await pool.query(
    `${SELECT} ${where} ORDER BY CASE l.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, l.created_at DESC`, params);
  res.json(rows);
});

async function load(id, db = pool) {
  if (!isUuid(id)) throw new HttpError(404, 'Lister not found');
  const l = (await db.query(`${SELECT} WHERE l.id = $1`, [id])).rows[0];
  if (!l) throw new HttpError(404, 'Lister not found');
  return l;
}

router.get('/:id', async (req, res) => {
  res.json(await load(req.params.id));
});

// Allowed transitions: pending → approved|rejected; rejected → approved; approved → suspended; suspended → approved.
const FROM = { approve: ['pending', 'rejected', 'suspended'], reject: ['pending'], suspend: ['approved'] };
const TO = { approve: 'approved', reject: 'rejected', suspend: 'suspended' };

for (const action of Object.keys(FROM)) {
  router.post(`/:id/${action}`, async (req, res) => {
    const l = await load(req.params.id);
    if (!FROM[action].includes(l.status)) throw new HttpError(409, `Cannot ${action} a lister who is ${l.status}`);
    const reason = String(req.body?.reason || '').trim().slice(0, 1000) || null;
    if (action !== 'approve' && !reason) throw new HttpError(400, 'A reason is required');
    const closed = await withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE listers SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4 WHERE id = $1 AND status = ANY($5) RETURNING id`,
        [l.id, TO[action], req.user.id, reason, FROM[action]]);
      if (!upd.rows.length) throw new HttpError(409, 'Lister changed — reload and try again');
      await logEvent({ entity_type: 'lister', entity_id: l.id, action: TO[action], actor_user_id: req.user.id, detail: { reason } }, client);
      if (action !== 'suspend') return [];
      // Take every open listing down and close the requests on it.
      const legs = (await client.query(
        `UPDATE empty_legs SET status = 'withdrawn', withdrawn_reason = 'Lister suspended'
          WHERE lister_id = $1 AND status IN ('draft','published','expired') RETURNING *`, [l.id])).rows;
      const out = [];
      for (const leg of legs) {
        await logEvent({ entity_type: 'empty_leg', entity_id: leg.id, action: 'withdrawn', actor_user_id: req.user.id, detail: { reason: 'Lister suspended' } }, client);
        const reqs = (await client.query(
          `UPDATE empty_leg_bookings SET status = 'cancelled', reject_reason = 'Flight withdrawn', decided_by = $2, decided_at = now()
            WHERE empty_leg_id = $1 AND status = 'requested' RETURNING *`, [leg.id, req.user.id])).rows;
        for (const r of reqs) out.push({ booking: r, leg });
      }
      return out;
    });
    if (closed.length) {
      const airports = Object.fromEntries((await pool.query('SELECT code, city FROM airports')).rows.map((a) => [a.code, a.city]));
      for (const { booking, leg } of closed) {
        await sendEmptyLegRequestClosed({ to: booking.guest_email, name: booking.guest_name, booking,
          leg: { ...leg, from_city: airports[leg.from_code], to_city: airports[leg.to_code] }, reason: 'The flight has been withdrawn' });
      }
    }
    await sendListerDecision({ to: l.email, name: l.name, status: TO[action], reason });
    res.json(await load(l.id));
  });
}

module.exports = router;
