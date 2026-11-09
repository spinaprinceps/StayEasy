// THE one place a payment's outcome changes our data. Both the webhook and the reconciler
// call it with "what the gateway says the intent looks like now", so they can never disagree
// about what a status means.
//
// Call it INSIDE a transaction. It locks the hold, then the payment: the same order Pay
// uses, so the two can't deadlock.
//
// What it does, by the gateway's status:
//   requires_payment / processing  -> nothing yet (remember the intent id if we didn't have it)
//   succeeded                      -> payment succeeded; hold 'converted'; a booking is created
//                                     ... unless the hold is no longer waiting for THIS payment:
//                                     then the money is not ours to keep -> queue a refund
//   failed / canceled              -> payment failed; hold back to 'active' if time is left,
//                                     otherwise 'expired' and its rooms go back
//
// Safe to call any number of times with the same or OLDER news:
//   - a payment already succeeded/failed is never changed again (except failed -> money arrived anyway)
//   - the booking INSERT has ON CONFLICT (hold_id) DO NOTHING
const { returnRooms } = require('../holds/returnRooms');
const { queueRefund } = require('./refunds');

const paymentReference = (paymentId) => `payment_${paymentId}`;
const parseReference = (ref) => {
  const m = /^payment_(\d{1,10})$/.exec(ref ?? '');
  return m ? Number(m[1]) : null;
};

const BOOKING_FROM_HOLD_SQL = `
INSERT INTO bookings (hold_id, payment_id, user_id, room_type_id, check_in, check_out, guests,
                      rate_plan, price_breakdown, total_paise, cancel_deadline)
SELECT h.id, $2, h.user_id, h.room_type_id, h.check_in, h.check_out, h.guests,
       h.rate_plan, h.price_breakdown, h.total_paise,
       -- 14:00 on the check-in date AT THE HOTEL, as a real moment in time, minus 48 hours.
       -- (date + time) is a wall-clock time with no zone; AT TIME ZONE says whose wall clock.
       ((h.check_in + time '14:00') AT TIME ZONE c.timezone) - interval '48 hours'
FROM holds h
JOIN room_types rt ON rt.id = h.room_type_id
JOIN hotels ho     ON ho.id = rt.hotel_id
JOIN cities c      ON c.id = ho.city_id
WHERE h.id = $1
ON CONFLICT (hold_id) DO NOTHING
RETURNING id`;

// intent: { id, status, amountPaise, currency, reference, failureReason? }
// Returns { outcome, bookingId?, refundId? }. outcome is a short word for logs and webhook_events.
async function applyIntent(client, intent) {
  const paymentId = parseReference(intent?.reference);
  if (!paymentId) return { outcome: 'ignored_not_ours' };

  const { rows: [found] } = await client.query('SELECT hold_id FROM payments WHERE id = $1', [paymentId]);
  if (!found) return { outcome: 'ignored_unknown_payment' };

  // Lock order: hold, then payment.
  const { rows: [hold] } = await client.query(
    `SELECT id, status, room_type_id, check_in, check_out, expires_at > now() AS time_left
     FROM holds WHERE id = $1 FOR UPDATE`,
    [found.hold_id],
  );
  const { rows: [payment] } = await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);

  if (intent.id && payment.intent_id && payment.intent_id !== intent.id) return { outcome: 'ignored_other_intent' };
  // Never trust an amount we didn't ask for. A mismatch is a bug or tampering: don't book on it.
  if (intent.amountPaise !== Number(payment.amount_paise) || intent.currency !== 'INR') {
    console.error(`applyIntent: payment ${paymentId} amount mismatch (ours ${payment.amount_paise}, gateway ${intent.amountPaise} ${intent.currency})`);
    return { outcome: 'ignored_amount_mismatch' };
  }
  if (payment.status === 'succeeded') return { outcome: 'no_change' };

  const wasOpen = payment.status === 'creating' || payment.status === 'pending';
  // First time we learn the intent id (the create response was lost, or the webhook beat it).
  if (intent.id && !payment.intent_id) {
    await client.query('UPDATE payments SET intent_id = $2, updated_at = now() WHERE id = $1', [paymentId, intent.id]);
  }

  switch (intent.status) {
    case 'requires_payment':
    case 'processing':
      if (payment.status === 'creating') {
        await client.query(`UPDATE payments SET status = 'pending', updated_at = now() WHERE id = $1`, [paymentId]);
      }
      return { outcome: 'waiting' };

    case 'succeeded': {
      await client.query(`UPDATE payments SET status = 'succeeded', failure_reason = NULL, updated_at = now() WHERE id = $1`, [paymentId]);
      // The hold must still be waiting for THIS payment. wasOpen + payment_pending means it is:
      // only one open payment per hold can exist (unique index).
      if (wasOpen && hold.status === 'payment_pending') {
        await client.query(`UPDATE holds SET status = 'converted', updated_at = now() WHERE id = $1`, [hold.id]);
        const { rows: [b] } = await client.query(BOOKING_FROM_HOLD_SQL, [hold.id, paymentId]);
        return { outcome: 'booked', bookingId: b?.id ?? null };
      }
      // Money arrived for a hold we had already let go. Keeping it with no room = a stolen payment.
      const refundId = await queueRefund(client, { paymentId, amountPaise: Number(payment.amount_paise), reason: 'late_payment' });
      return { outcome: 'refund_queued_late_payment', refundId };
    }

    case 'failed':
    case 'canceled': {
      if (!wasOpen) return { outcome: 'no_change' };
      await client.query(
        `UPDATE payments SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1`,
        [paymentId, intent.failureReason ?? intent.status],
      );
      if (hold.status !== 'payment_pending') return { outcome: 'payment_failed' };
      if (hold.time_left) {
        // Card declined with time left: the guest can try again, room still theirs.
        await client.query(`UPDATE holds SET status = 'active', updated_at = now() WHERE id = $1`, [hold.id]);
        return { outcome: 'hold_reopened' };
      }
      // Time ran out while paying: the expiry worker skipped this hold (payment_pending), so do its job here.
      await client.query(`UPDATE holds SET status = 'expired', updated_at = now() WHERE id = $1`, [hold.id]);
      await returnRooms(client, [hold]);
      return { outcome: 'hold_released' };
    }

    default:
      return { outcome: `ignored_status_${intent.status}` };
  }
}

module.exports = { applyIntent, paymentReference, parseReference };
