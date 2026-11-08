// Loads hotels from the Kaggle "515K Hotel Reviews Data in Europe" CSV,
// then generates room types and 365 nights of prices/availability for each.
//
// Safe to run again: hotels and room types are updated in place,
// missing nights are added, existing nights (and so bookings) are never touched.
//
// Usage: npm run seed [-- path/to/Hotel_Reviews.csv]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parse } = require('csv-parse');
const { Pool } = require('pg');

const CSV_PATH = process.argv[2] || path.join(__dirname, 'data', 'Hotel_Reviews.csv');
const DAYS_AHEAD = 365;

// Country suffix in the address -> country name + timezone, plus base price per city (Rs).
const COUNTRIES = {
  'United Kingdom': { tz: 'Europe/London' },
  France: { tz: 'Europe/Paris' },
  Netherlands: { tz: 'Europe/Amsterdam' },
  Spain: { tz: 'Europe/Madrid' },
  Italy: { tz: 'Europe/Rome' },
  Austria: { tz: 'Europe/Vienna' },
};
const CITIES = {
  London: { country: 'United Kingdom', baseRupees: 12000 },
  Paris: { country: 'France', baseRupees: 11000 },
  Amsterdam: { country: 'Netherlands', baseRupees: 10000 },
  Barcelona: { country: 'Spain', baseRupees: 8000 },
  Milan: { country: 'Italy', baseRupees: 8500 },
  Vienna: { country: 'Austria', baseRupees: 7500 },
};

const ROOM_TYPES = [
  { name: 'Standard Double', maxGuests: 2, mult: 1.0 }, // every hotel has this one
  { name: 'Single Room', maxGuests: 1, mult: 0.7 },
  { name: 'Twin Room', maxGuests: 2, mult: 1.0 },
  { name: 'Deluxe King', maxGuests: 2, mult: 1.4 },
  { name: 'Family Room', maxGuests: 4, mult: 1.6 },
  { name: 'Junior Suite', maxGuests: 3, mult: 1.9 },
];

// ---------- deterministic randomness: same input -> same numbers on every run ----------

function hashInt(str) {
  return crypto.createHash('md5').update(str).digest().readUInt32LE(0);
}

// Small seeded random number generator (mulberry32). Returns floats in [0, 1).
function seededRandom(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- step 1: read the CSV and collect unique hotels ----------

// Remove the country from the end first, then find the known city name in what's left.
// (UK addresses put the postcode after the city: "... London SW5 9NB United Kingdom".)
function parseCity(address) {
  const country = Object.keys(COUNTRIES).find((c) => address.endsWith(' ' + c));
  if (!country) return null;
  const rest = ' ' + address.slice(0, -country.length) + ' ';
  const city = Object.keys(CITIES).find(
    (c) => CITIES[c].country === country && rest.includes(' ' + c + ' ')
  );
  return city ? { city, country } : null;
}

function toNumber(v) {
  const n = Number(v);
  return v === '' || v === 'NA' || Number.isNaN(n) ? null : n;
}

async function readHotels(csvPath) {
  const hotels = new Map(); // key "name|address" -> hotel
  const parser = fs.createReadStream(csvPath).pipe(parse({ columns: true, trim: true }));

  let rows = 0;
  for await (const r of parser) {
    rows++;
    const key = `${r.Hotel_Name}|${r.Hotel_Address}`;
    const h = hotels.get(key);
    if (h) {
      if (h.lat === null) h.lat = toNumber(r.lat);
      if (h.lng === null) h.lng = toNumber(r.lng);
      continue;
    }
    const place = parseCity(r.Hotel_Address);
    if (!place) {
      throw new Error(`Unknown city in address: "${r.Hotel_Address}"`);
    }
    hotels.set(key, {
      key,
      name: r.Hotel_Name,
      address: r.Hotel_Address,
      city: place.city,
      country: place.country,
      lat: toNumber(r.lat),
      lng: toNumber(r.lng),
      avgScore: toNumber(r.Average_Score),
      reviewCount: toNumber(r.Total_Number_of_Reviews) || 0,
    });
  }
  console.log(`read ${rows} review rows -> ${hotels.size} unique hotels`);
  return [...hotels.values()];
}

// ---------- step 2: generate room types and nightly prices ----------

function generateRoomTypes(hotel) {
  const rand = seededRandom(hashInt(hotel.key));
  const score = hotel.avgScore ?? 8;
  const hotelBase =
    CITIES[hotel.city].baseRupees * (0.5 + (score - 5) * 0.25) * (0.85 + rand() * 0.3);

  const extras = ROOM_TYPES.slice(1).sort(() => rand() - 0.5);
  const count = 2 + Math.floor(rand() * 3); // 2 to 4 room types
  const chosen = [ROOM_TYPES[0], ...extras.slice(0, count - 1)];

  return chosen.map((t) => ({
    name: t.name,
    maxGuests: t.maxGuests,
    totalRooms: 2 + Math.floor(rand() * 14), // 2 to 15 rooms
    basePricePaise: Math.round((hotelBase * t.mult) / 100) * 100 * 100, // round to Rs 100
  }));
}

function nightlyPricePaise(hotelKey, roomType, dateStr) {
  const day = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  const weekend = day === 5 || day === 6 ? 1.2 : 1.0; // Friday and Saturday nights
  const jitter = 0.9 + (hashInt(`${hotelKey}|${roomType.name}|${dateStr}`) % 2001) / 10000; // 0.9-1.1
  return Math.round((roomType.basePricePaise * weekend * jitter) / 100) * 100; // whole rupees
}

function nightDates() {
  const today = new Date();
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const dates = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    dates.push(new Date(start + i * 86400000).toISOString().slice(0, 10));
  }
  return dates;
}

