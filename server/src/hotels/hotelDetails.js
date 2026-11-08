// One hotel and ALL its room types, each marked bookable or not for the requested stay.
//
// Unlike search (which hides what you can't book), the details page shows every room type
// and says WHY one can't be booked, so the user can change guests or dates instead of guessing.
const { quoteStay } = require('../pricing');

// Why a room type can't be booked. Checked in this order; the first that applies wins.
const STATUS = {
  AVAILABLE: 'available',
  TOO_SMALL: 'too_small',      // fewer beds than guests
  NOT_ON_SALE: 'not_on_sale',  // no inventory row for one or more nights (dates not loaded / not sold)
  SOLD_OUT: 'sold_out',        // a row exists but 0 rooms left on at least one night
};

const HOTEL_SQL = `
SELECT h.id, h.name, h.address, h.lat, h.lng, h.avg_score, h.review_count,
       c.name AS city, c.country, c.timezone
FROM hotels h
JOIN cities c ON c.id = h.city_id
WHERE h.id = $1`;

// LEFT JOIN, not JOIN: a room type with NO rows for these nights must still come back
// (as not_on_sale). An inner join would silently drop it.
// $1 hotel_id  $2 check_in  $3 check_out
const ROOM_TYPES_SQL = `
SELECT rt.id, rt.name, rt.max_guests,
       count(rn.night)                                AS nights_found,
       min(rn.available_count)                        AS rooms_left,
       array_agg(rn.price_paise ORDER BY rn.night)
         FILTER (WHERE rn.night IS NOT NULL)          AS night_prices
FROM room_types rt
LEFT JOIN room_nights rn ON rn.room_type_id = rt.id
                        AND rn.night >= $2::date
                        AND rn.night <  $3::date       -- check-out night is NOT included
WHERE rt.hotel_id = $1
GROUP BY rt.id
ORDER BY rt.base_price_paise, rt.id`;

// Pure function (no database), so the rules can be unit-tested with plain objects.
// row: one ROOM_TYPES_SQL row.  stay: { nights, guests }.
function toRoomTypeView(row, stay) {
  const nightsFound = Number(row.nights_found);  // count() is bigint -> string from pg
  const roomsLeft = row.rooms_left === null ? 0 : row.rooms_left;

  let status;
  if (row.max_guests < stay.guests) status = STATUS.TOO_SMALL;
  else if (nightsFound < stay.nights) status = STATUS.NOT_ON_SALE;
  else if (roomsLeft <= 0) status = STATUS.SOLD_OUT;
  else status = STATUS.AVAILABLE;

  return {
    id: row.id,
    name: row.name,
    maxGuests: row.max_guests,
    status,
    roomsLeft: status === STATUS.AVAILABLE ? roomsLeft : 0,
    // Price only when bookable: a price for something you can't buy just invites support tickets.
    // bigint comes out of Postgres as a string: convert BEFORE the money maths.
    price: status === STATUS.AVAILABLE ? quoteStay(row.night_prices.map(Number)) : null,
  };
}

// Returns null if the hotel doesn't exist (the route turns that into 404).
async function getHotel(db, hotelId) {
  const { rows } = await db.query(HOTEL_SQL, [hotelId]);
  if (!rows.length) return null;
  const h = rows[0];
  return {
    id: h.id,
    name: h.name,
    address: h.address,
    city: h.city,
    country: h.country,
    timezone: h.timezone,
    avgScore: h.avg_score === null ? null : Number(h.avg_score),
    reviewCount: h.review_count,
    location: { lat: Number(h.lat), lng: Number(h.lng) },
  };
}

async function getRoomTypes(db, hotelId, stay) {
  const { rows } = await db.query(ROOM_TYPES_SQL, [hotelId, stay.checkIn, stay.checkOut]);
  return rows.map((r) => toRoomTypeView(r, stay));
}

module.exports = { getHotel, getRoomTypes, toRoomTypeView, STATUS };
