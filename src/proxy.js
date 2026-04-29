import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import {
  extractTokenHeaders,
  forwardAndCaptureHttpRequest,
  isAbsoluteHttpUrl,
  readRequestBody,
  sanitizeHeaders,
  stripProxyHeaders,
  tokenPreview,
  writeJsonl,
  writeTokenFile,
} from "./request-log.js";

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function ignoreSocketErrors(socket) {
  if (socket && typeof socket.on === "function") socket.on("error", () => {});
}

function safeSocketWrite(socket, data) {
  if (!socket || socket.destroyed || socket.writable === false) return;
  try {
    socket.write(data, () => {});
  } catch {
    // Connection shutdown races are expected while traced CLIs are exiting.
  }
}

function routeTarget(reqUrl, upstreamUrl, openaiUpstreamUrl) {
  const text = String(reqUrl || "/");
  if (isAbsoluteHttpUrl(text)) return new URL(text);
  const base = text === "/v1" || text.startsWith("/v1/") ? new URL(openaiUpstreamUrl || upstreamUrl) : new URL(upstreamUrl);
  const target = new URL(text, base);
  if (base.pathname !== "/" && !target.pathname.startsWith(base.pathname)) target.pathname = path.posix.join(base.pathname, target.pathname);
  return target;
}

function writeRawEvent(rawDir, logFile, id, event) {
  try {
    fs.writeFileSync(path.join(rawDir, `${id}.json`), JSON.stringify(event, null, 2));
    writeJsonl(logFile, event);
  } catch {
    // Best effort; process shutdown can close files underneath us.
  }
}

function connectRequestRecord(req, host, port, started, extra = {}) {
  return {
    timestamp: new Date(started).toISOString(),
    method: "CONNECT",
    url: `${host}:${port}`,
    headers: sanitizeHeaders(req.headers),
    ...extra,
  };
}

function logConnectTunnel({ rawDir, logFile, id, started, requestRecord, error }) {
  const event = { type: "connect_tunnel", request: requestRecord, duration_ms: Date.now() - started };
  if (error) event.error = String(error);
  writeRawEvent(rawDir, logFile, id, event);
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseWebSocketFrames() {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    const frames = [];
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let len = second & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < offset + 2) break;
        len = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buffer.length < offset + 8) break;
        const bigLen = buffer.readBigUInt64BE(offset);
        if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) break;
        len = Number(bigLen);
        offset += 8;
      }
      let mask;
      if (masked) {
        if (buffer.length < offset + 4) break;
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + len) break;
      let payload = Buffer.from(buffer.subarray(offset, offset + len));
      if (masked) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      buffer = buffer.subarray(offset + len);
      frames.push({ opcode, payload });
    }
    return frames;
  };
}

function decodeWebSocketPayload(payload) {
  const attempts = [
    ["identity", (value) => value],
    ["deflate-raw", (value) => zlib.inflateRawSync(value, { finishFlush: zlib.constants.Z_SYNC_FLUSH })],
    ["deflate", (value) => zlib.inflateSync(value, { finishFlush: zlib.constants.Z_SYNC_FLUSH })],
    ["gzip", (value) => zlib.gunzipSync(value)],
    ["br", (value) => zlib.brotliDecompressSync(value)],
  ];
  if (typeof zlib.zstdDecompressSync === "function") attempts.push(["zstd", (value) => zlib.zstdDecompressSync(value)]);
  for (const [encoding, decode] of attempts) {
    try {
      const buffer = decode(payload);
      const text = buffer.toString("utf8");
      if (text && !text.includes("\ufffd")) return { encoding, buffer, text, parsed: parseMaybeJson(text) };
    } catch {
      // Try the next websocket payload encoding.
    }
  }
  return null;
}

