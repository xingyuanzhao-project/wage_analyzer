import { fuzzyRatio, fuzzyPartial, wordPrefixHit } from "./fuzzy";
import type { OccMap, XwalkMap, MatchResult, OnetHit } from "./types";

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
 * Match a SINGLE keyword. Port of match_soccodes(). Searches two real join
 * surfaces:
 *   1. oes_soc_occs.csv Title / Description (broad SOC)
 *   2. xwalk_plus.csv   ONetTitle           (granular O*NET -> parent SOC)
 * Deduplicated by soccode, best score wins; the O*NET children (code + title)
 * that produced a hit are recorded so the UI can show how the match was found
 * and link straight to those children's full profiles.
 */
export function matchSoccodes(
  keyword: string,
  occ: OccMap,
  xwalk: XwalkMap,
): MatchResult[] {
  const displayKeyword = keyword.trim();
  const keywordLower = displayKeyword.toLowerCase();
  const multiWord = keywordLower.includes(" ");
  const hits = new Map<string, { score: number; onetHits: OnetHit[] }>();

  const update = (code: string, score: number, onetHit?: OnetHit): void => {
    const cur = hits.get(code);
    if (!cur) {
      hits.set(code, { score, onetHits: onetHit ? [onetHit] : [] });
      return;
    }
    if (score > cur.score) cur.score = score;
    if (onetHit && !cur.onetHits.some((h) => h.code === onetHit.code)) {
      cur.onetHits.push(onetHit);
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
    for (const child of xwalk[code]) {
      const s = scoreTitle(keywordLower, child.title, multiWord, 98, 93, 65);
      if (s > 0) update(code, s, child);
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
      onetChildren: xwalk[code] ?? [],
      matchedKeywords: [displayKeyword],
    });
  });

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Split a raw keyword input into distinct search terms. Multiple terms are
 * separated by a semicolon or newline; each term may itself be several words
 * (e.g. "Business Intelligence Analyst"). Terms are trimmed and de-duplicated
 * case-insensitively, preserving first-seen order.
 */
export function parseKeywords(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of input.split(/[;\n]+/)) {
    const term = part.trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/**
 * Match a SET of keywords. Each term is matched independently with
 * matchSoccodes, then results are merged by soccode: best score wins, and the
 * O*NET hits and matched keywords are unioned. A single-term search is just the
 * size-1 case of this same path.
 */
export function matchKeywords(
  keywords: string[],
  occ: OccMap,
  xwalk: XwalkMap,
): MatchResult[] {
  const merged = new Map<string, MatchResult>();

  for (const keyword of keywords) {
    for (const r of matchSoccodes(keyword, occ, xwalk)) {
      const existing = merged.get(r.soccode);
      if (!existing) {
        merged.set(r.soccode, r);
        continue;
      }
      if (r.score > existing.score) existing.score = r.score;
      for (const o of r.onetHits) {
        if (!existing.onetHits.some((h) => h.code === o.code)) existing.onetHits.push(o);
      }
      for (const k of r.matchedKeywords) {
        if (!existing.matchedKeywords.includes(k)) existing.matchedKeywords.push(k);
      }
    }
  }

  const results = Array.from(merged.values());
  results.sort((a, b) => b.score - a.score);
  return results;
}
