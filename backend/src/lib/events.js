const { pool } = require('../db');

/** Write an audit/timeline row. Pass a transaction client to keep it atomic with the change. */
async function logEvent({ entity_type, entity_id, action, actor_user_id = null, detail = null }, db = pool) {
  await db.query(
    'INSERT INTO events (entity_type, entity_id, action, actor_user_id, detail) VALUES ($1,$2,$3,$4,$5)',
    [entity_type, entity_id, action, actor_user_id, detail ? JSON.stringify(detail) : null]
  );
}

module.exports = { logEvent };
