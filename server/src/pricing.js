// The one place money is calculated. Search shows these numbers, Reserve saves them
// on the hold, Pay charges them, so nobody else should do their own price arithmetic.
//
// All amounts are whole paise (integers). No floating-point maths anywhere.
//
// Rules (from the brief):
//   - tax is per night, on the price actually charged that night
//   - 5% if the night is <= Rs 7,500 (750000 paise), otherwise 18%
//   - round half up to the paisa
//   - the stay's total is the sum of its nights
//   - non-refundable: each night is 88% of the normal price; its tax band is decided on that lower price

const TAX_THRESHOLD_PAISE = 750000; // Rs 7,500
const LOW_TAX_PERCENT = 5;
const HIGH_TAX_PERCENT = 18;
const NON_REFUNDABLE_PERCENT = 88;

// pct% of an amount, rounded half up, using only integers:
// adding 50 before dividing by 100 is "add half, then cut off the decimals".
function percentOf(amountPaise, pct) {
  return Math.floor((amountPaise * pct + 50) / 100);
}

// Catches the classic bug: Postgres returns bigint columns as strings ("750000").
// Without this check, "750000" <= 750000 is true in JS and the maths "works", but wrongly elsewhere.
function assertPrice(pricePaise) {
  if (!Number.isSafeInteger(pricePaise) || pricePaise <= 0) {
    throw new TypeError(`price must be a positive whole number of paise, got ${JSON.stringify(pricePaise)}`);
  }
}

function taxForNight(pricePaise) {
  assertPrice(pricePaise);
  const pct = pricePaise <= TAX_THRESHOLD_PAISE ? LOW_TAX_PERCENT : HIGH_TAX_PERCENT;
  return percentOf(pricePaise, pct);
}

// Builds one rate's breakdown from the prices actually charged per night.
function breakdown(chargedPrices) {
  const nights = chargedPrices.map((p) => ({ pricePaise: p, taxPaise: taxForNight(p) }));
  const subtotalPaise = nights.reduce((sum, n) => sum + n.pricePaise, 0);
  const taxPaise = nights.reduce((sum, n) => sum + n.taxPaise, 0);
  return { nights, subtotalPaise, taxPaise, totalPaise: subtotalPaise + taxPaise };
}

// nightPricesPaise: the normal price of each night of the stay, in date order.
function quoteStay(nightPricesPaise) {
  if (!Array.isArray(nightPricesPaise) || nightPricesPaise.length === 0) {
    throw new TypeError('a stay needs at least one night');
  }
  nightPricesPaise.forEach(assertPrice);

  return {
    flexible: breakdown(nightPricesPaise),
    nonRefundable: breakdown(nightPricesPaise.map((p) => percentOf(p, NON_REFUNDABLE_PERCENT))),
  };
}

module.exports = { taxForNight, quoteStay, TAX_THRESHOLD_PAISE };
