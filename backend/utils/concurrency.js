/**
 * Small helpers that keep bursty work from swamping the shared MySQL pool
 * (db.js: ~40 connections, bounded queue). When one request fans out into
 * hundreds of parallel queries, every other user's queries queue behind it
 * or are rejected with "Queue limit reached".
 */

/**
 * Like Promise.all(items.map(fn)) but runs at most `limit` calls at a time.
 * Results keep input order. A rejection stops scheduling new items and
 * rejects the whole call (same as Promise.all).
 */
async function mapWithConcurrency(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  const width = Math.max(1, Math.min(Number(limit) || 1, list.length));
  let next = 0;

  const worker = async () => {
    while (next < list.length) {
      const index = next++;
      results[index] = await fn(list[index], index);
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/**
 * Shared, short-lived memo for expensive read-only results that are the same
 * for every caller (e.g. admin dashboard aggregates). Concurrent callers for
 * the same key share one in-flight promise, so N admins refreshing at once
 * cost one set of queries instead of N. Failures are never cached.
 */
function createSharedCache({ ttlMs = 1000, maxEntries = 500 } = {}) {
  const entries = new Map(); // key -> { expiresAt, promise }

  return function cached(key, loader) {
    const now = Date.now();
    const hit = entries.get(key);
    if (hit && hit.expiresAt > now) return hit.promise;

    const promise = Promise.resolve().then(loader);
    // In-flight entries never expire; the TTL starts once the value settles.
    const entry = { expiresAt: Infinity, promise };
    entries.set(key, entry);
    promise.then(
      () => {
        entry.expiresAt = Date.now() + ttlMs;
      },
      () => {
        if (entries.get(key) === entry) entries.delete(key);
      },
    );

    if (entries.size > maxEntries) {
      for (const [k, v] of entries) {
        if (entries.size <= maxEntries) break;
        if (v.expiresAt <= now) entries.delete(k);
      }
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    }
    return promise;
  };
}

module.exports = { mapWithConcurrency, createSharedCache };
