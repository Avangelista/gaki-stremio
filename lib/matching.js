const DATE_RE = /(\d{4})[.-](\d{2})[.-](\d{2})/;
const SE_RE = /S(\d{1,2})E(\d{1,3})/i;
const NOISE_RE = /\((?:subbed|raw|eng\s*sub|sub)\)/gi;
const PARENS_RE = /\([^)]*\)/g;

const EP_PATTERNS = [
  /(?:Episode|Ep\.?|EP)\s*(\d{1,3})/i,
  /#(\d{1,3})/,
  /(?:No\.?|Number)\s*(\d{1,3})/i,
  /(?:^|\s)(\d{1,3})\s*[-–]\s/,
];

const FUZZY_THRESHOLD = 0.65;
const FUZZY_GAP = 0.10;

/**
 * Bigram Sorensen-Dice coefficient between two strings.
 * Returns 0.0–1.0 (1.0 = identical bigram sets).
 */
function diceSimilarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigramsA = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    bigramsA.set(bg, (bigramsA.get(bg) || 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    const count = bigramsA.get(bg);
    if (count > 0) {
      overlap++;
      bigramsA.set(bg, count - 1);
    }
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

/**
 * Strip dates, subtitle tags, and parenthetical noise from a title.
 * Returns a lowercased, whitespace-normalized string for comparison.
 */
function cleanTitle(title) {
  let t = title.replace(DATE_RE, "").replace(NOISE_RE, "").replace(PARENS_RE, "");
  return t.toLowerCase().replace(/[_\-–—]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Extract YYYY-MM-DD air date from a title, or null. */
function extractDate(title) {
  const m = title.match(DATE_RE);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Extract {season, episode} from an S__E__ pattern, or null. */
function extractSeasonEpisode(title) {
  const m = title.match(SE_RE);
  return m ? { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) } : null;
}

/**
 * Extract a bare episode number from title patterns like "Episode 5", "#42", "No. 3".
 * Returns {season: 1, episode: N} or null.
 */
function extractEpisodeNumber(title) {
  for (const re of EP_PATTERNS) {
    const m = title.match(re);
    if (m) return { season: 1, episode: parseInt(m[1], 10) };
  }
  return null;
}

/**
 * Given an extracted episode number, search TMDB and TVDB maps for an episode
 * with that number and return the confirmed season + episode entry.
 * Prefers TMDB (has images). Returns null if not found.
 */
function verifyEpisodeNumber(epNum, tmdbEpMap, tvdbEpMap) {
  // Search TMDB first (higher quality data)
  for (const [date, ep] of tmdbEpMap) {
    if (ep.episode === epNum) return { epMatch: ep, airDate: date };
  }
  for (const [date, ep] of tvdbEpMap) {
    if (ep.episode === epNum) return { epMatch: ep, airDate: date };
  }
  return null;
}

/**
 * Score a cleaned video title against all episode names in both TMDB and TVDB maps.
 * Returns the best match if it passes threshold and gap checks, or null.
 */
function fuzzyMatchBest(cleanedTitle, tmdbEpMap, tvdbEpMap) {
  let best = null;
  let bestScore = 0;
  let secondScore = 0;

  function scoreMap(epMap) {
    for (const [date, ep] of epMap) {
      if (!ep.name) continue;
      const epName = ep.name.toLowerCase().trim();
      if (!epName) continue;

      // Substring containment = auto-accept (backward compat)
      if (cleanedTitle.includes(epName) || epName.includes(cleanedTitle)) {
        if (1.0 > bestScore) {
          secondScore = bestScore;
          bestScore = 1.0;
          best = { epMatch: ep, airDate: date, score: 1.0 };
        }
        continue;
      }

      const score = diceSimilarity(cleanedTitle, epName);
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        best = { epMatch: ep, airDate: date, score };
      } else if (score > secondScore) {
        secondScore = score;
      }
    }
  }

  scoreMap(tmdbEpMap);
  scoreMap(tvdbEpMap);

  if (!best) return null;
  if (bestScore < FUZZY_THRESHOLD) return null;
  if (bestScore < 1.0 && bestScore - secondScore < FUZZY_GAP) return null;
  return best;
}

/**
 * Run the full matching priority chain for a single video.
 *
 * Priority: overrides → date → S__E__ → episode number + verify → fuzzy name → fallback
 *
 * @param {Object} video - Video object with title, id, etc.
 * @param {Map} tmdbEpMap - TMDB episodes indexed by air date
 * @param {Map} tvdbEpMap - TVDB episodes indexed by air date
 * @param {Map} mergedEpMap - Merged TMDB+TVDB map for date lookups
 * @param {Object|undefined} catOverrides - Overrides for this category {videoId: {season, episode}}
 * @param {number} fallbackIndex - Position in the deduped list (for sequential fallback)
 * @param {{value: number}} undatedCounter - Mutable counter for undated episode numbering
 * @returns {{season: number, episode: number, airDate: string|null, epMatch: Object|null}}
 */
function matchEpisode(video, tmdbEpMap, tvdbEpMap, mergedEpMap, catOverrides, fallbackIndex, undatedCounter) {
  // 1. Manual overrides — explicit human mapping always wins
  const videoOverride = catOverrides?.[String(video.id)];
  if (videoOverride) {
    // Try to find the full episode entry for metadata (thumbnail, overview)
    for (const [date, ep] of mergedEpMap) {
      if (ep.season === videoOverride.season && ep.episode === videoOverride.episode) {
        return { season: ep.season, episode: ep.episode, airDate: date, epMatch: ep };
      }
    }
    return { season: videoOverride.season, episode: videoOverride.episode, airDate: null, epMatch: null };
  }

  // 2. Date-based lookup — most reliable automatic signal
  const airDate = extractDate(video.title);
  if (airDate) {
    const epMatch = mergedEpMap.get(airDate);
    if (epMatch) {
      return { season: epMatch.season, episode: epMatch.episode, airDate, epMatch };
    }
  }

  // 3. S__E__ pattern — strong unambiguous signal
  const se = extractSeasonEpisode(video.title);
  if (se) {
    return { season: se.season, episode: se.episode, airDate, epMatch: null };
  }

  // 4. Episode number extraction + TMDB/TVDB verification
  const epNum = extractEpisodeNumber(video.title);
  if (epNum) {
    const verified = verifyEpisodeNumber(epNum.episode, tmdbEpMap, tvdbEpMap);
    if (verified) {
      return {
        season: verified.epMatch.season,
        episode: verified.epMatch.episode,
        airDate: verified.airDate,
        epMatch: verified.epMatch,
      };
    }
    // No external match — use extracted number with season=1
    return { season: 1, episode: epNum.episode, airDate, epMatch: null };
  }

  // 5. Strict fuzzy name matching
  if (tmdbEpMap.size > 0 || tvdbEpMap.size > 0) {
    const cleaned = cleanTitle(video.title);
    const fuzzy = fuzzyMatchBest(cleaned, tmdbEpMap, tvdbEpMap);
    if (fuzzy) {
      return {
        season: fuzzy.epMatch.season,
        episode: fuzzy.epMatch.episode,
        airDate: fuzzy.airDate,
        epMatch: fuzzy.epMatch,
      };
    }
  }

  // 6. Fallback — sequential numbering
  if (airDate) {
    return { season: 1, episode: fallbackIndex + 1, airDate, epMatch: null };
  }
  return { season: 0, episode: ++undatedCounter.value, airDate: null, epMatch: null };
}

module.exports = {
  diceSimilarity,
  cleanTitle,
  extractDate,
  extractSeasonEpisode,
  extractEpisodeNumber,
  verifyEpisodeNumber,
  fuzzyMatchBest,
  matchEpisode,
};
