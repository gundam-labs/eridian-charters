const { pool, getSettings, withTransaction } = require('../db');
const { asyncRouter, HttpError, isUuid } = require('../lib/http');
const { requireRole, isStaff } = require('../middleware/auth');
const { nextNumber } = require('../lib/numbers');
const { logEvent } = require('../lib/events');
const { conflicts } = require('../lib/availability');
const { expireStaleQuotes, priceForRequest } = require('../lib/quotes');
const { publicAircraft } = require('../lib/serialize');
const { todayIST, addDays, fmtIST } = require('../lib/time');
const { sendQuoteSent, sendCharterAccepted } = require('../lib/email');
const { quotePdf } = require('../lib/pdf');

const router = asyncRouter();

const QUOTE_SELECT = `SELECT q.*, r.request_no, r.pax, r.status AS request_status, r.notes AS request_notes,
  m.member_no, m.contact_name AS member_name, m.company AS member_company, m.email AS member_email, m.gstin AS member_gstin, m.city AS member_city,
  json_build_object('id', a.id, 'registration', a.registration, 'type', a.type, 'seats', a.seats, 'home_base', a.home_base,
                    'cruise_speed_kts', a.cruise_speed_kts, 'hourly_rate_inr', a.hourly_rate_inr::float8, 'partner_name', a.partner_name, 'status', a.status) AS aircraft,
  (SELECT c.id FROM charters c WHERE c.quote_id = q.id) AS charter_id
  FROM quotes q
  JOIN quote_requests r ON r.id = q.request_id
  JOIN members m ON m.id = q.member_id
  JOIN aircraft a ON a.id = q.aircraft_id`;

/** Strip internal-only fields for members (no hourly rate, no partner name). */
function shapeQuote(q, user) {
  const out = { ...q };
  if (!isStaff(user)) {
    out.aircraft = publicAircraft(q.aircraft);
    delete out.created_by;
  }
  return out;
}

async function loadQuote(id, user, db = pool) {
  if (!isUuid(id)) throw new HttpError(404, 'Quote not found');
  const q = (await db.query(`${QUOTE_SELECT} WHERE q.id = $1`, [id])).rows[0];
  if (!q) throw new HttpError(404, 'Quote not found');
  if (user.role === 'member' && (q.member_id !== user.member_id || q.status === 'draft' || q.status === 'withdrawn' && !q.sent_at)) throw new HttpError(404, 'Quote not found');
  return q;
}

async function loadRequest(id, db = pool) {
  if (!isUuid(id)) throw new HttpError(400, 'request_id is required');
  const r = (await db.query('SELECT * FROM quote_requests WHERE id = $1', [id])).rows[0];
  if (!r) throw new HttpError(404, 'Request not found');
  return r;
}

function parseAdjustment(body) {
  const adj = body.adjustment_inr === undefined || body.adjustment_inr === null || body.adjustment_inr === '' ? 0 : Number(body.adjustment_inr);
  if (!Number.isFinite(adj)) throw new HttpError(400, 'adjustment_inr must be a number');
  return { adjustment_inr: Math.round(adj), adjustment_note: body.adjustment_note ? String(body.adjustment_note).slice(0, 200) : null };
}

function parseValidHours(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 24 * 30) throw new HttpError(400, 'valid_hours must be an integer between 1 and 720');
  return n;
}

// ── Preview (no write) ──────────────────────────────────────────────────────
router.post('/preview', requireRole('sales'), async (req, res) => {
  const body = req.body || {};
  const request = await loadRequest(body.request_id);
  if (!isUuid(body.aircraft_id)) throw new HttpError(400, 'aircraft_id is required');
  const { aircraft, priced } = await priceForRequest({ request, aircraft_id: body.aircraft_id, ...parseAdjustment(body) });
  const c = await conflicts(aircraft.id, priced.starts_on, priced.ends_on);
  if (aircraft.status === 'inactive') priced.warnings.push('Aircraft is inactive');
  res.json({ ...priced, pax: request.pax, aircraft, conflicts: c });
});

