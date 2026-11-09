// Reserve: take one room on every night of the stay and keep it for this traveller for
// HOLD_MINUTES at a frozen price.
//
// THE RULE: for every room type and night, rooms held + booked never exceed the rooms that
// exist, i.e. available_count never goes below 0, and a hold takes a room on EVERY night or NONE.
//
// How each danger is handled (numbers match the steps in createHold below):
//   two people, last room ......... step 6: check-and-take in ONE UPDATE (... AND available_count > 0)
//   some nights free, some not .... steps 5+6: count rows; wrong count -> ROLLBACK undoes everything
//   overlapping stays deadlock .... step 5: lock the nights in date order first (ORDER BY night FOR UPDATE)
//   double-click / retry .......... steps 1+3: same Idempotency-Key -> replay the saved hold
//   same key, same instant ........ step 3: advisory lock on the key + UNIQUE(user_id, idempotency_key)
//   price changes mid-checkout .... step 7: price comes from the rows we hold locked, saved on the hold
//   clocks on different servers ... step 8: expires_at uses the DATABASE clock (now())
const crypto = require('crypto');
const { quoteStay } = require('../pricing');
const { checkDatesForCity } = require('../search/validate');

const HOLD_MINUTES = 10;

// Shape of a result: the route sends { status, body } as-is.
const result = (status, body, headers = {}) => ({ status, body, headers });
const problem = (status, error, extra = {}) => result(status, { error, ...extra });

