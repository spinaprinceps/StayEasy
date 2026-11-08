// Checks a search or hotel-details request BEFORE it touches the database.
//   1. parseSearchQuery(query) / parseStayQuery(query) -> shape checks with zod (no database, no clock)
//   2. checkDatesForCity(stay, timezone, now)          -> "not in the past, not too far ahead",
//                                                        judged by the calendar AT THE HOTEL
// All return a list of problems ({ field, message }); an empty list means OK.
const { z } = require('zod');

const MAX_NIGHTS = 30;
const MAX_DAYS_AHEAD = 365;
const DAY_MS = 86400000;

// Calendar days between two 'YYYY-MM-DD' strings, counted at UTC midnight
// (UTC has no clock changes, so every day is exactly 24h).
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

// The fields every "a stay of N nights for G guests" request has: search AND hotel details.
// Shared so both endpoints accept exactly the same dates; if they disagreed, a hotel found
// in search could reject the same dates on its own page.
const stayFields = {
  checkIn: z.iso.date('checkIn must be a real date as YYYY-MM-DD'),   // rejects 2026-02-30
  checkOut: z.iso.date('checkOut must be a real date as YYYY-MM-DD'),
  guests: z.coerce.number().int().min(1).max(10).default(1),           // "2" -> 2
};

const withStayRules = (schema) =>
  schema
    .transform((q) => ({ ...q, nights: daysBetween(q.checkIn, q.checkOut) }))
    .refine((q) => q.nights >= 1, { path: ['checkOut'], message: 'checkOut must be after checkIn' })
    .refine((q) => q.nights <= MAX_NIGHTS, {
      path: ['checkOut'], message: `a stay can be at most ${MAX_NIGHTS} nights`,
    });

const SearchQuery = withStayRules(
  z.object({
    city: z.string().trim().min(1, 'city is required'),
    ...stayFields,
    page: z.coerce.number().int().min(1).default(1),
  })
);

const StayQuery = withStayRules(z.object(stayFields));

function parseWith(schema, query) {
  const result = schema.safeParse(query);
  if (result.success) return { errors: [], data: result.data };
  return {
    errors: result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
  };
}

function parseSearchQuery(query) {
  const { errors, data } = parseWith(SearchQuery, query);
  return { errors, search: data };
}

function parseStayQuery(query) {
  const { errors, data } = parseWith(StayQuery, query);
  return { errors, stay: data };
}

// Today's date where the hotel is, e.g. '2026-11-08' in Europe/London.
// The 'en-CA' locale is used only because it formats dates as YYYY-MM-DD.
function todayIn(timezone, now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

// `now` is a parameter (not read inside) so a test can pretend it is any moment.
function checkDatesForCity(stay, timezone, now = new Date()) {
  const ahead = daysBetween(todayIn(timezone, now), stay.checkIn);
  if (ahead < 0) return [{ field: 'checkIn', message: 'checkIn is in the past at the hotel' }];
  if (ahead > MAX_DAYS_AHEAD) {
    return [{ field: 'checkIn', message: `checkIn can be at most ${MAX_DAYS_AHEAD} days ahead` }];
  }
  return [];
}

module.exports = { parseSearchQuery, parseStayQuery, checkDatesForCity, todayIn };
