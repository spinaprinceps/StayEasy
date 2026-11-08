// GET /search?city=London&checkIn=2026-12-11&checkOut=2026-12-14&guests=2&page=1
// No login needed.
const express = require('express');
const pool = require('../db/pool');
const { parseSearchQuery, checkDatesForCity } = require('../search/validate');
const { searchHotels, PAGE_SIZE } = require('../search/searchHotels');

const router = express.Router();

router.get('/', async (req, res) => {
  // 1. Shape checks (zod): no database work for obviously bad requests.
  const { errors, search } = parseSearchQuery(req.query);
  if (errors.length) return res.status(400).json({ errors });

  const empty = { ...search, pageSize: PAGE_SIZE, totalHotels: 0, hotels: [] };

  // 2. Find the city. Unknown city is not an error: just no results (per the brief).
  const { rows } = await pool.query(
    'SELECT id, name, timezone FROM cities WHERE lower(name) = lower($1)',
    [search.city]
  );
  if (rows.length === 0) return res.json(empty);
  const city = rows[0];

  // 3. Date checks that need the hotel's time zone ("today" at the hotel).
  const dateErrors = checkDatesForCity(search, city.timezone);
  if (dateErrors.length) return res.status(400).json({ errors: dateErrors });

  // 4. The search itself.
  const result = await searchHotels(pool, { ...search, cityId: city.id });
  res.json({ ...empty, city: city.name, ...result });
});

module.exports = router;
