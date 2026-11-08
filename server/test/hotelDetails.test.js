// Tests for the room-type status rules in src/hotels/hotelDetails.js. No database needed.
// Run just this file: node --test test/hotelDetails.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toRoomTypeView, STATUS } = require('../src/hotels/hotelDetails');
const { parseStayQuery } = require('../src/search/validate');

// A row shaped like what Postgres returns (bigint count comes back as a string).
const row = (over = {}) => ({
  id: 1, name: 'Double', max_guests: 2,
  nights_found: '3', rooms_left: 4, night_prices: ['500000', '500000', '600000'],
  ...over,
});
const stay = { nights: 3, guests: 2 };

test('fits, every night present, rooms left -> available, with a price', () => {
  const v = toRoomTypeView(row(), stay);
  assert.equal(v.status, STATUS.AVAILABLE);
  assert.equal(v.roomsLeft, 4);
  assert.equal(v.price.flexible.subtotalPaise, 1600000); // strings were converted to numbers
});

test('more guests than beds -> too_small, no price', () => {
  const v = toRoomTypeView(row({ max_guests: 1 }), stay);
  assert.equal(v.status, STATUS.TOO_SMALL);
  assert.equal(v.price, null);
});

test('a night has no inventory row -> not_on_sale', () => {
  const v = toRoomTypeView(row({ nights_found: '2', night_prices: ['500000', '500000'] }), stay);
  assert.equal(v.status, STATUS.NOT_ON_SALE);
  assert.equal(v.price, null);
});

test('no rows at all (LEFT JOIN gives nulls) -> not_on_sale, no crash', () => {
  const v = toRoomTypeView(row({ nights_found: '0', rooms_left: null, night_prices: null }), stay);
  assert.equal(v.status, STATUS.NOT_ON_SALE);
});

test('one night with 0 rooms left -> sold_out (min over the nights is what counts)', () => {
  const v = toRoomTypeView(row({ rooms_left: 0 }), stay);
  assert.equal(v.status, STATUS.SOLD_OUT);
  assert.equal(v.roomsLeft, 0);
  assert.equal(v.price, null);
});

test('too_small wins over sold_out: tell the user the thing they can fix', () => {
  const v = toRoomTypeView(row({ max_guests: 1, rooms_left: 0 }), stay);
  assert.equal(v.status, STATUS.TOO_SMALL);
});

test('stay query: same date rules as search, but no city needed', () => {
  assert.equal(parseStayQuery({ checkIn: '2026-12-11', checkOut: '2026-12-14' }).stay.nights, 3);
  assert.equal(parseStayQuery({ checkIn: '2026-12-11', checkOut: '2026-12-14' }).stay.guests, 1);
  assert.equal(parseStayQuery({ checkIn: '2026-12-14', checkOut: '2026-12-11' }).errors[0].field, 'checkOut');
  assert.equal(parseStayQuery({ checkIn: '2026-02-30', checkOut: '2026-03-02' }).errors[0].field, 'checkIn');
});