function logWebSocketFrames(logFile, direction, meta = {}) {
  const parser = parseWebSocketFrames();
  let handshakeDone = direction === "client_to_upstream";
  let pending = Buffer.alloc(0);
  return (chunk) => {
    let data = Buffer.from(chunk);
    if (!handshakeDone) {
      pending = Buffer.concat([pending, data]);
      const marker = pending.indexOf("\r\n\r\n");
      if (marker === -1) return;
      data = pending.subarray(marker + 4);
      pending = Buffer.alloc(0);
      handshakeDone = true;
      if (!data.length) return;
    }
    for (const frame of parser(data)) {
      const event = { type: "websocket_frame", timestamp: new Date().toISOString(), direction, opcode: frame.opcode, ...meta };
      if (frame.payload.length) {
        event.body_base64 = frame.payload.toString("base64");
        event.body_sha256 = crypto.createHash("sha256").update(frame.payload).digest("hex");
      }
      if (frame.opcode === 1) {
        const decoded = decodeWebSocketPayload(frame.payload);
        if (decoded) {
          event.body = decoded.parsed;
          event.body_encoding = decoded.encoding;
          if (decoded.encoding !== "identity") {
            event.body_decoded_sha256 = crypto.createHash("sha256").update(decoded.buffer).digest("hex");
          }
        }
      }
      writeJsonl(logFile, event);
    }
  };
}

function proxyUrlFor(target) {
  if (process.env.NO_PROXY || process.env.no_proxy) {
    const noProxy = String(process.env.NO_PROXY || process.env.no_proxy);
    if (noProxy.split(",").map((item) => item.trim()).some((item) => item && target.hostname.endsWith(item.replace(/^\./, "")))) return null;
  }
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || null;
}

function connectTls(target, onConnect, onError) {
  const targetPort = target.port ? Number(target.port) : 443;
  const proxy = proxyUrlFor(target);
  if (!proxy) {
    const socket = tls.connect({ host: target.hostname, port: targetPort, servername: target.hostname }, () => onConnect(socket));
    socket.on("error", onError);
    return socket;
  }

  const proxyTarget = new URL(proxy);
  const proxySocket = net.connect(Number(proxyTarget.port || 80), proxyTarget.hostname);
  proxySocket.on("error", onError);
  proxySocket.once("connect", () => {
    proxySocket.write(`CONNECT ${target.hostname}:${targetPort} HTTP/1.1\r\nHost: ${target.hostname}:${targetPort}\r\n\r\n`);
  });
  let response = Buffer.alloc(0);
  proxySocket.on("data", function onProxyData(chunk) {
    response = Buffer.concat([response, chunk]);
    const marker = response.indexOf("\r\n\r\n");
    if (marker === -1) return;
    proxySocket.off("data", onProxyData);
    const head = response.subarray(0, marker).toString("utf8");
    const rest = response.subarray(marker + 4);
    if (!/^HTTP\/1\.[01] 200\b/.test(head)) {
      onError(new Error(`proxy CONNECT failed: ${head.split("\r\n")[0]}`));
      proxySocket.destroy();
      return;
    }
    const tlsSocket = tls.connect({ socket: proxySocket, servername: target.hostname }, () => {
      if (rest.length) tlsSocket.unshift(rest);
      onConnect(tlsSocket);
    });
    tlsSocket.on("error", onError);
  });
  return proxySocket;
}

function connectRawTarget(host, port, onConnect, onError) {
  const proxy = proxyUrlFor({ hostname: host });
  if (!proxy) {
    const socket = net.connect(Number(port), host, () => onConnect(socket));
    socket.on("error", onError);
    return socket;
  }

  const proxyTarget = new URL(proxy);
  const proxySocket = net.connect(Number(proxyTarget.port || 80), proxyTarget.hostname);
  proxySocket.on("error", onError);
  proxySocket.once("connect", () => {
    proxySocket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
  });
  let response = Buffer.alloc(0);
  proxySocket.on("data", function onProxyData(chunk) {
    response = Buffer.concat([response, chunk]);
    const marker = response.indexOf("\r\n\r\n");
    if (marker === -1) return;
    proxySocket.off("data", onProxyData);
    const head = response.subarray(0, marker).toString("utf8");
    const rest = response.subarray(marker + 4);
    if (!/^HTTP\/1\.[01] 200\b/.test(head)) {
      onError(new Error(`proxy CONNECT failed: ${head.split("\r\n")[0]}`));
      proxySocket.destroy();
      return;
    }
    if (rest.length) proxySocket.unshift(rest);
    onConnect(proxySocket);
  });
  return proxySocket;
}

