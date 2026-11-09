// Load data for a page: useApi(path) -> { data, error, loading, refresh }.
//
// The important part is the AbortController. If the user searches "Milan" then quickly
// "Rome", two requests are in flight. If Milan's reply arrives LAST, a naive page would
// show Milan's hotels under a "Rome" heading. Cancelling the old request when the path
// changes means only the latest request can ever update the page.
//
// refresh() fetches the same path again WITHOUT going back to "loading", so a page can poll
// (e.g. "waiting for your payment...") without flashing.
import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from './api'

export function useApi(path) {
  // Remember WHICH path the stored result belongs to. "loading" is then just
  // "the result we have isn't for the path we want yet": derived, not stored.
  const [result, setResult] = useState({ path: null, data: null, error: null })
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    apiFetch(path, { signal: controller.signal })
      .then((data) => setResult({ path, data, error: null }))
      .catch((error) => {
        if (error.name === 'AbortError') return // replaced by a newer request: ignore
        setResult({ path, data: null, error })
      })
    return () => controller.abort()
  }, [path, tick])

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  if (!path) return { data: null, error: null, loading: false, refresh }
  const fresh = result.path === path
  return {
    data: result.data,                 // while loading, keep showing the previous data (dimmed)
    error: fresh ? result.error : null,
    loading: !fresh,
    refresh,
  }
}
