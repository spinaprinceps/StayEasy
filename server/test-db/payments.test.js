// Pay, webhook, reconciler, bookings and cancel+refund, end to end, against the real database.
// The real API and a real FakePay each run on a random port; FakePay sends its webhooks to the API.
// Run: npm run test:db. Every row this file changes is put back in after().
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

process.env.FAKEPAY_API_KEY ||= 'test-fakepay-api-key-0123456789';
process.env.FAKEPAY_WEBHOOK_SECRET ||= 'test-fakepay-webhook-secret-0123456789';

const app = require('../src/app');
const pool = require('../src/db/pool');
const { issueToken } = require('../src/auth');
const { createGateway, sign, DEFAULT_CHAOS } = require('../src/fakepay/gateway');
const { reconcile } = require('../src/payments/reconcile');
const { expireHolds } = require('../src/holds/expireHolds');

let api, apiBase, gw, gwServer, gwBase, token, userId, roomTypeId, nights, originalCounts;

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what = 'condition', ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(20);
  }
  assert.fail(`timed out waiting for: ${what}`);
}

// ---- talking to the API (as the logged-in guest) ----
function call(method, path, body, headers = {}) {
  return fetch(`${apiBase}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const json = async (resPromise) => (await resPromise).json();
const getHold = (id) => json(call('GET', `/holds/${id}`));
const getBooking = (id) => json(call('GET', `/bookings/${id}`));

async function reserve({ from = 0, to = 2, ratePlan = 'flexible' } = {}) {
  const r = await call('POST', '/holds', {
    roomTypeId, checkIn: nights[from], checkOut: addDays(nights[to - 1], 1), guests: 1, ratePlan,
  }, { 'Idempotency-Key': crypto.randomUUID() });
  assert.equal(r.status, 201, 'reserve');
  return r.json();
}
const pay = (holdId) => call('POST', `/holds/${holdId}/pay`);

// ---- talking to FakePay ----
const gwApi = (method, path, body) => fetch(`${gwBase}${path}`, {
  method,
  headers: { Authorization: `Bearer ${process.env.FAKEPAY_API_KEY}`, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}).then((r) => r.json());
const chaos = (settings) => gwApi('POST', '/_chaos', settings);
// What the payer does on the gateway's page.
const checkout = (checkoutUrl, outcome) => fetch(checkoutUrl, { method: 'POST', body: new URLSearchParams({ outcome }), redirect: 'manual' });

// ---- database helpers ----
async function setAvailable(counts) {
  for (let i = 0; i < nights.length; i++) {
    await pool.query('UPDATE room_nights SET available_count = $1 WHERE room_type_id = $2 AND night = $3', [counts[i], roomTypeId, nights[i]]);
  }
}
async function available() {
  const { rows } = await pool.query(
    'SELECT available_count FROM room_nights WHERE room_type_id = $1 AND night = ANY($2::date[]) ORDER BY night', [roomTypeId, nights]);
  return rows.map((r) => r.available_count);
}
const payments = async (holdId) => (await pool.query('SELECT * FROM payments WHERE hold_id = $1 ORDER BY id', [holdId])).rows;
const mine = (opts = {}) => reconcile(pool, { userId, staleAfterSec: 0, log: () => {}, ...opts });

// Reserve, pay, succeed at the gateway, wait for the webhook to make the booking.
async function book(opts) {
  const hold = await reserve(opts);
  const { checkoutUrl } = await json(pay(hold.holdId));
  await checkout(checkoutUrl, 'succeeded');
  await until(async () => (await getHold(hold.holdId)).status === 'converted', 'booking');
  return (await getHold(hold.holdId)).bookingId;
}

before(async () => {
  api = app.listen(0);
  apiBase = `http://localhost:${api.address().port}`;

  // FakePay needs its own URL (for checkoutUrl) before it is created: listen first, plug the app in after.
  let gwApp = (req, res) => res.end();
  gwServer = http.createServer((req, res) => gwApp(req, res)).listen(0);
  gwBase = `http://localhost:${gwServer.address().port}`;
  gw = createGateway({
    apiKey: process.env.FAKEPAY_API_KEY,
    webhookSecret: process.env.FAKEPAY_WEBHOOK_SECRET,
    webhookUrl: `${apiBase}/payments/webhook`,
    publicUrl: gwBase,
    retryDelaysMs: [50, 50],
    processingMs: 100,
    log: () => {},
  });
  gwApp = gw.app;
  process.env.FAKEPAY_URL = gwBase; // the API's gateway client now talks to THIS FakePay

  const { rows: [u] } = await pool.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [`pay-test-${crypto.randomUUID()}@test.local`, 'x']);
  userId = u.id;
  token = issueToken(userId);

  // Three nights ~300 days out (holds tests use ~200, expiry ~250).
  const { rows: [pick] } = await pool.query(`
    SELECT rn.room_type_id, rn.night FROM room_nights rn
    WHERE rn.night = current_date + 300
      AND EXISTS (SELECT 1 FROM room_nights x WHERE x.room_type_id = rn.room_type_id AND x.night = current_date + 302)
    ORDER BY rn.room_type_id LIMIT 1`);
  roomTypeId = pick.room_type_id;
  nights = [pick.night, addDays(pick.night, 1), addDays(pick.night, 2)];
  originalCounts = await available();
});

