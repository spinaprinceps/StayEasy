const express = require('express');
const pool = require('./db/pool');
const searchRouter = require('./routes/search');

const app = express();
app.use(express.json());

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'down', error: err.message });
  }
});

app.use('/search', searchRouter);

// Last stop for any error a route didn't handle (Express 5 forwards async errors here).
// Log the details for us; never send stack traces or SQL to the user.
app.use((err, req, res, next) => {
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = app;
