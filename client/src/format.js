// Display helpers. NOTHING here decides a price: the server sends the numbers, we only show them.

// 850000 paise -> "₹8,500.00". Integer maths only: 850000 / 100 as a float is fine,
// but 1999 / 100 = 19.99 can print as 19.990000000000002 in other operations. Splitting
// into rupees and paise with whole numbers never has that problem.
export function formatPaise(paise) {
  const rupees = Math.floor(paise / 100)
  const rest = String(paise % 100).padStart(2, '0')
  return `₹${rupees.toLocaleString('en-IN')}.${rest}`
}

// Today's date on THIS computer as 'YYYY-MM-DD'.
// Not new Date().toISOString().slice(0, 10): that gives the date in UTC, which in India
// before 5:30 am is still YESTERDAY. The classic off-by-one-day bug.
export function localToday() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// '2026-12-11' + 3 -> '2026-12-14'. Done in UTC, where every day is exactly 24h
// (no clock changes), so adding days never lands on the wrong date.
export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// '2026-12-11' -> 'Fri 11 Dec'. timeZone UTC so the date isn't shifted by the viewer's zone.
export function formatDate(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  })
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
