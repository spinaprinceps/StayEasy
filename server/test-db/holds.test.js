// Reserve under real concurrency, against the real database.
// Needs Postgres running (docker compose up postgres). Run:  npm run test:db
//
// Kept OUT of test/ on purpose: `npm test` must work with no database.
// Every row this file changes is put back in after(): it's safe on your dev database.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const app = require('../src/app');
const pool = require('../src/db/pool');
const { hashPassword, issueToken } = require('../src/auth');

let server, base, token, userId;
let roomTypeId, maxGuests, nights;   // 3 consecutive nights we control
let originalCounts;                   // to put them back afterwards

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function hold(body, { key = crypto.randomUUID(), auth = token } = {}) {
  return fetch(`${base}/holds`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify(body),
  });
}

const stay = (from, to, extra = {}) => ({
  roomTypeId, checkIn: nights[from], checkOut: addDays(nights[to - 1], 1), guests: 1, ratePlan: 'flexible', ...extra,
});

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
const holdCount = async () =>
  Number((await pool.query('SELECT count(*) FROM holds WHERE user_id = $1', [userId])).rows[0].count);
const clearHolds = () => pool.query('DELETE FROM holds WHERE user_id = $1', [userId]);

before(async () => {
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;

  // A throwaway traveller. Token issued directly: no need to go through the login rate limiter.
  const email = `holds-test-${crypto.randomUUID()}@test.local`;
  const { rows: [u] } = await pool.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email, await hashPassword('x-password-1')]);
  userId = u.id;
  token = issueToken(userId);

  // Three consecutive nights ~200 days out (inside the 365-day booking window) of some room type.
  const { rows: [pick] } = await pool.query(`
    SELECT rn.room_type_id, rt.max_guests, rn.night
    FROM room_nights rn JOIN room_types rt ON rt.id = rn.room_type_id
    WHERE rn.night = current_date + 200
      AND EXISTS (SELECT 1 FROM room_nights x WHERE x.room_type_id = rn.room_type_id AND x.night = current_date + 202)
    ORDER BY rn.room_type_id LIMIT 1`);
  roomTypeId = pick.room_type_id;
  maxGuests = pick.max_guests;
  nights = [pick.night, addDays(pick.night, 1), addDays(pick.night, 2)];
  originalCounts = await available();
});

after(async () => {
  await clearHolds();
  await setAvailable(originalCounts);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  server.close();
  await pool.end();
});

test('50 people, last room: exactly 1 hold, 49 refused, never below 0', async () => {
  await clearHolds();
  await setAvailable([1, 5, 5]);

  const responses = await Promise.all(Array.from({ length: 50 }, () => hold(stay(0, 1))));
  const codes = responses.map((r) => r.status);

  assert.equal(codes.filter((c) => c === 201).length, 1, `codes: ${codes}`);
  assert.equal(codes.filter((c) => c === 409).length, 49, `codes: ${codes}`);
  assert.deepEqual(await available(), [0, 5, 5]);
  assert.equal(await holdCount(), 1);
});

test('all or nothing: middle night sold out -> 409 and the other nights untouched', async () => {
  await clearHolds();
  await setAvailable([3, 0, 3]);

  const r = await hold(stay(0, 3));
  assert.equal(r.status, 409);
  assert.equal((await r.json()).reason, 'sold_out');
  assert.deepEqual(await available(), [3, 0, 3]); // NOT [2, 0, 2]
  assert.equal(await holdCount(), 0);
});