beforeEach(async () => {
  await chaos(DEFAULT_CHAOS);
  await setAvailable([5, 5, 5]);
});

after(async () => {
  gw.stop();
  await sleep(100); // let in-flight webhooks land before deleting what they point at
  const { rows: refs } = await pool.query(
    `SELECT 'payment_' || p.id AS ref FROM payments p JOIN holds h ON h.id = p.hold_id WHERE h.user_id = $1
     UNION ALL
     SELECT 'refund_' || r.id FROM refunds r JOIN payments p ON p.id = r.payment_id JOIN holds h ON h.id = p.hold_id WHERE h.user_id = $1`,
    [userId]);
  await pool.query(`DELETE FROM webhook_events WHERE payload->'data'->>'reference' = ANY($1)`, [refs.map((r) => r.ref)]);
  await pool.query('DELETE FROM refunds WHERE payment_id IN (SELECT p.id FROM payments p JOIN holds h ON h.id = p.hold_id WHERE h.user_id = $1)', [userId]);
  await pool.query('DELETE FROM bookings WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM payments WHERE hold_id IN (SELECT id FROM holds WHERE user_id = $1)', [userId]);
  await pool.query('DELETE FROM holds WHERE user_id = $1', [userId]);
  await setAvailable(originalCounts);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  api.close();
  gwServer.close();
  await pool.end();
});

// ---------------- Pay ----------------

test('happy path: pay -> webhook -> booking; the room stays taken (moved from hold to booking)', async () => {
  const hold = await reserve({ from: 0, to: 2 });
  assert.deepEqual(await available(), [4, 4, 5]);

  const r = await pay(hold.holdId);
  assert.equal(r.status, 200);
  const { checkoutUrl } = await r.json();
  assert.equal((await getHold(hold.holdId)).status, 'payment_pending');

  const back = await checkout(checkoutUrl, 'succeeded');
  assert.match(back.headers.get('location'), new RegExp(`/holds/${hold.holdId}\\?intent=pi_`));

  await until(async () => (await getHold(hold.holdId)).status === 'converted', 'converted');
  const { bookingId } = await getHold(hold.holdId);
  const booking = await getBooking(bookingId);
  assert.equal(booking.status, 'confirmed');
  assert.equal(booking.totalPaise, hold.price.totalPaise, 'charged the FROZEN price');
  assert.deepEqual(await available(), [4, 4, 5], 'paying does not touch inventory');

  const list = await json(call('GET', '/bookings'));
  assert.ok(list.data.some((b) => b.bookingId === bookingId));
});

test('double click on Pay: both get the same checkout page, ONE payment, ONE intent', async () => {
  const hold = await reserve();
  const [a, b] = await Promise.all([json(pay(hold.holdId)), json(pay(hold.holdId))]);
  assert.equal(a.checkoutUrl, b.checkoutUrl);
  const ps = await payments(hold.holdId);
  assert.equal(ps.length, 1);
  assert.equal((await gwApi('GET', `/payment_intents?reference=payment_${ps[0].id}`)).data.length, 1);
});

test('lost response (dropResponse): the retry with the SAME key gets the same intent, not a second one', async () => {
  await chaos({ dropResponse: 1 });
  const hold = await reserve();
  const r = await pay(hold.holdId);
  assert.equal(r.status, 200, 'first try created + lost; the retry replayed it');
  const [p] = await payments(hold.holdId);
  assert.equal((await gwApi('GET', `/payment_intents?reference=payment_${p.id}`)).data.length, 1);
});

test('gateway down (failCreate): 503, room still held; Pay again later works', async () => {
  await chaos({ failCreate: 1 });
  const hold = await reserve();
  const r = await pay(hold.holdId);
  assert.equal(r.status, 503);
  assert.equal((await getHold(hold.holdId)).status, 'payment_pending', 'the expiry worker must leave it alone');
  assert.equal((await payments(hold.holdId))[0].status, 'creating');

  await chaos({ failCreate: 0 });
  const again = await pay(hold.holdId);
  assert.equal(again.status, 200);
  assert.equal((await payments(hold.holdId)).length, 1, 'same attempt, same key');
});

