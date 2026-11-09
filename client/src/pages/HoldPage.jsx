// /holds/:id: "your room is held for 9:42", with the frozen price, and Pay.
//
// Pay flow as the guest sees it:
//   1. Pay -> POST /holds/:id/pay -> { checkoutUrl } -> the browser goes to the GATEWAY's page.
//   2. The gateway sends them back here (?intent=pi_...). The page does NOT trust that return
//      visit as proof of payment: anyone can type that URL. It just shows "confirming..." and
//      asks the server every 2s until the webhook (or reconciler) has turned the hold into a booking.
import { useEffect, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import PriceBreakdown from '../components/PriceBreakdown'
import { apiFetch } from '../api'
import { useApi } from '../useApi'
import { useAuth } from '../auth'
import { formatDate, formatPaise, plural } from '../format'

const RATE_NAMES = { flexible: 'Flexible', non_refundable: 'Non-refundable' }
const FAILURE_TEXT = {
  card_declined: 'Your card was declined.',
  canceled_by_merchant: 'The payment timed out.',
  not_found_at_gateway: 'The payment provider did not start your payment.',
}
const POLL_MS = 2000

export default function HoldPage() {
  const { user } = useAuth()
  const location = useLocation()
  const { id } = useParams()
  const { data: hold, error, loading, refresh } = useApi(user ? `/holds/${encodeURIComponent(id)}` : null)

  // While the payment is being confirmed, ask again every 2 seconds.
  const status = hold?.status
  useEffect(() => {
    if (status !== 'payment_pending') return
    const t = setInterval(refresh, POLL_MS)
    return () => clearInterval(t)
  }, [status, refresh])

  if (!user) return <Navigate to="/login" state={{ from: location }} replace />
  if (error) return <p className="notice error">{error.status === 404 ? 'Hold not found.' : error.message} <Link to="/">Back to search</Link></p>
  if (loading || !hold) return <p className="muted">Loading…</p>
  if (hold.status === 'converted' && hold.bookingId) return <Navigate to={`/bookings/${hold.bookingId}?new=1`} replace />

  return (
    <section className="card hold">
      <h1>{hold.status === 'payment_pending' ? 'Confirming your payment' : 'Your room is on hold'}</h1>

      <StatusBanner hold={hold} onExpire={refresh} />

      <h2><Link to={`/hotels/${hold.hotel.id}`}>{hold.hotel.name}</Link></h2>
      <p>
        {hold.roomType.name} · {RATE_NAMES[hold.ratePlan]} rate<br />
        {formatDate(hold.checkIn)} – {formatDate(hold.checkOut)} · {plural(hold.price.nights.length, 'night')}, {plural(hold.guests, 'guest')}
      </p>
      <p className="price">{formatPaise(hold.price.totalPaise)}</p>
      <p className="muted small">incl. {formatPaise(hold.price.taxPaise)} tax · this price is fixed for you until the hold ends</p>
      <PriceBreakdown rate={hold.price} checkIn={hold.checkIn} />

      {(hold.status === 'active' || hold.status === 'payment_pending') && (
        <PayButton hold={hold} onChange={refresh} />
      )}
    </section>
  )
}

function StatusBanner({ hold, onExpire }) {
  if (hold.status === 'payment_pending') {
    return (
      <p className="notice">
        <span className="spinner" aria-hidden="true" /> Waiting for the payment provider to confirm.
        This page updates by itself. Your room stays held while we wait.
      </p>
    )
  }
  if (hold.status === 'expired') {
    return <p className="notice error">This hold has expired and the room was released. <Link to={`/hotels/${hold.hotel.id}`}>Check availability again</Link></p>
  }
  return (
    <>
      {hold.payment?.status === 'failed' && (
        <p className="notice error">
          {FAILURE_TEXT[hold.payment.failureReason] ?? 'Your payment did not go through.'} You were not charged. Your room is still held: you can try again.
        </p>
      )}
      <Countdown key={`${hold.holdId}:${hold.secondsLeft}`} secondsLeft={hold.secondsLeft} onZero={onExpire} />
    </>
  )
}

// Counts down from the SERVER's secondsLeft, not from expiresAt minus the browser's clock:
// if the user's computer clock is 5 minutes wrong, expiresAt - Date.now() would be 5 minutes wrong too.
function Countdown({ secondsLeft, onZero }) {
  const [left, setLeft] = useState(secondsLeft)

  useEffect(() => {
    if (left <= 0) {
      onZero() // ask the server: it decides that the hold is over, not this timer
      return
    }
    const t = setTimeout(() => setLeft((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [left, onZero])

  if (left <= 0) return <p className="notice error">Time is up. Checking…</p>
  const mm = Math.floor(left / 60)
  const ss = String(left % 60).padStart(2, '0')
  return <p className={left <= 60 ? 'notice error' : 'notice'}>Held for you for <strong>{mm}:{ss}</strong>. Pay before the timer runs out.</p>
}

function PayButton({ hold, onChange }) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const pending = hold.status === 'payment_pending'

  const pay = async () => {
    setBusy(true)
    setError(null)
    try {
      const { checkoutUrl } = await apiFetch(`/holds/${hold.holdId}/pay`, { method: 'POST' })
      window.location.assign(checkoutUrl) // leave our site: the card is entered on the gateway's page
    } catch (err) {
      setBusy(false)
      if (err.status === 409 && err.body?.bookingId) return navigate(`/bookings/${err.body.bookingId}`)
      setError(err)
      onChange() // the hold may have moved on (expired, now pending): show its real state
    }
  }

  return (
    <div className="pay-box">
      {error && <p className="notice error small">{error.message}</p>}
      <button className="primary big" onClick={pay} disabled={busy}>
        {busy ? 'Opening payment page…' : pending ? 'Back to the payment page' : `Pay ${formatPaise(hold.price.totalPaise)}`}
      </button>
      <p className="muted small">You'll pay on FakePay's secure page and come straight back here.</p>
    </div>
  )
}
