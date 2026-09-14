"""
Local OpenRouter proxy for Customize Job Description.

The browser never sees OPENROUTER_API_KEY. Every completion is a callId plus
variables; message text, temperature, and token limits come from /prompts.
Only models that are free on OpenRouter and listed in prompts/models.json are
used. Missing key, unknown call, or no matching free model is an error — nothing
is invented here.
"""

from __future__ import annotations

import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
PROMPTS = ROOT / "prompts"
ENV_PATH = ROOT / ".env"

VAR = re.compile(r"\{\{(\w+)\}\}")


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def read_json(path: Path):
    if not path.is_file():
        raise FileNotFoundError(f"Missing prompt file: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def interpolate(template: str, variables: dict) -> str:
    missing = [name for name in VAR.findall(template) if name not in variables]
    if missing:
        raise KeyError("Prompt variables not provided: " + ", ".join(sorted(set(missing))))

    def repl(match: re.Match) -> str:
        value = variables[match.group(1)]
        if isinstance(value, (dict, list)):
            return json.dumps(value, indent=2, ensure_ascii=False)
        if value is None:
            return ""
        return str(value)

    return VAR.sub(repl, template)


def is_free_model(model: dict, policy: dict) -> bool:
    model_id = str(model.get("id") or "")
    suffix = policy.get("requireIdSuffix")
    if suffix and not model_id.endswith(suffix):
        return False
    if not policy.get("alsoRequireZeroPricing"):
        return True
    pricing = model.get("pricing") or {}
    try:
        prompt = float(pricing.get("prompt") or 0)
        completion = float(pricing.get("completion") or 0)
    except (TypeError, ValueError):
        return False
    return prompt == 0 and completion == 0


class Catalog:
    def __init__(self) -> None:
        index = read_json(PROMPTS / "index.json")
        self.models = read_json(PROMPTS / index["models"])
        self.workflow = read_json(PROMPTS / index["workflow"])
        self.calls = {}
        for call_id, rel in index["calls"].items():
            spec = read_json(PROMPTS / rel)
            if spec.get("id") != call_id:
                raise ValueError(f"{rel} id {spec.get('id')!r} does not match catalog key {call_id!r}")
            self.calls[call_id] = spec

    def call(self, call_id: str) -> dict:
        spec = self.calls.get(call_id)
        if spec is None:
            raise KeyError(f"Unknown LLM call id: {call_id}")
        return spec


class OpenRouter:
    def __init__(self, catalog: Catalog) -> None:
        self.catalog = catalog
        key = os.environ.get("OPENROUTER_API_KEY", "").strip()
        if not key:
            raise RuntimeError("OPENROUTER_API_KEY is not set. Put it in .env or the environment.")
        self.key = key
        proxy = catalog.workflow["proxy"]
        self.base = proxy["openrouterBase"].rstrip("/")
        self.referer = proxy["siteUrl"]
        self.title = proxy["siteTitle"]
        self._free_ids: list[str] | None = None

    def preferred_free(self) -> list[str]:
        policy = self.catalog.models
        if policy.get("policy") != "free-only":
            raise RuntimeError("prompts/models.json must set policy to free-only")
        free = set(self.free_ids())
        preferred = [mid for mid in policy.get("preferred") or [] if mid in free]
        if preferred:
            return preferred
        if policy.get("ifPreferredUnavailable") == "error":
            available = self.free_ids()
            raise RuntimeError(
                "None of the preferred free models are available on OpenRouter. "
                "Update prompts/models.json preferred list. Currently free: "
                + (", ".join(available[:12]) if available else "(none)")
            )
        raise RuntimeError("ifPreferredUnavailable is not error and no fallback is defined")

    def _request(self, method: str, path: str, payload: dict | None = None) -> dict:
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        req = Request(
            self.base + path,
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.key}",
                "Content-Type": "application/json",
                "HTTP-Referer": self.referer,
                "X-Title": self.title,
            },
        )
        try:
            with urlopen(req, timeout=90) as res:
                return json.loads(res.read().decode("utf-8"))
        except HTTPError as err:
            body = err.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"OpenRouter HTTP {err.code}: {body}") from err
        except URLError as err:
            raise RuntimeError(f"OpenRouter request failed: {err.reason}") from err

    def free_ids(self) -> list[str]:
        if self._free_ids is None:
            listing = self._request("GET", "/models")
            rows = listing.get("data") or []
            self._free_ids = [
                str(row["id"])
                for row in rows
                if isinstance(row, dict) and is_free_model(row, self.catalog.models)
            ]
        return self._free_ids

    def resolve_model(self) -> str:
        return self.preferred_free()[0]

    def complete(self, spec: dict, variables: dict) -> dict:
        required = spec.get("variables") or []
        missing = [name for name in required if name not in variables]
        if missing:
            raise KeyError("Call is missing variables: " + ", ".join(missing))
        messages = []
        for message in spec["messages"]:
            messages.append(
                {
                    "role": message["role"],
                    "content": interpolate(message["content"], variables),
                }
            )
        models = self.preferred_free()
        walk = self.catalog.models.get("onPreferredError") == "next-preferred"
        errors: list[str] = []
        last: RuntimeError | None = None
        for model in models:
            body = {
                "model": model,
                "messages": messages,
                "temperature": spec["temperature"],
                "max_tokens": spec["max_tokens"],
            }
            try:
                result = self._request("POST", "/chat/completions", body)
                choice = (result.get("choices") or [{}])[0]
                content = ((choice.get("message") or {}).get("content")) or ""
                return {"model": model, "content": content, "callId": spec["id"]}
            except RuntimeError as err:
                last = err
                errors.append(f"{model}: {err}")
                if not walk:
                    raise
                continue
        raise RuntimeError("All preferred free models failed. " + " | ".join(errors)) from last


