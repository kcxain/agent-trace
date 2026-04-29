import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { Readable } from "node:stream";

export function tokenPreview(value) {
  const text = String(value || "");
  return text.length > 16 ? `${text.slice(0, 8)}...${text.slice(-4)}` : "[REDACTED]";
}

export function extractTokenHeaders(headers) {
  const out = [];
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "x-api-key" || lower === "cookie") {
      out.push({ header: key, value: Array.isArray(value) ? value.join(", ") : String(value || "") });
    }
  }
  return out;
}

export function sanitizeHeaders(headers) {
  const out = { ...headers };
  for (const key of Object.keys(out)) {
    const lower = key.toLowerCase();
    if (["authorization", "cookie", "set-cookie", "x-api-key"].includes(lower)) {
      const value = Array.isArray(out[key]) ? out[key].join(", ") : String(out[key] || "");
      out[key] = value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-4)}` : "[REDACTED]";
    }
  }
  return out;
}

export function stripProxyHeaders(headers) {
  const out = { ...headers };
  for (const key of Object.keys(out)) {
    if (["accept-encoding", "connection", "host", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"].includes(key.toLowerCase())) delete out[key];
  }
  return out;
}

export function responseHeadersForClient(headers) {
  const out = stripProxyHeaders(headers);
  delete out["content-encoding"];
  delete out["content-length"];
  return out;
}

export function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === lower) return Array.isArray(value) ? value.join(", ") : String(value || "");
  }
  return "";
}

function decodeBodyBuffer(buffer, headers) {
  const encoding = headerValue(headers, "content-encoding").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean).pop() || "";
  if (!buffer.length || !encoding || encoding === "identity") return { buffer, encoding };
  try {
    if (encoding === "gzip" || encoding === "x-gzip") return { buffer: zlib.gunzipSync(buffer), encoding };
    if (encoding === "br") return { buffer: zlib.brotliDecompressSync(buffer), encoding };
    if (encoding === "deflate") return { buffer: zlib.inflateSync(buffer), encoding };
    if (encoding === "zstd" && typeof zlib.zstdDecompressSync === "function") return { buffer: zlib.zstdDecompressSync(buffer), encoding };
  } catch (error) {
    return { buffer, encoding, decode_error: String(error) };
  }
  return { buffer, encoding, decode_error: `unsupported content-encoding: ${encoding}` };
}

function parseBody(buffer, headers) {
  const decoded = decodeBodyBuffer(buffer, headers);
  const text = decoded.buffer.toString("utf8");
  if (!text) return null;
  if (headerValue(headers, "content-type").includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

export function bodyCapture(buffer, headers) {
  const decoded = decodeBodyBuffer(buffer, headers);
  const out = {
    body: parseBody(buffer, headers),
  };
  if (buffer.length) {
    out.body_base64 = buffer.toString("base64");
    out.body_sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  }
  if (decoded.encoding) out.body_content_encoding = decoded.encoding;
  if (decoded.decode_error) out.body_decode_error = decoded.decode_error;
  if (decoded.buffer !== buffer) out.body_decoded_sha256 = crypto.createHash("sha256").update(decoded.buffer).digest("hex");
  return out;
}

export function isAbsoluteHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

export async function forwardAndCaptureHttpRequest({ req, res, target, requestBody, rawDir, logFile, tokenFile, extractToken, id, started, extraRequest = {} }) {
  const requestRecord = { timestamp: new Date(started).toISOString(), method: req.method, url: target.toString(), headers: sanitizeHeaders(req.headers), ...bodyCapture(requestBody, req.headers), ...extraRequest };
  if (extractToken) {
    for (const token of extractTokenHeaders(req.headers)) {
      writeTokenFile(tokenFile, { timestamp: new Date(started).toISOString(), url: target.toString(), header: token.header, preview: tokenPreview(token.value), value: token.value });
    }
  }
  try {
    const upstreamResponse = await fetch(target, { method: req.method, headers: stripProxyHeaders(req.headers), body: requestBody.length ? requestBody : undefined, redirect: "manual" });
    const responseHeaders = Object.fromEntries(upstreamResponse.headers.entries());
    res.writeHead(upstreamResponse.status, responseHeadersForClient(responseHeaders));
    const chunks = [];
    if (upstreamResponse.body) {
      for await (const chunk of Readable.fromWeb(upstreamResponse.body)) {
        chunks.push(Buffer.from(chunk));
        res.write(chunk);
      }
    }
    res.end();
    const responseBody = Buffer.concat(chunks);
    const pair = { type: "api_pair", request: requestRecord, response: { timestamp: new Date().toISOString(), status_code: upstreamResponse.status, headers: sanitizeHeaders(responseHeaders), ...bodyCapture(responseBody, responseHeaders) }, duration_ms: Date.now() - started };
    fs.writeFileSync(path.join(rawDir, `${id}.json`), JSON.stringify(pair, null, 2));
    writeJsonl(logFile, pair);
  } catch (error) {
    const pair = { type: "api_pair", request: requestRecord, error: String(error), duration_ms: Date.now() - started };
    fs.writeFileSync(path.join(rawDir, `${id}.json`), JSON.stringify(pair, null, 2));
    writeJsonl(logFile, pair);
    if (!res.headersSent) res.writeHead(502);
    res.end(String(error));
  }
}

export function writeJsonl(file, event) {
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
}

export function writeTokenFile(file, event) {
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort.
  }
}

