// /?city=Milan&checkIn=...&checkOut=...&guests=2&page=1
//
// The search lives in the URL, not only in React state. So refresh, the back button,
// and sharing a link all show the same results. The form just WRITES the URL;
// the results READ it.
import { Link, useSearchParams } from 'react-router-dom'
import StayForm from '../components/StayForm'
import { toQuery } from '../api'
import { useApi } from '../useApi'
import { addDays, formatPaise, localToday, plural } from '../format'

export default function SearchPage() {
  const [params, setParams] = useSearchParams()
  const query = {
    city: params.get('city') ?? '',
    checkIn: params.get('checkIn') ?? addDays(localToday(), 1),
    checkOut: params.get('checkOut') ?? addDays(localToday(), 3),
    guests: params.get('guests') ?? '2',
    page: Number(params.get('page') ?? 1),
  }

  // Only search once there is a city in the URL.
  const { data, error, loading } = useApi(query.city ? `/search?${toQuery(query)}` : null)

  const goTo = (changes) => setParams(toQuery({ ...query, ...changes }))
  const totalPages = data ? Math.ceil(data.totalHotels / data.pageSize) : 0
  const stayQuery = toQuery({ checkIn: query.checkIn, checkOut: query.checkOut, guests: query.guests })

  return (
    <>
      <section className="hero">
        <h1>Find a place to stay</h1>
        {/* key: remount the form when the URL changes (e.g. back button) so it shows the URL's values */}
        <StayForm
          key={params.toString()}
          initial={query}
          fieldErrors={error?.fieldErrors}
          onSubmit={(f) => goTo({ ...f, page: 1 })}
        />
      </section>

      {error && !Object.keys(error.fieldErrors).length && <p className="notice error">{error.message}</p>}

      {data && (
        <section className={loading ? 'results loading' : 'results'}>
          <p className="muted">
            {data.totalHotels === 0
              ? `No hotels in ${query.city} have a room for ${plural(Number(query.guests), 'guest')} on all of those nights.`
              : `${plural(data.totalHotels, 'hotel')} in ${data.city} · ${plural(data.nights, 'night')} · cheapest room shown, taxes included`}
          </p>

          <ul className="hotel-list">
            {data.hotels.map((h) => (
              <li key={h.id} className="card hotel-card">
                <div>
                  <h2><Link to={`/hotels/${h.id}?${stayQuery}`}>{h.name}</Link></h2>
                  <p className="muted">{h.address}</p>
                  {h.avgScore !== null && (
                    <p><span className="score">{h.avgScore.toFixed(1)}</span> {plural(h.reviewCount, 'review')}</p>
                  )}
                </div>
                <div className="price-col">
                  <p className="muted">{h.roomType.name}</p>
                  <p className="price">{formatPaise(h.price.flexible.totalPaise)}</p>
                  <p className="muted small">for {plural(data.nights, 'night')}, incl. tax</p>
                  {/* Could be stale a second later, and that's fine: Reserve re-checks in the database. */}
                  {h.roomsLeft <= 3 && <p className="warn small">Only {h.roomsLeft} left</p>}
                  <Link className="button" to={`/hotels/${h.id}?${stayQuery}`}>See rooms</Link>
                </div>
              </li>
            ))}
          </ul>

          {totalPages > 1 && (
            <nav className="pager">
              <button disabled={query.page <= 1} onClick={() => goTo({ page: query.page - 1 })}>Previous</button>
              <span>Page {query.page} of {totalPages}</span>
              <button disabled={query.page >= totalPages} onClick={() => goTo({ page: query.page + 1 })}>Next</button>
            </nav>
          )}
        </section>
      )}

      {loading && !data && <p className="muted">Searching…</p>}
    </>
  )
}
