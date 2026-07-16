import { fuzzyRatio, fuzzyPartial, wordPrefixHit } from "./fuzzy";
import type { OccMap, XwalkMap, MatchResult } from "./types";

/**
 * Score a keyword against a title. Uses full-string fuzzy ratio: "is this title
 * about the keyword?" (Port of _score_title.)
 */
function scoreTitle(
  keywordLower: string,
  title: string,
  multiWord: boolean,
  subScore: number,
  prefixScore: number,
  fuzzyThresh: number,
): number {
  const titleLower = title.toLowerCase();
  if (titleLower.includes(keywordLower)) return subScore;
  if (wordPrefixHit(keywordLower, titleLower)) return prefixScore;
  if (multiWord || keywordLower.length >= 6) {
    const fs = fuzzyRatio(keywordLower, titleLower);
    if (fs >= fuzzyThresh) return fs;
  }
  return 0;
}

/**
 * Score a keyword against a description. Uses partial fuzzy ratio: "does the
 * keyword appear somewhere in this text?" (Port of _score_desc.)
 */
function scoreDesc(
  keywordLower: string,
  desc: string,
  multiWord: boolean,
  subScore: number,
  prefixScore: number,
  fuzzyThresh: number,
): number {
  const descLower = desc.toLowerCase();
  if (descLower.includes(keywordLower)) return subScore;
  if (wordPrefixHit(keywordLower, descLower)) return prefixScore;
  if (multiWord) {
    const fs = fuzzyPartial(keywordLower, descLower);
    if (fs >= fuzzyThresh) return fs;
  }
  return 0;
}

/**
 * Port of match_soccodes(). Searches two real join surfaces:
 *   1. oes_soc_occs.csv Title / Description (broad SOC)
 *   2. xwalk_plus.csv   ONetTitle           (granular O*NET -> parent SOC)
 * Deduplicated by soccode, best score wins; O*NET titles that produced a hit
 * are recorded so the UI can show how the match was found.
 */
export function matchSoccodes(
  keyword: string,
  occ: OccMap,
  xwalk: XwalkMap,
): MatchResult[] {
  const keywordLower = keyword.trim().toLowerCase();
  const multiWord = keywordLower.includes(" ");
  const hits = new Map<string, { score: number; onetHits: string[] }>();

  const update = (code: string, score: number, onetTitle?: string): void => {
    const cur = hits.get(code);
    if (!cur) {
      hits.set(code, { score, onetHits: onetTitle ? [onetTitle] : [] });
    } else {
      if (score > cur.score) cur.score = score;
      if (onetTitle) cur.onetHits.push(onetTitle);
    }
  };

  for (const code in occ) {
    const { title, description } = occ[code];
    const ts = scoreTitle(keywordLower, title, multiWord, 100, 95, 65);
    if (ts > 0) {
      update(code, ts);
      continue;
    }
    const ds = scoreDesc(keywordLower, description, multiWord, 90, 85, 80);
    if (ds > 0) update(code, ds);
  }

  for (const code in xwalk) {
    for (const ot of xwalk[code]) {
      const s = scoreTitle(keywordLower, ot, multiWord, 98, 93, 65);
      if (s > 0) update(code, s, ot);
    }
  }

  const results: MatchResult[] = [];
  hits.forEach((h, code) => {
    const o = occ[code];
    if (!o) return; // xwalk may reference a SOC with no occupation entry
    results.push({
      soccode: code,
      title: o.title,
      description: o.description,
      score: h.score,
      onetHits: h.onetHits,
    });
  });

  results.sort((a, b) => b.score - a.score);
  return results;
}
