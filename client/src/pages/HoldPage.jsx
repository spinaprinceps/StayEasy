// /holds/:id: "your room is held for 9:42", with the frozen price.
import { useEffect, useState } from 'react'
import { Link, Navigate, useLocation, useParams } from 'react-router-dom'
import PriceBreakdown from '../components/PriceBreakdown'
import { useApi } from '../useApi'
import { useAuth } from '../auth'
import { formatDate, formatPaise, plural } from '../format'

const RATE_NAMES = { flexible: 'Flexible', non_refundable: 'Non-refundable' }

export default function HoldPage() {
  const { user } = useAuth()
  const location = useLocation()
  const { id } = useParams()
  const { data: hold, error, loading } = useApi(user ? `/holds/${encodeURIComponent(id)}` : null)

  if (!user) return <Navigate to="/login" state={{ from: location }} replace />
  if (error) return <p className="notice error">{error.status === 404 ? 'Hold not found.' : error.message} <Link to="/">Back to search</Link></p>
  if (loading || !hold) return <p className="muted">Loading…</p>

  return (
    <section className="card hold">
      <h1>Your room is on hold</h1>
      <Countdown key={hold.holdId} secondsLeft={hold.secondsLeft} status={hold.status} />

      <h2><Link to={`/hotels/${hold.hotel.id}`}>{hold.hotel.name}</Link></h2>
      <p>
        {hold.roomType.name} · {RATE_NAMES[hold.ratePlan]} rate<br />
        {formatDate(hold.checkIn)} – {formatDate(hold.checkOut)} · {plural(hold.price.nights.length, 'night')}, {plural(hold.guests, 'guest')}
      </p>
      <p className="price">{formatPaise(hold.price.totalPaise)}</p>
      <p className="muted small">incl. {formatPaise(hold.price.taxPaise)} tax · this price is fixed for you until the hold ends</p>
      <PriceBreakdown rate={hold.price} checkIn={hold.checkIn} />

      <button className="primary" disabled title="Payment is feature 7">Pay (coming soon)</button>
    </section>
  )
}

// Counts down from the SERVER's secondsLeft, not from expiresAt minus the browser's clock:
// if the user's computer clock is 5 minutes wrong, expiresAt - Date.now() would be 5 minutes wrong too.
function Countdown({ secondsLeft, status }) {
  const [left, setLeft] = useState(secondsLeft)

  useEffect(() => {
    if (left <= 0) return
    const t = setTimeout(() => setLeft((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [left])

  if (status !== 'active' || left <= 0) {
    return <p className="notice error">This hold has expired. The room may no longer be available. <Link to="/">Search again</Link></p>
  }
  const mm = Math.floor(left / 60)
  const ss = String(left % 60).padStart(2, '0')
  return <p className={left <= 60 ? 'notice error' : 'notice'}>Held for you for <strong>{mm}:{ss}</strong>. Pay before the timer runs out.</p>
}
