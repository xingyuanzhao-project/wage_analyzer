/**
 * Walk the parse steps declared in prompts/parse.json. Each step is a named
 * transform; unknown step names fail instead of being skipped.
 */

export interface ParsePolicy {
  retries: number;
  retryDelayMs: number;
  steps: string[];
}

export function parseModelJson(raw: string, policy: ParsePolicy): unknown {
  let text = raw;
  for (const step of policy.steps) {
    if (step === "trim") text = text.trim();
    else if (step === "stripFences") text = stripFences(text);
    else if (step === "extractBalanced") text = extractBalanced(text);
    else if (step === "repairSmartQuotes") text = repairSmartQuotes(text);
    else if (step === "repairTrailingCommas") text = repairTrailingCommas(text);
    else if (step === "parse") return JSON.parse(text);
    else throw new Error(`Unknown parse step in prompts/parse.json: ${step}`);
  }
  throw new Error("prompts/parse.json steps did not end with parse");
}

function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function repairSmartQuotes(text: string): string {
  return text.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function repairTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, "$1");
}

/** First complete `{...}` or `[...]`, respecting quoted strings. */
function extractBalanced(text: string): string {
  const start = text.search(/[\{\[]/);
  if (start < 0) return text;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}