export function ensureCodexMitmCerts(runDir) {
  const certDir = path.join(runDir, "mitm");
  mkdirp(certDir);
  const caKey = path.join(certDir, "agent-trace-ca.key");
  const caPem = path.join(certDir, "agent-trace-ca.pem");
  const hostKey = path.join(certDir, "chatgpt.com.key");
  const hostCsr = path.join(certDir, "chatgpt.com.csr");
  const hostPem = path.join(certDir, "chatgpt.com.pem");
  const hostConf = path.join(certDir, "chatgpt.com.cnf");
  if (!fs.existsSync(caPem)) {
    execFileSync("openssl", ["genrsa", "-out", caKey, "2048"], { stdio: "ignore" });
    execFileSync("openssl", ["req", "-x509", "-new", "-nodes", "-key", caKey, "-sha256", "-days", "30", "-subj", "/CN=agent-trace local CA", "-out", caPem], { stdio: "ignore" });
  }
  if (!fs.existsSync(hostPem)) {
    fs.writeFileSync(hostConf, [
      "[req]",
      "distinguished_name=req_distinguished_name",
      "req_extensions=v3_req",
      "prompt=no",
      "[req_distinguished_name]",
      "CN=chatgpt.com",
      "[v3_req]",
      "subjectAltName=@alt_names",
      "[alt_names]",
      "DNS.1=chatgpt.com",
      "DNS.2=*.chatgpt.com",
      "",
    ].join("\n"));
    execFileSync("openssl", ["genrsa", "-out", hostKey, "2048"], { stdio: "ignore" });
    execFileSync("openssl", ["req", "-new", "-key", hostKey, "-out", hostCsr, "-config", hostConf], { stdio: "ignore" });
    execFileSync("openssl", ["x509", "-req", "-in", hostCsr, "-CA", caPem, "-CAkey", caKey, "-CAcreateserial", "-out", hostPem, "-days", "30", "-sha256", "-extfile", hostConf, "-extensions", "v3_req"], { stdio: "ignore" });
  }
  return { caPem, key: fs.readFileSync(hostKey), cert: fs.readFileSync(hostPem) };
}

function parseHttpHead(buffer) {
  const marker = buffer.indexOf("\r\n\r\n");
  if (marker === -1) return null;
  const head = buffer.subarray(0, marker).toString("utf8");
  const rest = buffer.subarray(marker + 4);
  const lines = head.split("\r\n");
  const [method, target, version] = lines.shift().split(" ");
  const headers = {};
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).toLowerCase();
    const value = line.slice(index + 1).trim();
    if (headers[key]) headers[key] = `${headers[key]}, ${value}`;
    else headers[key] = value;
  }
  return { method, target, version, headers, rawHead: head, rest };
}

