/**
 * Hosted OpenRouter proxy for Customize Job Description.
 * Same contract as scripts/llm_proxy.py: callId + variables in, key stays here.
 */

const VAR = /\{\{(\w+)\}\}/g;

function interpolate(template, variables) {
  const names = [...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
  const missing = [...new Set(names.filter((name) => !(name in variables)))];
  if (missing.length) {
    throw new Error("Prompt variables not provided: " + missing.sort().join(", "));
  }
  return template.replace(VAR, (_, name) => {
    const value = variables[name];
    if (value !== null && typeof value === "object") {
      return JSON.stringify(value, null, 2);
    }
    if (value === null || value === undefined) return "";
    return String(value);
  });
}

function isFreeModel(model, policy) {
  const modelId = String(model.id || "");
  const suffix = policy.requireIdSuffix;
  if (suffix && !modelId.endsWith(suffix)) return false;
  if (!policy.alsoRequireZeroPricing) return true;
  const pricing = model.pricing || {};
  const prompt = Number(pricing.prompt || 0);
  const completion = Number(pricing.completion || 0);
  return prompt === 0 && completion === 0;
}

function allowedOrigins(workflow) {
  const proxy = workflow.proxy;
  const out = new Set(proxy.allowedOrigins || []);
  if (proxy.siteUrl) {
    try {
      out.add(new URL(proxy.siteUrl).origin);
    } catch {
      /* siteUrl is not a URL */
    }
  }
  return out;
}

function originOk(request, workflow) {
  const origin = request.headers.get("Origin");
  const listed = allowedOrigins(workflow);
  if (!origin) return [...listed][0] || "*";
  if (listed.has(origin)) return origin;
  const pattern = workflow.proxy.allowedOriginPattern;
  if (pattern && new RegExp(pattern).test(origin)) return origin;
  return null;
}

async function readJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: HTTP ${res.status}`);
  return res.json();
}

async function loadCatalog(base) {
  const root = base.endsWith("/") ? base : `${base}/`;
  const index = await readJson(`${root}index.json`);
  const [models, workflow] = await Promise.all([
    readJson(`${root}${index.models}`),
    readJson(`${root}${index.workflow}`),
  ]);
  const calls = {};
  for (const [id, rel] of Object.entries(index.calls || {})) {
    const spec = await readJson(`${root}${rel}`);
    if (spec.id !== id) {
      throw new Error(`${rel} id ${spec.id} does not match catalog key ${id}`);
    }
    calls[id] = spec;
  }
  return { models, workflow, calls };
}

async function openrouter(env, workflow, method, path, payload) {
  const key = (env.OPENROUTER_API_KEY || "").trim();
  if (!key) throw new Error("OPENROUTER_API_KEY is not set on the proxy.");
  const base = String(workflow.proxy.openrouterBase).replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": workflow.proxy.siteUrl,
      "X-Title": workflow.proxy.siteTitle,
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function freeIds(env, catalog) {
  const listing = await openrouter(env, catalog.workflow, "GET", "/models");
  const rows = listing.data || [];
  return rows
    .filter((row) => row && typeof row === "object" && isFreeModel(row, catalog.models))
    .map((row) => String(row.id));
}

async function preferredFree(env, catalog) {
  const policy = catalog.models;
  if (policy.policy !== "free-only") {
    throw new Error("prompts/models.json must set policy to free-only");
  }
  const free = new Set(await freeIds(env, catalog));
  const preferred = (policy.preferred || []).filter((id) => free.has(id));
  if (preferred.length) return preferred;
  if (policy.ifPreferredUnavailable === "error") {
    const available = [...free];
    throw new Error(
      "None of the preferred free models are available on OpenRouter. " +
        "Update prompts/models.json preferred list. Currently free: " +
        (available.slice(0, 12).join(", ") || "(none)"),
    );
  }
  throw new Error("ifPreferredUnavailable is not error and no fallback is defined");
}

async function complete(env, catalog, spec, variables) {
  const required = spec.variables || [];
  const missing = required.filter((name) => !(name in variables));
  if (missing.length) throw new Error("Call is missing variables: " + missing.join(", "));
  const messages = spec.messages.map((message) => ({
    role: message.role,
    content: interpolate(message.content, variables),
  }));
  const models = await preferredFree(env, catalog);
  const walk = catalog.models.onPreferredError === "next-preferred";
  const errors = [];
  let last = null;
  for (const model of models) {
    try {
      const result = await openrouter(env, catalog.workflow, "POST", "/chat/completions", {
        model,
        messages,
        temperature: spec.temperature,
        max_tokens: spec.max_tokens,
      });
      const choice = (result.choices || [{}])[0];
      const content = (choice.message || {}).content || "";
      return { model, content, callId: spec.id };
    } catch (err) {
      last = err;
      errors.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
      if (!walk) throw err;
    }
  }
  throw new Error("All preferred free models failed. " + errors.join(" | ") + (last ? "" : ""));
}

function jsonResponse(code, payload, origin) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
  }
  return new Response(JSON.stringify(payload), { status: code, headers });
}

export default {
  async fetch(request, env) {
    let catalog;
    try {
      catalog = await loadCatalog(env.PROMPTS_BASE);
    } catch (err) {
      return jsonResponse(502, { error: err instanceof Error ? err.message : String(err) }, "*");
    }
    const origin = originOk(request, catalog.workflow);
    if (origin === null) return jsonResponse(403, { error: "Origin not allowed" }, null);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const path = new URL(request.url).pathname;
    const proxy = catalog.workflow.proxy;

    if (request.method === "GET" && path === "/health") {
      return jsonResponse(200, { ok: true }, origin);
    }
    if (request.method === "GET" && path === "/v1/models/free") {
      try {
        const preferred = await preferredFree(env, catalog);
        return jsonResponse(
          200,
          { policy: "free-only", resolved: preferred[0], free: await freeIds(env, catalog) },
          origin,
        );
      } catch (err) {
        return jsonResponse(502, { error: err instanceof Error ? err.message : String(err) }, origin);
      }
    }
    if (request.method !== "POST") {
      return jsonResponse(404, { error: "Not found" }, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { error: "Request body must be JSON" }, origin);
    }

    if (path === proxy.embedPath) {
      return jsonResponse(
        501,
        { error: "Query embeddings run in the browser from prompts/retrieve.json embedding.query." },
        origin,
      );
    }
    if (path !== proxy.completePath) {
      return jsonResponse(404, { error: "Not found" }, origin);
    }
    const callId = body.callId;
    const variables = body.variables;
    if (typeof callId !== "string" || !variables || typeof variables !== "object") {
      return jsonResponse(400, { error: "Body must include callId and variables" }, origin);
    }
    try {
      const spec = catalog.calls[callId];
      if (!spec) throw new Error(`Unknown LLM call id: ${callId}`);
      return jsonResponse(200, await complete(env, catalog, spec, variables), origin);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message.startsWith("Unknown LLM") || message.startsWith("Call is missing") ? 400 : 502;
      return jsonResponse(code, { error: message }, origin);
    }
  },
};
