// Linux-side dispatch service for the n8n "trigger Agent Orchestrator"
// workflow. The HTTP-calling logic below (withTimeout/callOpenAiCompatible/
// callGemini/callOllamaLocal/dispatch/callOne/sleep) is ported verbatim
// from the Windows agent-orchestrator's call-provider.mjs -- that logic
// was already tested and platform-agnostic (plain fetch calls); the only
// thing that doesn't work on Linux is credential retrieval, which used
// Windows DPAPI via PowerShell. Swapped here for environment variables,
// which is the standard way secrets get into a container.
//
// Internal-only by design: this service is NOT routed through Traefik
// and has no public entrypoint in docker-compose.yml. It holds live API
// keys and has no user-facing login of its own (unlike n8n), so exposing
// it directly would repeat the exact unauthenticated-standing-service
// mistake apify-data-pull was built to avoid. n8n reaches it over the
// internal Docker network only, using a shared secret as a second layer
// on top of "not publicly reachable" rather than relying on network
// isolation alone.
//
// providers.json is a Linux-side mirror of the schema/endpoint/model
// facts in the Windows agent-orchestrator's store.mjs -- deliberately
// NOT the whole roster (no claude-subagent/mcp-tool entries, since those
// aren't HTTP-dispatchable and don't belong in a standalone service). It
// has to stay pure data (no comment keys) since Object.keys(PROVIDERS)
// below is trusted as the real provider list.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROVIDERS = JSON.parse(readFileSync(join(__dirname, "providers.json"), "utf8"));
const PORT = process.env.PORT || 3000;
const DISPATCH_SECRET = process.env.DISPATCH_SECRET || "";

if (!DISPATCH_SECRET) {
  console.error("DISPATCH_SECRET is not set -- refusing to start. Set it in .env; n8n's HTTP Request node must send it as X-Dispatch-Secret.");
  process.exit(1);
}

// ---- ported verbatim from call-provider.mjs ----

async function withTimeout(timeoutMs, fn) {
  if (!timeoutMs) return fn(undefined);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAiCompatible(provider, apiKey, prompt) {
  if (!provider.model) throw new Error(`Provider has no model configured.`);
  return withTimeout(provider.timeoutMs, async (signal) => {
    const res = await fetch(provider.endpoint, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
    const text = json?.choices?.[0]?.message?.content;
    if (!text) throw new Error("Response had no message content.");
    return text;
  });
}

async function callGemini(provider, apiKey, prompt) {
  return withTimeout(provider.timeoutMs, async (signal) => {
    const url = `${provider.endpoint}?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Response had no candidate text.");
    return text;
  });
}

async function callOllamaLocal(provider, prompt) {
  return withTimeout(provider.timeoutMs, async (signal) => {
    const res = await fetch(provider.endpoint, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: provider.model || "llama3", prompt, stream: false }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} -- is Ollama running and reachable from this container?`);
    const json = await res.json();
    if (!json?.response) throw new Error("Response had no text.");
    return json.response;
  });
}

// Shells out to the Claude Code CLI baked into this image (see Dockerfile)
// instead of hitting an HTTP API -- it authenticates via a long-lived
// CLAUDE_CODE_OAUTH_TOKEN (Pro/Max subscription), not a per-request API
// key, and the prompt is passed as an argv element (never shell-interpolated)
// so it can't be used to inject extra CLI flags or commands.
async function callClaudeCode(provider, apiKey, prompt) {
  return withTimeout(provider.timeoutMs, async (signal) => {
    const args = ["-p", prompt, "--output-format", "text"];
    if (provider.model) args.push("--model", provider.model);
    const { stdout, stderr } = await execFileAsync("claude", args, {
      signal,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: apiKey },
    });
    const text = stdout.trim();
    if (!text) throw new Error(stderr?.trim() || "Claude Code produced no output.");
    return text;
  });
}

async function dispatch(provider, apiKey, prompt) {
  switch (provider.schema) {
    case "openai": return callOpenAiCompatible(provider, apiKey, prompt);
    case "gemini": return callGemini(provider, apiKey, prompt);
    case "ollama-local": return callOllamaLocal(provider, prompt);
    case "claude-code": return callClaudeCode(provider, apiKey, prompt);
    default: throw new Error(`No call handler for schema "${provider.schema}".`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- credential lookup: the one part that's genuinely different from
// the Windows version (env var instead of DPAPI-decrypted file) ----

async function callOne(providerId, prompt) {
  const started = Date.now();
  try {
    const provider = PROVIDERS[providerId];
    if (!provider) return { ok: false, providerId, error: `Unknown provider id "${providerId}". Known: ${Object.keys(PROVIDERS).join(", ")}`, ms: 0 };

    const apiKey = process.env[provider.credentialEnvVar];
    if (!apiKey) {
      return { ok: false, providerId, error: `${provider.credentialEnvVar} is not set in this service's environment.`, ms: 0 };
    }

    const attempts = 1 + (provider.maxRetries || 0);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const text = await dispatch(provider, apiKey, prompt);
        return { ok: true, providerId, text, attempt, ms: Date.now() - started };
      } catch (err) {
        lastError = err.name === "AbortError" ? `Timed out after ${provider.timeoutMs}ms` : (err.message || String(err));
      }
      if (attempt < attempts) await sleep(500 * attempt);
    }
    return { ok: false, providerId, error: lastError, attempts, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, providerId, error: `Unexpected failure: ${err.message || String(err)}`, ms: Date.now() - started };
  }
}

// ---- HTTP server ----

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, providers: Object.keys(PROVIDERS) }));
    return;
  }

  if (req.headers["x-dispatch-secret"] !== DISPATCH_SECRET) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Missing or wrong X-Dispatch-Secret header." }));
    return;
  }

  try {
    if (req.method === "POST" && req.url === "/dispatch") {
      const { providerId, prompt } = await readBody(req);
      if (!providerId || !prompt) throw new Error('Body needs { "providerId": "...", "prompt": "..." }');
      const result = await callOne(providerId, prompt);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === "POST" && req.url === "/dispatch-parallel") {
      const { providerIds, prompt } = await readBody(req);
      if (!Array.isArray(providerIds) || providerIds.length === 0 || !prompt) {
        throw new Error('Body needs { "providerIds": ["...", ...], "prompt": "..." }');
      }
      const settled = await Promise.allSettled(providerIds.map((id) => callOne(id, prompt)));
      const results = settled.map((s, i) =>
        s.status === "fulfilled" ? s.value : { ok: false, providerId: providerIds[i], error: String(s.reason), ms: 0 }
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Not found. POST /dispatch or /dispatch-parallel, GET /health." }));
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: err.message || String(err) }));
  }
});

server.listen(PORT, () => console.log(`dispatch-service listening on :${PORT}`));
