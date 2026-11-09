// refundFor (money rule) and verifySignature (webhook safety). No database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { quoteStay, refundFor } = require('../src/pricing');
const { verifySignature } = require('../src/payments/signature');
const { sign } = require('../src/fakepay/gateway');

// ---- refundFor ----

const stay = quoteStay([800000, 700000, 700000]); // night 1 is above Rs 7,500 -> 18% tax
// flexible: 800000+144000, 700000+35000, 700000+35000 = 2414000

test('flexible, before the deadline: everything back, tax included', () => {
  assert.equal(stay.flexible.totalPaise, 2414000);
  assert.equal(refundFor(stay.flexible, 'flexible', true), 2414000);
});

test('flexible, after the deadline: everything except the first night and ITS tax', () => {
  assert.equal(refundFor(stay.flexible, 'flexible', false), 2414000 - 800000 - 144000);
});

test('one-night flexible stay after the deadline: nothing back', () => {
  const one = quoteStay([500000]).flexible;
  assert.equal(refundFor(one, 'flexible', false), 0);
});

test('non-refundable: nothing back, before or after', () => {
  assert.equal(refundFor(stay.nonRefundable, 'non_refundable', true), 0);
  assert.equal(refundFor(stay.nonRefundable, 'non_refundable', false), 0);
});

test('refunds come from the FROZEN breakdown, and bad input throws', () => {
  const frozen = JSON.parse(JSON.stringify(stay.flexible)); // what comes back from jsonb
  assert.equal(refundFor(frozen, 'flexible', true), 2414000);
  assert.throws(() => refundFor({ ...frozen, totalPaise: '2414000' }, 'flexible', true), TypeError);
  assert.throws(() => refundFor(frozen, 'weekly', true), TypeError);
});

// ---- verifySignature ----

const SECRET = 'whsec-test-0123456789abcdef';
const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { id: 'pi_1' } });
const now = 1_800_000_000;

test('a correct signature passes', () => {
  assert.equal(verifySignature(SECRET, body, sign(SECRET, body, now), now), true);
});

test('a changed body, a wrong secret or a junk header fails', () => {
  const header = sign(SECRET, body, now);
  assert.equal(verifySignature(SECRET, body.replace('pi_1', 'pi_2'), header, now), false);
  assert.equal(verifySignature('other-secret-0123456789', body, header, now), false);
  assert.equal(verifySignature(SECRET, body, 'nonsense', now), false);
  assert.equal(verifySignature(SECRET, body, undefined, now), false);
  assert.equal(verifySignature(undefined, body, header, now), false, 'no secret configured -> reject, never accept');
});

test('an old signature is refused (replay), even though the HMAC is right', () => {
  const old = sign(SECRET, body, now - 301);
  assert.equal(verifySignature(SECRET, body, old, now), false);
  assert.equal(verifySignature(SECRET, body, sign(SECRET, body, now - 299), now), true);
});

test('re-serialised JSON fails: the signature is over the exact bytes sent', () => {
  const header = sign(SECRET, body, now);
  const pretty = JSON.stringify(JSON.parse(body), null, 2);
  assert.equal(verifySignature(SECRET, pretty, header, now), false);
});