export function startCodexMitmProxy({ port, runDir, logFile, tokenFile, extractToken, certs }) {
  let counter = 0;
  const rawDir = path.join(runDir, "raw");
  mkdirp(rawDir);
  const secureContext = tls.createSecureContext({ key: certs.key, cert: certs.cert });
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.url === "/shutdown") {
      res.writeHead(200).end("ok");
      for (const socket of sockets) socket.destroy();
      server.close();
      return;
    }
    if (!isAbsoluteHttpUrl(req.url)) {
      res.writeHead(501).end("agent-trace MITM proxy only supports CONNECT or absolute HTTP proxy requests");
      return;
    }
    const id = `${String(++counter).padStart(4, "0")}-${Date.now()}`;
    const started = Date.now();
    const requestBody = await readRequestBody(req);
    await forwardAndCaptureHttpRequest({ req, res, target: new URL(req.url), requestBody, rawDir, logFile, tokenFile, extractToken, id, started, extraRequest: { mitm_http_proxy: true } });
  });
  server.on("connect", (req, clientSocket, head) => {
    ignoreSocketErrors(clientSocket);
    sockets.add(clientSocket);
    clientSocket.on("close", () => sockets.delete(clientSocket));
    const [host, portText = "443"] = String(req.url || "").split(":");
    const targetPort = Number(portText || 443);
    if (host !== "chatgpt.com" || targetPort !== 443) {
      const id = `${String(++counter).padStart(4, "0")}-${Date.now()}`;
      const started = Date.now();
      const requestRecord = connectRequestRecord(req, host, targetPort, started, { tunnel_only: true });
      let wroteClose = false;
      const closeTunnel = (error) => {
        if (wroteClose) return;
        wroteClose = true;
        logConnectTunnel({ rawDir, logFile, id, started, requestRecord, error });
      };
      connectRawTarget(host, targetPort, (upstream) => {
        ignoreSocketErrors(upstream);
        sockets.add(upstream);
        upstream.on("close", () => {
          sockets.delete(upstream);
          closeTunnel();
        });
        safeSocketWrite(clientSocket, "HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) safeSocketWrite(upstream, head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      }, (error) => {
        closeTunnel(error);
        clientSocket.destroy(error);
      });
      clientSocket.on("close", () => closeTunnel());
      return;
    }

    safeSocketWrite(clientSocket, "HTTP/1.1 200 Connection Established\r\n\r\n");
    const tlsSocket = new tls.TLSSocket(clientSocket, { isServer: true, secureContext, ALPNProtocols: ["http/1.1"] });
    ignoreSocketErrors(tlsSocket);
    let initial = Buffer.alloc(0);
    tlsSocket.on("data", function onInitialData(chunk) {
      initial = Buffer.concat([initial, chunk]);
      const parsed = parseHttpHead(initial);
      if (!parsed) return;
      tlsSocket.off("data", onInitialData);
      const id = `${String(++counter).padStart(4, "0")}-${Date.now()}`;
      const started = Date.now();
      const target = new URL(parsed.target, "https://chatgpt.com");
      const requestRecord = { timestamp: new Date(started).toISOString(), method: parsed.method, url: target.toString(), headers: sanitizeHeaders(parsed.headers), mitm: true };
      if (extractToken) {
        for (const token of extractTokenHeaders(parsed.headers)) {
          writeTokenFile(tokenFile, { timestamp: new Date(started).toISOString(), url: target.toString(), header: token.header, preview: tokenPreview(token.value), value: token.value });
        }
      }
      connectTls(target, (upstream) => {
        ignoreSocketErrors(upstream);
        sockets.add(upstream);
        upstream.on("close", () => sockets.delete(upstream));
        const upstreamHead = parsed.rawHead
          .replace(/^Host: .*$/im, "Host: chatgpt.com")
          .replace(/^Sec-WebSocket-Extensions:.*\r?\n/im, "");
        safeSocketWrite(upstream, `${upstreamHead}\r\n\r\n`);
        if (parsed.rest.length) safeSocketWrite(upstream, parsed.rest);
        const isWebSocket = /websocket/i.test(parsed.headers.upgrade || "") || /\/backend-api\/codex\/responses\b/.test(target.pathname);
        let wroteClose = false;
        const close = (error) => {
          if (wroteClose) return;
          wroteClose = true;
          const event = { type: isWebSocket ? "websocket_connection" : "mitm_connection", request: requestRecord, duration_ms: Date.now() - started };
          if (error) event.error = String(error);
          writeRawEvent(rawDir, logFile, id, event);
        };
        if (isWebSocket) {
          const frameMeta = { url: target.toString(), websocket: true };
          const clientLogger = logWebSocketFrames(logFile, "client_to_upstream", frameMeta);
          const upstreamLogger = logWebSocketFrames(logFile, "upstream_to_client", frameMeta);
          if (parsed.rest.length) clientLogger(parsed.rest);
          tlsSocket.on("data", (data) => {
            clientLogger(data);
            safeSocketWrite(upstream, data);
          });
          upstream.on("data", (data) => {
            upstreamLogger(data);
            safeSocketWrite(tlsSocket, data);
          });
        } else {
          tlsSocket.pipe(upstream);
          upstream.pipe(tlsSocket);
        }
        upstream.on("error", close);
        tlsSocket.on("error", close);
        upstream.on("close", () => close());
        tlsSocket.on("close", () => close());
      }, (error) => tlsSocket.destroy(error));
    });
    tlsSocket.on("error", () => clientSocket.destroy());
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port ? Number(port) : 0, "127.0.0.1", () => resolve({
      server,
      port: server.address().port,
      caPem: certs.caPem,
      destroy: () => {
        for (const socket of sockets) socket.destroy();
        server.close();
      },
    }));
  });
}

