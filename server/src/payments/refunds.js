// Money going back to the guest. Two steps, on purpose:
//   1. queueRefund(): INSIDE the transaction that decides a refund is owed (cancel, late payment),
//      write a 'pending' refunds row. The decision and the debt commit together.
//   2. sendRefund(): AFTER commit, ask the gateway. If that fails (gateway down, timeout), the row
//      stays 'pending' and the reconciler tries again later with the SAME key, so the guest is
//      refunded exactly once however many tries it takes.
// Never call the gateway inside a transaction: a slow gateway would hold row locks for seconds.
const gateway = require('./gatewayClient');

// One refund per payment (UNIQUE payment_id), so the key can be derived from the payment.
async function queueRefund(client, { paymentId, bookingId = null, amountPaise, reason }) {
  const { rows } = await client.query(
    `INSERT INTO refunds (payment_id, booking_id, amount_paise, reason, gateway_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (payment_id) DO NOTHING
     RETURNING id`,
    [paymentId, bookingId, amountPaise, reason, `refund-payment-${paymentId}`],
  );
  return rows[0]?.id ?? null;
}

// Returns the refund's status afterwards. Throws GatewayError if the gateway can't be reached.
async function sendRefund(db, refundId) {
  const { rows: [r] } = await db.query(
    `SELECT r.id, r.status, r.amount_paise, r.gateway_key, p.intent_id
     FROM refunds r JOIN payments p ON p.id = r.payment_id
     WHERE r.id = $1`,
    [refundId],
  );
  if (!r) return null;
  if (r.status !== 'pending') return r.status;

  const refund = await gateway.createRefund({
    key: r.gateway_key,
    paymentIntentId: r.intent_id,
    amountPaise: Number(r.amount_paise), // bigint arrives as a string
    reference: `refund_${r.id}`,
  });
  await db.query(
    `UPDATE refunds SET status = 'succeeded', gateway_refund_id = $2, updated_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [r.id, refund.id],
  );
  return 'succeeded';
}

module.exports = { queueRefund, sendRefund };
