const BASE_URL = "https://gakiarchives.com/api";

const cache = new Map();

function getCached(key, ttlMs, fetchFn) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < ttlMs) return Promise.resolve(entry.data);
  return fetchFn().then((data) => {
    cache.set(key, { data, time: Date.now() });
    return data;
  });
}

const TTL = {
  categories: 24 * 60 * 60 * 1000,
  videos: 60 * 60 * 1000,
  search: 10 * 60 * 1000,
};

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}: ${url}`);
  return res.json();
}

async function getCategories() {
  return getCached("categories", TTL.categories, () =>
    fetchJSON(`${BASE_URL}/categories.php`)
  );
}

async function getVideosByCategory(categoryId) {
  return getCached(`cat_${categoryId}`, TTL.videos, async () => {
    const all = [];
    let offset = 0;
    const limit = 100;
    for (let i = 0; i < 10; i++) {
      const batch = await fetchJSON(
        `${BASE_URL}/videos.php?category_id=${categoryId}&limit=${limit}&offset=${offset}`
      );
      all.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
    }
    all.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return all;
  });
}

async function searchVideos(query) {
  return getCached(`search_${query}`, TTL.search, () =>
    fetchJSON(`${BASE_URL}/videos.php?q=${encodeURIComponent(query)}&limit=100`)
  );
}

// Poster cache: categoryId -> poster_url
const posterCache = new Map();
let posterWarmed = false;

async function warmPosters() {
  if (posterWarmed) return;
  posterWarmed = true;
  const categories = await getCategories();
  // Fetch in batches of 10
  for (let i = 0; i < categories.length; i += 10) {
    const batch = categories.slice(i, i + 10);
    await Promise.all(
      batch.map(async (cat) => {
        try {
          const videos = await fetchJSON(
            `${BASE_URL}/videos.php?category_id=${cat.id}&limit=1`
          );
          if (videos.length > 0) {
            posterCache.set(cat.id, videos[0].poster_url);
          }
        } catch {}
      })
    );
  }
}

function getPoster(categoryId) {
  return posterCache.get(categoryId) || null;
}

module.exports = { getCategories, getVideosByCategory, searchVideos, warmPosters, getPoster };
