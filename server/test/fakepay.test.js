// FakePay on its own: no database. A real HTTP gateway on a random port, plus a tiny
// "merchant" server that records the webhooks it receives and answers with whatever
// status codes the test asks for. Run just this file: node --test test/fakepay.test.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const { createGateway, sign, DEFAULT_CHAOS } = require('../src/fakepay/gateway');

const API_KEY = 'test-api-key-0123456789';
const SECRET = 'test-webhook-secret-0123456789';

let gw, gwServer, base, merchant, received, replies;

// The merchant answers webhooks with replies.shift() (default 200) and records each one.
before(async () => {
  const m = express();
  m.post('/webhook', express.text({ type: '*/*' }), (req, res) => {
    received.push({ raw: req.body, signature: req.get('fakepay-signature'), event: JSON.parse(req.body) });
    res.sendStatus(replies.shift() ?? 200);
  });
  merchant = m.listen(0);

  gw = createGateway({
    apiKey: API_KEY,
    webhookSecret: SECRET,
    webhookUrl: `http://localhost:${merchant.address().port}/webhook`,
    publicUrl: 'http://fakepay.test',
    retryDelaysMs: [20, 20],     // 3 attempts in total, fast
    processingMs: 50,
    log: () => {},
  });
  gwServer = gw.app.listen(0);
  base = `http://localhost:${gwServer.address().port}`;
});

after(() => { gw.stop(); gwServer.close(); merchant.close(); });

beforeEach(async () => {
  received = [];
  replies = [];
  await api('POST', '/_chaos', DEFAULT_CHAOS); // every test starts with chaos off
});

function api(method, path, body, { key, auth = API_KEY } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const intentBody = (extra = {}) => ({ amountPaise: 1_234_500, currency: 'INR', reference: `hold_${crypto.randomUUID()}`, ...extra });
const create = (body = intentBody(), key = crypto.randomUUID()) => api('POST', '/payment_intents', body, { key });
const pay = (id, outcome) => fetch(`${base}/checkout/${id}`, {
  method: 'POST', body: new URLSearchParams({ outcome }), redirect: 'manual',
});
async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('condition not met in time');
}

test('create: needs the API key, an Idempotency-Key and a valid body', async () => {
  assert.equal((await api('POST', '/payment_intents', intentBody(), { key: crypto.randomUUID(), auth: 'wrong' })).status, 401);
  assert.equal((await api('POST', '/payment_intents', intentBody())).status, 400, 'no key');
  assert.equal((await create(intentBody({ amountPaise: 12.5 }))).status, 400, 'paise must be whole');
  assert.equal((await create(intentBody({ currency: 'USD' }))).status, 400);

  const r = await create(intentBody({ returnUrl: 'http://localhost:5173/holds/7' }));
  assert.equal(r.status, 201);
  const i = await r.json();
  assert.match(i.id, /^pi_/);
  assert.equal(i.status, 'requires_payment');
  assert.equal(i.checkoutUrl, `http://fakepay.test/checkout/${i.id}`);
});

test('same Idempotency-Key: same intent back; different body: 422', async () => {
  const key = crypto.randomUUID();
  const body = intentBody();
  const first = await (await create(body, key)).json();
  const again = await create(body, key);
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.equal((await again.json()).id, first.id);
  assert.equal((await create({ ...body, amountPaise: 1 }, key)).status, 422);
});

test('pay -> succeeded, redirect back, and a correctly signed webhook', async () => {
  const i = await (await create(intentBody({ returnUrl: 'http://localhost:5173/holds/7' }))).json();
  const r = await pay(i.id, 'succeeded');
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), `http://localhost:5173/holds/7?intent=${i.id}`);

  await until(() => received.length === 1);
  const { raw, signature, event } = received[0];
  assert.equal(event.type, 'payment_intent.succeeded');
  assert.equal(event.data.id, i.id);
  assert.equal(event.data.amountPaise, 1_234_500);
  const t = Number(/t=(\d+)/.exec(signature)[1]);
  assert.equal(signature, sign(SECRET, raw, t), 'HMAC over `${t}.${rawBody}`');

  assert.equal((await (await api('GET', `/payment_intents/${i.id}`)).json()).status, 'succeeded');
});

