// Page layout and the list of pages (routes).
import { Link, NavLink, Route, Routes } from 'react-router-dom'
import { useAuth } from './auth'
import SearchPage from './pages/SearchPage'
import HotelPage from './pages/HotelPage'
import AuthPage from './pages/AuthPage'
import HoldPage from './pages/HoldPage'
import BookingsPage from './pages/BookingsPage'
import BookingPage from './pages/BookingPage'
import './App.css'

export default function App() {
  const { user, logout } = useAuth()
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">StayEasy</Link>
        <nav>
          {user ? (
            <>
              <NavLink to="/bookings">My bookings</NavLink>
              <span className="muted small hide-narrow">{user.email}</span>
              <button onClick={logout}>Log out</button>
            </>
          ) : (
            <>
              <Link to="/login">Log in</Link>
              <Link to="/signup" className="button">Sign up</Link>
            </>
          )}
        </nav>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<SearchPage />} />
          <Route path="/hotels/:id" element={<HotelPage />} />
          <Route path="/holds/:id" element={<HoldPage />} />
          <Route path="/bookings" element={<BookingsPage />} />
          <Route path="/bookings/:id" element={<BookingPage />} />
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/signup" element={<AuthPage mode="signup" />} />
          <Route path="*" element={<p className="notice">Page not found. <Link to="/">Go to search</Link></p>} />
        </Routes>
      </main>
    </>
  )
}
