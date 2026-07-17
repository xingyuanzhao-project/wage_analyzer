import type {
  YearsFile,
  GeoRow,
  OccMap,
  XwalkMap,
  WageMap,
  WageTable,
  OnetBundle,
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

// O*NET profiles are bundled per parent SOC (all its O*NET-SOC children) and
// fetched on demand, the same pattern as per-area wages. The in-flight promise
// is cached so a card expanding while the aggregate loads shares one request.
// Only a *resolved* fetch stays cached, matching loadYearData/loadWages above:
// a rejected fetch (dropped connection, cold CDN edge, etc.) is transient, not
// evidence the file is missing, so it must not permanently poison the cache --
// the entry is evicted on rejection so the next call retries against the network.
const onetCache = new Map<string, Promise<OnetBundle>>();

export function loadOnet(year: string, soccode: string): Promise<OnetBundle> {
  const key = `${year}/${soccode}`;
  const cached = onetCache.get(key);
  if (cached) return cached;

  const request = getJSON<OnetBundle>(`${year}/onet/${soccode}.json`);
  request.catch(() => {
    if (onetCache.get(key) === request) onetCache.delete(key);
  });
  onetCache.set(key, request);
  return request;
}
