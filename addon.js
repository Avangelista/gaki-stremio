const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const api = require("./lib/api");
const { seriesId, episodeId, parseCategoryId, parseVideoId, formatDuration } = require("./lib/utils");

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

  await api.warmPosters();

  if (extra.search) {
    const videos = await api.searchVideos(extra.search);
    const categories = await api.getCategories();
    const catMap = new Map(categories.map((c) => [c.id, c.name]));

    // Deduplicate by category, keep first match's poster
    const seen = new Map();
    for (const v of videos) {
      if (!seen.has(v.category_id)) {
        seen.set(v.category_id, v);
      }
    }

    const metas = [...seen.entries()].map(([catId, video]) => ({
      id: seriesId(catId),
      type: "series",
      name: catMap.get(catId) || `Category ${catId}`,
      poster: video.poster_url || api.getPoster(catId),
    }));
    return { metas };
  }

  // Browse mode
  const categories = await api.getCategories();
  const skip = parseInt(extra.skip) || 0;
  const page = categories.slice(skip, skip + 100);

  const metas = page.map((cat) => ({
    id: seriesId(cat.id),
    type: "series",
    name: cat.name,
    poster: api.getPoster(cat.id),
  }));

  return { metas };
});

// --- Meta Handler ---
builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "series") return { meta: null };

  const categoryId = parseCategoryId(id);
  if (!categoryId) return { meta: null };

  const [categories, videos] = await Promise.all([
    api.getCategories(),
    api.getVideosByCategory(categoryId),
  ]);

  const category = categories.find((c) => c.id === categoryId);
  const name = category ? category.name : `Category ${categoryId}`;

  const meta = {
    id,
    type: "series",
    name,
    poster: videos[0]?.poster_url || api.getPoster(categoryId),
    background: videos[0]?.poster_url || api.getPoster(categoryId),
    description: `${name} — ${videos.length} episode${videos.length !== 1 ? "s" : ""} from Gaki Archives`,
    videos: videos.map((v, i) => ({
      id: episodeId(categoryId, v.id),
      title: v.title,
      season: 1,
      episode: i + 1,
      released: new Date(v.created_at).toISOString(),
      thumbnail: v.thumbnail_url,
      overview: v.description || formatDuration(v.duration_seconds),
    })),
  };

  return { meta };
});

// --- Stream Handler ---
builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "series") return { streams: [] };

  const categoryId = parseCategoryId(id);
  const videoId = parseVideoId(id);
  if (!categoryId || !videoId) return { streams: [] };

  const videos = await api.getVideosByCategory(categoryId);
  const video = videos.find((v) => v.id === videoId);
  if (!video || !video.video_url) return { streams: [] };

  return {
    streams: [
      {
        url: video.video_url,
        name: "Gaki Archives",
        description: `${video.title}${video.duration_seconds ? " • " + formatDuration(video.duration_seconds) : ""}`,
        behaviorHints: {
          notWebReady: true,
          bingeGroup: `gaki_cat_${categoryId}`,
        },
      },
    ],
  };
});

const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port });
console.log(`Gaki Archives addon running on http://localhost:${port}`);
