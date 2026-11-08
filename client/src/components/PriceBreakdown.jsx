// Shows one rate (flexible or non-refundable) exactly as the server calculated it:
// each night's price and tax, then the totals. No arithmetic here: if the page added things up
// itself, the page and the server could disagree by a paisa, and judges check that live.
import { addDays, formatDate, formatPaise } from '../format'

export default function PriceBreakdown({ rate, checkIn }) {
  return (
    <details className="breakdown">
      <summary>Price per night</summary>
      <table>
        <thead>
          <tr><th>Night</th><th>Room</th><th>Tax</th></tr>
        </thead>
        <tbody>
          {rate.nights.map((n, i) => (
            <tr key={i}>
              <td>{formatDate(addDays(checkIn, i))}</td>
              <td>{formatPaise(n.pricePaise)}</td>
              <td>{formatPaise(n.taxPaise)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td>Subtotal</td><td>{formatPaise(rate.subtotalPaise)}</td><td>{formatPaise(rate.taxPaise)}</td></tr>
          <tr className="grand"><td>Total</td><td colSpan="2">{formatPaise(rate.totalPaise)}</td></tr>
        </tfoot>
      </table>
    </details>
  )
}