test('a final intent never changes: decline after success does nothing', async () => {
  const i = await (await create()).json();
  await pay(i.id, 'succeeded');
  await pay(i.id, 'failed');
  assert.equal((await (await api('GET', `/payment_intents/${i.id}`)).json()).status, 'succeeded');
  await until(() => received.length === 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(received.length, 1, 'no second event');
});

test('webhook retried until 2xx: 500, 500, then 200 = three deliveries of the SAME event', async () => {
  replies = [500, 500];
  const i = await (await create()).json();
  await pay(i.id, 'failed');
  await until(() => received.length === 3);
  assert.equal(new Set(received.map((d) => d.event.id)).size, 1);
  assert.equal(received[0].event.data.failureReason, 'card_declined');
});

test('webhook gives up after the last retry', async () => {
  replies = [500, 500, 500, 500];
  const i = await (await create()).json();
  await pay(i.id, 'succeeded');
  await until(async () => {
    const { data } = await (await api('GET', '/_deliveries')).json();
    return data.some((d) => d.objectId === i.id && /giving up/.test(String(d.result)));
  });
  assert.equal(received.length, 3);
});

test('bank is slow: processing event first, then succeeded', async () => {
  const i = await (await create()).json();
  await pay(i.id, 'processing');
  assert.equal((await (await api('GET', `/payment_intents/${i.id}`)).json()).status, 'processing');
  await until(() => received.length === 2);
  assert.deepEqual(received.map((d) => d.event.type).sort(), ['payment_intent.processing', 'payment_intent.succeeded']);
});

test('chaos failCreate: 500 and nothing created', async () => {
  await api('POST', '/_chaos', { failCreate: 1 });
  const body = intentBody();
  assert.equal((await create(body)).status, 500);
  assert.deepEqual((await (await api('GET', `/payment_intents?reference=${body.reference}`)).json()).data, []);
});

test('chaos dropResponse: the connection dies, but the intent EXISTS; retry with the same key finds it', async () => {
  await api('POST', '/_chaos', { dropResponse: 1 });
  const key = crypto.randomUUID();
  const body = intentBody();
  await assert.rejects(create(body, key), 'the caller never gets an answer');

  const { data } = await (await api('GET', `/payment_intents?reference=${body.reference}`)).json();
  assert.equal(data.length, 1, 'it was created anyway');

  await api('POST', '/_chaos', { dropResponse: 0 });
  const again = await create(body, key);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).id, data[0].id, 'same key -> same intent, not a second charge');
});

test('chaos dropWebhook: no delivery at all; duplicateWebhook: the same event twice', async () => {
  await api('POST', '/_chaos', { dropWebhook: 1 });
  const a = await (await create()).json();
  await pay(a.id, 'succeeded');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(received.length, 0);
  assert.equal((await (await api('GET', `/payment_intents/${a.id}`)).json()).status, 'succeeded', 'only GET can tell');

  await api('POST', '/_chaos', { dropWebhook: 0, duplicateWebhook: 1 });
  const b = await (await create()).json();
  await pay(b.id, 'succeeded');
  await until(() => received.length === 2);
  assert.equal(received[0].event.id, received[1].event.id);
});

test('cancel: only while unpaid; after payment the 409 says what happened', async () => {
  const a = await (await create()).json();
  const c = await api('POST', `/payment_intents/${a.id}/cancel`);
  assert.equal(c.status, 200);
  assert.equal((await c.json()).status, 'canceled');
  await pay(a.id, 'succeeded'); // too late: the payer can't pay a canceled intent
  assert.equal((await (await api('GET', `/payment_intents/${a.id}`)).json()).status, 'canceled');

  const b = await (await create()).json();
  await pay(b.id, 'succeeded');
  const late = await api('POST', `/payment_intents/${b.id}/cancel`);
  assert.equal(late.status, 409);
  assert.equal((await late.json()).intent.status, 'succeeded');
});

test('refunds: idempotent, only on paid intents, never more than was paid', async () => {
  const i = await (await create(intentBody({ amountPaise: 10_000 }))).json();
  const refund = (amountPaise, key = crypto.randomUUID()) =>
    api('POST', '/refunds', { paymentIntentId: i.id, amountPaise, reference: 'refund_1' }, { key });

  assert.equal((await refund(5_000)).status, 409, 'not paid yet');
  await pay(i.id, 'succeeded');

  const key = crypto.randomUUID();
  const first = await refund(6_000, key);
  assert.equal(first.status, 201);
  const again = await refund(6_000, key);
  assert.equal(again.status, 200, 'same key -> the same refund, not a second one');
  assert.equal((await again.json()).id, (await first.json()).id);
  assert.equal((await refund(5_000)).status, 409, '6000 + 5000 > 10000');
  assert.equal((await (await api('GET', `/payment_intents/${i.id}`)).json()).amountRefundedPaise, 6_000);
});

test('checkout page shows the amount; unknown intent is 404', async () => {
  const i = await (await create(intentBody({ amountPaise: 1_234_550 }))).json();
  const html = await (await fetch(`${base}/checkout/${i.id}`)).text();
  assert.match(html, /12,345\.50/);
  assert.equal((await fetch(`${base}/checkout/pi_nope`)).status, 404);
  assert.equal((await api('GET', '/payment_intents/pi_nope')).status, 404);
});
