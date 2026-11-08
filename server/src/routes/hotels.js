// GET /hotels/:id?checkIn=2026-12-11&checkOut=2026-12-14&guests=2
// No login needed. Returns the hotel and every room type, each with a status:
//   available | too_small | not_on_sale | sold_out   (price only when available)
const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const { parseStayQuery, checkDatesForCity } = require('../search/validate');
const { getHotel, getRoomTypes } = require('../hotels/hotelDetails');

const router = express.Router();

// ids are Postgres `int` (max 2147483647). Without the max, /hotels/99999999999 reaches
// the database, Postgres throws "out of range", and the user gets a 500 instead of a 404.
const HotelId = z.coerce.number().int().min(1).max(2147483647);

router.get('/:id', async (req, res) => {
  // 1. Shape checks first: no database work for obviously bad requests.
  const id = HotelId.safeParse(req.params.id);
  if (!id.success) return res.status(404).json({ error: 'Hotel not found' });

  const { errors, stay } = parseStayQuery(req.query);
  if (errors.length) return res.status(400).json({ errors });

  // 2. The hotel (and its time zone, needed for the date check).
  const hotel = await getHotel(pool, id.data);
  if (!hotel) return res.status(404).json({ error: 'Hotel not found' });

  // 3. "Is checkIn in the past?" is judged by the calendar AT THE HOTEL, same as search.
  const dateErrors = checkDatesForCity(stay, hotel.timezone);
  if (dateErrors.length) return res.status(400).json({ errors: dateErrors });

  // 4. Room types with availability and price for these exact nights.
  const roomTypes = await getRoomTypes(pool, hotel.id, stay);
  res.json({ hotel, stay, roomTypes });
});

module.exports = router;
