const ID_PREFIX = "gaki_cat_";

function seriesId(categoryId) {
  return `${ID_PREFIX}${categoryId}`;
}

function episodeId(categoryId, videoId) {
  return `${ID_PREFIX}${categoryId}:${videoId}`;
}

function parseCategoryId(stremioId) {
  const match = stremioId.match(/^gaki_cat_(\d+)(?::|$)/);
  return match ? parseInt(match[1], 10) : null;
}

function parseVideoId(stremioId) {
  const parts = stremioId.split(":");
  return parts.length >= 2 ? parseInt(parts[parts.length - 1], 10) : null;
}

function formatDuration(seconds) {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

module.exports = { ID_PREFIX, seriesId, episodeId, parseCategoryId, parseVideoId, formatDuration };
