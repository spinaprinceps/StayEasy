// Feature 5 (hold, then pay). One "tick" of the expiry worker.
//
// THE RULE: for every room_type + night,
//   available_count + (ACTIVE or PAYMENT_PENDING holds covering that night) + bookings == rooms that exist.
// So when a hold leaves 'active' by expiring, its rooms must come back on EVERY night, EXACTLY once.
//
// How each danger is handled:
//   crash between the two changes ...... ONE transaction: status and rooms change together or not at all
//   two workers, same hold ............. step 1: FOR UPDATE SKIP LOCKED, so each worker takes a different batch
//   pay and expiry at the same moment .. step 1: only rows still 'active' AND expires_at < now() (DB clock)
//   payment_pending holds .............. step 1: never matched; the payment flow / reconciler owns them
//   deadlocks, missing nights .......... step 2: returnRooms locks in a fixed order and checks the row count
//   huge backlog ....................... LIMIT: short transactions; the worker loops while batches come back full
//
// expireHolds(db, { limit }) -> Promise<number>   how many holds this tick expired

const pool = require('../db/pool');
const { returnRooms } = require('./returnRooms');

async function expireHolds(db = pool, { limit = 100 } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Claim a batch of expired holds and mark them, in one statement.
    //    FOR UPDATE    = lock these hold rows until COMMIT.
    //    SKIP LOCKED   = if another worker already locked a row, skip it instead of waiting.
    //    status='active' again in the UPDATE: belt and braces. Only rows this statement
    //    actually changed come back in RETURNING, and only those get rooms back.
    const { rows: expired } = await client.query(
      `WITH due AS (
         SELECT id FROM holds
         WHERE status = 'active' AND expires_at < now()
         ORDER BY expires_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE holds h
       SET status = 'expired', updated_at = now()
       FROM due
       WHERE h.id = due.id AND h.status = 'active'
       RETURNING h.id, h.room_type_id, h.check_in, h.check_out`,
      [limit],
    );

    // 2. Give their rooms back (same transaction).
    await returnRooms(client, expired);

    await client.query('COMMIT');
    return expired.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {}); // the connection may already be dead
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { expireHolds };
