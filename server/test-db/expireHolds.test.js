// The expiry worker against the real database. Run:  npm run test:db
// Every row this file changes is put back in after().
//
// Holds are inserted straight into the table (not through POST /holds) so we can set
// expires_at in the past and the status we want. Before each test, available_count is set
// to "what it would be after those holds took their rooms", so expiry should restore it.
//
// Note: expireHolds() is global. before() runs it once to clear any expired holds already
// in your dev DB (exactly what the real worker would do), so the counts below are ours alone.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const pool = require('../src/db/pool');
const { expireHolds } = require('../src/holds/expireHolds');

let userId, roomTypeId, nights, originalCounts;

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function setAvailable(counts) {
  for (let i = 0; i < nights.length; i++) {
    await pool.query('UPDATE room_nights SET available_count = $1 WHERE room_type_id = $2 AND night = $3',
      [counts[i], roomTypeId, nights[i]]);
  }
}
async function available() {
  const { rows } = await pool.query(
    'SELECT available_count FROM room_nights WHERE room_type_id = $1 AND night = ANY($2::date[]) ORDER BY night',
    [roomTypeId, nights]);
  return rows.map((r) => r.available_count);
}

// Insert a hold for nights[from] .. nights[to - 1]. `expiresIn` is SQL interval text: '-1 minute' = already expired.
async function insertHold(from, to, { status = 'active', expiresIn = '-1 minute' } = {}) {
  const { rows: [h] } = await pool.query(
    `INSERT INTO holds (user_id, idempotency_key, request_hash, room_type_id, check_in, check_out,
                        guests, rate_plan, price_breakdown, total_paise, status, expires_at)
     VALUES ($1, $2, 'test', $3, $4, $5, 1, 'flexible', '{}', 100, $6, now() + $7::interval)
     RETURNING id`,
    [userId, crypto.randomUUID(), roomTypeId, nights[from], addDays(nights[to - 1], 1), status, expiresIn]);
  return h.id;
}
const statusOf = async (id) => (await pool.query('SELECT status FROM holds WHERE id = $1', [id])).rows[0].status;

before(async () => {
  const { rows: [u] } = await pool.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [`expire-test-${crypto.randomUUID()}@test.local`, 'not-a-real-hash']);
  userId = u.id;

  // Three consecutive nights ~250 days out (holds.test.js uses ~200: no overlap).
  const { rows: [pick] } = await pool.query(`
    SELECT rn.room_type_id, rn.night FROM room_nights rn
    WHERE rn.night = current_date + 250
      AND EXISTS (SELECT 1 FROM room_nights x WHERE x.room_type_id = rn.room_type_id AND x.night = current_date + 252)
    ORDER BY rn.room_type_id LIMIT 1`);
  roomTypeId = pick.room_type_id;
  nights = [pick.night, addDays(pick.night, 1), addDays(pick.night, 2)];
  originalCounts = await available();

  while ((await expireHolds(pool)) > 0); // clear any backlog that isn't ours
});

beforeEach(() => pool.query('DELETE FROM holds WHERE user_id = $1', [userId]));

after(async () => {
  await pool.query('DELETE FROM holds WHERE user_id = $1', [userId]);
  await setAvailable(originalCounts);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

test('an expired active hold -> expired, and +1 on EVERY night of the stay', async () => {
  await setAvailable([4, 4, 4]);
  const id = await insertHold(0, 3);

  assert.equal(await expireHolds(pool), 1);
  assert.equal(await statusOf(id), 'expired');
  assert.deepEqual(await available(), [5, 5, 5]);
});

test('a hold that has not expired yet is untouched', async () => {
  await setAvailable([4, 4, 4]);
  const id = await insertHold(0, 3, { expiresIn: '1 minute' });

  assert.equal(await expireHolds(pool), 0);
  assert.equal(await statusOf(id), 'active');
  assert.deepEqual(await available(), [4, 4, 4]);
});

test('an expired payment_pending hold is untouched (the reconciler owns it)', async () => {
  await setAvailable([4, 4, 4]);
  const id = await insertHold(0, 3, { status: 'payment_pending' });

  assert.equal(await expireHolds(pool), 0);
  assert.equal(await statusOf(id), 'payment_pending');
  assert.deepEqual(await available(), [4, 4, 4]);
});

test('4 workers at once, small batches: every hold expired once, rooms given back once', async () => {
  // 10 one-night holds on night 0, 10 three-night holds: night 0 had 20 taken, nights 1-2 had 10.
  await setAvailable([0, 10, 10]);
  for (let i = 0; i < 10; i++) await insertHold(0, 1);
  for (let i = 0; i < 10; i++) await insertHold(0, 3);

  // Each "worker" keeps ticking until it finds nothing it can claim.
  const worker = async () => { let total = 0, n; while ((n = await expireHolds(pool, { limit: 3 })) > 0) total += n; return total; };
  const totals = await Promise.all([worker(), worker(), worker(), worker()]);

  assert.equal(totals.reduce((a, b) => a + b, 0), 20, `per worker: ${totals}`);
  assert.deepEqual(await available(), [20, 20, 20]);
  const { rows: [c] } = await pool.query(
    "SELECT count(*) FILTER (WHERE status = 'expired') AS expired, count(*) AS all FROM holds WHERE user_id = $1", [userId]);
  assert.equal(Number(c.expired), 20);
  assert.equal(Number(c.all), 20);
});

test('running it twice in a row: the second run does nothing', async () => {
  await setAvailable([4, 4, 4]);
  await insertHold(0, 2);

  assert.equal(await expireHolds(pool), 1);
  assert.equal(await expireHolds(pool), 0);
  assert.deepEqual(await available(), [5, 5, 4]);
});