test('gateway down and the guest gives up: the reconciler finds no intent -> hold back to active', async () => {
  await chaos({ failCreate: 1 });
  const hold = await reserve();
  await pay(hold.holdId);
  await chaos({ failCreate: 0 });

  const s = await mine();
  assert.equal(s.changed, 1);
  const h = await getHold(hold.holdId);
  assert.equal(h.status, 'active');
  assert.equal(h.payment.status, 'failed');
  assert.equal(h.payment.failureReason, 'not_found_at_gateway');
});

test('card declined: hold back to active (time left), pay again with a NEW attempt, then booked', async () => {
  const hold = await reserve();
  const first = await json(pay(hold.holdId));
  await checkout(first.checkoutUrl, 'failed');
  await until(async () => (await getHold(hold.holdId)).status === 'active', 'reopened');
  assert.equal((await getHold(hold.holdId)).payment.failureReason, 'card_declined');

  const second = await json(pay(hold.holdId));
  assert.notEqual(second.checkoutUrl, first.checkoutUrl);
  await checkout(second.checkoutUrl, 'succeeded');
  await until(async () => (await getHold(hold.holdId)).status === 'converted', 'converted');
  assert.deepEqual((await payments(hold.holdId)).map((p) => p.status), ['failed', 'succeeded']);
});

test('declined AFTER the hold time ran out: hold expired and rooms given back', async () => {
  const hold = await reserve({ from: 0, to: 3 });
  const { checkoutUrl } = await json(pay(hold.holdId));
  await pool.query(`UPDATE holds SET expires_at = now() - interval '1 minute' WHERE id = $1`, [hold.holdId]);
  assert.equal(await expireHolds(pool), 0, 'payment_pending: the worker must NOT touch it');

  await checkout(checkoutUrl, 'failed');
  await until(async () => (await getHold(hold.holdId)).status === 'expired', 'expired');
  assert.deepEqual(await available(), [5, 5, 5]);
});

test('webhook lost (dropWebhook): the reconciler asks the gateway and books it', async () => {
  await chaos({ dropWebhook: 1 });
  const hold = await reserve();
  await checkout((await json(pay(hold.holdId))).checkoutUrl, 'succeeded');
  await sleep(100);
  assert.equal((await getHold(hold.holdId)).status, 'payment_pending', 'no webhook, no news');

  await mine();
  const h = await getHold(hold.holdId);
  assert.equal(h.status, 'converted');
  assert.ok(h.bookingId);
});

test('webhook sent twice (duplicateWebhook): processed once, one booking', async () => {
  await chaos({ duplicateWebhook: 1 });
  const hold = await reserve();
  const { checkoutUrl } = await json(pay(hold.holdId));
  await checkout(checkoutUrl, 'succeeded');
  await until(async () => {
    const { data } = await gwApi('GET', '/_deliveries');
    const [p] = await payments(hold.holdId);
    return data.filter((d) => d.objectId === p.intent_id && d.type === 'payment_intent.succeeded' && d.result === 200).length === 2;
  }, 'two deliveries');
  const { rows } = await pool.query('SELECT count(*) FROM bookings WHERE hold_id = $1', [hold.holdId]);
  assert.equal(Number(rows[0].count), 1);
});

test('bank is slow (processing): waits, then books when it succeeds', async () => {
  const hold = await reserve();
  await checkout((await json(pay(hold.holdId))).checkoutUrl, 'processing');
  await sleep(30);
  assert.equal((await getHold(hold.holdId)).status, 'payment_pending');
  await until(async () => (await getHold(hold.holdId)).status === 'converted', 'converted after processing');
});

test('abandoned at the checkout page: reconciler cancels the intent, hold expires, rooms back', async () => {
  const hold = await reserve({ from: 0, to: 3 });
  const { checkoutUrl } = await json(pay(hold.holdId));
  await pool.query(`UPDATE holds SET expires_at = now() - interval '1 minute' WHERE id = $1`, [hold.holdId]);

  await mine({ abandonAfterSec: 0 });
  assert.equal((await getHold(hold.holdId)).status, 'expired');
  assert.deepEqual(await available(), [5, 5, 5]);
  const [p] = await payments(hold.holdId);
  assert.equal((await gwApi('GET', `/payment_intents/${p.intent_id}`)).status, 'canceled');

  await checkout(checkoutUrl, 'succeeded'); // too late: the gateway refuses
  assert.equal((await gwApi('GET', `/payment_intents/${p.intent_id}`)).status, 'canceled');
});

