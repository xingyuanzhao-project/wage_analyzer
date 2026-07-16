import type {
  YearsFile,
  GeoRow,
  OccMap,
  XwalkMap,
  WageMap,
  WageTable,
} from "./types";

// Injected by layouts/_partials/head.html. Falls back to a root-relative path
// so the module still works if opened outside the Hugo build.
declare global {
  interface Window {
    WAGE_DATA_BASE?: string;
  }
}

const BASE = (typeof window !== "undefined" && window.WAGE_DATA_BASE) || "/data/";

function url(path: string): string {
  return BASE.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(url(path));
  if (!res.ok) {
    throw new Error(`Could not load ${path} (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
}

export function loadYears(): Promise<YearsFile> {
  return getJSON<YearsFile>("years.json");
}

export interface YearData {
  geo: GeoRow[];
  occ: OccMap;
  xwalk: XwalkMap;
}

const yearCache = new Map<string, YearData>();

export async function loadYearData(year: string): Promise<YearData> {
  const cached = yearCache.get(year);
  if (cached) return cached;

  const [geo, occ, xwalk] = await Promise.all([
    getJSON<GeoRow[]>(`${year}/geography.json`),
    getJSON<OccMap>(`${year}/occupations.json`),
    getJSON<XwalkMap>(`${year}/xwalk.json`),
  ]);

  const data: YearData = { geo, occ, xwalk };
  yearCache.set(year, data);
  return data;
}

const wageCache = new Map<string, WageMap>();

export async function loadWages(
  year: string,
  table: WageTable,
  area: string,
): Promise<WageMap> {
  const key = `${year}/${table}/${area}`;
  const cached = wageCache.get(key);
  if (cached) return cached;

  const wages = await getJSON<WageMap>(`${year}/wages/${table}/${area}.json`);
  wageCache.set(key, wages);
  return wages;
}
