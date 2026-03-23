const BASE_URL = "https://gakiarchives.com/api";
const mappingsData = require("../data/mappings.json");

// Static categories from mappings.json
const categories = Object.entries(mappingsData.categories).map(([id, name]) => ({
  id: parseInt(id, 10),
  name,
}));
categories.sort((a, b) => a.name.localeCompare(b.name));

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
  videos: 60 * 60 * 1000,
  search: 10 * 60 * 1000,
  poster: 60 * 60 * 1000,
};

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}: ${url}`);
  return res.json();
}

function getCategories() {
  return categories;
}

function getCategoryName(categoryId) {
  return mappingsData.categories[String(categoryId)] || `Category ${categoryId}`;
}

async function getVideosByCategory(categoryId) {
  return getCached(`cat_${categoryId}`, TTL.videos, async () => {
    const all = [];
    let offset = 0;
    const limit = 50;
    for (let i = 0; i < 20; i++) {
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
    fetchJSON(`${BASE_URL}/videos.php?query=${encodeURIComponent(query)}&limit=100`)
  );
}

// Lazy poster fetcher — fetches first video for a category on demand, caches result
async function getPoster(categoryId) {
  return getCached(`poster_${categoryId}`, TTL.poster, async () => {
    try {
      const videos = await fetchJSON(
        `${BASE_URL}/videos.php?category_id=${categoryId}&limit=1`
      );
      return videos.length > 0 ? videos[0].poster_url : null;
    } catch (err) {
      console.warn(`Failed to fetch poster for category ${categoryId}:`, err.message);
      return null;
    }
  });
}

module.exports = { getCategories, getCategoryName, getVideosByCategory, searchVideos, getPoster };
