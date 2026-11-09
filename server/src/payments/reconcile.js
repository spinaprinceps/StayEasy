// The reconciler: webhooks are a hint, the gateway's GET is the truth. Every tick:
//
//   A. Unfinished payments that haven't changed for `staleAfterSec`: ASK the gateway.
//        creating, no intent id ... look it up by reference (the create response may have been lost)
//                                   nothing there -> it was never created -> failed
//        pending ................... GET the intent
//                                   404 (gateway forgot it) -> failed
//                                   still unpaid after `abandonAfterSec` -> CANCEL it at the gateway.
//                                   Cancel answers with the final state, which may be 'succeeded'
//                                   (the guest paid a second before): then we book, not cancel.
//        then applyIntent() with whatever the gateway said: the same code the webhook runs.
//   B. Refunds still 'pending' (the gateway was down when we tried): send again, same key.
//
// A slow or broken gateway never blocks the database: every gateway call is outside a
// transaction, and each payment is handled on its own (one failure doesn't stop the rest).
const gateway = require('./gatewayClient');
const { applyIntent, paymentReference } = require('./applyIntent');
const { sendRefund } = require('./refunds');

async function inTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// What the gateway says about one of our payments, as an intent-shaped object.
async function askGateway(p, { abandonAfterSec }) {
  const reference = paymentReference(p.id);
  const amountPaise = Number(p.amount_paise);
  const notThere = { id: p.intent_id, status: 'failed', failureReason: 'not_found_at_gateway', reference, amountPaise, currency: 'INR' };

  let intent;
  if (p.intent_id) {
    intent = await gateway.getIntent(p.intent_id);
  } else {
    const found = await gateway.findIntentsByReference(reference);
    intent = found[0] ?? null;
  }
  if (!intent) return notThere;

  if (intent.status === 'requires_payment' && p.age_sec >= abandonAfterSec) {
    intent = await gateway.cancelIntent(intent.id); // may come back 'succeeded': that's the point
  }
  return intent;
}

// Options are for tests and the demo: shorter waits, and userId to touch only one user's rows.
async function reconcile(pool, { staleAfterSec = 60, abandonAfterSec = 15 * 60, limit = 50, userId = null, log = console.log } = {}) {
  const summary = { checked: 0, changed: 0, refundsSent: 0, errors: 0 };

  // ---- A. payments ----
  const { rows: open } = await pool.query(
    `SELECT p.id, p.intent_id, p.status, p.amount_paise,
            extract(epoch FROM now() - p.created_at)::int AS age_sec
     FROM payments p JOIN holds h ON h.id = p.hold_id
     WHERE p.status IN ('creating', 'pending')
       AND p.updated_at <= now() - make_interval(secs => $1)
       AND ($3::int IS NULL OR h.user_id = $3)
     ORDER BY p.updated_at
     LIMIT $2`,
    [staleAfterSec, limit, userId],
  );

  for (const p of open) {
    summary.checked++;
    try {
      const intent = await askGateway(p, { abandonAfterSec });
      const { outcome, refundId } = await inTransaction(pool, (c) => applyIntent(c, intent));
      if (outcome === 'waiting') {
        // Nothing new: push it to the back of the queue so we ask again in staleAfterSec, not every tick.
        await pool.query(`UPDATE payments SET updated_at = now() WHERE id = $1 AND status IN ('creating', 'pending')`, [p.id]);
      } else {
        summary.changed++;
        log(`[reconcile] payment ${p.id}: ${outcome}`);
      }
      if (refundId) await sendRefund(pool, refundId).catch(() => {}); // part B retries if this fails
    } catch (err) {
      summary.errors++;
      log(`[reconcile] payment ${p.id} failed: ${err.message}`);
    }
  }

  // ---- B. refunds ----
  const { rows: pending } = await pool.query(
    `SELECT r.id FROM refunds r JOIN payments p ON p.id = r.payment_id JOIN holds h ON h.id = p.hold_id
     WHERE r.status = 'pending'
       AND r.updated_at <= now() - make_interval(secs => $1)
       AND ($3::int IS NULL OR h.user_id = $3)
     ORDER BY r.updated_at
     LIMIT $2`,
    [staleAfterSec, limit, userId],
  );
  for (const r of pending) {
    try {
      if ((await sendRefund(pool, r.id)) === 'succeeded') {
        summary.refundsSent++;
        log(`[reconcile] refund ${r.id} sent`);
      }
    } catch (err) {
      summary.errors++;
      await pool.query('UPDATE refunds SET updated_at = now() WHERE id = $1', [r.id]); // back of the queue
      log(`[reconcile] refund ${r.id} failed: ${err.message}`);
    }
  }

  return summary;
}

module.exports = { reconcile, inTransaction };
