// Checks a search request BEFORE it touches the database.
//   1. parseSearchQuery(query)                   -> shape checks with zod (no database, no clock)
//   2. checkDatesForCity(search, timezone, now)  -> "not in the past, not too far ahead",
//                                                   judged by the calendar AT THE HOTEL
// Both return a list of problems ({ field, message }); an empty list means OK.
const { z } = require('zod');

const MAX_NIGHTS = 30;
const MAX_DAYS_AHEAD = 365;
const DAY_MS = 86400000;

// Calendar days between two 'YYYY-MM-DD' strings, counted at UTC midnight
// (UTC has no clock changes, so every day is exactly 24h).
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

const SearchQuery = z
  .object({
    city: z.string().trim().min(1, 'city is required'),
    checkIn: z.iso.date('checkIn must be a real date as YYYY-MM-DD'),   // rejects 2026-02-30
    checkOut: z.iso.date('checkOut must be a real date as YYYY-MM-DD'),
    guests: z.coerce.number().int().min(1).max(10).default(1),           // "2" -> 2
    page: z.coerce.number().int().min(1).default(1),
  })
  .transform((q) => ({ ...q, nights: daysBetween(q.checkIn, q.checkOut) }))
  .refine((q) => q.nights >= 1, { path: ['checkOut'], message: 'checkOut must be after checkIn' })
  .refine((q) => q.nights <= MAX_NIGHTS, {
    path: ['checkOut'], message: `a stay can be at most ${MAX_NIGHTS} nights`,
  });

function parseSearchQuery(query) {
  const result = SearchQuery.safeParse(query);
  if (result.success) return { errors: [], search: result.data };
  return {
    errors: result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
  };
}

// Today's date where the hotel is, e.g. '2026-11-08' in Europe/London.
// The 'en-CA' locale is used only because it formats dates as YYYY-MM-DD.
function todayIn(timezone, now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

// `now` is a parameter (not read inside) so a test can pretend it is any moment.
function checkDatesForCity(search, timezone, now = new Date()) {
  const ahead = daysBetween(todayIn(timezone, now), search.checkIn);
  if (ahead < 0) return [{ field: 'checkIn', message: 'checkIn is in the past at the hotel' }];
  if (ahead > MAX_DAYS_AHEAD) {
    return [{ field: 'checkIn', message: `checkIn can be at most ${MAX_DAYS_AHEAD} days ahead` }];
  }
  return [];
}

module.exports = { parseSearchQuery, checkDatesForCity, todayIn };
