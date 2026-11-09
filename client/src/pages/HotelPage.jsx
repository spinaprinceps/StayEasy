// /hotels/:id?checkIn=...&checkOut=...&guests=2
// The hotel and every room type, with why a room can't be booked when it can't.
import { useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import StayForm from '../components/StayForm'
import PriceBreakdown from '../components/PriceBreakdown'
import { apiFetch, toQuery } from '../api'
import { useApi } from '../useApi'
import { useAuth } from '../auth'
import { addDays, formatDate, formatPaise, localToday, plural } from '../format'

// What to tell the user for each status the API sends.
const STATUS_TEXT = {
  too_small: (guests) => `Not enough room for ${plural(guests, 'guest')}`,
  not_on_sale: () => 'Not on sale for these dates',
  sold_out: () => 'Sold out for at least one of your nights',
}

export default function HotelPage() {
  const { id } = useParams()
  const [params, setParams] = useSearchParams()
  const stay = {
    checkIn: params.get('checkIn') ?? addDays(localToday(), 1),
    checkOut: params.get('checkOut') ?? addDays(localToday(), 3),
    guests: params.get('guests') ?? '2',
  }
  const { data, error, loading } = useApi(`/hotels/${encodeURIComponent(id)}?${toQuery(stay)}`)

  if (error?.status === 404) {
    return <p className="notice error">This hotel doesn't exist. <Link to="/">Back to search</Link></p>
  }

  return (
    <>
      <p><Link to={-1}>← Back</Link></p>

      {data && (
        <header className="hotel-header">
          <h1>{data.hotel.name}</h1>
          <p className="muted">{data.hotel.address}, {data.hotel.city}, {data.hotel.country}</p>
          {data.hotel.avgScore !== null && (
            <p><span className="score">{data.hotel.avgScore.toFixed(1)}</span> {plural(data.hotel.reviewCount, 'review')}</p>
          )}
        </header>
      )}

      <section className="card">
        <StayForm
          key={params.toString()}
          initial={stay}
          withCity={false}
          fieldErrors={error?.fieldErrors}
          submitLabel="Update"
          onSubmit={({ checkIn, checkOut, guests }) => setParams(toQuery({ checkIn, checkOut, guests }))}
        />
      </section>

      {error && error.status !== 404 && !Object.keys(error.fieldErrors).length && (
        <p className="notice error">{error.message}</p>
      )}
      {loading && !data && <p className="muted">Loading…</p>}

      {data && (
        <section className={loading ? 'loading' : ''}>
          <h2>
            Rooms for {formatDate(data.stay.checkIn)} – {formatDate(data.stay.checkOut)}
            <span className="muted"> · {plural(data.stay.nights, 'night')}, {plural(data.stay.guests, 'guest')}</span>
          </h2>
          {/* key: new dates/guests -> fresh components -> fresh Idempotency-Keys (see Rate) */}
          <ul className="room-list" key={toQuery(data.stay)}>
            {data.roomTypes.map((rt) => (
              <RoomType key={rt.id} rt={rt} stay={data.stay} />
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

function RoomType({ rt, stay }) {
  const available = rt.status === 'available'
  return (
    <li className={available ? 'card room' : 'card room unavailable'}>
      <div className="room-head">
        <h3>{rt.name}</h3>
        <p className="muted">Sleeps {rt.maxGuests}</p>
        {available
          ? rt.roomsLeft <= 3 && <p className="warn small">Only {rt.roomsLeft} left</p>
          : <p className="badge">{STATUS_TEXT[rt.status]?.(stay.guests) ?? 'Not available'}</p>}
      </div>

      {available && (
        <div className="rates">
          <Rate title="Flexible" note="Free cancellation before the deadline" rate={rt.price.flexible}
            stay={stay} roomTypeId={rt.id} ratePlan="flexible" />
          <Rate title="Non-refundable" note="12% cheaper, no refund if you cancel" rate={rt.price.nonRefundable}
            stay={stay} roomTypeId={rt.id} ratePlan="non_refundable" />
        </div>
      )}
    </li>
  )
}

function Rate({ title, note, rate, stay, roomTypeId, ratePlan }) {
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // ONE key per "I want this room, these dates, this rate", made once when this box appears.
  // A double-click, or clicking again after a network error, re-sends the SAME key, so the
  // server returns the same hold instead of taking a second room.
  const [idempotencyKey] = useState(() => crypto.randomUUID())

  const reserve = async () => {
    setBusy(true)
    setError(null)
    try {
      const hold = await apiFetch('/holds', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: { roomTypeId, checkIn: stay.checkIn, checkOut: stay.checkOut, guests: stay.guests, ratePlan },
      })
      navigate(`/holds/${hold.holdId}`)
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <div className="rate">
      <h4>{title}</h4>
      <p className="muted small">{note}</p>
      <p className="price">{formatPaise(rate.totalPaise)}</p>
      <p className="muted small">incl. {formatPaise(rate.taxPaise)} tax</p>
      <PriceBreakdown rate={rate} checkIn={stay.checkIn} />
      {/* The page showed "available" a moment ago, but only the server's answer counts:
          a 409 here is the "someone else got the last room" case, said plainly. */}
      {error && <p className="notice error small">{error.message}</p>}
      {user
        ? <button className="primary" onClick={reserve} disabled={busy}>{busy ? 'Reserving…' : 'Reserve'}</button>
        : <Link className="button" to="/login" state={{ from: location }}>Log in to reserve</Link>}
    </div>
  )
}
