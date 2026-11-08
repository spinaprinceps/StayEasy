// /login and /signup: one page, two modes.
// After success, go back to where the user was (e.g. the hotel they wanted to reserve).
import { useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth'

export default function AuthPage({ mode }) {
  const { user, login, signup } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [form, setForm] = useState({ email: '', password: '' })
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const from = location.state?.from ?? '/'
  if (user) return <Navigate to={from} replace />

  const isSignup = mode === 'signup'
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true) // also blocks double-clicks sending two sign-ups
    setError(null)
    try {
      await (isSignup ? signup : login)(form.email, form.password)
      navigate(from, { replace: true })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const fe = error?.fieldErrors ?? {}
  return (
    <section className="card auth-card">
      <h1>{isSignup ? 'Create an account' : 'Log in'}</h1>
      <form onSubmit={submit}>
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="email" value={form.email} onChange={set('email')} required />
          {fe.email && <small className="field-error">{fe.email}</small>}
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete={isSignup ? 'new-password' : 'current-password'}
            minLength={isSignup ? 8 : undefined}
            value={form.password}
            onChange={set('password')}
            required
          />
          {fe.password && <small className="field-error">{fe.password}</small>}
        </label>
        {error && !Object.keys(fe).length && <p className="notice error">{error.message}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Please wait…' : isSignup ? 'Sign up' : 'Log in'}
        </button>
      </form>
      <p className="muted small">
        {isSignup
          ? <>Already have an account? <Link to="/login" state={location.state}>Log in</Link></>
          : <>New here? <Link to="/signup" state={location.state}>Create an account</Link></>}
      </p>
    </section>
  )
}
