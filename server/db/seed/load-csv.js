// Loads the synthetic CSVs (from `npm run gen`) into Postgres. Safe to run again.
//
// Usage: npm run seed                 # loads db/seed/data/medium
//        npm run seed -- large        # loads db/seed/data/large
//
// For each table, in foreign-key order:
//   1. COPY the CSV into a temporary staging table (fast bulk load, no constraints to trip on)
//   2. INSERT ... SELECT from staging into the real table, with a per-table conflict rule
//   3. move the id counter past the highest id, so normal INSERTs don't collide
// Everything runs in ONE transaction: the load either fully happens or not at all.
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { from: copyFrom } = require('pg-copy-streams');
const { Pool } = require('pg');

const tier = process.argv[2] || 'medium';
const dir = path.join(__dirname, 'data', tier);

// Order matters: parents before children, or the foreign keys reject the rows.
const TABLES = [
  {
    name: 'cities',
    columns: ['id', 'name', 'country', 'timezone'],
    onConflict: `(id) DO UPDATE SET name = EXCLUDED.name, country = EXCLUDED.country,
                                    timezone = EXCLUDED.timezone`,
    identity: true,
  },
  {
    name: 'hotels',
    columns: ['id', 'city_id', 'name', 'address', 'lat', 'lng', 'avg_score', 'review_count'],
    onConflict: `(id) DO UPDATE SET city_id = EXCLUDED.city_id, name = EXCLUDED.name,
                                    address = EXCLUDED.address, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
                                    avg_score = EXCLUDED.avg_score, review_count = EXCLUDED.review_count`,
    identity: true,
  },
  {
    name: 'room_types',
    columns: ['id', 'hotel_id', 'name', 'max_guests', 'total_rooms', 'base_price_paise'],
    // total_rooms is deliberately NOT updated: available_count on existing nights was
    // computed from it, and bookings have already taken rooms off those counts.
    onConflict: `(id) DO UPDATE SET name = EXCLUDED.name, max_guests = EXCLUDED.max_guests,
                                    base_price_paise = EXCLUDED.base_price_paise`,
    identity: true,
  },
  {
    name: 'room_nights',
    columns: ['room_type_id', 'night', 'price_paise', 'available_count'],
    // Never overwrite an existing night: it may have holds and bookings against it.
    onConflict: '(room_type_id, night) DO NOTHING',
    identity: false,
  },
];

async function loadTable(client, t) {
  const file = path.join(dir, `${t.name}.csv`);
  if (!fs.existsSync(file)) throw new Error(`missing ${file} (run: npm run gen -- --tier=${tier})`);
  const cols = t.columns.join(', ');
  const staging = `staging_${t.name}`;

  // Same column types as the real table, but no constraints and dropped at COMMIT.
  await client.query(
    `CREATE TEMP TABLE ${staging} ON COMMIT DROP AS SELECT ${cols} FROM ${t.name} WITH NO DATA`
  );
  await pipeline(
    fs.createReadStream(file),
    client.query(copyFrom(`COPY ${staging} (${cols}) FROM STDIN WITH (FORMAT csv, HEADER)`))
  );

  const res = await client.query(
    `INSERT INTO ${t.name} (${cols}) SELECT ${cols} FROM ${staging} ON CONFLICT ${t.onConflict}`
  );

  if (t.identity) {
    // COPY with explicit ids doesn't advance the identity counter; do it by hand.
    await client.query(
      `SELECT setval(pg_get_serial_sequence('${t.name}', 'id'),
                     (SELECT coalesce(max(id), 1) FROM ${t.name}))`
    );
  }
  return res.rowCount; // rows inserted or updated (DO NOTHING rows are not counted)
}

async function main() {
  const started = Date.now();
  const pool = new Pool({ max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const t of TABLES) {
      const t0 = Date.now();
      const n = await loadTable(client, t);
      console.log(`${t.name.padEnd(12)} ${String(n).padStart(9)} rows written  (${Date.now() - t0} ms)`);
    }
    await client.query('COMMIT');
    // Fresh statistics so the query planner knows how big the tables now are.
    await client.query('ANALYZE cities, hotels, room_types, room_nights');
    console.log(`loaded tier "${tier}" in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
