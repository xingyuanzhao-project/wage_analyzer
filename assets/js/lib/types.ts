export interface YearInfo {
  id: string;
  label: string;
  sourceNote: string;
}

export interface YearsFile {
  default: string;
  years: YearInfo[];
}

export interface GeoRow {
  area: string;
  areaName: string;
  stateAb: string;
  state: string;
  county: string;
}

export interface Occupation {
  title: string;
  description: string;
}

export type OccMap = Record<string, Occupation>; // soccode -> occupation
export type XwalkMap = Record<string, string[]>; // parent soccode -> O*NET titles

export interface WageEntry {
  l1: number | null;
  l2: number | null;
  l3: number | null;
  l4: number | null;
  avg: number | null;
  label: string;
}

export type WageMap = Record<string, WageEntry>; // soccode -> wage (annualized)

export type WageTable = "alc" | "edc";

export interface MatchResult {
  soccode: string;
  title: string;
  description: string;
  score: number;
  onetHits: string[];
  matchedKeywords: string[];
}

export interface ResultRow extends MatchResult {
  l1: number | null;
  l2: number | null;
  l3: number | null;
  l4: number | null;
  avg: number | null;
  label: string;
  hasWage: boolean;
}

export interface AreaResolution {
  area: string | null;
  areaName: string | null;
  detail: string;
}