// ---------- step 3: write to the database ----------

async function upsertCities(pool, hotels) {
  const ids = {};
  const cities = new Map(hotels.map((h) => [h.city, h.country]));
  for (const [name, country] of cities) {
    const { rows } = await pool.query(
      `INSERT INTO cities (name, country, timezone) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET country = EXCLUDED.country, timezone = EXCLUDED.timezone
       RETURNING id`,
      [name, country, COUNTRIES[country].tz]
    );
    ids[name] = rows[0].id;
  }
  return ids;
}

async function loadHotel(client, hotel, cityId, dates) {
  const { rows } = await client.query(
    `INSERT INTO hotels (city_id, name, address, lat, lng, avg_score, review_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (name, address) DO UPDATE SET
       city_id = EXCLUDED.city_id, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
       avg_score = EXCLUDED.avg_score, review_count = EXCLUDED.review_count
     RETURNING id`,
    [cityId, hotel.name, hotel.address, hotel.lat, hotel.lng, hotel.avgScore, hotel.reviewCount]
  );
  const hotelId = rows[0].id;

  let nightsAdded = 0;
  for (const rt of generateRoomTypes(hotel)) {
    // total_rooms is NOT updated on re-run: changing it would make available_count wrong.
    const res = await client.query(
      `INSERT INTO room_types (hotel_id, name, max_guests, total_rooms, base_price_paise)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (hotel_id, name) DO UPDATE SET
         max_guests = EXCLUDED.max_guests, base_price_paise = EXCLUDED.base_price_paise
       RETURNING id, total_rooms`,
      [hotelId, rt.name, rt.maxGuests, rt.totalRooms, rt.basePricePaise]
    );
    const { id: roomTypeId, total_rooms: totalRooms } = res.rows[0];

    // All 365 nights in one statement. DO NOTHING = never overwrite an existing night.
    const prices = dates.map((d) => nightlyPricePaise(hotel.key, rt, d));
    const ins = await client.query(
      `INSERT INTO room_nights (room_type_id, night, price_paise, available_count)
       SELECT $1, d, p, $2 FROM unnest($3::date[], $4::bigint[]) AS t(d, p)
       ON CONFLICT (room_type_id, night) DO NOTHING`,
      [roomTypeId, totalRooms, dates, prices]
    );
    nightsAdded += ins.rowCount;
  }
  return nightsAdded;
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`CSV not found at ${CSV_PATH}`);
  }
  const started = Date.now();
  const hotels = await readHotels(CSV_PATH);
  const pool = new Pool({ max: 4 });

  try {
    const cityIds = await upsertCities(pool, hotels);
    const dates = nightDates();
    let totalNights = 0;

    for (let i = 0; i < hotels.length; i++) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN'); // one transaction per hotel: all of it or none of it
        totalNights += await loadHotel(client, hotels[i], cityIds[hotels[i].city], dates);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${hotels.length} hotels`);
    }

    const { rows } = await pool.query(`
      SELECT (SELECT count(*) FROM hotels) AS hotels,
             (SELECT count(*) FROM room_types) AS room_types,
             (SELECT count(*) FROM room_nights) AS room_nights`);
    console.log(`added ${totalNights} new nights`);
    console.log('database now has:', rows[0]);
    console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
