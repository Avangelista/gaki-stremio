const { getCached } = require("./cache");
const BASE_URL = "https://gakiarchives.com/api";
const mappingsData = require("../data/mappings.json");

// Static categories from mappings.json, sorted alphabetically
const categories = Object.entries(mappingsData.categories).map(([id, name]) => ({
  id: parseInt(id, 10),
  name,
}));
categories.sort((a, b) => a.name.localeCompare(b.name));

const FETCH_TIMEOUT = 10_000; // 10s timeout for Gaki Archives API calls
const BATCH_SIZE = 50;        // Videos per page from Gaki Archives API
const MAX_PAGES = 20;         // Safety limit to prevent runaway pagination

// Cache TTLs: videos change rarely (1h), search results are more dynamic (10m),
// poster URLs are stable (1h)
const TTL = {
  videos: 60 * 60 * 1000,    // 1 hour
  search: 10 * 60 * 1000,    // 10 minutes
  poster: 60 * 60 * 1000,    // 1 hour
};

/**
 * Fetch JSON from a URL, throwing on non-2xx responses.
 * @param {string} url
 * @returns {Promise<*>}
 */
async function fetchJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`API ${res.status}: ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return the full list of categories, sorted alphabetically by name.
 * @returns {{id: number, name: string}[]}
 */
function getCategories() {
  return categories;
}

/**
 * Look up a category's display name by ID.
 * @param {number} categoryId
 * @returns {string}
 */
function getCategoryName(categoryId) {
  return mappingsData.categories[String(categoryId)] || `Category ${categoryId}`;
}

/**
 * Fetch all videos for a category (paginated), sorted by creation date ascending.
 * Results are cached for 1 hour.
 * @param {number} categoryId
 * @returns {Promise<Object[]>} Array of video objects from the Gaki Archives API
 */
async function getVideosByCategory(categoryId) {
  return getCached(`cat_${categoryId}`, TTL.videos, async () => {
    const all = [];
    let offset = 0;
    let pages = 0;
    for (; pages < MAX_PAGES; pages++) {
      const batch = await fetchJSON(
        `${BASE_URL}/videos.php?category_id=${categoryId}&limit=${BATCH_SIZE}&offset=${offset}`
      );
      all.push(...batch);
      if (batch.length < BATCH_SIZE) break;
      offset += BATCH_SIZE;
    }
    if (pages === MAX_PAGES) {
      console.warn(`Pagination limit reached for category ${categoryId} (${MAX_PAGES} pages, ${all.length} videos)`);
    }
    // Sort by creation date ascending; created_at is ISO 8601 so string comparison works
    all.sort((a, b) => (a.created_at > b.created_at) - (a.created_at < b.created_at));
    return all;
  });
}

/**
 * Search videos by query string. Results are cached for 10 minutes.
 * @param {string} query
 * @returns {Promise<Object[]>} Array of video objects matching the query
 */
async function searchVideos(query) {
  return getCached(`search_${query}`, TTL.search, () =>
    fetchJSON(`${BASE_URL}/videos.php?query=${encodeURIComponent(query)}&limit=100`)
  );
}

/**
 * Fetch a poster URL for a category by loading its first video.
 * Returns the video's poster_url or thumbnail_url, or null on failure.
 * Results are cached for 1 hour.
 * @param {number} categoryId
 * @returns {Promise<string|null>}
 */
async function getPoster(categoryId) {
  return getCached(`poster_${categoryId}`, TTL.poster, async () => {
    try {
      const videos = await fetchJSON(
        `${BASE_URL}/videos.php?category_id=${categoryId}&limit=1`
      );
      return videos.length > 0 ? (videos[0].poster_url || videos[0].thumbnail_url) : null;
    } catch (err) {
      console.warn(`Failed to fetch poster for category ${categoryId}:`, err.message);
      return null;
    }
  });
}

module.exports = { getCategories, getCategoryName, getVideosByCategory, searchVideos, getPoster };
