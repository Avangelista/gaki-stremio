require("dotenv").config();
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { version } = require("./package.json");
const api = require("./lib/api");
const tmdb = require("./lib/tmdb");
const tvdb = require("./lib/tvdb");
const { seriesId, episodeId, parseCategoryId, parseVideoId, formatDuration } = require("./lib/utils");

// Load and validate mappings: categoryId (number) -> external IDs
const mappingsData = require("./data/mappings.json");
if (!mappingsData.categories || typeof mappingsData.categories !== "object") {
  throw new Error("mappings.json: missing or invalid 'categories' object");
}
if (Object.keys(mappingsData.categories).length === 0) {
  throw new Error("mappings.json: 'categories' is empty");
}
const tmdbMappings = new Map();
for (const [catId, tmdbId] of Object.entries(mappingsData.tmdb || {})) {
  tmdbMappings.set(parseInt(catId, 10), tmdbId);
}
const tvdbMappings = new Map();
for (const [catId, tvdbId] of Object.entries(mappingsData.tvdb || {})) {
  tvdbMappings.set(parseInt(catId, 10), tvdbId);
}
// Manual video → season/episode overrides for videos that can't be matched automatically
const overrides = mappingsData.overrides || {};

const CATALOG_PAGE_SIZE = 100; // Max items per catalog page returned to Stremio

async function getTmdbForCategory(categoryId) {
  const tmdbId = tmdbMappings.get(categoryId);
  if (!tmdbId) return null;
  return tmdb.getShowDetails(tmdbId);
}

/** Attempt an async enrichment, returning null on failure. */
async function tryEnrich(fn) {
  try { return await fn(); } catch { return null; }
}

