// Tests for src/pricing.js: the one place money is calculated.
// Run all tests:      npm test
// Run just this file: node --test test/pricing.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { taxForNight, quoteStay } = require('../src/pricing');

// Each row: a night price, why it's interesting, and the answers worked out by hand.
// All money is in paise: 750000 = Rs 7,500.00
const CASES = [
  { price: 750000, why: 'exactly Rs 7,500 is still 5%',         tax: 37500,  nrPrice: 660000, nrTax: 33000 },
  { price: 750100, why: 'just above Rs 7,500 jumps to 18%',     tax: 135018, nrPrice: 660088, nrTax: 33004 },
  { price: 333310, why: '5% gives 16665.5 -> rounds UP',        tax: 16666,  nrPrice: 293313, nrTax: 14666 },
  { price: 750025, why: '18% gives 135004.5 -> rounds UP',      tax: 135005, nrPrice: 660022, nrTax: 33001 },
  { price: 852273, why: '88% lands exactly on Rs 7,500 -> 5%',  tax: 153409, nrPrice: 750000, nrTax: 37500 },
  { price: 852274, why: '88% lands just above Rs 7,500 -> 18%', tax: 153409, nrPrice: 750001, nrTax: 135000 },
];

// One test per row, so a failure names the exact case that broke.
for (const c of CASES) {
  test(`taxForNight(${c.price}): ${c.why}`, () => {
    assert.equal(taxForNight(c.price), c.tax);
  });

  test(`non-refundable for ${c.price}: 88% price, tax band decided on the LOWER price`, () => {
    const { nonRefundable } = quoteStay([c.price]);
    assert.equal(nonRefundable.nights[0].pricePaise, c.nrPrice);
    assert.equal(nonRefundable.nights[0].taxPaise, c.nrTax);
  });
}

test('a 3-night stay: tax is per night, total is the sum of the nights', () => {
  const q = quoteStay([750000, 750100, 333310]);

  assert.deepEqual(q.flexible, {
    nights: [
      { pricePaise: 750000, taxPaise: 37500 },
      { pricePaise: 750100, taxPaise: 135018 },
      { pricePaise: 333310, taxPaise: 16666 },
    ],
    subtotalPaise: 1833410, // 750000 + 750100 + 333310
    taxPaise: 189184,       // 37500 + 135018 + 16666
    totalPaise: 2022594,    // subtotal + tax
  });

  assert.equal(q.nonRefundable.subtotalPaise, 1613401); // 660000 + 660088 + 293313
  assert.equal(q.nonRefundable.taxPaise, 80670);        // 33000 + 33004 + 14666
  assert.equal(q.nonRefundable.totalPaise, 1694071);
});

test('every total is a whole number of paise', () => {
  const q = quoteStay([750000, 750100, 333310, 852274]);
  for (const rate of [q.flexible, q.nonRefundable]) {
    assert.ok(Number.isInteger(rate.totalPaise));
  }
});

// Bad input must fail LOUDLY, not produce a wrong price quietly.
// The string case is the real trap: Postgres returns bigint columns as strings.
test('rejects bad input', () => {
  assert.throws(() => quoteStay([]));             // no nights
  assert.throws(() => quoteStay([-500]));         // negative price
  assert.throws(() => quoteStay([0]));            // zero price
  assert.throws(() => quoteStay(['750000']));     // string from the database, not converted
  assert.throws(() => quoteStay([7500.5]));       // half a paisa does not exist
  assert.throws(() => taxForNight('750000'));     // string passed straight to taxForNight
});