// Fingerprint of WHAT was asked. Fixed field order, so the same request always hashes the same.
function requestHash(r) {
  const canonical = JSON.stringify([r.roomTypeId, r.checkIn, r.checkOut, r.guests, r.ratePlan]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// One query used for every read of a hold, so every response has the same shape.
// seconds_left is worked out by the DATABASE clock, so the browser's (possibly wrong)
// clock never decides how long the user has.
const HOLD_VIEW_SQL = `
SELECT h.id, h.user_id, h.request_hash, h.status, h.expires_at, h.room_type_id,
       h.check_in, h.check_out, h.guests, h.rate_plan, h.price_breakdown, h.total_paise,
       rt.name  AS room_name,
       ho.id    AS hotel_id,
       ho.name  AS hotel_name,
       greatest(0, ceil(extract(epoch FROM h.expires_at - now())))::int AS seconds_left,
       bk.id AS booking_id,
       lp.status AS payment_status, lp.failure_reason AS payment_failure
FROM holds h
JOIN room_types rt ON rt.id = h.room_type_id
JOIN hotels ho     ON ho.id = rt.hotel_id
LEFT JOIN bookings bk ON bk.hold_id = h.id
-- the latest payment attempt, if any (a declined card, then a retry = two attempts)
LEFT JOIN LATERAL (
  SELECT status, failure_reason FROM payments WHERE hold_id = h.id ORDER BY id DESC LIMIT 1
) lp ON true`;

function toHoldView(row) {
  return {
    holdId: row.id,
    // expires_at decides, not the worker: between expiry and the next worker tick the row
    // still says 'active', but the hold is already dead.
    status: row.status === 'active' && row.seconds_left === 0 ? 'expired' : row.status,
    expiresAt: row.expires_at,
    secondsLeft: row.status === 'active' ? row.seconds_left : 0,
    hotel: { id: row.hotel_id, name: row.hotel_name },
    roomType: { id: row.room_type_id, name: row.room_name },
    checkIn: row.check_in,
    checkOut: row.check_out,
    guests: row.guests,
    ratePlan: row.rate_plan,
    price: row.price_breakdown,
    payment: row.payment_status ? { status: row.payment_status, failureReason: row.payment_failure } : null,
    bookingId: row.booking_id ?? null,
  };
}

async function findHoldByKey(db, userId, key) {
  const { rows } = await db.query(`${HOLD_VIEW_SQL} WHERE h.user_id = $1 AND h.idempotency_key = $2`, [userId, key]);
  return rows[0] ?? null;
}

async function findHoldById(db, userId, holdId) {
  // user_id in the WHERE: someone else's hold is "not found", not "forbidden",
  // so you can't probe which hold ids exist.
  const { rows } = await db.query(`${HOLD_VIEW_SQL} WHERE h.id = $1 AND h.user_id = $2`, [holdId, userId]);
  return rows[0] ?? null;
}

// The request was already handled: send back the same hold, or refuse if the key was reused.
function replay(row, hash) {
  if (row.request_hash !== hash) {
    return problem(422, 'This Idempotency-Key was already used for a different request. Use a new key.');
  }
  return result(201, toHoldView(row), { 'Idempotent-Replayed': 'true' });
}

// req: { roomTypeId, checkIn, checkOut, nights, guests, ratePlan } (already shape-checked by the route)
async function createHold(pool, { userId, key, req }) {
  const hash = requestHash(req);

  // 1. Fast path for plain retries: already done? Replay it.
  //    Comes BEFORE the date checks: a retry sent just after midnight must still get its hold back.
  const earlier = await findHoldByKey(pool, userId, key);
  if (earlier) return replay(earlier, hash);

  // 2. Checks that don't need locks: do them OUTSIDE the transaction to keep it short.
  const { rows: rtRows } = await pool.query(
    `SELECT rt.id, rt.max_guests, c.timezone
     FROM room_types rt JOIN hotels h ON h.id = rt.hotel_id JOIN cities c ON c.id = h.city_id
     WHERE rt.id = $1`,
    [req.roomTypeId]
  );
  const roomType = rtRows[0];
  if (!roomType) return problem(404, 'Room type not found');
  if (req.guests > roomType.max_guests) {
    return result(400, { errors: [{ field: 'guests', message: `this room sleeps at most ${roomType.max_guests}` }] });
  }
  const dateErrors = checkDatesForCity(req, roomType.timezone);
  if (dateErrors.length) return result(400, { errors: dateErrors });

  // A transaction must run on ONE connection. pool.query() could send BEGIN and UPDATE
  // down two different connections, and then there is no transaction at all.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 3. Only one request per (user, key) gets past this line at a time.
    //    Advisory lock = a lock on a NAME rather than a row; released automatically at COMMIT/ROLLBACK.
    //    Without it, two identical requests racing for the LAST room go wrong: the first takes
    //    the room, the second finds 0 left and says "sold out", when it should replay the first's hold.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`hold:${userId}:${key}`]);
    const twin = await findHoldByKey(client, userId, key);
    if (twin) {
      await client.query('ROLLBACK');
      return replay(twin, hash);
    }

    // 4+5. Lock every night of the stay, ALWAYS in date order, and read the prices.
    //      Same order for everyone -> two overlapping stays can't each hold a night the other wants.
    const { rows: nights } = await client.query(
      `SELECT night, price_paise FROM room_nights
       WHERE room_type_id = $1 AND night >= $2 AND night < $3
       ORDER BY night
       FOR UPDATE`,
      [req.roomTypeId, req.checkIn, req.checkOut]
    );
    if (nights.length !== req.nights) {
      await client.query('ROLLBACK');
      return problem(409, 'This room is not on sale for all of those nights', { reason: 'not_on_sale' });
    }

    // 6. Check-and-take in one statement. Every night must change, or none do.
    const taken = await client.query(
      `UPDATE room_nights SET available_count = available_count - 1
       WHERE room_type_id = $1 AND night >= $2 AND night < $3 AND available_count > 0`,
      [req.roomTypeId, req.checkIn, req.checkOut]
    );
    if (taken.rowCount !== req.nights) {
      await client.query('ROLLBACK'); // puts back the nights that DID change
      return problem(409, 'Sorry, this room just sold out for at least one of your nights', { reason: 'sold_out' });
    }

    // 7. Freeze the price from the rows we hold locked (nobody can change them until we commit).
    const quote = quoteStay(nights.map((n) => Number(n.price_paise))); // bigint arrives as a string
    const rate = req.ratePlan === 'flexible' ? quote.flexible : quote.nonRefundable;

    // 8. Save the hold. expires_at from the DATABASE clock.
    const { rows: [inserted] } = await client.query(
      `INSERT INTO holds (user_id, idempotency_key, request_hash, room_type_id, check_in, check_out,
                          guests, rate_plan, price_breakdown, total_paise, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(mins => $11))
       RETURNING id`,
      [userId, key, hash, req.roomTypeId, req.checkIn, req.checkOut,
        req.guests, req.ratePlan, rate, rate.totalPaise, HOLD_MINUTES]
    );
    const { rows: [saved] } = await client.query(`${HOLD_VIEW_SQL} WHERE h.id = $1`, [inserted.id]);

    await client.query('COMMIT');
    return result(201, toHoldView(saved));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {}); // the connection may already be broken
    // Safety net: the advisory lock should make this impossible, but if two inserts with
    // the same key ever race, the UNIQUE constraint stops the second. Replay the first.
    if (err.code === '23505') {
      const first = await findHoldByKey(pool, userId, key);
      if (first) return replay(first, hash);
    }
    // 40P01 = deadlock. Locking in date order should prevent it; if it happens anyway,
    // nothing was taken (rolled back), so it's safe to tell the user to try again.
    if (err.code === '40P01') return problem(409, 'Busy right now, please try again', { reason: 'retry' });
    throw err;
  } finally {
    client.release(); // forget this and the pool runs dry after 10 requests
  }
}

module.exports = { createHold, findHoldById, toHoldView, requestHash, HOLD_MINUTES };
