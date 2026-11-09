// /bookings: everything this guest has booked. Upcoming first (the server sorts).
import { Link, Navigate, useLocation } from 'react-router-dom'
import { useApi } from '../useApi'
import { useAuth } from '../auth'
import { formatDate, formatPaise, localToday, plural } from '../format'

export default function BookingsPage() {
  const { user } = useAuth()
  const location = useLocation()
  const { data, error, loading } = useApi(user ? '/bookings' : null)

  if (!user) return <Navigate to="/login" state={{ from: location }} replace />
  if (error) return <p className="notice error">{error.message}</p>
  if (loading || !data) return <p className="muted">Loading…</p>

  const today = localToday()
  const upcoming = data.data.filter((b) => b.status === 'confirmed' && b.checkOut >= today)
  const past = data.data.filter((b) => !upcoming.includes(b))

  return (
    <>
      <h1>My bookings</h1>
      {data.data.length === 0 && (
        <p className="notice">No bookings yet. <Link to="/">Find a place to stay</Link></p>
      )}
      {upcoming.length > 0 && <BookingList title="Upcoming" bookings={upcoming} />}
      {past.length > 0 && <BookingList title="Past and cancelled" bookings={past} />}
    </>
  )
}

function BookingList({ title, bookings }) {
  return (
    <section>
      <h2 className="section-title">{title}</h2>
      <ul className="booking-list">
        {bookings.map((b) => (
          <li key={b.bookingId}>
            <Link to={`/bookings/${b.bookingId}`} className={`card booking-card ${b.status}`}>
              <div>
                <h3>{b.hotel.name}</h3>
                <p className="muted small">{b.hotel.city} · {b.roomType.name}</p>
                <p>{formatDate(b.checkIn)} – {formatDate(b.checkOut)} · {plural(b.price.nights.length, 'night')}, {plural(b.guests, 'guest')}</p>
              </div>
              <div className="price-col">
                <StatusPill booking={b} />
                <p className="price">{formatPaise(b.totalPaise)}</p>
                {b.status === 'cancelled' && b.refundPaise > 0 && (
                  <p className="muted small">refund {formatPaise(b.refundPaise)}</p>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function StatusPill({ booking }) {
  if (booking.status === 'cancelled') return <span className="pill cancelled">Cancelled</span>
  return <span className="pill confirmed">Confirmed</span>
}