test('money arrives for a payment we had given up on: no booking, automatic refund', async () => {
  const hold = await reserve();
  const { checkoutUrl } = await json(pay(hold.holdId));
  // Pretend we gave up on it (as the reconciler does when it can't find the intent in time).
  await pool.query(`UPDATE payments SET status = 'failed' WHERE hold_id = $1`, [hold.holdId]);
  await pool.query(`UPDATE holds SET status = 'active', expires_at = now() - interval '1 minute' WHERE id = $1`, [hold.holdId]);
  await expireHolds(pool);

  await checkout(checkoutUrl, 'succeeded'); // ...but the guest pays anyway
  const [p] = await payments(hold.holdId);
  await until(async () => (await pool.query(`SELECT status FROM refunds WHERE payment_id = $1`, [p.id])).rows[0]?.status === 'succeeded', 'refund sent');
  assert.equal((await getHold(hold.holdId)).bookingId, null);
  const intent = await gwApi('GET', `/payment_intents/${p.intent_id}`);
  assert.equal(intent.amountRefundedPaise, intent.amountPaise, 'all of it back');
});

test('cannot pay an expired hold', async () => {
  const hold = await reserve();
  await pool.query(`UPDATE holds SET expires_at = now() - interval '1 second' WHERE id = $1`, [hold.holdId]);
  const r = await pay(hold.holdId);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).reason, 'expired');
});

test('webhook with a bad or old signature is refused', async () => {
  const body = JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type: 'payment_intent.succeeded', data: {} });
  const post = (signature) => fetch(`${apiBase}/payments/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'FakePay-Signature': signature }, body,
  });
  assert.equal((await post('t=1,v1=00')).status, 400);
  assert.equal((await post(sign('wrong-secret-0123456789', body))).status, 400);
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.equal((await post(sign(process.env.FAKEPAY_WEBHOOK_SECRET, body, old))).status, 400);
});

// ---------------- Bookings: cancel + refund ----------------

test('cancel before the deadline: full refund from the frozen price, rooms back, twice = same answer', async () => {
  const bookingId = await book({ from: 0, to: 2 });
  assert.deepEqual(await available(), [4, 4, 5]);
  const before = await getBooking(bookingId);
  assert.equal(before.beforeDeadline, true);
  assert.equal(before.refundIfCancelledNowPaise, before.totalPaise);
  // 14:00 hotel time, 48h before check-in: two days earlier, 14:00 (13:00/15:00 across a DST change)
  assert.match(before.cancelDeadlineLocal, new RegExp(`^${addDays(before.checkIn, -2)}T1[345]:00$`));

  const r = await call('POST', `/bookings/${bookingId}/cancel`);
  assert.equal(r.status, 200);
  const cancelled = await r.json();
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.refundPaise, before.totalPaise);
  assert.equal(cancelled.refundStatus, 'succeeded');
  assert.deepEqual(await available(), [5, 5, 5]);

  const again = await json(call('POST', `/bookings/${bookingId}/cancel`));
  assert.equal(again.refundPaise, before.totalPaise);
  assert.deepEqual(await available(), [5, 5, 5], 'rooms given back once');
  const { rows } = await pool.query('SELECT count(*) FROM refunds WHERE booking_id = $1', [bookingId]);
  assert.equal(Number(rows[0].count), 1);
});

test('cancel after the deadline: refund = total minus the first night (room + its tax)', async () => {
  const bookingId = await book({ from: 0, to: 3 });
  await pool.query(`UPDATE bookings SET cancel_deadline = now() - interval '1 minute' WHERE id = $1`, [bookingId]);
  const b = await getBooking(bookingId);
  const first = b.price.nights[0];
  const expected = b.totalPaise - first.pricePaise - first.taxPaise;
  assert.equal(b.refundIfCancelledNowPaise, expected);
  const cancelled = await json(call('POST', `/bookings/${bookingId}/cancel`));
  assert.equal(cancelled.refundPaise, expected);
});

test('non-refundable: cancel gives the room back but no money', async () => {
  const bookingId = await book({ from: 0, to: 1, ratePlan: 'non_refundable' });
  const cancelled = await json(call('POST', `/bookings/${bookingId}/cancel`));
  assert.equal(cancelled.refundPaise, 0);
  assert.equal(cancelled.refundStatus, null, 'no refund row at all');
  assert.deepEqual(await available(), [5, 5, 5]);
});

test('refund while the gateway is down: cancellation stands, refund pending, reconciler sends it once', async () => {
  const bookingId = await book({ from: 0, to: 1 });
  await chaos({ failCreate: 1 });
  const cancelled = await json(call('POST', `/bookings/${bookingId}/cancel`));
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.refundStatus, 'pending');

  await chaos({ failCreate: 0 });
  const s = await mine();
  assert.equal(s.refundsSent, 1);
  assert.equal((await getBooking(bookingId)).refundStatus, 'succeeded');
});

test("someone else's booking is 404", async () => {
  const bookingId = await book({ from: 0, to: 1 });
  const stranger = issueToken(2147483647);
  const r = await fetch(`${apiBase}/bookings/${bookingId}`, { headers: { Authorization: `Bearer ${stranger}` } });
  assert.equal(r.status, 404);
  const c = await fetch(`${apiBase}/bookings/${bookingId}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${stranger}` } });
  assert.equal(c.status, 404);
});
