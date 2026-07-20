import type {
  YearsFile,
  GeoRow,
  OccMap,
  XwalkMap,
  WageMap,
  WageTable,
  OnetBundle,
  OnetShard,
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

// O*NET profiles are grouped into SOC major-group shards: onet/<major>.json,
// where <major> is the two digits before the hyphen in the SOC code, holds the
// bundle (all O*NET-SOC children) for every parent SOC in that major group. This
// keeps the file count near the ~23 SOC major groups instead of one file per SOC.
//
// The in-flight *shard* promise is cached (not the per-SOC bundle) so expanding
// several SOCs in the same major group -- or an aggregate spanning them -- shares
// one request. Only a *resolved* fetch stays cached, matching the loaders above:
// a rejected fetch (dropped connection, cold CDN edge, etc.) is transient, not
// evidence the file is missing, so it must not permanently poison the cache --
// the entry is evicted on rejection so the next call retries against the network.
const onetShardCache = new Map<string, Promise<OnetShard>>();

/** SOC major group: the two digits before the hyphen (e.g. 15-2051 -> 15). */
function onetMajorGroup(soccode: string): string {
  return soccode.split("-", 1)[0];
}

function loadOnetShard(year: string, major: string): Promise<OnetShard> {
  const key = `${year}/${major}`;
  const cached = onetShardCache.get(key);
  if (cached) return cached;

  const request = getJSON<OnetShard>(`${year}/onet/${major}.json`);
  request.catch(() => {
    if (onetShardCache.get(key) === request) onetShardCache.delete(key);
  });
  onetShardCache.set(key, request);
  return request;
}

/**
 * The O*NET bundle for one parent SOC, read from its major-group shard. Every
 * SOC in the crosswalk is written into a shard by build_data.py, so a resolved
 * shard that lacks the SOC means the code is genuinely outside the crosswalk --
 * surfaced as an error (the same signal a missing file gave before), never a
 * silent empty bundle.
 */
export async function loadOnet(year: string, soccode: string): Promise<OnetBundle> {
  const shard = await loadOnetShard(year, onetMajorGroup(soccode));
  const bundle = shard[soccode];
  if (!bundle) {
    throw new Error(`No O*NET bundle for ${soccode} in ${year}`);
  }
  return bundle;
}
