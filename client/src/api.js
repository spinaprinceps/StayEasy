// The ONE place the front end talks to the API.
// Every call goes through apiFetch so token handling and error shapes are dealt with once.

// The server sends errors in two shapes:
//   { error: 'message' }                        -> one message
//   { errors: [{ field, message }, ...] }       -> per-field problems (400 from zod)
// ApiError turns both into one thing pages can use: err.message and err.fieldErrors.
export class ApiError extends Error {
  constructor(status, body) {
    const fieldErrors = {};
    for (const e of body?.errors ?? []) fieldErrors[e.field] = e.message;
    super(body?.error ?? body?.errors?.[0]?.message ?? `Request failed (${status})`);
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

let currentToken = null;
let onUnauthorized = () => {};

// Called by AuthProvider, so this file doesn't need to know about React.
export function setAuth(token, handleUnauthorized) {
  currentToken = token;
  onUnauthorized = handleUnauthorized;
}

export async function apiFetch(path, { method = 'GET', body, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (currentToken) headers.Authorization = `Bearer ${currentToken}`;

  let res;
  try {
    res = await fetch(`/api${path}`, {
      method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err; // the page cancelled it on purpose: not an error
    throw new ApiError(0, { error: 'Cannot reach the server. Is the API running?' });
  }

  // 204 or an empty body: nothing to parse.
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON: e.g. proxy error page */ }

  if (!res.ok) {
    // We sent a token and the server rejected it: it expired. Log out everywhere.
    if (res.status === 401 && currentToken) onUnauthorized();
    throw new ApiError(res.status, data);
  }
  return data;
}

// URLSearchParams from a plain object, skipping empty values.
export const toQuery = (params) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')).toString();
