import { parseModelJson } from "./parseJson";
import { loadPrompts } from "./prompts";

export interface LlmResult<T> {
  callId: string;
  model: string;
  raw: string;
  parsed: T;
}

function proxyOrigin(defaultOrigin: string): string {
  const fromWindow = typeof window !== "undefined" ? window.WAGE_LLM_PROXY : "";
  return (fromWindow || defaultOrigin).replace(/\/+$/, "");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function postOnce(
  origin: string,
  path: string,
  callId: string,
  variables: Record<string, unknown>,
  emptyError: string,
): Promise<{ content: string; model: string }> {
  let res: Response;
  try {
    res = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callId, variables }),
    });
  } catch {
    throw new Error((await loadPrompts()).workflow.labels.proxyMissing);
  }
  const body = (await res.json()) as { content?: string; model?: string; error?: string };
  if (!res.ok) {
    throw new Error(body.error || `${emptyError} HTTP ${res.status}`);
  }
  if (!body.content || !body.model) {
    throw new Error(`${emptyError} Empty model response.`);
  }
  return { content: body.content, model: body.model };
}

/**
 * Run one named call from /prompts. The proxy interpolates templates and picks
 * a free model. This client only sends callId + variables, then walks the
 * shared parse/retry policy in prompts/parse.json.
 */
export async function completeCall<T>(
  callId: string,
  variables: Record<string, unknown>,
): Promise<LlmResult<T>> {
  const catalog = await loadPrompts();
  const spec = catalog.calls[callId];
  if (!spec) throw new Error(`Unknown LLM call id: ${callId}`);
  const missing = spec.variables.filter((name) => !(name in variables));
  if (missing.length) {
    throw new Error(`${callId} missing variables: ${missing.join(", ")}`);
  }

  if (spec.parse.type !== "json") {
    throw new Error(`${callId} parse.type must be json`);
  }

  const origin = proxyOrigin(catalog.workflow.proxy.defaultOrigin);
  const attempts = 1 + catalog.parse.retries;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const body = await postOnce(
        origin,
        catalog.workflow.proxy.completePath,
        callId,
        variables,
        catalog.workflow.labels.errorPrefix,
      );
      const parsed = parseModelJson(body.content, catalog.parse) as T;
      return { callId, model: body.model, raw: body.content, parsed };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < attempts) await delay(catalog.parse.retryDelayMs);
    }
  }

  throw lastError ?? new Error(catalog.workflow.labels.errorPrefix);
}
