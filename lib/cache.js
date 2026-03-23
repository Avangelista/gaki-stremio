const cache = new Map();
const inflight = new Map();
const MAX_ENTRIES = 500;

/**
 * Returns cached data if fresh, otherwise calls fetchFn and caches the result.
 * Concurrent requests for the same expired key share a single fetch (no thundering herd).
 * @param {string} key - Cache key
 * @param {number} ttlMs - Time-to-live in milliseconds
 * @param {() => Promise<*>} fetchFn - Async function that produces the value
 * @returns {Promise<*>} Cached or freshly fetched data
 */
function getCached(key, ttlMs, fetchFn) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < ttlMs) return Promise.resolve(entry.data);

  // Return existing in-flight promise if another caller is already fetching
  if (inflight.has(key)) return inflight.get(key);

  const promise = fetchFn().then((data) => {
    // Evict oldest entries if cache is full
    if (cache.size >= MAX_ENTRIES) {
      const first = cache.keys().next().value;
      cache.delete(first);
    }
    cache.set(key, { data, time: Date.now() });
    inflight.delete(key);
    return data;
  }).catch((err) => {
    inflight.delete(key);
    throw err;
  });

  inflight.set(key, promise);
  return promise;
}

module.exports = { getCached };
