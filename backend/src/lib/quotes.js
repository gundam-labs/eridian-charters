const { pool, getSettings } = require('../db');
const { priceQuote } = require('./pricing');
const { HttpError } = require('./http');

/** Mark sent quotes past valid_until as expired (lazy evaluation) and log events. */
async function expireStaleQuotes(db = pool) {
  const { rows } = await db.query(
    `UPDATE quotes SET status = 'expired' WHERE status = 'sent' AND valid_until IS NOT NULL AND valid_until < now() RETURNING id, quote_no`
  );
  for (const q of rows) {
    await db.query(`INSERT INTO events (entity_type, entity_id, action, detail) VALUES ('quote', $1, 'expired', $2)`, [q.id, JSON.stringify({ quote_no: q.quote_no })]);
  }
  return rows.length;
}

/** Load request + aircraft + airports + settings and run the pure pricing function. */
async function priceForRequest({ request, aircraft_id, adjustment_inr = 0, adjustment_note = null }, db = pool) {
  const ac = (await db.query('SELECT * FROM aircraft WHERE id = $1', [aircraft_id])).rows[0];
  if (!ac) throw new HttpError(400, 'Unknown aircraft');
  const airports = (await db.query('SELECT * FROM airports')).rows;
  const settings = await getSettings(db);
  const priced = priceQuote({ legs: request.legs, aircraft: ac, airports, settings, adjustment_inr, adjustment_note, pax: request.pax });
  return { aircraft: ac, priced };
}

module.exports = { expireStaleQuotes, priceForRequest };
