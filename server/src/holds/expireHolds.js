// Feature 5 (hold, then pay). One "tick" of the expiry worker.
//
// THE RULE: for every room_type + night,
//   available_count + (ACTIVE or PAYMENT_PENDING holds covering that night) == the rooms we started with.
// So when a hold leaves 'active' by expiring, its rooms must come back on EVERY night, EXACTLY once.
//
// How each danger is handled (numbers match the steps below):
//   crash between the two changes ...... all steps in ONE transaction: status and rooms change together or not at all
//   two workers, same hold ............. step 1: FOR UPDATE SKIP LOCKED, so each worker takes a different batch
//   pay and expiry at the same moment .. step 1: only rows still 'active' AND expires_at < now() (DB clock)
//   payment_pending holds .............. step 1: never matched; the reconciler owns them (feature 7)
//   two holds share a night ............ step 2: GROUP BY, so that night gets +2 in one update
//   deadlock with Reserve / 2 workers .. step 3: lock room_nights in (room_type_id, night) order, as Reserve does
//   a night row has gone missing ....... step 4: count check, throw -> ROLLBACK -> nothing half-done
//   huge backlog ....................... LIMIT: short transactions; the worker loops while batches come back full
//
// expireHolds(db, { limit }) -> Promise<number>   how many holds this tick expired

const pool = require('../db/pool');

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
       RETURNING h.id`,
      [limit],
    );
    if (expired.length === 0) {
      await client.query('COMMIT');
      return 0;
    }
    const ids = expired.map((r) => r.id);

    // 2. Which nights get how many rooms back? One row per (room type, night).
    //    check_out is NOT a night you stay: nights are check_in .. check_out - 1.
    //    Plain date + integer arithmetic: no time zones, no timestamps.
    const { rows: give } = await client.query(
      `SELECT h.room_type_id, h.check_in + i AS night, count(*)::int AS rooms
       FROM holds h
       CROSS JOIN LATERAL generate_series(0, h.check_out - h.check_in - 1) AS i
       WHERE h.id = ANY($1::int[])
       GROUP BY 1, 2
       ORDER BY 1, 2`,
      [ids],
    );
    const typeIds = give.map((g) => g.room_type_id);
    const nights = give.map((g) => g.night);
    const rooms = give.map((g) => g.rooms);

    // 3. Lock those night rows in a fixed order (room type, then night). Reserve locks one
    //    room type's nights in night order, so the two can never wait on each other in a circle.
    await client.query(
      `SELECT 1 FROM room_nights rn
       JOIN unnest($1::int[], $2::date[]) AS g(room_type_id, night)
         ON rn.room_type_id = g.room_type_id AND rn.night = g.night
       ORDER BY rn.room_type_id, rn.night
       FOR UPDATE OF rn`,
      [typeIds, nights],
    );

    // 4. Give the rooms back. Every (room type, night) must exist; if not, undo everything.
    const { rowCount } = await client.query(
      `UPDATE room_nights rn
       SET available_count = rn.available_count + g.rooms
       FROM unnest($1::int[], $2::date[], $3::int[]) AS g(room_type_id, night, rooms)
       WHERE rn.room_type_id = g.room_type_id AND rn.night = g.night`,
      [typeIds, nights, rooms],
    );
    if (rowCount !== give.length) {
      throw new Error(`expireHolds: ${give.length} night rows expected, ${rowCount} found (holds ${ids.join(',')})`);
    }

    await client.query('COMMIT');
    return ids.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {}); // the connection may already be dead
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { expireHolds };
