const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const runDir = process.env.AGENT_TRACE_RUN_DIR || path.resolve(".agent-trace", "runtime");
const logFile = process.env.AGENT_TRACE_LOG_FILE || path.join(runDir, "logs.jsonl");
const tokenFile = process.env.AGENT_TRACE_TOKEN_FILE || path.join(runDir, "tokens.jsonl");
const includeAll = process.env.AGENT_TRACE_INCLUDE_ALL_REQUESTS === "true";
const extractToken = process.env.AGENT_TRACE_EXTRACT_TOKEN === "true";
fs.mkdirSync(runDir, { recursive: true });
fs.mkdirSync(path.dirname(logFile), { recursive: true });

function write(event) {
  try {
    fs.appendFileSync(logFile, `${JSON.stringify(event)}\n`);
  } catch {
    // Ignore tracing failures inside the wrapped agent.
  }
}

function writeToken(event) {
  if (!extractToken) return;
  try {
    fs.appendFileSync(tokenFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(tokenFile, 0o600);
    } catch {
      // Best effort on filesystems without chmod support.
    }
  } catch {
    // Ignore tracing failures inside the wrapped agent.
  }
}

function tokenPreview(value) {
  const text = String(value || "");
  return text.length > 16 ? `${text.slice(0, 8)}...${text.slice(-4)}` : "[REDACTED]";
}

function redact(headers) {
  const out = { ...(headers || {}) };
  for (const key of Object.keys(out)) {
    const lower = key.toLowerCase();
    if (["authorization", "x-api-key", "cookie", "set-cookie", "proxy-authorization"].some((s) => lower.includes(s))) {
      const value = Array.isArray(out[key]) ? out[key].join(", ") : String(out[key] || "");
      out[key] = value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-4)}` : "[REDACTED]";
    }
  }
  return out;
}

function maybePrintToken(headers) {
  if (!extractToken) return;
  for (const key of Object.keys(headers || {})) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "x-api-key") {
      console.error(`[agent-trace] ${key}: ${headers[key]}`);
      writeToken({
        timestamp: new Date().toISOString(),
        header: key,
        preview: tokenPreview(headers[key]),
        value: String(headers[key]),
      });
    }
  }
}

function apiHosts() {
  const urls = [
    process.env.CLAUDE_TRACE_API_ENDPOINT,
    process.env.ANTHROPIC_BASE_URL,
    "https://api.anthropic.com",
  ].filter(Boolean);
  return urls.map((url) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  });
}

function isClaudeApi(url) {
  const text = String(url);
  const matchedHost = apiHosts().some((host) => text.includes(host));
  if (!matchedHost) return false;
  return includeAll || text.includes("/v1/messages") || text.includes("bedrock-runtime.");
}

function parseBody(body) {
  if (!body) return null;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return body;
}

function parseText(text, contentType = "") {
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

if (global.fetch && !global.fetch.__agentTraceWrapped) {
  const originalFetch = global.fetch;
  global.fetch = async function tracedFetch(input, init = {}) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!isClaudeApi(url)) return originalFetch(input, init);
    const started = Date.now();
    const requestHeaders = Object.fromEntries(new Headers(init.headers || {}).entries());
    maybePrintToken(requestHeaders);
    const request = {
      timestamp: new Date(started).toISOString(),
      method: init.method || "GET",
      url,
      headers: redact(requestHeaders),
      body: parseBody(init.body),
    };
    try {
      const response = await originalFetch(input, init);
      const clone = response.clone();
      const contentType = clone.headers.get("content-type") || "";
      const text = await clone.text();
      write({
        type: "api_pair",
        request,
        response: {
          timestamp: new Date().toISOString(),
          status_code: response.status,
          headers: redact(Object.fromEntries(response.headers.entries())),
          body: parseText(text, contentType),
        },
        duration_ms: Date.now() - started,
      });
      return response;
    } catch (error) {
      write({ type: "api_pair", request, error: String(error), duration_ms: Date.now() - started });
      throw error;
    }
  };
  global.fetch.__agentTraceWrapped = true;
}

function wrapRequest(mod, protocol) {
  if (!mod.request || mod.request.__agentTraceWrapped) return;
  const original = mod.request;
  mod.request = function tracedRequest(options, callback) {
    const url = typeof options === "string" ? options : `${protocol}//${options.hostname || options.host || "localhost"}${options.port ? `:${options.port}` : ""}${options.path || "/"}`;
    if (!isClaudeApi(url)) return original.call(this, options, callback);
    const started = Date.now();
    let body = "";
    const req = original.call(this, options, (res) => {
      let responseText = "";
      res.on("data", (chunk) => { responseText += chunk; });
      res.on("end", () => {
        maybePrintToken(options.headers || {});
        write({
          type: "api_pair",
          request: {
            timestamp: new Date(started).toISOString(),
            method: options.method || "GET",
            url,
            headers: redact(options.headers || {}),
            body: parseBody(body),
          },
          response: {
            timestamp: new Date().toISOString(),
            status_code: res.statusCode,
            headers: redact(res.headers || {}),
            body: parseText(responseText, res.headers?.["content-type"] || ""),
          },
          duration_ms: Date.now() - started,
        });
      });
      if (callback) callback(res);
    });
    const writeOriginal = req.write;
    req.write = function tracedWrite(chunk, ...args) {
      if (chunk) body += chunk;
      return writeOriginal.call(this, chunk, ...args);
    };
    return req;
  };
  mod.request.__agentTraceWrapped = true;
}

wrapRequest(http, "http:");
wrapRequest(https, "https:");