export function startForwardProxy({ port, upstreamUrl, openaiUpstreamUrl, runDir, logFile, tokenFile, extractToken }) {
  let counter = 0;
  const rawDir = path.join(runDir, "raw");
  mkdirp(rawDir);
  const server = http.createServer(async (req, res) => {
    if (req.url === "/shutdown") {
      res.writeHead(200).end("ok");
      server.close();
      return;
    }
    const id = `${String(++counter).padStart(4, "0")}-${Date.now()}`;
    const started = Date.now();
    const requestBody = await readRequestBody(req);
    const target = routeTarget(req.url, upstreamUrl, openaiUpstreamUrl);
    await forwardAndCaptureHttpRequest({ req, res, target, requestBody, rawDir, logFile, tokenFile, extractToken, id, started });
  });
  server.on("connect", (req, socket, head) => {
    ignoreSocketErrors(socket);
    const id = `${String(++counter).padStart(4, "0")}-${Date.now()}`;
    const started = Date.now();
    const [host, portText = "443"] = String(req.url || "").split(":");
    const targetPort = Number(portText || 443);
    const requestRecord = connectRequestRecord(req, host, targetPort, started, { tunnel_only: true });
    let upstream;
    let wroteClose = false;
    const close = (error) => {
      if (wroteClose) return;
      wroteClose = true;
      logConnectTunnel({ rawDir, logFile, id, started, requestRecord, error });
    };
    upstream = connectRawTarget(host, targetPort, (targetSocket) => {
      upstream = targetSocket;
      ignoreSocketErrors(upstream);
      safeSocketWrite(socket, "HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) safeSocketWrite(upstream, head);
      upstream.pipe(socket);
      socket.pipe(upstream);
      upstream.on("close", () => close());
      upstream.on("error", close);
    }, (error) => {
      close(error);
      socket.destroy(error);
    });
    socket.on("error", (error) => {
      close(error);
      if (upstream) upstream.destroy(error);
    });
    socket.on("close", () => close());
  });
  server.on("upgrade", (req, socket, head) => {
    const id = `${String(++counter).padStart(4, "0")}-${Date.now()}`;
    const started = Date.now();
    const target = routeTarget(req.url, upstreamUrl, openaiUpstreamUrl);
    const requestRecord = { timestamp: new Date(started).toISOString(), method: req.method, url: target.toString(), headers: sanitizeHeaders(req.headers), websocket: true };
    if (extractToken) {
      for (const token of extractTokenHeaders(req.headers)) {
        writeTokenFile(tokenFile, { timestamp: new Date(started).toISOString(), url: target.toString(), header: token.header, preview: tokenPreview(token.value), value: token.value });
      }
    }
    let upstream;
    let wroteClose = false;
    const close = (error) => {
      if (wroteClose) return;
      wroteClose = true;
      const event = { type: "websocket_connection", request: requestRecord, duration_ms: Date.now() - started };
      if (error) event.error = String(error);
      fs.writeFileSync(path.join(rawDir, `${id}.json`), JSON.stringify(event, null, 2));
      writeJsonl(logFile, event);
    };
    const onError = (error) => {
      close(error);
      socket.destroy(error);
    };
    upstream = connectTls(target, (tlsSocket) => {
      upstream = tlsSocket;
      const headers = stripProxyHeaders(req.headers);
      delete headers["sec-websocket-extensions"];
      const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.host}`, "Upgrade: websocket", "Connection: Upgrade"];
      for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
        else if (value !== undefined) lines.push(`${key}: ${value}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      tlsSocket.on("data", logWebSocketFrames(logFile, "upstream_to_client"));
      socket.pipe(tlsSocket);
      tlsSocket.pipe(socket);
      tlsSocket.on("error", onError);
      tlsSocket.on("close", () => close());
    }, onError);
    socket.on("data", logWebSocketFrames(logFile, "client_to_upstream"));
    socket.on("error", (error) => {
      close(error);
      upstream.destroy(error);
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port ? Number(port) : 0, "127.0.0.1", () => resolve({
      server,
      port: server.address().port,
      destroy: () => server.close(),
    }));
  });
}

export async function shutdownProxy(port) {
  await new Promise((resolve) => {
    const socket = net.connect(Number(port), "127.0.0.1", () => socket.end("GET /shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"));
    socket.on("error", resolve);
    socket.on("close", resolve);
    socket.setTimeout(1000, () => socket.destroy());
  });
}

