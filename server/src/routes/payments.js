// POST /payments/webhook   (called by the GATEWAY, not by a browser: no login, a signature instead)
//   -> 200 accepted (including duplicates and events we don't care about)
//   -> 400 bad signature / not JSON          (the gateway will retry; a real one would alert)
//   -> 500 our fault                         (the gateway retries later: that's what we want)
//
// Mounted BEFORE express.json() in app.js: the signature is over the raw bytes, so the body
// must reach us exactly as sent.
const express = require('express');
const pool = require('../db/pool');
const { verifySignature } = require('../payments/signature');
const { applyIntent } = require('../payments/applyIntent');
const { sendRefund } = require('../payments/refunds');

const router = express.Router();

router.post('/webhook', express.raw({ type: '*/*', limit: '100kb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!verifySignature(process.env.FAKEPAY_WEBHOOK_SECRET, raw, req.get('fakepay-signature'))) {
    return res.status(400).json({ error: 'Invalid or expired signature' });
  }
  let event;
  try { event = JSON.parse(raw); } catch { return res.status(400).json({ error: 'Body is not valid JSON' }); }
  if (typeof event?.id !== 'string' || typeof event?.type !== 'string' || typeof event?.data !== 'object') {
    return res.status(400).json({ error: 'Not an event' });
  }

  let result = { outcome: 'ignored_type' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The inbox: the event id is the PRIMARY KEY. A duplicate (retry, or the gateway sending
    // twice) inserts nothing, and we answer 200 so the gateway stops retrying.
    // If two copies arrive at the same instant, the second INSERT waits for the first to commit.
    const fresh = await client.query(
      `INSERT INTO webhook_events (event_id, type, payload) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING`,
      [event.id, event.type, event],
    );
    if (fresh.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.json({ received: true, duplicate: true });
    }
    // Same transaction as the inbox row: if applying fails, the event isn't marked as seen,
    // we answer 500, and the gateway's retry gets a clean second chance.
    if (event.type.startsWith('payment_intent.')) result = await applyIntent(client, event.data);
    await client.query('UPDATE webhook_events SET outcome = $2 WHERE event_id = $1', [event.id, result.outcome]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // A late payment owes money back: try now; the reconciler retries if the gateway is down.
  if (result.refundId) sendRefund(pool, result.refundId).catch((err) => console.error('webhook refund:', err.message));
  res.json({ received: true, outcome: result.outcome });
});

module.exports = router;
