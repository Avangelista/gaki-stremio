require("dotenv").config();
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const api = require("./lib/api");
const tmdb = require("./lib/tmdb");
const { seriesId, episodeId, parseCategoryId, parseVideoId, formatDuration } = require("./lib/utils");

// Load TMDB mappings: categoryId (number) -> tmdbId
const mappingsData = require("./data/mappings.json");
const tmdbMappings = new Map();
for (const [catId, tmdbId] of Object.entries(mappingsData.tmdb)) {
  tmdbMappings.set(parseInt(catId, 10), tmdbId);
}

async function getTmdbForCategory(categoryId) {
  const tmdbId = tmdbMappings.get(categoryId);
  if (!tmdbId) return null;
  return tmdb.getShowDetails(tmdbId);
}

const manifest = {
  id: "com.gakiarchives.stremio",
  version: "1.0.0",
  name: "Gaki Archives",
  description:
    "Japanese comedy shows from the Gaki Archives - Downtown, Gaki no Tsukai, and more",
  logo: "https://gakiarchives.com/img/logo.png",
  resources: [
    "catalog",
    { name: "meta", types: ["series"], idPrefixes: ["gaki_cat_"] },
    { name: "stream", types: ["series"], idPrefixes: ["gaki_cat_"] },
  ],
  types: ["series"],
  catalogs: [
    {
      type: "series",
      id: "gaki_archives",
      name: "Gaki Archives",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
  ],
  idPrefixes: ["gaki_cat_"],
};

const builder = new addonBuilder(manifest);

// --- Catalog Handler ---
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== "series" || id !== "gaki_archives") return { metas: [] };

  try {
    if (extra.search) {
      const videos = await api.searchVideos(extra.search);

      // Deduplicate by category, keep first match's poster
      const seen = new Map();
      for (const v of videos) {
        if (!seen.has(v.category_id)) {
          seen.set(v.category_id, v);
        }
      }

      const catIds = [...seen.keys()];
      const [tmdbDetails, posters] = await Promise.all([
        Promise.all(catIds.map(getTmdbForCategory)),
        Promise.all(catIds.map((id) => api.getPoster(id))),
      ]);
      const metas = catIds.map((catId, i) => ({
        id: seriesId(catId),
        type: "series",
        name: api.getCategoryName(catId),
        poster: tmdbDetails[i]?.poster || seen.get(catId).poster_url || posters[i],
      }));
      return { metas };
    }

    // Browse mode
    const categories = api.getCategories();
    const skip = parseInt(extra.skip) || 0;
    const page = categories.slice(skip, skip + 100);

    const [tmdbDetails, posters] = await Promise.all([
      Promise.all(page.map((cat) => getTmdbForCategory(cat.id))),
      Promise.all(page.map((cat) => api.getPoster(cat.id))),
    ]);
    const metas = page.map((cat, i) => ({
      id: seriesId(cat.id),
      type: "series",
      name: cat.name,
      poster: tmdbDetails[i]?.poster || posters[i],
    }));

    return { metas };
  } catch (err) {
    console.error("Catalog handler error:", err.message);
    return { metas: [] };
  }
});

