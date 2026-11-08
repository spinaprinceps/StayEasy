// The search query: hotels in a city with a room type that fits the guests
// and is free on EVERY night of the stay. One row per hotel (its cheapest
// qualifying room type), cheapest first, PAGE_SIZE per page.
const { quoteStay } = require('../pricing');

const PAGE_SIZE = 20;

// $1 city_id  $2 check_in  $3 check_out  $4 guests  $5 nights  $6 limit  $7 offset
const SQL = `
WITH bookable AS (
  -- Step 1: every room type in the city that fits the guests and has a room on all nights.
  SELECT rt.hotel_id,
         rt.id   AS room_type_id,
         rt.name AS room_name,
         rt.max_guests,
         array_agg(rn.price_paise ORDER BY rn.night) AS night_prices,
         min(rn.available_count)                     AS rooms_left,
         -- Sort key only: total incl. tax, same rule as pricing.js (5% up to Rs 7,500, else 18%,
         -- half up). Integer division on positive numbers rounds down, so +50 then /100 = half up.
         sum(rn.price_paise + CASE WHEN rn.price_paise <= 750000
                                   THEN (rn.price_paise * 5  + 50) / 100
                                   ELSE (rn.price_paise * 18 + 50) / 100 END) AS total_paise
  FROM hotels h
  JOIN room_types  rt ON rt.hotel_id = h.id
  JOIN room_nights rn ON rn.room_type_id = rt.id
                     AND rn.night >= $2::date
                     AND rn.night <  $3::date          -- check-out night is NOT included
  WHERE h.city_id = $1
    AND rt.max_guests >= $4
    AND rn.available_count > 0                         -- drops sold-out nights...
  GROUP BY rt.id
  HAVING count(*) = $5                                 -- ...so any missing or sold-out night fails this
),
cheapest AS (
  -- Step 2: keep one room type per hotel: the cheapest (ties -> lowest id, so it's stable).
  SELECT DISTINCT ON (hotel_id) *
  FROM bookable
  ORDER BY hotel_id, total_paise, room_type_id
)
SELECT h.id, h.name, h.address, h.avg_score, h.review_count, h.lat, h.lng,
       c.room_type_id, c.room_name, c.max_guests, c.night_prices, c.rooms_left,
       count(*) OVER () AS total_hotels               -- how many hotels match, before paging
FROM cheapest c
JOIN hotels h ON h.id = c.hotel_id
ORDER BY c.total_paise, h.id                          -- h.id breaks ties so pages never overlap
LIMIT $6 OFFSET $7`;

async function searchHotels(db, { cityId, checkIn, checkOut, guests, nights, page }) {
  const { rows } = await db.query(SQL, [
    cityId, checkIn, checkOut, guests, nights, PAGE_SIZE, (page - 1) * PAGE_SIZE,
  ]);

  return {
    totalHotels: rows.length ? Number(rows[0].total_hotels) : 0,
    hotels: rows.map((r) => ({
      id: r.id,
      name: r.name,
      address: r.address,
      avgScore: r.avg_score === null ? null : Number(r.avg_score),
      reviewCount: r.review_count,
      location: { lat: Number(r.lat), lng: Number(r.lng) },
      roomType: { id: r.room_type_id, name: r.room_name, maxGuests: r.max_guests },
      roomsLeft: r.rooms_left,
      // bigint comes out of Postgres as a string: convert BEFORE the money maths.
      price: quoteStay(r.night_prices.map(Number)),
    })),
  };
}

module.exports = { searchHotels, PAGE_SIZE };
