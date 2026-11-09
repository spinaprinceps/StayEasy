// Bookings: list (feature 8), one booking, and cancel + refund (feature 9).
//
// Cancel rules (time rules + money rules):
//   - The deadline is 14:00 hotel time on the check-in date, minus 48 hours. It was worked out
//     ONCE, when the booking was made (bookings.cancel_deadline, a timestamptz = an exact moment),
//     so a later change to the hotel's time zone data can't move it.
//   - "Before the deadline?" is decided by the DATABASE clock (now()), like every other expiry.
//   - Refund = refundFor(frozen price, rate plan, before deadline) in pricing.js. Never a new quote.
//   - Once check-in time (14:00 on check-in day, hotel time) has passed, it can't be cancelled.
//   - Cancelling gives the room back (returnRooms), in the same transaction as the status change.
//   - The refund is QUEUED in that transaction and SENT after commit (see payments/refunds.js).
const { refundFor } = require('../pricing');
const { returnRooms } = require('../holds/returnRooms');
const { queueRefund, sendRefund } = require('../payments/refunds');

const result = (status, body) => ({ status, body });
const problem = (status, error, extra = {}) => result(status, { error, ...extra });

const BOOKING_VIEW_SQL = `
SELECT b.id, b.status, b.hold_id, b.payment_id, b.room_type_id, b.check_in, b.check_out, b.guests,
       b.rate_plan, b.price_breakdown, b.total_paise, b.cancel_deadline, b.refund_paise,
       b.cancelled_at, b.created_at,
       c.timezone, c.name AS city, ho.id AS hotel_id, ho.name AS hotel_name, rt.name AS room_name,
       -- the deadline as the HOTEL's wall clock, for display ("Mon 7 Dec, 14:00 Europe/London")
       to_char(b.cancel_deadline AT TIME ZONE c.timezone, 'YYYY-MM-DD"T"HH24:MI') AS cancel_deadline_local,
       now() < b.cancel_deadline AS before_deadline,
       now() >= ((b.check_in + time '14:00') AT TIME ZONE c.timezone) AS check_in_passed,
       r.status AS refund_status
FROM bookings b
JOIN room_types rt ON rt.id = b.room_type_id
JOIN hotels ho     ON ho.id = rt.hotel_id
JOIN cities c      ON c.id = ho.city_id
LEFT JOIN refunds r ON r.booking_id = b.id`;

function toBookingView(row) {
  const confirmed = row.status === 'confirmed';
  const canCancel = confirmed && !row.check_in_passed;
  return {
    bookingId: row.id,
    holdId: row.hold_id,
    status: row.status,
    hotel: { id: row.hotel_id, name: row.hotel_name, city: row.city, timezone: row.timezone },
    roomType: { id: row.room_type_id, name: row.room_name },
    checkIn: row.check_in,
    checkOut: row.check_out,
    guests: row.guests,
    ratePlan: row.rate_plan,
    price: row.price_breakdown,
    totalPaise: Number(row.total_paise),
    cancelDeadline: row.cancel_deadline,             // exact moment (UTC ISO in JSON)
    cancelDeadlineLocal: row.cancel_deadline_local,  // hotel wall clock, 'YYYY-MM-DDTHH:MM'
    beforeDeadline: row.before_deadline,
    canCancel,
    // What cancelling RIGHT NOW would give back (the server works it out; the page only shows it).
    refundIfCancelledNowPaise: canCancel ? refundFor(row.price_breakdown, row.rate_plan, row.before_deadline) : null,
    refundPaise: row.refund_paise === null ? null : Number(row.refund_paise),
    refundStatus: row.refund_status,                 // null | 'pending' | 'succeeded'
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
  };
}

async function listBookings(db, userId) {
  // Upcoming confirmed first (soonest first), then everything else, newest first.
  const { rows } = await db.query(
    `${BOOKING_VIEW_SQL}
     WHERE b.user_id = $1
     ORDER BY (b.status = 'confirmed' AND b.check_out >= current_date) DESC,
              CASE WHEN b.status = 'confirmed' AND b.check_out >= current_date THEN b.check_in END ASC,
              b.check_in DESC
     LIMIT 200`,
    [userId],
  );
  return rows.map(toBookingView);
}

async function getBooking(db, userId, bookingId) {
  const { rows } = await db.query(`${BOOKING_VIEW_SQL} WHERE b.id = $1 AND b.user_id = $2`, [bookingId, userId]);
  return rows[0] ? toBookingView(rows[0]) : null;
}

async function cancelBooking(pool, { userId, bookingId }) {
  let refundId = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [b] } = await client.query(
      `SELECT b.id, b.status, b.payment_id, b.room_type_id, b.check_in, b.check_out, b.rate_plan, b.price_breakdown,
              now() < b.cancel_deadline AS before_deadline,
              now() >= ((b.check_in + time '14:00') AT TIME ZONE c.timezone) AS check_in_passed
       FROM bookings b
       JOIN room_types rt ON rt.id = b.room_type_id
       JOIN hotels ho     ON ho.id = rt.hotel_id
       JOIN cities c      ON c.id = ho.city_id
       WHERE b.id = $1 AND b.user_id = $2
       FOR UPDATE OF b`,
      [bookingId, userId],
    );
    if (!b) {
      await client.query('ROLLBACK');
      return problem(404, 'Booking not found');
    }
    // Already cancelled (double click, retry): same answer again, nothing new happens.
    if (b.status === 'cancelled') {
      await client.query('ROLLBACK');
      return result(200, await getBooking(pool, userId, bookingId));
    }
    if (b.check_in_passed) {
      await client.query('ROLLBACK');
      return problem(409, 'Check-in time has passed; this booking can no longer be cancelled', { reason: 'too_late' });
    }

    const refundPaise = refundFor(b.price_breakdown, b.rate_plan, b.before_deadline);
    await client.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = now(), refund_paise = $2 WHERE id = $1`,
      [b.id, refundPaise],
    );
    await returnRooms(client, [b]);
    if (refundPaise > 0) {
      refundId = await queueRefund(client, { paymentId: b.payment_id, bookingId: b.id, amountPaise: refundPaise, reason: 'cancelled' });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // After commit: the cancellation stands even if the gateway is down right now.
  if (refundId) {
    await sendRefund(pool, refundId).catch((err) => console.error(`cancel booking ${bookingId}: refund not sent yet:`, err.message));
  }
  return result(200, await getBooking(pool, userId, bookingId));
}

module.exports = { listBookings, getBooking, cancelBooking, toBookingView };
