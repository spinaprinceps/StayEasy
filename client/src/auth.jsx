// Who is logged in, available to every page via useAuth().
//
// The token lives in localStorage so a refresh doesn't log you out.
// Trade-off: any script running on this page can read localStorage. The safer option is an
// httpOnly cookie (JavaScript can't read it), but that needs CSRF protection on the server.
// For this project localStorage is the simpler, stated choice.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { apiFetch, setAuth } from './api'

const STORAGE_KEY = 'stayeasy.session'
const AuthContext = createContext(null)

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY))
    // Expired while the tab was closed? Treat as logged out, don't wait for a 401.
    if (s && s.token && s.expiresAt > Date.now()) return s
  } catch { /* storage blocked or corrupt: just start logged out */ }
  return null
}

function saveSession(s) {
  try {
    if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
    else localStorage.removeItem(STORAGE_KEY)
  } catch { /* storage blocked: the session just won't survive a refresh */ }
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(loadSession) // { token, expiresAt, email } or null

  const logout = useCallback(() => {
    saveSession(null)
    setSession(null)
  }, [])

  // Keep api.js in step with the current token. Runs before any child effect fetches.
  setAuth(session?.token ?? null, logout)

  // Log out exactly when the token expires, even if the user is just sitting on a page.
  useEffect(() => {
    if (!session) return
    const t = setTimeout(logout, session.expiresAt - Date.now())
    return () => clearTimeout(t)
  }, [session, logout])

  const login = useCallback(async (email, password) => {
    const { token, expiresIn } = await apiFetch('/auth/login', { method: 'POST', body: { email, password } })
    // The server says how long the token lasts; we store WHEN it ends.
    const s = { token, expiresAt: Date.now() + expiresIn * 1000, email: email.trim().toLowerCase() }
    saveSession(s)
    setSession(s)
  }, [])

  const signup = useCallback(async (email, password) => {
    await apiFetch('/auth/signup', { method: 'POST', body: { email, password } })
    await login(email, password) // sign up, then log straight in
  }, [login])

  const value = useMemo(() => ({ user: session, login, signup, logout }), [session, login, signup, logout])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext)
