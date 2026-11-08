// Writes the synthetic dataset to CSV files, one per table, ready for Postgres COPY.
//
// Usage:
//   npm run gen                              # medium tier (1,500 hotels), 365 nights from today
//   npm run gen -- --tier=large              # 20,000 hotels
//   npm run gen -- --hotels=50 --days=30     # any custom size
//   npm run gen -- --start=2026-12-01        # fixed start date (same files on any day)
//
// Output: db/seed/data/<tier>/{cities,hotels,room_types,room_nights}.csv + manifest.json
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const {
  CITIES, generateHotels, generateRoomTypes, generateNight, nightDates,
} = require('./synthetic');

const TIERS = { small: 200, medium: 1500, large: 20000 };

function parseArgs(argv) {
  const args = Object.fromEntries(
    argv.filter((a) => a.startsWith('--')).map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k, v ?? 'true'];
    })
  );
  const tier = args.tier || (args.hotels ? 'custom' : 'medium');
  const hotels = args.hotels ? Number(args.hotels) : TIERS[tier];
  if (!Number.isInteger(hotels) || hotels <= 0) {
    throw new Error(`Unknown tier "${tier}". Use one of ${Object.keys(TIERS).join(', ')} or --hotels=N`);
  }
  const days = Number(args.days || 365);
  const start = args.start || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error('--start must be YYYY-MM-DD');
  return { tier, hotels, days, start, out: args.out || path.join(__dirname, 'data', tier) };
}

// CSV field: quote it only if it contains a comma, quote or newline; double any quotes inside.
function csv(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// A CSV writer that respects backpressure: if the OS buffer is full, wait for 'drain'.
// Without this, 20M rows would pile up in memory before reaching the disk.
function csvWriter(file, header) {
  const stream = fs.createWriteStream(file);
  stream.write(header.join(',') + '\n');
  let rows = 0;
  return {
    async row(values) {
      rows++;
      if (!stream.write(values.map(csv).join(',') + '\n')) await once(stream, 'drain');
    },
    async close() {
      stream.end();
      await once(stream, 'finish');
      return rows;
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  fs.mkdirSync(opts.out, { recursive: true });
  console.log(`generating ${opts.hotels} hotels x ${opts.days} nights from ${opts.start} -> ${opts.out}`);

  const cities = csvWriter(path.join(opts.out, 'cities.csv'), ['id', 'name', 'country', 'timezone']);
  for (const c of CITIES) await cities.row([c.id, c.name, c.country, c.timezone]);

  const hotels = csvWriter(path.join(opts.out, 'hotels.csv'),
    ['id', 'city_id', 'name', 'address', 'lat', 'lng', 'avg_score', 'review_count']);
  const roomTypes = csvWriter(path.join(opts.out, 'room_types.csv'),
    ['id', 'hotel_id', 'name', 'max_guests', 'total_rooms', 'base_price_paise']);
  const roomNights = csvWriter(path.join(opts.out, 'room_nights.csv'),
    ['room_type_id', 'night', 'price_paise', 'available_count']);

  const dates = nightDates(opts.start, opts.days);
  const perCity = {};
  let soldOut = 0;
  let lastRoom = 0;

  const all = generateHotels(opts.hotels);
  for (let i = 0; i < all.length; i++) {
    const h = all[i];
    perCity[h.city] = (perCity[h.city] || 0) + 1;
    await hotels.row([h.id, h.cityId, h.name, h.address, h.lat, h.lng, h.avgScore, h.reviewCount]);

    for (const rt of generateRoomTypes(h)) {
      await roomTypes.row([rt.id, rt.hotelId, rt.name, rt.maxGuests, rt.totalRooms, rt.basePricePaise]);
      for (const d of dates) {
        const n = generateNight(h, rt, d);
        if (n.availableCount === 0) soldOut++;
        if (n.availableCount === 1) lastRoom++;
        await roomNights.row([rt.id, d, n.pricePaise, n.availableCount]);
      }
    }
    if ((i + 1) % 1000 === 0) console.log(`  ${i + 1}/${all.length} hotels`);
  }

  const counts = {
    cities: await cities.close(),
    hotels: await hotels.close(),
    room_types: await roomTypes.close(),
    room_nights: await roomNights.close(),
  };
  const manifest = {
    ...opts, out: undefined, generatedAt: new Date().toISOString(),
    counts, hotelsPerCity: perCity,
    nights: { soldOut, oneRoomLeft: lastRoom },
  };
  fs.writeFileSync(path.join(opts.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(counts);
  console.log('hotels per city:', perCity);
  console.log(`sold-out nights: ${soldOut}, one-room-left nights: ${lastRoom}`);
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('Generate failed:', err.message);
  process.exit(1);
});
