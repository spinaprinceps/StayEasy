// /bookings/:id: one booking, its cancellation deadline (in HOTEL time), and Cancel.
//
// Every number here comes from the server, including "you'd get ₹X back if you cancel now"
// (refundIfCancelledNowPaise). The page never works out a refund itself: money rules live
// in one place (server/src/pricing.js), and the server's clock decides "before the deadline".
import { useState } from 'react'
import { Link, Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom'
import PriceBreakdown from '../components/PriceBreakdown'
import { StatusPill } from './BookingsPage'
import { apiFetch } from '../api'
import { useApi } from '../useApi'
import { useAuth } from '../auth'
import { formatDate, formatHotelTime, formatMoment, formatPaise, plural } from '../format'

const RATE_NAMES = { flexible: 'Flexible', non_refundable: 'Non-refundable' }

export default function BookingPage() {
  const { user } = useAuth()
  const location = useLocation()
  const { id } = useParams()
  const [params] = useSearchParams()
  const { data: booking, error, loading, refresh } = useApi(user ? `/bookings/${encodeURIComponent(id)}` : null)

  if (!user) return <Navigate to="/login" state={{ from: location }} replace />
  if (error) return <p className="notice error">{error.status === 404 ? 'Booking not found.' : error.message} <Link to="/bookings">My bookings</Link></p>
  if (loading || !booking) return <p className="muted">Loading…</p>

  return (
    <section className="card hold">
      <p><Link to="/bookings">← My bookings</Link></p>
      {params.get('new') && booking.status === 'confirmed' && (
        <p className="notice success">Payment received. Your booking is confirmed!</p>
      )}

      <div className="row-between">
        <h1>{booking.hotel.name}</h1>
        <StatusPill booking={booking} />
      </div>
      <p className="muted">Booking #{booking.bookingId} · {booking.hotel.city}</p>
      <p>
        {booking.roomType.name} · {RATE_NAMES[booking.ratePlan]} rate<br />
        {formatDate(booking.checkIn)} – {formatDate(booking.checkOut)} · {plural(booking.price.nights.length, 'night')}, {plural(booking.guests, 'guest')}
      </p>
      <p className="price">{formatPaise(booking.totalPaise)}</p>
      <p className="muted small">paid, incl. {formatPaise(booking.price.taxPaise)} tax</p>
      <PriceBreakdown rate={booking.price} checkIn={booking.checkIn} />

      {booking.status === 'cancelled' ? <Cancelled booking={booking} /> : <CancelBox booking={booking} onCancelled={refresh} />}
    </section>
  )
}

function Cancelled({ booking }) {
  return (
    <div className="notice">
      <p>Cancelled on {formatMoment(booking.cancelledAt)}.</p>
      {booking.refundPaise > 0 ? (
        <p>
          Refund of <strong>{formatPaise(booking.refundPaise)}</strong>{' '}
          {booking.refundStatus === 'succeeded'
            ? 'has been sent to your card.'
            : 'is on its way (the payment provider is slow right now; we will keep trying).'}
        </p>
      ) : (
        <p>No refund: {booking.ratePlan === 'non_refundable' ? 'this was a non-refundable rate.' : 'it was cancelled after the free-cancellation deadline.'}</p>
      )}
    </div>
  )
}

function CancelBox({ booking, onCancelled }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const deadline = `${formatHotelTime(booking.cancelDeadlineLocal)} (${booking.hotel.timezone} time)`

  if (!booking.canCancel) {
    return <p className="notice">Check-in time has passed, so this booking can no longer be cancelled.</p>
  }

  const cancel = async () => {
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`/bookings/${booking.bookingId}/cancel`, { method: 'POST' })
      onCancelled()
    } catch (err) {
      setError(err)
      setBusy(false)
      onCancelled() // whatever happened, show the booking as the server now sees it
    }
  }

  const refund = booking.refundIfCancelledNowPaise
  return (
    <div className="cancel-box">
      <h3>Cancellation</h3>
      {booking.ratePlan === 'non_refundable' ? (
        <p>Non-refundable rate: you can cancel, but no money comes back.</p>
      ) : booking.beforeDeadline ? (
        <p>Free cancellation until <strong>{deadline}</strong>.</p>
      ) : (
        <p>The free-cancellation deadline ({deadline}) has passed. Cancelling now refunds everything except the first night.</p>
      )}
      <p>If you cancel now you get back <strong>{formatPaise(refund)}</strong>.</p>

      {error && <p className="notice error small">{error.message}</p>}
      {!confirming ? (
        <button onClick={() => setConfirming(true)}>Cancel booking</button>
      ) : (
        <div className="confirm-row">
          <span>Cancel and get {formatPaise(refund)} back?</span>
          <button className="danger" onClick={cancel} disabled={busy}>{busy ? 'Cancelling…' : 'Yes, cancel'}</button>
          <button onClick={() => setConfirming(false)} disabled={busy}>Keep booking</button>
        </div>
      )}
    </div>
  )
}
