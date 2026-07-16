import type { MatchResult, WageMap, ResultRow } from "./types";

/**
 * Join keyword matches with the resolved area's wage rows and sort by annual
 * average ascending, mirroring the final sort in lookup():
 *   rows.sort(key=lambda r: (r["Average"] is None, r["Average"] or 0))
 * Occupations with no wage row for the area are kept and sorted to the end.
 */
export function buildRows(matches: MatchResult[], wages: WageMap): ResultRow[] {
  const rows: ResultRow[] = matches.map((m) => {
    const w = wages[m.soccode];
    if (!w) {
      return {
        ...m,
        l1: null,
        l2: null,
        l3: null,
        l4: null,
        avg: null,
        label: "no data for area",
        hasWage: false,
      };
    }
    return {
      ...m,
      l1: w.l1,
      l2: w.l2,
      l3: w.l3,
      l4: w.l4,
      avg: w.avg,
      label: w.label,
      hasWage: true,
    };
  });

  rows.sort((a, b) => {
    const aNull = a.avg === null;
    const bNull = b.avg === null;
    if (aNull !== bNull) return aNull ? 1 : -1;
    return (a.avg ?? 0) - (b.avg ?? 0);
  });

  return rows;
}
