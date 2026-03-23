const { getCached } = require("./cache");
const API_KEY = process.env.TVDB_API_KEY || "";
const BASE = "https://api4.thetvdb.com/v4";
const TVDB_TTL = 24 * 60 * 60 * 1000;    // 24h — episode data cache TTL
const FETCH_TIMEOUT = 10_000;             // 10s timeout for TVDB API calls
const MAX_PAGES = 20;                     // Safety limit for episode pagination

let token = null;
let tokenTime = 0;
const TOKEN_TTL = 23 * 60 * 60 * 1000;   // 23h — refresh token before its 24h server-side expiry

/** @returns {boolean} Whether a TVDB API key is configured */
function isAvailable() {
  return API_KEY.length > 0;
}

/**
 * Authenticate with TVDB and return a bearer token.
 * Reuses a cached token until it approaches expiry (23 hours).
 * @returns {Promise<string>}
 */
async function getToken() {
  if (token && Date.now() - tokenTime < TOKEN_TTL) return token;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apikey: API_KEY }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`TVDB login failed: ${res.status}`);
    const data = await res.json();
    token = data.data.token;
    tokenTime = Date.now();
    return token;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch JSON from a TVDB endpoint with bearer token authentication.
 * Retries once on 401 in case the token was invalidated early.
 * @param {string} url
 * @returns {Promise<*>}
 */
async function fetchTVDB(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const t = await getToken();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${t}` },
      signal: controller.signal,
    });
    if (res.status === 401) {
      // Token may have been invalidated early — clear and retry once
      token = null;
      tokenTime = 0;
      const t2 = await getToken();
      const res2 = await fetch(url, {
        headers: { Authorization: `Bearer ${t2}` },
        signal: controller.signal,
      });
      if (!res2.ok) throw new Error(`TVDB ${res2.status}: ${url}`);
      return await res2.json();
    }
    if (!res.ok) throw new Error(`TVDB ${res.status}: ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch all episodes for a TVDB show, indexed by air date.
 * Returns an empty Map if TVDB is unavailable or the request fails.
 * @param {number} tvdbId
 * @returns {Promise<Map<string, {season: number, episode: number, name: string|undefined, overview: string|undefined}>>}
 */
async function getEpisodesByDate(tvdbId) {
  if (!isAvailable()) return new Map();
  return getCached(`tvdb_eps_${tvdbId}`, TVDB_TTL, async () => {
    const dateMap = new Map();
    try {
      let page = 0;
      while (true) {
        const data = await fetchTVDB(
          `${BASE}/series/${tvdbId}/episodes/eng?page=${page}`
        );
        const episodes = data.data?.episodes || [];
        for (const ep of episodes) {
          if (ep.aired) {
            dateMap.set(ep.aired, {
              season: ep.seasonNumber,
              episode: ep.number,
              name: ep.name || undefined,
              overview: ep.overview || undefined,
            });
          }
        }
        if (!data.links?.next) break;
        page++;
        if (page >= MAX_PAGES) break;
      }
      if (page >= MAX_PAGES) {
        console.warn(`TVDB pagination limit reached for series ${tvdbId} (${MAX_PAGES} pages)`);
      }
    } catch (err) {
      console.warn(`TVDB episodes fetch failed for ${tvdbId}:`, err.message);
    }
    return dateMap;
  });
}

module.exports = { isAvailable, getEpisodesByDate };
