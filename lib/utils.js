const ID_PREFIX = "gaki_cat_";

/**
 * Build a Stremio series ID from a Gaki Archives category ID.
 * @param {number} categoryId
 * @returns {string} e.g. "gaki_cat_2"
 */
function seriesId(categoryId) {
  return `${ID_PREFIX}${categoryId}`;
}

/**
 * Build a Stremio episode ID from a category ID and video ID.
 * @param {number} categoryId
 * @param {number} videoId
 * @returns {string} e.g. "gaki_cat_2:1234"
 */
function episodeId(categoryId, videoId) {
  return `${ID_PREFIX}${categoryId}:${videoId}`;
}

/**
 * Extract the numeric category ID from a Stremio ID string.
 * @param {string} stremioId - e.g. "gaki_cat_2" or "gaki_cat_2:1234"
 * @returns {number|null} Category ID, or null if format is invalid
 */
const categoryIdRe = new RegExp(`^${ID_PREFIX}(\\d+)(?::|$)`);
function parseCategoryId(stremioId) {
  const match = stremioId.match(categoryIdRe);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Extract the numeric video ID from a Stremio episode ID string.
 * @param {string} stremioId - e.g. "gaki_cat_2:1234"
 * @returns {number|null} Video ID, or null if format is invalid or non-numeric
 */
function parseVideoId(stremioId) {
  const parts = stremioId.split(":");
  if (parts.length < 2) return null;
  const parsed = parseInt(parts[parts.length - 1], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Format a duration in seconds as a human-readable string.
 * @param {number} seconds
 * @returns {string} e.g. "1h 23m", "45m", or "" if falsy
 */
function formatDuration(seconds) {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

module.exports = { seriesId, episodeId, parseCategoryId, parseVideoId, formatDuration };