// ── Create draft ────────────────────────────────────────────────────────────
router.post('/', requireRole('sales'), async (req, res) => {
  const body = req.body || {};
  const request = await loadRequest(body.request_id);
  if (!['open', 'quoted'].includes(request.status)) throw new HttpError(409, `Request is ${request.status}`);
  if (!isUuid(body.aircraft_id)) throw new HttpError(400, 'aircraft_id is required');
  const adj = parseAdjustment(body);
  const settings = await getSettings();
  const valid_hours = parseValidHours(body.valid_hours, settings.quote_validity_hours);
  const { aircraft, priced } = await priceForRequest({ request, aircraft_id: body.aircraft_id, ...adj });
  const id = await withTransaction(async (client) => {
    const quote_no = await nextNumber('Q', client);
    const { rows } = await client.query(
      `INSERT INTO quotes (quote_no, request_id, member_id, aircraft_id, legs, positioning, line_items, adjustment_inr, adjustment_note,
                           subtotal, gst_rate_pct, gst_amount, total, starts_on, ends_on, valid_hours, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [quote_no, request.id, request.member_id, aircraft.id, JSON.stringify(priced.legs), JSON.stringify(priced.positioning),
        JSON.stringify(priced.line_items), adj.adjustment_inr, adj.adjustment_note, priced.subtotal, priced.gst_rate_pct,
        priced.gst_amount, priced.total, priced.starts_on, priced.ends_on, valid_hours, req.user.id]);
    await logEvent({ entity_type: 'quote', entity_id: rows[0].id, action: 'created', actor_user_id: req.user.id, detail: { quote_no, total: priced.total } }, client);
    return rows[0].id;
  });
  const q = await loadQuote(id, req.user);
  res.status(201).json({ ...shapeQuote(q, req.user), warnings: priced.warnings, conflicts: await conflicts(aircraft.id, priced.starts_on, priced.ends_on) });
});

// ── Edit draft (re-price) ───────────────────────────────────────────────────
router.patch('/:id', requireRole('sales'), async (req, res) => {
  const q = await loadQuote(req.params.id, req.user);
  if (q.status !== 'draft') throw new HttpError(409, 'Only draft quotes can be edited');
  const body = req.body || {};
  const aircraft_id = body.aircraft_id !== undefined ? body.aircraft_id : q.aircraft_id;
  if (!isUuid(aircraft_id)) throw new HttpError(400, 'Invalid aircraft_id');
  const adj = {
    adjustment_inr: body.adjustment_inr !== undefined ? parseAdjustment(body).adjustment_inr : q.adjustment_inr,
    adjustment_note: body.adjustment_note !== undefined ? (body.adjustment_note || null) : q.adjustment_note,
  };
  let valid_hours = q.valid_hours;
  let valid_until = q.valid_until;
  if (body.valid_hours !== undefined) valid_hours = parseValidHours(body.valid_hours, q.valid_hours);
  if (body.valid_until !== undefined) {
    if (body.valid_until === null || body.valid_until === '') valid_until = null;
    else {
      const d = new Date(body.valid_until);
      if (isNaN(d)) throw new HttpError(400, 'valid_until must be an ISO timestamp');
      valid_until = d;
    }
  }
  const request = await loadRequest(q.request_id);
  const { aircraft, priced } = await priceForRequest({ request, aircraft_id, ...adj });
  await pool.query(
    `UPDATE quotes SET aircraft_id=$2, legs=$3, positioning=$4, line_items=$5, adjustment_inr=$6, adjustment_note=$7,
       subtotal=$8, gst_rate_pct=$9, gst_amount=$10, total=$11, starts_on=$12, ends_on=$13, valid_hours=$14, valid_until=$15
     WHERE id=$1 AND status='draft'`,
    [q.id, aircraft.id, JSON.stringify(priced.legs), JSON.stringify(priced.positioning), JSON.stringify(priced.line_items),
      adj.adjustment_inr, adj.adjustment_note, priced.subtotal, priced.gst_rate_pct, priced.gst_amount, priced.total,
      priced.starts_on, priced.ends_on, valid_hours, valid_until]);
  await logEvent({ entity_type: 'quote', entity_id: q.id, action: 'updated', actor_user_id: req.user.id, detail: { total: priced.total } });
  const updated = await loadQuote(q.id, req.user);
  res.json({ ...shapeQuote(updated, req.user), warnings: priced.warnings, conflicts: await conflicts(aircraft.id, priced.starts_on, priced.ends_on) });
});

// ── Send ────────────────────────────────────────────────────────────────────
router.post('/:id/send', requireRole('sales'), async (req, res) => {
  const q = await loadQuote(req.params.id, req.user);
  if (q.status !== 'draft') throw new HttpError(409, `Cannot send a quote that is ${q.status}`);
  const request = await loadRequest(q.request_id);
  if (!['open', 'quoted'].includes(request.status)) throw new HttpError(409, `Request is ${request.status}`);
  const settings = await getSettings();
  const valid_hours = parseValidHours(req.body?.valid_hours, q.valid_hours || settings.quote_validity_hours);
  // Re-price at send time so the member sees current rates/fees.
  const { aircraft, priced } = await priceForRequest({ request, aircraft_id: q.aircraft_id, adjustment_inr: q.adjustment_inr, adjustment_note: q.adjustment_note });
  await withTransaction(async (client) => {
    const upd = await client.query(
      `UPDATE quotes SET status='sent', sent_at=now(), valid_hours=$2,
         valid_until = COALESCE(CASE WHEN valid_until > now() THEN valid_until END, now() + make_interval(hours => $2)),
         legs=$3, positioning=$4, line_items=$5, subtotal=$6, gst_rate_pct=$7, gst_amount=$8, total=$9, starts_on=$10, ends_on=$11
       WHERE id=$1 AND status='draft' RETURNING id`,
      [q.id, valid_hours, JSON.stringify(priced.legs), JSON.stringify(priced.positioning), JSON.stringify(priced.line_items),
        priced.subtotal, priced.gst_rate_pct, priced.gst_amount, priced.total, priced.starts_on, priced.ends_on]);
    if (!upd.rows.length) throw new HttpError(409, 'Quote changed — reload and try again');
    const r = await client.query(`UPDATE quote_requests SET status='quoted' WHERE id=$1 AND status='open' RETURNING id`, [request.id]);
    if (r.rows.length) await logEvent({ entity_type: 'quote_request', entity_id: request.id, action: 'quoted', actor_user_id: req.user.id, detail: { quote_no: q.quote_no } }, client);
    await logEvent({ entity_type: 'quote', entity_id: q.id, action: 'sent', actor_user_id: req.user.id, detail: { total: priced.total } }, client);
  });
  const sent = await loadQuote(q.id, req.user);
  await sendQuoteSent({ to: sent.member_email, name: sent.member_name, quote: { ...sent, valid_until_display: fmtIST(sent.valid_until) }, request });
  res.json({ ...shapeQuote(sent, req.user), warnings: priced.warnings, conflicts: await conflicts(aircraft.id, priced.starts_on, priced.ends_on) });
});

// ── Withdraw ────────────────────────────────────────────────────────────────
router.post('/:id/withdraw', requireRole('sales'), async (req, res) => {
  await expireStaleQuotes();
  const q = await loadQuote(req.params.id, req.user);
  if (!['draft', 'sent'].includes(q.status)) throw new HttpError(409, `Cannot withdraw a quote that is ${q.status}`);
  await pool.query(`UPDATE quotes SET status='withdrawn', decided_at=now() WHERE id=$1`, [q.id]);
  await logEvent({ entity_type: 'quote', entity_id: q.id, action: 'withdrawn', actor_user_id: req.user.id, detail: { reason: req.body?.reason || null } });
  res.json(shapeQuote(await loadQuote(q.id, req.user), req.user));
});

// ── List / get ──────────────────────────────────────────────────────────────
router.get('/', requireRole('member', 'sales', 'ops'), async (req, res) => {
  await expireStaleQuotes();
  const params = [];
  const where = [];
  if (req.user.role === 'member') {
    params.push(req.user.member_id); where.push(`q.member_id = $${params.length}`);
    where.push(`q.status <> 'draft'`, `NOT (q.status = 'withdrawn' AND q.sent_at IS NULL)`);
  } else if (req.query.member_id) {
    if (!isUuid(req.query.member_id)) throw new HttpError(400, 'Invalid member_id');
    params.push(req.query.member_id); where.push(`q.member_id = $${params.length}`);
  }
  if (req.query.status) { params.push(String(req.query.status)); where.push(`q.status = $${params.length}`); }
  if (req.query.request_id) {
    if (!isUuid(req.query.request_id)) throw new HttpError(400, 'Invalid request_id');
    params.push(req.query.request_id); where.push(`q.request_id = $${params.length}`);
  }
  const { rows } = await pool.query(`${QUOTE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY q.created_at DESC`, params);
  res.json(rows.map((q) => shapeQuote(q, req.user)));
});

router.get('/:id', requireRole('member', 'sales', 'ops'), async (req, res) => {
  await expireStaleQuotes();
  const q = await loadQuote(req.params.id, req.user);
  const body = shapeQuote(q, req.user);
  if (isStaff(req.user) && ['draft', 'sent'].includes(q.status)) body.conflicts = await conflicts(q.aircraft_id, q.starts_on, q.ends_on);
  res.json(body);
});

router.get('/:id/pdf', requireRole('member', 'sales', 'ops'), async (req, res) => {
  await expireStaleQuotes();
  const q = await loadQuote(req.params.id, req.user);
  const settings = await getSettings();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${q.quote_no}.pdf"`);
  quotePdf(shapeQuote(q, { role: 'member' }), settings, res);
});

// ── Accept (one transaction) ────────────────────────────────────────────────
router.post('/:id/accept', requireRole('member', 'sales'), async (req, res) => {
  await expireStaleQuotes();
  const q0 = await loadQuote(req.params.id, req.user);
  const settings = await getSettings();
  const result = await withTransaction(async (client) => {
    // Lock the quote row so two concurrent accepts cannot both succeed.
    const q = (await client.query('SELECT * FROM quotes WHERE id = $1 FOR UPDATE', [q0.id])).rows[0];
    if (q.status === 'sent' && q.valid_until && new Date(q.valid_until) < new Date()) {
      await client.query(`UPDATE quotes SET status='expired' WHERE id=$1`, [q.id]);
      await logEvent({ entity_type: 'quote', entity_id: q.id, action: 'expired', detail: {} }, client);
      return { expired: true };
    }
    if (q.status === 'expired') throw new HttpError(409, 'This quote has expired — contact sales for a new one');
    if (q.status !== 'sent') throw new HttpError(409, `Cannot accept a quote that is ${q.status}`);
    // Serialise acceptances per aircraft, then check availability.
    await client.query('SELECT id FROM aircraft WHERE id = $1 FOR UPDATE', [q.aircraft_id]);
    const ac = (await client.query('SELECT status FROM aircraft WHERE id = $1', [q.aircraft_id])).rows[0];
    const c = await conflicts(q.aircraft_id, q.starts_on, q.ends_on, null, client);
    if (c.length || ac.status === 'inactive') throw new HttpError(409, 'Aircraft no longer available for these dates — contact sales');
    const request = (await client.query('SELECT * FROM quote_requests WHERE id = $1 FOR UPDATE', [q.request_id])).rows[0];
    if (!['open', 'quoted'].includes(request.status)) throw new HttpError(409, `Request is ${request.status}`);

    await client.query(`UPDATE quotes SET status='accepted', decided_at=now() WHERE id=$1`, [q.id]);
    await logEvent({ entity_type: 'quote', entity_id: q.id, action: 'accepted', actor_user_id: req.user.id, detail: { by_role: req.user.role } }, client);
    const others = await client.query(
      `UPDATE quotes SET status='withdrawn', decided_at=now() WHERE request_id=$1 AND id<>$2 AND status IN ('sent','draft') RETURNING id`, [q.request_id, q.id]);
    for (const o of others.rows) await logEvent({ entity_type: 'quote', entity_id: o.id, action: 'withdrawn', actor_user_id: req.user.id, detail: { reason: 'another quote accepted' } }, client);
    await client.query(`UPDATE quote_requests SET status='closed' WHERE id=$1`, [q.request_id]);
    await logEvent({ entity_type: 'quote_request', entity_id: q.request_id, action: 'closed', actor_user_id: req.user.id, detail: { accepted_quote: q.quote_no } }, client);

    const charter_no = await nextNumber('CH', client);
    const charter = (await client.query(
      `INSERT INTO charters (charter_no, quote_id, member_id, aircraft_id, legs, starts_on, ends_on, pax, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'accepted') RETURNING *`,
      [charter_no, q.id, q.member_id, q.aircraft_id, JSON.stringify(q.legs), q.starts_on, q.ends_on, request.pax])).rows[0];
    await logEvent({ entity_type: 'charter', entity_id: charter.id, action: 'accepted', actor_user_id: req.user.id, detail: { charter_no, quote_no: q.quote_no } }, client);

    const invoice_no = await nextNumber('INV', client);
    const today = todayIST();
    const invoice = (await client.query(
      `INSERT INTO invoices (invoice_no, charter_id, member_id, subtotal, gst_rate_pct, gst_amount, total, issued_on, due_on, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unpaid') RETURNING *`,
      [invoice_no, charter.id, q.member_id, q.subtotal, q.gst_rate_pct, q.gst_amount, q.total, today, addDays(today, Number(settings.invoice_due_days) || 7)])).rows[0];
    await logEvent({ entity_type: 'invoice', entity_id: invoice.id, action: 'issued', actor_user_id: req.user.id, detail: { invoice_no, total: invoice.total } }, client);
    return { charter, invoice };
  });
  if (result.expired) throw new HttpError(409, 'This quote has expired — contact sales for a new one');
  await sendCharterAccepted({ to: q0.member_email, name: q0.member_name, charter: result.charter, invoice: result.invoice });
  res.json(result);
});

// ── Decline ─────────────────────────────────────────────────────────────────
router.post('/:id/decline', requireRole('member', 'sales'), async (req, res) => {
  await expireStaleQuotes();
  const q = await loadQuote(req.params.id, req.user);
  if (q.status !== 'sent') throw new HttpError(409, `Cannot decline a quote that is ${q.status}`);
  const reason = req.body?.reason ? String(req.body.reason).slice(0, 500) : null;
  const upd = await pool.query(`UPDATE quotes SET status='declined', decided_at=now(), decline_reason=$2 WHERE id=$1 AND status='sent' RETURNING id`, [q.id, reason]);
  if (!upd.rows.length) throw new HttpError(409, 'Quote changed — reload and try again');
  await logEvent({ entity_type: 'quote', entity_id: q.id, action: 'declined', actor_user_id: req.user.id, detail: { reason } });
  res.json(shapeQuote(await loadQuote(q.id, req.user), req.user));
});

module.exports = router;
module.exports.shapeQuote = shapeQuote;
module.exports.QUOTE_SELECT = QUOTE_SELECT;
