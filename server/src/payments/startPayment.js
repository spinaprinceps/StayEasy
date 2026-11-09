// POST /holds/:id/pay  ->  { paymentId, checkoutUrl }   (the browser then goes to checkoutUrl)
//
// THE RULE: one hold is paid for at most once, and a request to the gateway is never sent in
// a way that could charge twice.
//
// Steps:
//   1. Transaction: lock the hold. Decide:
//        active + time left   -> hold 'payment_pending' + NEW payments row ('creating', fresh gateway_key)
//        payment_pending      -> reuse the open payment (double click, back button, retry after error)
//        converted            -> 409 already paid
//        expired / time up    -> 409 expired
//      COMMIT. The request key (gateway_key) is now SAVED before any network call.
//   2. No transaction: if the payment has no checkout URL yet, ask the gateway to create the
//      intent, with gateway_key as the Idempotency-Key. Asking twice returns the same intent.
//   3. Save intent_id + checkout_url, only if the payment is still 'creating'.
//
// Why 'payment_pending' at step 1 (before the gateway even answers): from that moment the
// expiry worker leaves the hold alone. Otherwise a guest paying at 9:59 could lose the room
// at 10:00 while their bank is still saying yes.
const crypto = require('crypto');
const gateway = require('./gatewayClient');
const { paymentReference } = require('./applyIntent');

const result = (status, body) => ({ status, body });
const problem = (status, error, extra = {}) => result(status, { error, ...extra });
const appUrl = () => process.env.APP_URL || 'http://localhost:5173';

async function startPayment(pool, { userId, holdId }) {
  // ---- 1. decide, in a short transaction ----
  let payment;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [hold] } = await client.query(
      `SELECT h.id, h.status, h.total_paise, h.expires_at > now() AS time_left, b.id AS booking_id
       FROM holds h LEFT JOIN bookings b ON b.hold_id = h.id
       WHERE h.id = $1 AND h.user_id = $2
       FOR UPDATE OF h`,
      [holdId, userId],
    );
    if (!hold) {
      await client.query('ROLLBACK');
      return problem(404, 'Hold not found');
    }
    if (hold.status === 'converted') {
      await client.query('ROLLBACK');
      return problem(409, 'This hold is already paid for', { reason: 'already_paid', bookingId: hold.booking_id });
    }

    if (hold.status === 'payment_pending') {
      ({ rows: [payment] } = await client.query(
        `SELECT * FROM payments WHERE hold_id = $1 AND status IN ('creating', 'pending')`, [holdId]));
    } else if (hold.status === 'active' && hold.time_left) {
      await client.query(`UPDATE holds SET status = 'payment_pending', updated_at = now() WHERE id = $1`, [holdId]);
      ({ rows: [payment] } = await client.query(
        `INSERT INTO payments (hold_id, amount_paise, gateway_key) VALUES ($1, $2, $3) RETURNING *`,
        [holdId, hold.total_paise, `pay-${crypto.randomUUID()}`]));
    }
    if (!payment) {
      await client.query('ROLLBACK');
      return problem(409, 'This hold has expired. Please reserve again.', { reason: 'expired' });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (payment.checkout_url) return result(200, { paymentId: payment.id, checkoutUrl: payment.checkout_url });

  // ---- 2. talk to the gateway, outside any transaction ----
  let intent;
  try {
    intent = await gateway.createIntent({
      key: payment.gateway_key,
      amountPaise: Number(payment.amount_paise), // the FROZEN total from the hold, never recalculated
      reference: paymentReference(payment.id),
      returnUrl: `${appUrl()}/holds/${holdId}`,
    });
  } catch (err) {
    if (err instanceof gateway.GatewayError && err.retryable) {
      // We don't know if the intent exists. That's fine: the payment stays 'creating', the hold
      // stays ours, and the next Pay click (or the reconciler) asks again with the SAME key.
      console.error(`startPayment: hold ${holdId}, payment ${payment.id}:`, err.message);
      return problem(503, 'The payment provider is not responding. Your room is still held: press Pay again in a moment.', { reason: 'gateway_unavailable' });
    }
    throw err; // 4xx = our bug (bad amount, key reused with a different body): a real 500
  }

  // ---- 3. remember it ----
  //    'pending' is allowed too: a webhook or the reconciler may have seen the intent first.
  const { rowCount } = await pool.query(
    `UPDATE payments
     SET intent_id = $2, checkout_url = $3, status = 'pending', updated_at = now()
     WHERE id = $1 AND status IN ('creating', 'pending')`,
    [payment.id, intent.id, intent.checkoutUrl],
  );
  if (rowCount === 0) {
    // While we waited for the gateway, the reconciler already decided this payment (e.g. it
    // looked, found nothing yet, and gave up). Don't send the guest to pay a dead attempt:
    // cancel the intent we just made. If it somehow gets paid anyway, applyIntent refunds it.
    gateway.cancelIntent(intent.id).catch((err) => console.error('startPayment: cancel stale intent:', err.message));
    return problem(409, 'This payment attempt has already finished. Refresh the page and press Pay again.', { reason: 'payment_finished' });
  }
  return result(200, { paymentId: payment.id, checkoutUrl: intent.checkoutUrl });
}

module.exports = { startPayment };
