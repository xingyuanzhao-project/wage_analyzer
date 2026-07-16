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

/** An O*NET-SOC child of a parent SOC: its code plus its O*NET title. */
export interface OnetHit {
  code: string;
  title: string;
}

export type XwalkMap = Record<string, OnetHit[]>; // parent soccode -> O*NET children

// --- O*NET occupational profile (one per O*NET-SOC code) ---------------------

export interface OnetTask {
  text: string;
  type: string; // "Core" | "Supplemental"
}

/** A worker-requirement element (skill, knowledge area) with its definition. */
export interface OnetElement {
  name: string;
  description: string;
}

export interface OnetJobZone {
  zone: number;
  name: string;
  experience: string;
  education: string;
  training: string;
  examples: string;
  svp: string;
}

export interface OnetSoftwareExample {
  name: string;
  hot: boolean;
  inDemand: boolean;
}

export interface OnetSoftwareCategory {
  category: string;
  examples: OnetSoftwareExample[];
}

export interface OnetEducation {
  level: string;
  percent: number;
}

/** Sections are optional: O*NET does not publish every domain for every code. */
export interface OnetProfile {
  code: string;
  title: string;
  description: string;
  tasks?: OnetTask[];
  dwas?: string[];
  jobZone?: OnetJobZone;
  knowledge?: OnetElement[];
  essentialSkills?: OnetElement[];
  software?: OnetSoftwareCategory[];
  education?: OnetEducation[];
}

export type OnetBundle = Record<string, OnetProfile>; // onetcode -> profile

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
  onetHits: OnetHit[];
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