const manifest = {
  id: "com.gakiarchives.stremio",
  version,
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

// Logging convention:
//   console.warn  — recoverable degradation (e.g. optional TMDB/TVDB enrichment failed)
//   console.error — handler-level failure that returns an empty/null response to Stremio

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

      const allCatIds = [...seen.keys()];
      const skip = Math.max(0, parseInt(extra.skip) || 0);
      const catIds = allCatIds.slice(skip, skip + CATALOG_PAGE_SIZE);
      const [tmdbDetails, posters] = await Promise.all([
        Promise.all(catIds.map((id) => tryEnrich(() => getTmdbForCategory(id)))),
        Promise.all(catIds.map((id) => tryEnrich(() => api.getPoster(id)))),
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
    const skip = Math.max(0, parseInt(extra.skip) || 0);
    const page = categories.slice(skip, skip + CATALOG_PAGE_SIZE);

    const [tmdbDetails, posters] = await Promise.all([
      Promise.all(page.map((cat) => tryEnrich(() => getTmdbForCategory(cat.id)))),
      Promise.all(page.map((cat) => tryEnrich(() => api.getPoster(cat.id)))),
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
    const tvdbId = tvdbMappings.get(categoryId);
    const [videos, tmdbData, tmdbEpMap, tvdbEpMap] = await Promise.all([
      api.getVideosByCategory(categoryId),
      getTmdbForCategory(categoryId),
      tmdbId ? tmdb.getEpisodesByDate(tmdbId) : Promise.resolve(new Map()),
      tvdbId ? tvdb.getEpisodesByDate(tvdbId) : Promise.resolve(new Map()),
    ]);
    // Merge: TVDB as base, TMDB overwrites (has images/English overviews)
    const episodeMap = new Map([...tvdbEpMap, ...tmdbEpMap]);

    const name = api.getCategoryName(categoryId);

    // Deduplicate videos with the same air date — keep highest ID (newest upload)
    // Matches dates in titles like "2023-01-15" or "2023.01.15"
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

    // Sort undated episodes by number extracted from title
    // Dated episodes already sorted by date from the API; undated ones need numeric ordering
    function extractSortNum(title) {
      // Try "Part N" first for multi-part episodes
      const partMatch = title.match(/Part\s*(\d+)/i);
      // Try "S__E__" for season/episode
      const seMatch = title.match(/S(\d+)E(\d+)/i);
      // Sort key: season*1000 + episode for S__E__ patterns (e.g. S05E01 = 5001)
      if (seMatch) return parseInt(seMatch[1], 10) * 1000 + parseInt(seMatch[2], 10);
      // Match a standalone number at start/end of segments (e.g. "Silent Library - 6", "Suberanai 7")
      const nums = title.match(/(?:^|[- ])\s*(\d+)(?:\s*$|\s*[-– ])/g);
      const firstNum = nums ? parseInt(nums[0].replace(/[^0-9]/g, ''), 10) : null;
      // Primary number * 100 + part number gives stable ordering (e.g. "Episode 3 Part 2" = 302)
      if (firstNum != null && partMatch) return firstNum * 100 + parseInt(partMatch[1], 10);
      if (firstNum != null) return firstNum * 100;
      if (partMatch) return parseInt(partMatch[1], 10);
      return Infinity;
    }
    deduped.sort((a, b) => {
      const aDate = a.title.match(dateRe);
      const bDate = b.title.match(dateRe);
      // Dated episodes first (keep their existing order via stable sort)
      if (aDate && !bDate) return -1;
      if (!aDate && bDate) return 1;
      if (aDate && bDate) return 0; // preserve existing date order
      // Both undated — sort by extracted number
      const aVal = extractSortNum(a.title);
      const bVal = extractSortNum(b.title);
      return aVal - bVal;
    });

    const episodeCount = `${deduped.length} episode${deduped.length !== 1 ? "s" : ""} from Gaki Archives`;

    const catOverrides = overrides[String(categoryId)];
    let undatedEpNum = 0;

    const episodes = deduped.map((v, i) => {
        const m = v.title.match(dateRe);
        let airDate = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
        let epMatch = airDate ? episodeMap.get(airDate) : null;

        // No date match — try matching by name (e.g. "Absolutely Tasty Takoyaki" -> TVDB "Takoyaki")
        if (!epMatch && !airDate && episodeMap.size > 0) {
          const titleLower = v.title.toLowerCase();
          for (const [date, ep] of episodeMap) {
            if (ep.name && titleLower.includes(ep.name.toLowerCase())) {
              epMatch = ep;
              airDate = date;
              break;
            }
          }
        }

        // Manual override: maps specific video IDs to season/episode when auto-matching fails
        const videoOverride = catOverrides?.[String(v.id)];
        if (!epMatch && videoOverride) {
          for (const [date, ep] of episodeMap) {
            if (ep.season === videoOverride.season && ep.episode === videoOverride.episode) {
              epMatch = ep;
              airDate = date;
              break;
            }
          }
        }

        // Parse S__E__ from title (e.g. "Documental - S8E4", "GameCenter CX S05E01")
        const seMatch = v.title.match(/S(\d{1,2})E(\d{1,2})/i);

        // Determine season/episode number
        let season, episode;
        if (epMatch) {
          season = epMatch.season;
          episode = epMatch.episode;
        } else if (videoOverride) {
          season = videoOverride.season;
          episode = videoOverride.episode;
        } else if (seMatch) {
          season = parseInt(seMatch[1], 10);
          episode = parseInt(seMatch[2], 10);
        } else {
          season = airDate ? 1 : 0;
          episode = airDate ? (i + 1) : ++undatedEpNum;
        }

        return {
          id: episodeId(categoryId, v.id),
          title: v.title,
          season,
          episode,
          released: airDate ? new Date(airDate).toISOString() : undefined,
          thumbnail: epMatch?.still || v.poster_url || v.thumbnail_url,
          overview: epMatch?.overview || v.description || undefined,
        };
      });

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
        videos: episodes,
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

// Log API key availability at startup
if (!tmdb.isAvailable()) {
  console.warn("TMDB_API_KEY not set — show metadata enrichment will be disabled");
}
if (!tvdb.isAvailable()) {
  console.warn("TVDB_API_KEY not set — TVDB episode enrichment will be disabled");
}

const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port });
console.log(`Gaki Archives addon running on http://localhost:${port}`);
