const API_KEY = process.env.TMDB_API_KEY || "";
const BASE = "https://api.themoviedb.org/3";
const IMG_BASE = "https://image.tmdb.org/t/p/";
const TMDB_TTL = 24 * 60 * 60 * 1000;

const cache = new Map();

function getCached(key, ttlMs, fetchFn) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < ttlMs) return Promise.resolve(entry.data);
  return fetchFn().then((data) => {
    cache.set(key, { data, time: Date.now() });
    return data;
  });
}

function isAvailable() {
  return API_KEY.length > 0;
}

function imageUrl(path, size = "w500") {
  return path ? `${IMG_BASE}${size}${path}` : null;
}

async function getShowDetails(tmdbId) {
  if (!isAvailable()) return null;
  return getCached(`tmdb_show_${tmdbId}`, TMDB_TTL, async () => {
    try {
      const res = await fetch(`${BASE}/tv/${tmdbId}?api_key=${API_KEY}&append_to_response=images`);
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

// Returns Map<"YYYY-MM-DD", {season, episode, name}> for a show
async function getEpisodesByDate(tmdbId) {
  if (!isAvailable()) return new Map();
  return getCached(`tmdb_eps_${tmdbId}`, TMDB_TTL, async () => {
    const dateMap = new Map();
    try {
      // Get season list
      const showRes = await fetch(`${BASE}/tv/${tmdbId}?api_key=${API_KEY}`);
      if (!showRes.ok) return dateMap;
      const show = await showRes.json();
      const seasonNums = (show.seasons || [])
        .map((s) => s.season_number)
        .filter((n) => n > 0); // skip specials (season 0)

      // Fetch all seasons in parallel
      const seasons = await Promise.all(
        seasonNums.map(async (num) => {
          try {
            const res = await fetch(`${BASE}/tv/${tmdbId}/season/${num}?api_key=${API_KEY}`);
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

module.exports = { getShowDetails, getEpisodesByDate };
