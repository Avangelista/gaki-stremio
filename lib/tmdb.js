const { getCached } = require("./cache");
const API_KEY = process.env.TMDB_API_KEY || "";
const BASE = "https://api.themoviedb.org/3";
const IMG_BASE = "https://image.tmdb.org/t/p/";
const TMDB_TTL = 24 * 60 * 60 * 1000; // 24h — show metadata and episode lists change rarely
const FETCH_TIMEOUT = 10_000;          // 10s timeout for TMDB API calls

/** @returns {boolean} Whether a TMDB API key is configured */
function isAvailable() {
  return API_KEY.length > 0;
}

/**
 * Fetch with a timeout via AbortController.
 * @param {string} url
 * @param {RequestInit} [opts]
 * @returns {Promise<Response>}
 */
async function tmdbFetch(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a full TMDB image URL from a relative path.
 * @param {string|null} path - Relative image path from TMDB API
 * @param {string} [size="w500"] - TMDB image size preset
 * @returns {string|null}
 */
function imageUrl(path, size = "w500") {
  return path ? `${IMG_BASE}${size}${path}` : null;
}

/**
 * Fetch show-level metadata from TMDB (poster, backdrop, logo, genres, rating, etc.).
 * Returns null if TMDB is unavailable or the request fails.
 * @param {number} tmdbId
 * @returns {Promise<{name: string, overview: string, poster: string|null, backdrop: string|null, logo: string|null, genres: string[], rating: number, firstAired: string}|null>}
 */
async function getShowDetails(tmdbId) {
  if (!isAvailable()) return null;
  return getCached(`tmdb_show_${tmdbId}`, TMDB_TTL, async () => {
    try {
      const res = await tmdbFetch(`${BASE}/tv/${tmdbId}?api_key=${API_KEY}&append_to_response=images`);
      if (!res.ok) return null;
      const data = await res.json();
      const englishLogo = (data.images?.logos || []).find((l) => l.iso_639_1 === "en");
      const anyLogo = (data.images?.logos || [])[0];
      return {
        name: data.name,
        overview: data.overview,
        poster: imageUrl(data.poster_path, "w500"),
        backdrop: imageUrl(data.backdrop_path, "w1280"),
        logo: imageUrl((englishLogo || anyLogo)?.file_path, "w500"),
        genres: (data.genres || []).map((g) => g.name),
        rating: data.vote_average,
        firstAired: data.first_air_date,
      };
    } catch (err) {
      console.warn(`TMDB fetch failed for ${tmdbId}:`, err.message);
      return null;
    }
  });
}

/**
 * Fetch all episodes for a TMDB show, indexed by air date.
 * Skips season 0 (specials). Returns an empty Map if unavailable.
 * @param {number} tmdbId
 * @returns {Promise<Map<string, {season: number, episode: number, name: string, overview: string, still: string|null, runtime: number|null}>>}
 */
async function getEpisodesByDate(tmdbId) {
  if (!isAvailable()) return new Map();
  return getCached(`tmdb_eps_${tmdbId}`, TMDB_TTL, async () => {
    const dateMap = new Map();
    try {
      const showRes = await tmdbFetch(`${BASE}/tv/${tmdbId}?api_key=${API_KEY}`);
      if (!showRes.ok) return dateMap;
      const show = await showRes.json();
      const seasonNums = (show.seasons || [])
        .map((s) => s.season_number)
        .filter((n) => n > 0); // skip specials (season 0)

      const seasons = await Promise.all(
        seasonNums.map(async (num) => {
          try {
            const res = await tmdbFetch(`${BASE}/tv/${tmdbId}/season/${num}?api_key=${API_KEY}`);
            if (!res.ok) return null;
            return res.json();
          } catch {
            return null;
          }
        })
      );

      for (const season of seasons) {
        if (!season?.episodes) continue;
        for (const ep of season.episodes) {
          if (ep.air_date) {
            dateMap.set(ep.air_date, {
              season: ep.season_number,
              episode: ep.episode_number,
              name: ep.name,
              overview: ep.overview || "",
              still: imageUrl(ep.still_path, "w300"),
              runtime: ep.runtime,
            });
          }
        }
      }
    } catch (err) {
      console.warn(`TMDB episodes fetch failed for ${tmdbId}:`, err.message);
    }
    return dateMap;
  });
}

module.exports = { isAvailable, getShowDetails, getEpisodesByDate };