// --- Meta Handler ---
builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "series") return { meta: null };

  const categoryId = parseCategoryId(id);
  if (!categoryId) return { meta: null };

  try {
    const tmdbId = tmdbMappings.get(categoryId);
    const [videos, tmdbData, episodeMap] = await Promise.all([
      api.getVideosByCategory(categoryId),
      getTmdbForCategory(categoryId),
      tmdbId ? tmdb.getEpisodesByDate(tmdbId) : Promise.resolve(new Map()),
    ]);

    const name = api.getCategoryName(categoryId);

    // Deduplicate videos with the same air date — keep highest ID (newest upload)
    const dateRe = /(\d{4})[.-](\d{2})[.-](\d{2})/;
    const seenDates = new Map();
    const deduped = [];
    for (const v of videos) {
      const m = v.title.match(dateRe);
      const airDate = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
      if (airDate && seenDates.has(airDate)) {
        const { index } = seenDates.get(airDate);
        if (v.id > deduped[index].id) {
          deduped[index] = v;
          seenDates.set(airDate, { index });
        }
      } else {
        if (airDate) seenDates.set(airDate, { index: deduped.length });
        deduped.push(v);
      }
    }

    const episodeCount = `${deduped.length} episode${deduped.length !== 1 ? "s" : ""} from Gaki Archives`;

    const meta = {
      id,
      type: "series",
      name,
      poster: tmdbData?.poster || deduped[0]?.poster_url || await api.getPoster(categoryId),
      background: tmdbData?.backdrop || undefined,
      logo: tmdbData?.logo || undefined,
      description: tmdbData?.overview ? `${tmdbData.overview}\n\n${episodeCount}` : `${name} — ${episodeCount}`,
      genres: tmdbData?.genres || [],
      imdbRating: tmdbData?.rating ? String(tmdbData.rating) : undefined,
      releaseInfo: tmdbData?.firstAired ? tmdbData.firstAired.substring(0, 4) : undefined,
      videos: deduped.map((v, i) => {
        const m = v.title.match(dateRe);
        let airDate = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
        let tmdbEp = airDate ? episodeMap.get(airDate) : null;

        // No date in title — only try fuzzy matching for full-length episodes (>=30min) with enough keywords
        if (!tmdbEp && episodeMap.size > 0 && v.duration_seconds >= 1800) {
          const stopWords = new Set(["wednesday", "downtown", "part", "with", "that", "this", "from", "have", "will", "been", "than", "they", "their", "what", "when", "which", "about", "would", "could", "episode", "theory", "special"]);
          const titleLower = v.title.toLowerCase();
          const words = titleLower.split(/[\s\-:,#]+/)
            .filter((w) => w.length > 3 && !stopWords.has(w) && !/^\d+$/.test(w));
          if (words.length >= 3) {
            let bestMatch = null;
            let bestScore = 0;
            for (const [date, ep] of episodeMap) {
              const haystack = `${ep.name} ${ep.overview}`.toLowerCase();
              const score = words.filter((w) => haystack.includes(w)).length;
              if (score > bestScore && score >= 3) {
                bestScore = score;
                bestMatch = { date, ep };
              }
            }
            if (bestMatch) {
              airDate = bestMatch.date;
              tmdbEp = bestMatch.ep;
            }
          }
        }

        return {
          id: episodeId(categoryId, v.id),
          title: v.title,
          season: tmdbEp ? tmdbEp.season : (airDate ? 1 : 0),
          episode: tmdbEp ? tmdbEp.episode : i + 1,
          released: airDate ? new Date(airDate).toISOString() : undefined,
          thumbnail: tmdbEp?.still || v.poster_url || v.thumbnail_url,
          overview: tmdbEp?.overview || v.description || formatDuration(v.duration_seconds),
        };
      }),
    };

    return { meta };
  } catch (err) {
    console.error("Meta handler error:", err.message);
    return { meta: null };
  }
});

// --- Stream Handler ---
builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "series") return { streams: [] };

  const categoryId = parseCategoryId(id);
  const videoId = parseVideoId(id);
  if (!categoryId || !videoId) return { streams: [] };

  try {
    const videos = await api.getVideosByCategory(categoryId);
    const video = videos.find((v) => v.id === videoId);
    if (!video) return { streams: [] };

    const streamUrl = `https://videos.gakiarchives.com/${video.id}.m3u8`;

    return {
      streams: [
        {
          url: streamUrl,
          name: "Gaki Archives",
          description: `${video.title}${video.duration_seconds ? " • " + formatDuration(video.duration_seconds) : ""}`,
          behaviorHints: {
            notWebReady: true,
            bingeGroup: `gaki_cat_${categoryId}`,
          },
        },
      ],
    };
  } catch (err) {
    console.error("Stream handler error:", err.message);
    return { streams: [] };
  }
});

const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port });
console.log(`Gaki Archives addon running on http://localhost:${port}`);
