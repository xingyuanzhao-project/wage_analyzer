import { loadOnet, loadStaticJson } from "./dataLoader";
import type { AggregateEntry, RoleRef } from "./onetView";
import { collectRoles } from "./onetView";
import type { PromptCatalog, RetrieveFile } from "./prompts";
import type { OnetProfile } from "./types";

export interface EvidenceChunk {
  id: string;
  code: string;
  title: string;
  section: string;
  text: string;
  selected: boolean;
}

export interface EvidencePack {
  query: string;
  chunks: EvidenceChunk[];
}

export interface OccupationBrief {
  code: string;
  title: string;
  description: string;
  parentSoc: string;
  major: string;
}

export interface RetrieveIndex {
  year: string;
  occupations: Record<string, OccupationBrief>;
  related: Record<string, string[]>;
}

interface IntakeValue {
  chips: string[];
  text: string;
}

function tokenize(text: string, cfg: RetrieveFile): string[] {
  const stops = new Set(cfg.stopwords);
  return text
    .toLowerCase()
    .split(/[^a-z0-9.+-]+/)
    .filter((tok) => tok.length >= cfg.minTokenLength && !stops.has(tok));
}

function queryText(
  catalog: PromptCatalog,
  intake: Record<string, IntakeValue>,
  purposeOther: string,
): string {
  const parts: string[] = [];
  for (const id of catalog.retrieve.queryFieldIds) {
    if (id === "otherIntent") {
      if (purposeOther.trim()) parts.push(purposeOther);
      continue;
    }
    const field = intake[id];
    if (!field) continue;
    if (field.chips.length) parts.push(field.chips.join(" "));
    if (field.text.trim()) parts.push(field.text);
  }
  return parts.join(" ");
}

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max).trimEnd() + "…";
}

function readField(profile: OnetProfile, field: string): unknown {
  return (profile as unknown as Record<string, unknown>)[field];
}

function chunkProfile(
  role: { code: string; title: string; profile: OnetProfile },
  selected: boolean,
  cfg: RetrieveFile,
): EvidenceChunk[] {
  const chunks: EvidenceChunk[] = [];
  let n = 0;
  for (const spec of cfg.chunkers) {
    const value = readField(role.profile, spec.field);
    const push = (text: string) => {
      const clipped = clip(text, cfg.maxChunkChars);
      if (!clipped) return;
      chunks.push({
        id: `${role.code}:${spec.section}:${n++}`,
        code: role.code,
        title: role.title,
        section: spec.section,
        text: clipped,
        selected,
      });
    };
    if (spec.from === "string" && typeof value === "string") {
      push(value);
    } else if (spec.from === "array" && Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") push(item);
        else if (item && spec.textKey && typeof item === "object") {
          const text = (item as Record<string, unknown>)[spec.textKey];
          if (typeof text === "string") push(text);
        }
      }
    } else if (spec.from === "object" && value && typeof value === "object") {
      const rec = value as Record<string, unknown>;
      const bits = (spec.textKeys || [])
        .map((key) => rec[key])
        .filter((bit): bit is string => typeof bit === "string" && bit.trim().length > 0);
      if (bits.length) push(bits.join(" — "));
    }
  }
  return chunks;
}

function scoreChunk(chunk: EvidenceChunk, queryTokens: string[]): number {
  if (queryTokens.length === 0) return chunk.selected ? 1 : 0;
  const hay = new Set(chunk.text.toLowerCase().split(/[^a-z0-9.+-]+/));
  let hits = 0;
  for (const tok of queryTokens) if (hay.has(tok)) hits += 1;
  return hits + (chunk.selected ? 0.25 : 0);
}

function scoreBrief(brief: OccupationBrief, queryTokens: string[]): number {
  const hay = `${brief.title} ${brief.description}`.toLowerCase();
  let hits = 0;
  for (const tok of queryTokens) {
    if (hay.includes(tok)) hits += 1;
  }
  return hits;
}

let indexCache: { key: string; data: RetrieveIndex } | null = null;

async function loadIndex(year: string, path: string): Promise<RetrieveIndex> {
  const key = `${year}/${path}`;
  if (indexCache?.key === key) return indexCache.data;
  const data = await loadStaticJson<RetrieveIndex>(`${year}/${path}`);
  indexCache = { key, data };
  return data;
}

/**
 * Rank O*NET chunks after intake. Selected compiled roles are always eligible.
 * Full-corpus occupation search runs only for purpose ids listed in retrieve.json.
 */
export async function buildEvidencePack(opts: {
  catalog: PromptCatalog;
  year: string;
  entries: AggregateEntry[];
  purposeId: string;
  purposeOther: string;
  intake: Record<string, IntakeValue>;
}): Promise<EvidencePack> {
  const cfg = opts.catalog.retrieve;
  const selected = collectRoles(opts.entries);
  if (selected.length === 0) {
    throw new Error(opts.catalog.workflow.labels.retrieveEmptyRoles);
  }

  const query = queryText(opts.catalog, opts.intake, opts.purposeOther);
  const queryTokens = tokenize(query, cfg);
  const chunks = selected.flatMap((role) => chunkProfile(role, true, cfg));

  const needsCorpus = cfg.fullCorpusOccupationSearch.purposeIds.includes(opts.purposeId);
  if (needsCorpus) {
    const index = await loadIndex(opts.year, cfg.occupationIndexPath);
    const selectedCodes = new Set(selected.map((role) => role.code));
    const extraCodes = new Set<string>();
    for (const role of selected) {
      for (const rel of index.related[role.code] || []) extraCodes.add(rel);
    }
    const ranked = Object.values(index.occupations)
      .filter((occ) => !selectedCodes.has(occ.code))
      .map((occ) => ({ occ, score: scoreBrief(occ, queryTokens) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, cfg.fullCorpusOccupationSearch.topOccupations);
    for (const row of ranked) extraCodes.add(row.occ.code);

    const parents = new Set<string>();
    for (const code of extraCodes) {
      const brief = index.occupations[code];
      if (brief) parents.add(brief.parentSoc);
    }
    const extraRoles: RoleRef[] = [];
    for (const parent of parents) {
      try {
        const bundle = await loadOnet(opts.year, parent);
        for (const code of extraCodes) {
          const profile = bundle[code];
          if (profile && !selectedCodes.has(code)) {
            extraRoles.push({ code, title: profile.title, profile });
          }
        }
      } catch (err) {
        throw new Error(
          `Couldn't load a related O*NET bundle for ${parent}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    chunks.push(...extraRoles.flatMap((role) => chunkProfile(role, false, cfg)));
  }

  const rankedChunks = chunks
    .map((chunk) => ({ chunk, score: scoreChunk(chunk, queryTokens) }))
    .sort((a, b) => b.score - a.score || Number(b.chunk.selected) - Number(a.chunk.selected))
    .slice(0, cfg.topK)
    .map((row) => row.chunk);

  return { query, chunks: rankedChunks };
}

export function evidenceForPrompt(pack: EvidencePack): unknown {
  return pack.chunks.map((chunk) => ({
    id: chunk.id,
    code: chunk.code,
    title: chunk.title,
    section: chunk.section,
    selected: chunk.selected,
    text: chunk.text,
  }));
}
