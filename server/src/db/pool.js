const { Pool } = require('pg');

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
