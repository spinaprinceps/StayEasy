// The "where / when / how many" form. Used on the search page (with city)
// and on the hotel page (without city, to change dates or guests).
import { useState } from 'react'
import { addDays, localToday } from '../format'

export default function StayForm({ initial, withCity = true, fieldErrors = {}, submitLabel = 'Search', onSubmit }) {
  const [form, setForm] = useState(initial)
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }))

  // Moving check-in past check-out? Push check-out to the next day so the form is never invalid.
  const setCheckIn = (e) => {
    const checkIn = e.target.value
    setForm((f) => ({ ...f, checkIn, checkOut: f.checkOut > checkIn ? f.checkOut : addDays(checkIn, 1) }))
  }

  const submit = (e) => {
    e.preventDefault()
    onSubmit({ ...form, city: form.city?.trim() })
  }

  // The browser's min/required checks are for convenience only. The server checks everything
  // again (a user can edit the HTML or call the API directly), and its errors show under the fields.
  return (
    <form className="stay-form" onSubmit={submit}>
      {withCity && (
        <Field label="City" error={fieldErrors.city}>
          <input value={form.city} onChange={set('city')} placeholder="e.g. Milan" required />
        </Field>
      )}
      <Field label="Check-in" error={fieldErrors.checkIn}>
        <input type="date" value={form.checkIn} min={localToday()} onChange={setCheckIn} required />
      </Field>
      <Field label="Check-out" error={fieldErrors.checkOut}>
        <input type="date" value={form.checkOut} min={addDays(form.checkIn || localToday(), 1)} onChange={set('checkOut')} required />
      </Field>
      <Field label="Guests" error={fieldErrors.guests}>
        <input type="number" min="1" max="10" value={form.guests} onChange={set('guests')} required />
      </Field>
      <button type="submit" className="primary">{submitLabel}</button>
    </form>
  )
}

function Field({ label, error, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {error && <small className="field-error">{error}</small>}
    </label>
  )
}
