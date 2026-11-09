const { Pool, types } = require('pg');

// Postgres `date` columns ('2026-12-11') are turned into JavaScript Date objects by default,
// at MIDNIGHT IN THE SERVER'S TIME ZONE. In India that's 2026-12-10T18:30Z, so the moment
// you send it as JSON the check-in date is a day early. A calendar date has no time and
// no zone: keep it as the plain string Postgres sends. (1082 = the id of the `date` type.)
types.setTypeParser(1082, (value) => value);

// Connection details come from PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGPORT.
const pool = new Pool({
  max: 10,
  connectionTimeoutMillis: 2000, // fail fast if the DB is down
  idleTimeoutMillis: 30000,
});

// Without this, an idle connection dropping (e.g. Postgres restart)
// emits an unhandled 'error' event and crashes the process.
pool.on('error', (err) => {
  console.error('Idle DB client error:', err.message);
});

module.exports = pool;
