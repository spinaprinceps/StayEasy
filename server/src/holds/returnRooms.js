// Give one room back on every night of each stay. Used by: hold expiry (feature 5), a payment
// that fails after the hold's time ran out (feature 7) and booking cancellation (feature 9).
// Call it INSIDE the caller's transaction, after changing the hold/booking status, so the
// status change and the rooms coming back commit together or not at all.
//
// stays: [{ room_type_id, check_in, check_out }]   (check_out is not a night you stay)
async function returnRooms(client, stays) {
  if (stays.length === 0) return;

  // Which nights get how many rooms back? One row per (room type, night): two stays sharing
  // a night give +2 in one update. Plain date + integer arithmetic: no time zones involved.
  const { rows: give } = await client.query(
    `SELECT s.room_type_id, s.check_in + i AS night, count(*)::int AS rooms
     FROM unnest($1::int[], $2::date[], $3::date[]) AS s(room_type_id, check_in, check_out)
     CROSS JOIN LATERAL generate_series(0, s.check_out - s.check_in - 1) AS i
     GROUP BY 1, 2
     ORDER BY 1, 2`,
    [stays.map((s) => s.room_type_id), stays.map((s) => s.check_in), stays.map((s) => s.check_out)],
  );
  const typeIds = give.map((g) => g.room_type_id);
  const nights = give.map((g) => g.night);
  const rooms = give.map((g) => g.rooms);

  // Lock in a fixed order (room type, then night). Reserve locks one room type's nights in
  // night order, so nobody can wait on anybody else in a circle (no deadlock).
  await client.query(
    `SELECT 1 FROM room_nights rn
     JOIN unnest($1::int[], $2::date[]) AS g(room_type_id, night)
       ON rn.room_type_id = g.room_type_id AND rn.night = g.night
     ORDER BY rn.room_type_id, rn.night
     FOR UPDATE OF rn`,
    [typeIds, nights],
  );

  const { rowCount } = await client.query(
    `UPDATE room_nights rn
     SET available_count = rn.available_count + g.rooms
     FROM unnest($1::int[], $2::date[], $3::int[]) AS g(room_type_id, night, rooms)
     WHERE rn.room_type_id = g.room_type_id AND rn.night = g.night`,
    [typeIds, nights, rooms],
  );
  // Every night must exist. If not, throw: the caller's ROLLBACK undoes the status change too.
  if (rowCount !== give.length) {
    throw new Error(`returnRooms: ${give.length} night rows expected, ${rowCount} found`);
  }
}

module.exports = { returnRooms };