class Handler(BaseHTTPRequestHandler):
    catalog: Catalog
    router: OpenRouter

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _origin_ok(self) -> str | None:
        origin = self.headers.get("Origin")
        proxy = self.catalog.workflow["proxy"]
        allowed = proxy["allowedOrigins"]
        pattern = proxy.get("allowedOriginPattern")
        if origin and origin in allowed:
            return origin
        if origin and pattern and re.fullmatch(pattern, origin):
            return origin
        if origin is None:
            return allowed[0]
        return None

    def _cors(self, origin: str) -> None:
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send(self, code: int, payload: dict, origin: str | None) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        if origin:
            self._cors(origin)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:
        origin = self._origin_ok()
        if origin is None:
            self.send_error(403, "Origin not allowed")
            return
        self.send_response(204)
        self._cors(origin)
        self.end_headers()

    def do_GET(self) -> None:
        origin = self._origin_ok()
        if origin is None:
            self._send(403, {"error": "Origin not allowed"}, None)
            return
        if self.path.split("?", 1)[0] == "/health":
            self._send(200, {"ok": True}, origin)
            return
        if self.path.split("?", 1)[0] == "/v1/models/free":
            try:
                chosen = self.router.resolve_model()
                self._send(
                    200,
                    {"policy": "free-only", "resolved": chosen, "free": self.router.free_ids()},
                    origin,
                )
            except Exception as err:
                self._send(502, {"error": str(err)}, origin)
            return
        self._send(404, {"error": "Not found"}, origin)

    def do_POST(self) -> None:
        origin = self._origin_ok()
        if origin is None:
            self._send(403, {"error": "Origin not allowed"}, None)
            return
        if self.path.split("?", 1)[0] != self.catalog.workflow["proxy"]["completePath"]:
            self._send(404, {"error": "Not found"}, origin)
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._send(400, {"error": "Request body must be JSON"}, origin)
            return
        call_id = body.get("callId")
        variables = body.get("variables")
        if not isinstance(call_id, str) or not isinstance(variables, dict):
            self._send(400, {"error": "Body must include callId and variables"}, origin)
            return
        try:
            spec = self.catalog.call(call_id)
            result = self.router.complete(spec, variables)
            self._send(200, result, origin)
        except KeyError as err:
            self._send(400, {"error": str(err)}, origin)
        except Exception as err:
            self._send(502, {"error": str(err)}, origin)


def main() -> None:
    load_dotenv(ENV_PATH)
    if not PROMPTS.is_dir():
        print(f"ERROR: prompts folder not found: {PROMPTS}", file=sys.stderr)
        sys.exit(1)
    catalog = Catalog()
    try:
        router = OpenRouter(catalog)
    except RuntimeError as err:
        print(f"ERROR: {err}", file=sys.stderr)
        sys.exit(1)
    Handler.catalog = catalog
    Handler.router = router
    proxy = catalog.workflow["proxy"]
    host = proxy["host"]
    port = int(proxy["port"])
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"LLM proxy on http://{host}:{port} (free OpenRouter models only)", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
