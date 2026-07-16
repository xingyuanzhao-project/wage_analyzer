import { fuzzyRatio, fuzzyPartial } from "./fuzzy";
import type { GeoRow, AreaResolution } from "./types";

/**
 * Port of resolve_area() in scripts/wage_lookup.py.
 *
 * 1. Score the input state against each row's full name and abbreviation
 *    (full-string ratio); keep rows whose state score >= 50 and within 5
 *    points of the best state score.
 * 2. Among those rows, pick the county with the best partial-ratio score;
 *    require >= 40 to accept.
 */
export function resolveArea(
  stateInput: string,
  countyInput: string,
  geo: GeoRow[],
): AreaResolution {
  const state = stateInput.trim();
  const county = countyInput.trim();

  const stateScored: Array<{ score: number; row: GeoRow }> = [];
  for (const row of geo) {
    const bestState = Math.max(
      fuzzyRatio(state, row.state),
      fuzzyRatio(state, row.stateAb),
    );
    if (bestState >= 50) stateScored.push({ score: bestState, row });
  }

  if (stateScored.length === 0) {
    return { area: null, areaName: null, detail: "No state match" };
  }

  let topStateScore = 0;
  for (const s of stateScored) if (s.score > topStateScore) topStateScore = s.score;
  const stateRows = stateScored.filter((s) => s.score >= topStateScore - 5);

  let bestCountyScore = -1;
  let best: { area: string; areaName: string; detail: string } | null = null;
  for (const { row } of stateRows) {
    const cs = fuzzyPartial(county, row.county);
    if (cs > bestCountyScore) {
      bestCountyScore = cs;
      best = {
        area: row.area,
        areaName: row.areaName,
        detail: `${row.county}, ${row.stateAb}`,
      };
    }
  }

  if (best === null || bestCountyScore < 40) {
    return { area: null, areaName: null, detail: "No county match in matched state" };
  }

  return { area: best.area, areaName: best.areaName, detail: best.detail };
}