test('overlapping stays at the same time: no deadlock, each night counted exactly', async () => {
  await clearHolds();
  await setAvailable([20, 20, 20]);

  // nights 0-1, 1-2 and 0-2, 10 of each, all at once: lots of chances to lock in opposite orders.
  // Night 1 is wanted by all three shapes: 30 people, 20 rooms. So some 409 "sold_out" are
  // CORRECT. What must never happen: a deadlock (reason "retry"), a crash (500), or the books
  // not balancing.
  const shapes = [[0, 2], [1, 3], [0, 3]];
  const reqs = shapes.flatMap(([a, b]) => Array.from({ length: 10 }, () => hold(stay(a, b))));
  const responses = await Promise.all(reqs);
  const outcomes = await Promise.all(responses.map(async (r) => (r.status === 201 ? 201 : `${r.status}:${(await r.json()).reason}`)));

  assert.ok(outcomes.every((o) => o === 201 || o === '409:sold_out'), `outcomes: ${outcomes}`);
  assert.equal(outcomes.filter((o) => o === 201).length, 20, 'night 1 sells out at exactly 20');

  // The books balance: for each night, rooms taken == holds covering that night.
  const { rows } = await pool.query(`
    SELECT n.night, count(h.id)::int AS holding
    FROM unnest($2::date[]) AS n(night)
    LEFT JOIN holds h ON h.user_id = $1 AND h.check_in <= n.night AND h.check_out > n.night
    GROUP BY n.night ORDER BY n.night`, [userId, nights]);
  const counts = await available();
  rows.forEach((r, i) => assert.equal(20 - counts[i], r.holding, `night ${r.night}`));
});

test('the same request 10 times at once (same key): ONE hold, one room taken, all get it back', async () => {
  await clearHolds();
  await setAvailable([1, 5, 5]); // last room: the dangerous case for a duplicate

  const key = crypto.randomUUID();
  const responses = await Promise.all(Array.from({ length: 10 }, () => hold(stay(0, 1), { key })));
  const bodies = await Promise.all(responses.map((r) => r.json()));

  assert.ok(responses.every((r) => r.status === 201), `codes: ${responses.map((r) => r.status)}`);
  assert.equal(new Set(bodies.map((b) => b.holdId)).size, 1, 'everyone got the same hold');
  assert.equal(responses.filter((r) => r.headers.get('idempotent-replayed') === 'true').length, 9);
  assert.equal(await holdCount(), 1);
  assert.deepEqual(await available(), [0, 5, 5]);
});

test('same key, different request -> 422, nothing taken', async () => {
  await clearHolds();
  await setAvailable([5, 5, 5]);
  const key = crypto.randomUUID();

  assert.equal((await hold(stay(0, 1), { key })).status, 201);
  const r = await hold(stay(0, 2), { key });
  assert.equal(r.status, 422);
  assert.deepEqual(await available(), [4, 5, 5]);
});

test('the price is frozen on the hold: a later price change does not touch it', async () => {
  await clearHolds();
  await setAvailable([5, 5, 5]);

  const created = await (await hold(stay(0, 2))).json();
  const { rows: [before] } = await pool.query(
    'SELECT price_paise FROM room_nights WHERE room_type_id = $1 AND night = $2', [roomTypeId, nights[0]]);
  await pool.query('UPDATE room_nights SET price_paise = price_paise * 2 WHERE room_type_id = $1 AND night = $2',
    [roomTypeId, nights[0]]);
  try {
    const again = await (await fetch(`${base}/holds/${created.holdId}`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.deepEqual(again.price, created.price);
    assert.equal(again.price.nights[0].pricePaise, Number(before.price_paise));
    assert.equal(again.checkIn, nights[0], 'dates come back as plain YYYY-MM-DD, not shifted by time zone');
  } finally {
    await pool.query('UPDATE room_nights SET price_paise = $3 WHERE room_type_id = $1 AND night = $2',
      [roomTypeId, nights[0], before.price_paise]);
  }
});

test('input checks: too many guests 400, no key 400, no token 401, unknown room type 404', async () => {
  await clearHolds();
  await setAvailable([5, 5, 5]);

  assert.equal((await hold(stay(0, 1, { guests: maxGuests + 1 }))).status, 400);
  assert.equal((await hold(stay(0, 1), { key: null })).status, 400);
  assert.equal((await hold(stay(0, 1), { auth: null })).status, 401);
  assert.equal((await hold(stay(0, 1, { roomTypeId: 2147483647 }))).status, 404);
  assert.deepEqual(await available(), [5, 5, 5], 'refused requests take nothing');
});

test("someone else's hold is 404, not 403", async () => {
  await clearHolds();
  await setAvailable([5, 5, 5]);
  const created = await (await hold(stay(0, 1))).json();
  const stranger = issueToken(2147483647);
  const r = await fetch(`${base}/holds/${created.holdId}`, { headers: { Authorization: `Bearer ${stranger}` } });
  assert.equal(r.status, 404);
});
