// The desktop app serves this page with a per-launch token in <meta name="app-token">.
// No token => we're the plain website, and every app-only feature stays hidden.
const token = document.querySelector('meta[name="app-token"]')?.content || "";
export const isApp = token.length > 10;

async function req(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "X-App-Token": token, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => req("GET", p),
  post: (p, b = {}) => req("POST", p, b),
  del: (p) => req("DELETE", p),
};

/** Subscribe to server-sent events (radar alerts, job output). Returns an unsubscribe fn. */
export function openEvents(onEvent) {
  const es = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch {
      /* ignore malformed */
    }
  };
  return () => es.close();
}
