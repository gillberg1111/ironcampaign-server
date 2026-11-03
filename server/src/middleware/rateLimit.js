// In-memory window limiter. Entries older than the window are dropped on each check so a
// long-lived process does not keep one row per client IP forever.

export function slidingWindowLimit(map, key, { windowMs, max }) {
  const now = Date.now();
  for (const [k, entry] of map) {
    if (!entry || now - entry.windowStart > windowMs) map.delete(k);
  }
  const current = map.get(key);
  if (!current) {
    map.set(key, { count: 1, windowStart: now });
    return;
  }
  current.count += 1;
  if (current.count > max) {
    const err = new Error('rate limited');
    err.status = 429;
    throw err;
  }
}
