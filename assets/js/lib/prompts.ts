/**
 * Load the /prompts catalog. Every LLM message, argument, purpose, intake
 * field, retrieve rule, and customize label lives there. This module only
 * fetches and types that folder — it does not invent call text.
 */

export interface ModelPolicy {
  policy: string;
  requireIdSuffix: string;
  alsoRequireZeroPricing: boolean;
  ifPreferredUnavailable: string;
  onPreferredError?: string;
  preferred: string[];
}

export interface WorkflowProxy {
  host: string;
  port: number;
  defaultOrigin: string;
  completePath: string;
  allowedOrigins: string[];
  allowedOriginPattern?: string;
  openrouterBase: string;
  siteTitle: string;
  siteUrl: string;
}

export interface ParsePolicyFile {
  retries: number;
  retryDelayMs: number;
  steps: string[];
}

export interface WorkflowFile {
  proxy: WorkflowProxy;
  outline: { maxRevisions: number };
  grounding: { socPattern: string; rejectUnsourcedMoney: boolean };
  labels: Record<string, string>;
}

export interface IntakeField {
  id: string;
  label: string;
  kind: "chips" | "text" | "chips+text";
  chipSource?: "wage-levels" | "model";
  help?: string;
  placeholder?: string;
}

export interface ReportField {
  id: string;
  title: string;
  kind: "prose" | "list";
}

export interface PurposeItem {
  id: string;
  label: string;
  allowsFreeText?: boolean;
  reportFields: ReportField[];
}

export interface PurposesFile {
  otherPurposeId: string;
  sharedIntakeFields: IntakeField[];
  items: PurposeItem[];
}

export interface ChunkerSpec {
  section: string;
  from: "string" | "array" | "object";
  field: string;
  textKey?: string;
  textKeys?: string[];
}

export interface RetrieveFile {
  occupationIndexPath: string;
  topK: number;
  relatedCap: number;
  relatedTiers: string[];
  minTokenLength: number;
  maxChunkChars: number;
  stopwords: string[];
  queryFieldIds: string[];
  fullCorpusOccupationSearch: { purposeIds: string[]; topOccupations: number };
  chunkers: ChunkerSpec[];
}

export interface CallMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CallSpec {
  id: string;
  variables: string[];
  temperature: number;
  max_tokens: number;
  parse: { type: "json" };
  messages: CallMessage[];
}

export interface PromptIndex {
  models: string;
  workflow: string;
  retrieve: string;
  purposes: string;
  parse: string;
  calls: Record<string, string>;
}

export interface PromptCatalog {
  models: ModelPolicy;
  workflow: WorkflowFile;
  retrieve: RetrieveFile;
  purposes: PurposesFile;
  parse: ParsePolicyFile;
  calls: Record<string, CallSpec>;
}

const BASE =
  (typeof window !== "undefined" && window.WAGE_PROMPTS_BASE) || "/prompts/";

function promptUrl(path: string): string {
  return BASE.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(promptUrl(path));
  if (!res.ok) {
    throw new Error(`Could not load prompt file ${path} (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
}

let cached: PromptCatalog | null = null;
let inflight: Promise<PromptCatalog> | null = null;

export function loadPrompts(): Promise<PromptCatalog> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = (async () => {
    const index = await getJSON<PromptIndex>("index.json");
    const [models, workflow, retrieve, purposes, parse] = await Promise.all([
      getJSON<ModelPolicy>(index.models),
      getJSON<WorkflowFile>(index.workflow),
      getJSON<RetrieveFile>(index.retrieve),
      getJSON<PurposesFile>(index.purposes),
      getJSON<ParsePolicyFile>(index.parse),
    ]);
    const callEntries = await Promise.all(
      Object.entries(index.calls).map(async ([id, rel]) => {
        const spec = await getJSON<CallSpec>(rel);
        if (spec.id !== id) {
          throw new Error(`prompts/${rel} id ${spec.id} does not match catalog key ${id}`);
        }
        return [id, spec] as const;
      }),
    );
    const catalog: PromptCatalog = {
      models,
      workflow,
      retrieve,
      purposes,
      parse,
      calls: Object.fromEntries(callEntries),
    };
    cached = catalog;
    return catalog;
  })();
  inflight.catch(() => {
    inflight = null;
  });
  return inflight;
}

export function purposeById(catalog: PromptCatalog, id: string): PurposeItem {
  const found = catalog.purposes.items.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown purpose id: ${id}`);
  return found;
}

export function modelChipFields(catalog: PromptCatalog): IntakeField[] {
  return catalog.purposes.sharedIntakeFields.filter((field) => field.chipSource === "model");
}
