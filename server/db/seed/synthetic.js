// Deterministic synthetic data for StayEasy.
//
// Everything here is a pure function: the same inputs always give the same output,
// on any machine, on any day. No Math.random(), no database, no files.
//
//   generateHotels(count)                 -> hotel objects
//   generateRoomTypes(hotel)              -> 2-4 room types for that hotel
//   generateNight(hotel, roomType, date)  -> { pricePaise, availableCount } for one night
const crypto = require('crypto');

// ---------- seeded randomness ----------

// Turns any string into a 32-bit integer. Same string -> same number, always.
function hashInt(str) {
  return crypto.createHash('md5').update(str).digest().readUInt32LE(0);
}

// mulberry32: a tiny random number generator that starts from a seed.
// Returns a function that gives floats in [0, 1).
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One random float in [0, 1) for a given string, without keeping any state.
function hashFloat(str) {
  return hashInt(str) / 4294967296;
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const between = (rand, lo, hi) => lo + rand() * (hi - lo);

// ---------- reference data ----------

// Order matters: the position gives the city id (London = 1 ... Vienna = 6).
// `weight` = share of hotels. London is heaviest because the load test targets it.
const CITIES = [
  {
    name: 'London', country: 'United Kingdom', timezone: 'Europe/London',
    lat: 51.5074, lng: -0.1278, weight: 30, baseRupees: 10000,
    streets: ['Baker Street', 'Kensington High Street', 'Cromwell Road', 'Strand', 'Oxford Street',
      'Brompton Road', 'Gloucester Road', 'King\'s Road', 'Edgware Road', 'Euston Road',
      'Bayswater Road', 'Marylebone Road', 'Southampton Row', 'Great Russell Street', 'Shaftesbury Avenue'],
    postcode: (r) => pick(r, ['W1', 'W2', 'SW1', 'SW3', 'SW5', 'SW7', 'WC1', 'WC2', 'EC1', 'NW1', 'SE1']) +
      ' ' + Math.floor(r() * 9 + 1) + pick(r, ['AA', 'BD', 'EJ', 'HL', 'NB', 'PT', 'RW', 'UZ']),
    format: (num, street, pc) => `${num} ${street} London ${pc} United Kingdom`,
  },
  {
    name: 'Paris', country: 'France', timezone: 'Europe/Paris',
    lat: 48.8566, lng: 2.3522, weight: 25, baseRupees: 9500,
    streets: ['Rue de Rivoli', 'Boulevard Haussmann', 'Rue Saint-Honore', 'Avenue de l\'Opera',
      'Rue de la Paix', 'Boulevard Saint-Germain', 'Rue du Bac', 'Avenue Kleber', 'Rue Lafayette',
      'Boulevard de Clichy', 'Rue de Vaugirard', 'Avenue Montaigne', 'Rue Cler', 'Quai Voltaire'],
    postcode: (r) => '750' + String(Math.floor(r() * 20) + 1).padStart(2, '0'),
    format: (num, street, pc) => `${num} ${street} ${pc} Paris France`,
  },
  {
    name: 'Amsterdam', country: 'Netherlands', timezone: 'Europe/Amsterdam',
    lat: 52.3676, lng: 4.9041, weight: 15, baseRupees: 8500,
    streets: ['Prinsengracht', 'Keizersgracht', 'Herengracht', 'Damrak', 'Rokin', 'Kalverstraat',
      'Leidsestraat', 'Vijzelstraat', 'Nieuwezijds Voorburgwal', 'Stadhouderskade', 'Overtoom',
      'Utrechtsestraat'],
    postcode: (r) => (1011 + Math.floor(r() * 90)) + ' ' +
      String.fromCharCode(65 + Math.floor(r() * 26), 65 + Math.floor(r() * 26)),
    format: (num, street, pc) => `${street} ${num} ${pc} Amsterdam Netherlands`,
  },
  {
    name: 'Barcelona', country: 'Spain', timezone: 'Europe/Madrid',
    lat: 41.3874, lng: 2.1686, weight: 12, baseRupees: 6500,
    streets: ['La Rambla', 'Passeig de Gracia', 'Carrer de Balmes', 'Gran Via de les Corts Catalanes',
      'Carrer d\'Arago', 'Avinguda Diagonal', 'Carrer de Pelai', 'Rambla de Catalunya',
      'Carrer de Mallorca', 'Via Laietana', 'Carrer de Ferran', 'Passeig de Colom'],
    postcode: (r) => '080' + String(Math.floor(r() * 42) + 1).padStart(2, '0'),
    format: (num, street, pc) => `${street} ${num} ${pc} Barcelona Spain`,
  },
  {
    name: 'Milan', country: 'Italy', timezone: 'Europe/Rome',
    lat: 45.4642, lng: 9.19, weight: 10, baseRupees: 7000,
    streets: ['Via Montenapoleone', 'Corso Buenos Aires', 'Via Dante', 'Corso Como', 'Via Torino',
      'Corso Magenta', 'Via Manzoni', 'Viale Monza', 'Via Vittor Pisani', 'Corso di Porta Romana',
      'Via Tortona', 'Piazza della Repubblica'],
    postcode: (r) => '201' + String(Math.floor(r() * 62)).padStart(2, '0'),
    format: (num, street, pc) => `${street} ${num} ${pc} Milan Italy`,
  },
  {
    name: 'Vienna', country: 'Austria', timezone: 'Europe/Vienna',
    lat: 48.2082, lng: 16.3738, weight: 8, baseRupees: 6000,
    streets: ['Karntner Strasse', 'Graben', 'Mariahilfer Strasse', 'Ringstrasse', 'Wiedner Hauptstrasse',
      'Landstrasser Hauptstrasse', 'Praterstrasse', 'Josefstadter Strasse', 'Rotenturmstrasse',
      'Opernring', 'Schottenring', 'Neubaugasse'],
    postcode: (r) => '1' + String(Math.floor(r() * 23) + 1).padStart(2, '0') + '0',
    format: (num, street, pc) => `${street} ${num} ${pc} Vienna Austria`,
  },
];
CITIES.forEach((c, i) => { c.id = i + 1; });
const TOTAL_WEIGHT = CITIES.reduce((s, c) => s + c.weight, 0);

const NAME_PREFIX = ['The', 'Hotel', 'Grand', 'Royal', 'Park', 'City', 'Little', 'Old', 'New', 'Boutique'];
const NAME_CORE = ['Canal', 'Garden', 'Crown', 'Harbour', 'Palace', 'Opera', 'Station', 'Bridge',
  'Market', 'Tower', 'Square', 'River', 'Cathedral', 'Museum', 'Linden', 'Oak', 'Maple', 'Atlas',
  'Meridian', 'Aurora', 'Regent', 'Sterling', 'Ivory', 'Saffron', 'Cobalt', 'Juniper'];
const NAME_SUFFIX = ['Hotel', 'Inn', 'Suites', 'House', 'Residence', 'Lodge', 'Hotel & Spa', 'Rooms', 'Boutique Hotel'];

// The catalog position is part of the room type id, so never reorder this list; only append.
const ROOM_TYPES = [
  { name: 'Standard Double', maxGuests: 2, mult: 1.0 }, // every hotel has this one
  { name: 'Single Room', maxGuests: 1, mult: 0.7 },
  { name: 'Twin Room', maxGuests: 2, mult: 1.0 },
  { name: 'Deluxe King', maxGuests: 2, mult: 1.4 },
  { name: 'Family Room', maxGuests: 4, mult: 1.6 },
  { name: 'Junior Suite', maxGuests: 3, mult: 1.9 },
];

// ---------- hotels ----------

function pickCity(rand) {
  let x = rand() * TOTAL_WEIGHT;
  for (const c of CITIES) {
    if ((x -= c.weight) < 0) return c;
  }
  return CITIES[CITIES.length - 1];
}

// Roughly bell-shaped around 8.2 (the average of 3 uniforms), kept between 6.0 and 9.6.
function reviewScore(rand) {
  const bell = (rand() + rand() + rand()) / 3; // 0..1, peaks at 0.5
  return Math.round(Math.min(9.6, Math.max(6.0, 6.6 + bell * 3.2)) * 10) / 10;
}

// Hotel i depends only on its own seed ("hotel-i") plus how many earlier hotels share its city.
// So generateHotels(10) always starts with exactly the hotels of generateHotels(5).
function generateHotels(count) {
  const perCity = new Map(CITIES.map((c) => [c.id, 0]));
  const hotels = [];

  for (let i = 0; i < count; i++) {
    const rand = seededRandom(hashInt(`hotel-${i}`));
    const city = pickCity(rand);

    // Unique address by construction: the nth hotel in a city gets street n % S,
    // and a house number from the band floor(n / S). Different n -> different (street, number).
    const n = perCity.get(city.id);
    perCity.set(city.id, n + 1);
    const S = city.streets.length;
    const street = city.streets[n % S];
    const houseNumber = Math.floor(n / S) * 3 + 1 + Math.floor(rand() * 3);
    const address = city.format(houseNumber, street, city.postcode(rand));

    const name = rand() < 0.35
      ? `${pick(rand, NAME_CORE)} ${pick(rand, NAME_SUFFIX)}`
      : `${pick(rand, NAME_PREFIX)} ${pick(rand, NAME_CORE)} ${pick(rand, NAME_SUFFIX)}`;

    // Longitude degrees are shorter than latitude degrees away from the equator,
    // so scale the spread to keep the "circle" of hotels roughly round on a map.
    const lngScale = 1 / Math.cos((city.lat * Math.PI) / 180);

    hotels.push({
      id: i + 1,
      key: `${name}|${address}`,
      name,
      address,
      cityId: city.id,
      city: city.name,
      country: city.country,
      lat: +(city.lat + between(rand, -0.05, 0.05)).toFixed(6),
      lng: +(city.lng + between(rand, -0.05, 0.05) * lngScale).toFixed(6),
      avgScore: reviewScore(rand),
      reviewCount: Math.round(20 * Math.pow(250, rand())), // 20..5000, most hotels at the low end
      occupancy: between(rand, 0.25, 0.75), // how busy this hotel usually is; used for availability
    });
  }
  return hotels;
}

// ---------- room types ----------

function generateRoomTypes(hotel) {
  const rand = seededRandom(hashInt(`rooms-${hotel.key}`));
  const city = CITIES[hotel.cityId - 1];

  // Better-reviewed hotels cost more: score 6 -> x0.6, score 9.6 -> x1.32, then +/-15% per hotel.
  const hotelBaseRupees =
    city.baseRupees * (0.6 + (hotel.avgScore - 6) * 0.2) * between(rand, 0.85, 1.15);

  // Fisher-Yates shuffle of the optional types (sort(() => rand() - 0.5) is biased).
  const extras = ROOM_TYPES.slice(1).map((t, idx) => ({ ...t, catalogIndex: idx + 1 }));
  for (let i = extras.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [extras[i], extras[j]] = [extras[j], extras[i]];
  }
  const count = 2 + Math.floor(rand() * 3); // 2, 3 or 4 room types
  const chosen = [{ ...ROOM_TYPES[0], catalogIndex: 0 }, ...extras.slice(0, count - 1)]
    .sort((a, b) => a.catalogIndex - b.catalogIndex);

  return chosen.map((t) => ({
    // Stable id: hotel 17's Deluxe King (catalog index 3) is always 174.
    id: hotel.id * 10 + t.catalogIndex,
    hotelId: hotel.id,
    name: t.name,
    maxGuests: t.maxGuests,
    totalRooms: t.catalogIndex === 0 ? 4 + Math.floor(rand() * 12) : 1 + Math.floor(rand() * 8),
    basePricePaise: Math.round((hotelBaseRupees * t.mult) / 100) * 100 * 100, // whole Rs 100
  }));
}

// ---------- one night ----------

// Month (0-11) -> price and demand multiplier. Summer and December are peak season.
const SEASON = [0.85, 0.85, 0.95, 1.0, 1.05, 1.15, 1.25, 1.25, 1.1, 1.0, 0.95, 1.15];

// dateStr is 'YYYY-MM-DD'. Depends only on (hotel, room type, date), so a night generated
// today and the same night generated next month by the worker get identical values.
function generateNight(hotel, roomType, dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay();
  const weekend = dow === 5 || dow === 6 ? 1.2 : 1.0; // Friday and Saturday nights
  const season = SEASON[d.getUTCMonth()];
  const seed = `${hotel.key}|${roomType.name}|${dateStr}`;

  const jitter = 0.9 + hashFloat(seed + '|price') * 0.2; // +/-10%
  const pricePaise = Math.max(100, Math.round((roomType.basePricePaise * weekend * season * jitter) / 100) * 100);

  // Rooms already sold elsewhere before our system went live. Busier on weekends and in season,
  // so some nights are sold out (0) and some have 1 left: search and Reserve have real work to do.
  const demand = Math.min(1, hotel.occupancy * weekend * season * (0.7 + hashFloat(seed + '|occ') * 0.6));
  const sold = Math.min(roomType.totalRooms, Math.round(roomType.totalRooms * demand));

  return { pricePaise, availableCount: roomType.totalRooms - sold };
}

// 'YYYY-MM-DD' strings for `days` nights starting at startStr, in UTC.
function nightDates(startStr, days) {
  const start = Date.parse(startStr + 'T00:00:00Z');
  return Array.from({ length: days }, (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10));
}

module.exports = {
  CITIES, ROOM_TYPES,
  hashInt, seededRandom,
  generateHotels, generateRoomTypes, generateNight, nightDates,
};
