// Thin fetch layer with memoization for static objects.
const memo = new Map();

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function cached(url) {
  if (!memo.has(url)) memo.set(url, get(url).catch(e => { memo.delete(url); throw e; }));
  return memo.get(url);
}

export const api = {
  catalog: () => cached('/api/catalog'),
  field: () => cached('/api/field'),
  logs: (w, b) => cached(`/api/wb/${w}/${b}/logs`),
  obj: (w, b, name) => cached(`/api/wb/${w}/${b}/obj/${name}`),
  messages: (w, b) => cached(`/api/wb/${w}/${b}/messages`),
  snapshot: (w, b, t) => get(`/api/wb/${w}/${b}/snapshot?t=${Math.round(t)}`),
  series: (w, b, src, ch, x0, x1, n, states = false) => {
    const q = new URLSearchParams({ src, ch: ch.join(','), n: String(Math.round(n)) });
    if (x0 != null) q.set('x0', String(x0));
    if (x1 != null) q.set('x1', String(x1));
    if (states) q.set('states', states === true ? 'calc' : states);
    return get(`/api/wb/${w}/${b}/series?${q}`);
  },
};
