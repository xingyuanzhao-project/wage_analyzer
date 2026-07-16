/**
 * Faithful TypeScript port of the difflib.SequenceMatcher-based fuzzy helpers
 * in scripts/wage_lookup.py (the `except ImportError` fallback branch, which is
 * the path that was actually tuned and verified in the original CLI session).
 *
 * Python's SequenceMatcher.ratio() = 2*M / T, where M is the total number of
 * matched characters found by the recursive longest-matching-block algorithm
 * and T is the combined length of both strings.
 *
 * We deliberately omit Python's `autojunk` heuristic: it only activates for a
 * comparison sequence of length >= 200, and every comparison this app performs
 * is on short slices (titles, keywords, or keyword-length description windows),
 * so its absence produces identical results while keeping the code simpler.
 */

function findLongestMatch(
  a: string,
  b: string,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): [number, number, number] {
  // Map each character in b[blo, bhi) to its ascending list of indices.
  const b2j = new Map<string, number[]>();
  for (let j = blo; j < bhi; j++) {
    const ch = b[j];
    const arr = b2j.get(ch);
    if (arr) arr.push(j);
    else b2j.set(ch, [j]);
  }

  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map<number, number>();

  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map<number, number>();
    const idxs = b2j.get(a[i]);
    if (idxs) {
      for (const j of idxs) {
        // idxs only holds j in [blo, bhi); no further bounds checks needed.
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
    }
    j2len = newj2len;
  }

  // Extend the best block as far as possible in both directions.
  while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
    besti--;
    bestj--;
    bestsize++;
  }
  while (
    besti + bestsize < ahi &&
    bestj + bestsize < bhi &&
    a[besti + bestsize] === b[bestj + bestsize]
  ) {
    bestsize++;
  }

  return [besti, bestj, bestsize];
}

function matchingCharCount(a: string, b: string): number {
  const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
  let total = 0;
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
    const [i, j, k] = findLongestMatch(a, b, alo, ahi, blo, bhi);
    if (k) {
      total += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return total;
}

/** SequenceMatcher.ratio() in [0, 1]. */
export function sequenceRatio(a: string, b: string): number {
  const length = a.length + b.length;
  if (length === 0) return 1.0;
  return (2.0 * matchingCharCount(a, b)) / length;
}

/** Port of _fuzzy_ratio: full-string similarity, scaled to 0-100. */
export function fuzzyRatio(a: string, b: string): number {
  return sequenceRatio(a.toLowerCase(), b.toLowerCase()) * 100;
}

/**
 * Port of the fallback _fuzzy_partial: slide a window the size of the shorter
 * string across the longer one and keep the best full-string ratio.
 */
export function fuzzyPartial(a: string, b: string): number {
  const aLow = a.toLowerCase();
  const bLow = b.toLowerCase();
  let short: string;
  let long: string;
  if (aLow.length <= bLow.length) {
    short = aLow;
    long = bLow;
  } else {
    short = bLow;
    long = aLow;
  }
  const n = short.length;
  let best = 0.0;
  for (let i = 0; i <= long.length - n; i++) {
    const r = sequenceRatio(short, long.substring(i, i + n)) * 100;
    if (r > best) best = r;
  }
  return best;
}

const STRIP_CHARS = new Set([".", ",", ";", ":", "(", ")", '"', "'"]);

function stripEdges(word: string): string {
  let start = 0;
  let end = word.length;
  while (start < end && STRIP_CHARS.has(word[start])) start++;
  while (end > start && STRIP_CHARS.has(word[end - 1])) end--;
  return word.substring(start, end);
}

/** Port of _word_prefix_hit: does any word in the text start with the keyword? */
export function wordPrefixHit(keywordLower: string, textLower: string): boolean {
  for (const raw of textLower.split(/\s+/)) {
    if (!raw) continue;
    if (stripEdges(raw).startsWith(keywordLower)) return true;
  }
  return false;
}
