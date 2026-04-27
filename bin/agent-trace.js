#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { Readable } from "node:stream";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_TRACE_DIR = ".agent-trace";

async function relaunchWithNodeEnvProxyIfNeeded() {
  const hasProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (!hasProxy || process.env.NODE_USE_ENV_PROXY === "1" || process.env.AGENT_TRACE_NODE_ENV_PROXY_REEXEC === "1") return false;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1", AGENT_TRACE_NODE_ENV_PROXY_REEXEC: "1" },
  });
  const handlers = ["SIGINT", "SIGTERM"].map((signal) => {
    const handler = () => {
      try {
        if (!child.killed) child.kill(signal);
      } catch {
        // Best effort: the child may already have exited.
      }
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  const exit = await waitForExit(child);
  for (const { signal, handler } of handlers) process.removeListener(signal, handler);
  process.exitCode = exit.code ?? signalExitCode(exit.signal);
  return true;
}

function usage() {
  console.log(`agent-trace

Trace Claude Code or Codex CLI sessions and render local HTML reports.

Usage:
  agent-trace cc [options] [-- claude args...]
  agent-trace codex [options] [-- codex args...]
  agent-trace [options]                  Alias for: agent-trace cc

Claude-trace compatible options:
  --include-all-requests                 Capture all provider API requests
  --run-with <arg>                       Append an argument to the launched agent
  --extract-token                        Capture detected auth headers during agent traffic
  --generate-html <jsonl> [html]         Generate a self-contained HTML report from JSONL
  --generate-md <trace-dir|jsonl> [md]   Generate a Markdown report
  --export-training-jsonl <trace-dir> [jsonl]
                                      Export a redacted training-oriented JSONL dataset
  --validate-trace <trace-dir>           Validate trace completeness and renderability
  --index                                Generate .agent-trace/index.html
  -h, --help                             Show help

Shared options:
  --trace-dir <dir>                      Trace output directory (default: .agent-trace)
  --port <port>                          Local proxy port for Codex mode
  --upstream-url <url>                   Override provider upstream URL

Claude Code options:
  --cc-bin <path>                        Claude Code binary (default: claude)

Codex options:
  --codex-bin <path>                     Codex binary (default: codex)
  --auth <mode>                          auto, api-key, or chatgpt-login (default: auto)
  --base-url <url>                       Override URL passed to Codex config
  --capture-model-requests               Capture Codex model traffic; login mode uses a local HTTPS MITM proxy

Examples:
  agent-trace cc
  agent-trace cc --include-all-requests
  agent-trace cc --run-with chat --model sonnet-3.5
  agent-trace codex -- "explain this repo"
  agent-trace --generate-html .agent-trace/trace-.../logs.jsonl report.html
`);
}

function parse(argv) {
  const opts = {
    agent: "cc",
    traceDir: DEFAULT_TRACE_DIR,
    includeAllRequests: false,
    extractToken: false,
    generateHtml: null,
    generateMd: null,
    exportTrainingJsonl: null,
    trainingOut: null,
    validateTrace: null,
    htmlOut: null,
    mdOut: null,
    index: false,
    port: null,
    upstreamUrl: null,
    ccBin: "claude",
    codexBin: "codex",
    auth: "auto",
    baseUrl: null,
    captureModelRequests: false,
    includeSensitive: false,
    agentArgs: [],
    help: false,
  };

  const rest = [...argv];
  if (rest[0] === "cc" || rest[0] === "claude" || rest[0] === "claude-code") opts.agent = (rest.shift(), "cc");
  else if (rest[0] === "codex") opts.agent = (rest.shift(), "codex");

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--") {
      opts.agentArgs.push(...rest.slice(i + 1));
      break;
    } else if (arg === "--include-all-requests") {
      opts.includeAllRequests = true;
    } else if (arg === "--run-with") {
      opts.agentArgs.push(requireValue(rest, ++i, arg));
    } else if (arg === "--extract-token") {
      opts.extractToken = true;
    } else if (arg === "--generate-html") {
      opts.generateHtml = requireValue(rest, ++i, arg);
      if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) opts.htmlOut = rest[++i];
    } else if (arg === "--generate-md") {
      opts.generateMd = requireValue(rest, ++i, arg);
      if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) opts.mdOut = rest[++i];
    } else if (arg === "--export-training-jsonl") {
      opts.exportTrainingJsonl = requireValue(rest, ++i, arg);
      if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) opts.trainingOut = rest[++i];
    } else if (arg === "--validate-trace") {
      opts.validateTrace = requireValue(rest, ++i, arg);
    } else if (arg === "--index") {
      opts.index = true;
    } else if (arg === "--trace-dir") {
      opts.traceDir = requireValue(rest, ++i, arg);
    } else if (arg === "--port") {
      opts.port = requireValue(rest, ++i, arg);
    } else if (arg === "--upstream-url") {
      opts.upstreamUrl = requireValue(rest, ++i, arg);
    } else if (arg === "--cc-bin") {
      opts.ccBin = requireValue(rest, ++i, arg);
    } else if (arg === "--codex-bin") {
      opts.codexBin = requireValue(rest, ++i, arg);
    } else if (arg === "--auth") {
      opts.auth = requireValue(rest, ++i, arg);
    } else if (arg === "--base-url") {
      opts.baseUrl = requireValue(rest, ++i, arg);
    } else if (arg === "--capture-model-requests") {
      opts.captureModelRequests = true;
    } else if (arg === "--include-sensitive") {
      opts.includeSensitive = true;
    } else if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else {
      opts.agentArgs.push(arg);
    }
  }
  return opts;
}

function requireValue(argv, index, flag) {
  if (index >= argv.length || argv[index].startsWith("--")) throw new Error(`${flag} requires a value`);
  return argv[index];
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, -5);
}

function waitForExit(child) {
  return new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
}

function signalExitCode(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function waitForExitWithSignals(child, signals = ["SIGINT", "SIGTERM"], timeoutMs = 2500) {
  const exitPromise = waitForExit(child);
  let timer = null;
  let handlers = [];
  const signalPromise = new Promise((resolve) => {
    handlers = signals.map((signal) => {
      const handler = () => {
        try {
          if (!child.killed) child.kill(signal);
        } catch {
          // Best effort: the child may already have exited.
        }
        if (!timer) {
          timer = setTimeout(() => resolve({ code: null, signal }), timeoutMs);
        }
      };
      process.on(signal, handler);
      return { signal, handler };
    });
  });
  return Promise.race([exitPromise, signalPromise]).finally(() => {
    if (timer) clearTimeout(timer);
    for (const { signal, handler } of handlers) process.removeListener(signal, handler);
  });
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { parse_error: String(error), raw: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "" };
  }
}

function readJsonl(file, maxLines = 5000) {
  try {
    return fs.readFileSync(file, "utf8").split(/\n+/).filter(Boolean).slice(-maxLines).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  } catch {
    return [];
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderJson(value) {
  return escapeHtml(JSON.stringify(value, null, 2));
}

function fence(value, lang = "") {
  const text = String(value ?? "");
  const ticks = text.match(/`{3,}/g);
  const fenceTicks = ticks ? "`".repeat(Math.max(...ticks.map((item) => item.length)) + 1) : "```";
  return `${fenceTicks}${lang}\n${text}\n${fenceTicks}`;
}

function looksLikeDiff(text) {
  const value = String(text || "");
  return /^diff --git /m.test(value) || /^@@ .* @@/m.test(value) || /^--- .*\n\+\+\+ /m.test(value) || /^\*\*\* Begin Patch/m.test(value);
}

function mdEscapeInline(value) {
  return String(value ?? "").replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function stripAnsi(value) {
  return String(value ?? "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function truncateText(value, max = 20000) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}\n\n... <truncated ${text.length - max} chars>` : text;
}

function fullText(value) {
  return String(value ?? "");
}

function parseJsonMaybe(value) {
  if (value == null) return {};
  if (typeof value === "object") return value;
  if (typeof value !== "string") return { value };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : { value: parsed };
  } catch {
    return { raw: value };
  }
}

function detailsBlock(summary, body) {
  return `<details><summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

function renderDiffBlock(lines) {
  const keep = 60;
  let out = lines;
  if (lines.length > keep) {
    const head = Math.floor(keep / 2);
    const tail = keep - head;
    out = [...lines.slice(0, head), `... (${lines.length - keep} lines omitted) ...`, ...lines.slice(-tail)];
  }
  return fence(out.join("\n"), "diff");
}

function prefixedLines(text, prefix) {
  return String(text || "").split("\n").map((line) => `${prefix}${line}`);
}

function renderAddDiff(content) {
  return renderDiffBlock(prefixedLines(content, "+ "));
}

function renderDeleteDiff(content) {
  return renderDiffBlock(prefixedLines(content, "- "));
}

function renderReplaceDiff(oldText, newText) {
  return renderDiffBlock([...prefixedLines(oldText, "- "), ...prefixedLines(newText, "+ ")]);
}

function renderMultiEditDiff(edits) {
  const lines = [];
  edits.filter((edit) => edit && typeof edit === "object").forEach((edit, index) => {
    if (index > 0) lines.push("@@");
    if (edit.replace_all) lines.push(`# replace_all=${edit.replace_all}`);
    lines.push(...prefixedLines(edit.old_string ?? edit.oldText ?? "", "- "));
    lines.push(...prefixedLines(edit.new_string ?? edit.newText ?? "", "+ "));
  });
  return renderDiffBlock(lines);
}

function isEditTool(name) {
  const lower = String(name || "").toLowerCase();
  return ["write", "add", "create_file", "edit", "replace_in_file", "multiedit", "multi_edit", "apply_patch", "applypatch", "delete", "delete_file", "remove_file"].includes(lower);
}

function extractPatchText(input) {
  for (const key of ["patch", "input", "content", "diff", "raw"]) {
    if (typeof input?.[key] === "string" && input[key].trim()) return input[key];
  }
  return "";
}

function renderCc2mdToolUse(name, input) {
  const lower = String(name || "").toLowerCase();
  const lines = [`**Tool: ${name || "function_call"}**`];
  if (name === "Bash") {
    if (input.description) lines.push(`*${input.description}*`);
    lines.push(fence(input.command || "", "bash"));
  } else if (name === "Read") {
    lines.push(`Reading \`${input.file_path || ""}\``);
  } else if (["write", "add", "create_file"].includes(lower)) {
    const fp = input.file_path || input.path || "";
    lines.push(`${lower === "add" || lower === "create_file" ? "Adding" : "Writing"} \`${fp}\``);
    if (input.content) lines.push(renderAddDiff(input.content));
  } else if (["edit", "replace_in_file"].includes(lower)) {
    lines.push(`Editing \`${input.file_path || input.path || ""}\``);
    if (input.old_string || input.new_string || input.oldText || input.newText) lines.push(renderReplaceDiff(input.old_string ?? input.oldText ?? "", input.new_string ?? input.newText ?? ""));
  } else if (["multiedit", "multi_edit"].includes(lower)) {
    lines.push(`Editing \`${input.file_path || input.path || ""}\``);
    if (Array.isArray(input.edits) && input.edits.length) lines.push(renderMultiEditDiff(input.edits));
  } else if (["apply_patch", "applypatch"].includes(lower)) {
    const patch = extractPatchText(input);
    lines.push("Applying patch");
    if (patch) lines.push(renderDiffBlock(patch.split("\n")));
  } else if (["delete", "delete_file", "remove_file"].includes(lower)) {
    lines.push(`Deleting \`${input.file_path || input.path || ""}\``);
    const content = input.old_string || input.old_content || input.content || "";
    if (content) lines.push(renderDeleteDiff(content));
  } else if (name === "exec_command") {
    if (input.justification) lines.push(`*${input.justification}*`);
    lines.push(fence(input.cmd || "", "bash"));
  } else if (name === "write_stdin") {
    lines.push(`Sending input to session \`${input.session_id || ""}\``);
    if (input.chars) lines.push(fence(input.chars, "text"));
  } else if (name === "wait_agent") {
    lines.push("Waiting for subagents");
    if (input.targets) lines.push(fence(JSON.stringify(input.targets, null, 2), "json"));
  } else if (name === "send_input") {
    lines.push(`Sending input to agent \`${input.target || ""}\``);
    if (input.message) lines.push(fence(input.message, "text"));
  } else if (name === "close_agent") {
    lines.push(`Closing agent \`${input.target || ""}\``);
  } else if (["Agent", "Task", "spawn_agent"].includes(name)) {
    const subtype = input.subagent_type || input.agent_type || "general-purpose";
    const desc = input.description || input.message || "";
    lines.push(`Spawning **${subtype}** agent: *${desc}*`);
    const prompt = input.prompt || input.message || "";
    if (prompt) lines.push(`\n> ${prompt.length > 500 ? `${prompt.slice(0, 500)}...` : prompt}`);
  } else if (input && Object.keys(input).length) {
    lines.push(fence(JSON.stringify(input, null, 2).slice(0, 5000), "json"));
  }
  return lines.join("\n");
}

function normalizeToolOutput(output) {
  if (output == null) return "";
  if (typeof output !== "string") return JSON.stringify(output, null, 2);
  let text = output;
  if (text.startsWith("Chunk ID:") && text.includes("\nOutput:\n")) text = text.split("\nOutput:\n", 2)[1];
  const stripped = text.trim();
  if (!stripped) return "";
  try {
    return JSON.stringify(JSON.parse(stripped), null, 2);
  } catch {
    return text;
  }
}

function normalizeCustomToolOutput(output) {
  if (output == null) return "";
  if (typeof output !== "string") return normalizeToolOutput(output);
  const trimmed = output.trim();
  if (!trimmed) return "";
  try {
    const data = JSON.parse(trimmed);
    if (data && typeof data === "object") {
      const rendered = String(data.output || "").trim();
      const metadata = data.metadata && typeof data.metadata === "object" ? JSON.stringify(data.metadata, null, 2) : "";
      if (rendered && metadata) return `${rendered}\n\n${metadata}`;
      if (rendered) return rendered;
      return JSON.stringify(data, null, 2);
    }
  } catch {
    // Fall through to plain output.
  }
  return output;
}

function customToolInput(name, input) {
  if (name === "apply_patch" && typeof input === "string") return { patch: input };
  return parseJsonMaybe(input);
}

function isPromptRole(role) {
  return role === "system" || role === "developer" || role === "user";
}

function promptMessageFromResponseItem(line, rolloutIndex = null) {
  const payload = line.payload || {};
  if (payload.type !== "message" || !isPromptRole(payload.role)) return null;
  const text = textFromContent(payload.content).trim();
  if (!text) return null;
  return { role: payload.role, source: "response_item.message", rollout_index: rolloutIndex, timestamp: line.timestamp || "", text };
}

function summarizeEvents(events) {
  const counts = {};
  const tools = [];
  const messages = [];
  for (const event of events) {
    const type = event.type || event.payload?.type || "unknown";
    counts[type] = (counts[type] || 0) + 1;
    if (event.type === "response_item" && event.payload?.type === "function_call") {
      tools.push({ name: event.payload.name, call_id: event.payload.call_id, timestamp: event.timestamp });
    }
    if (event.request?.body?.messages) counts.api_messages = (counts.api_messages || 0) + event.request.body.messages.length;
    if (event.type === "message" || event.payload?.type === "message") messages.push(event);
  }
  return { counts, tools, messages };
}

function tokenPreview(value) {
  const text = String(value || "");
  return text.length > 16 ? `${text.slice(0, 8)}...${text.slice(-4)}` : "[REDACTED]";
}

function extractTokenHeaders(headers) {
  const out = [];
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "x-api-key" || lower === "cookie") {
      out.push({ header: key, value: Array.isArray(value) ? value.join(", ") : String(value || "") });
    }
  }
  return out;
}

function isSensitiveKey(key) {
  const lower = String(key || "").toLowerCase();
  return ["authorization", "cookie", "set-cookie", "x-api-key", "api-key", "access_token", "refresh_token", "id_token"].includes(lower)
    || lower.includes("secret")
    || lower.includes("password");
}

function redactSensitive(value) {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? tokenPreview(Array.isArray(item) ? item.join(", ") : item) : redactSensitive(item);
  }
  return out;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((item) => item?.text || item?.input_text || item?.output_text || JSON.stringify(item)).join("\n");
}

function buildConversationTurns(rollouts) {
  const turns = [];
  for (const rollout of rollouts) {
    let current = null;
    const ensureTurn = (timestamp) => {
      if (!current) {
        current = { rollout: rollout.file, turn_id: "", started_at: timestamp || "", items: [], usage: null, completed_at: "", duration_ms: null };
        turns.push(current);
      }
      return current;
    };
    for (const line of rollout.lines || []) {
      const payload = line.payload || {};
      if (line.type === "event_msg" && payload.type === "task_started") {
        current = { rollout: rollout.file, turn_id: payload.turn_id || "", started_at: line.timestamp || "", items: [], usage: null, completed_at: "", duration_ms: null };
        turns.push(current);
      } else if (line.type === "event_msg" && payload.type === "user_message") {
        ensureTurn(line.timestamp).items.push({ kind: "user", timestamp: line.timestamp, text: payload.message || "" });
      } else if (line.type === "event_msg" && payload.type === "agent_message") {
        ensureTurn(line.timestamp).items.push({ kind: "assistant", timestamp: line.timestamp, phase: payload.phase || "", text: payload.message || "" });
      } else if (line.type === "event_msg" && payload.type === "token_count") {
        ensureTurn(line.timestamp).usage = payload.info?.last_token_usage || payload.info?.total_token_usage || null;
      } else if (line.type === "event_msg" && payload.type === "task_complete") {
        const turn = ensureTurn(line.timestamp);
        turn.completed_at = line.timestamp || "";
        turn.duration_ms = payload.duration_ms ?? null;
      } else if (line.type === "event_msg" && payload.type === "collab_agent_spawn_end") {
        ensureTurn(line.timestamp).items.push({
          kind: "subagent",
          timestamp: line.timestamp,
          text: `Spawned ${payload.new_agent_nickname || payload.new_thread_id || "subagent"} (${payload.new_agent_role || "agent"})`,
          detail: payload,
        });
      } else if (line.type === "event_msg" && payload.type === "collab_waiting_end") {
        ensureTurn(line.timestamp).items.push({ kind: "subagent_result", timestamp: line.timestamp, text: JSON.stringify(payload.statuses || payload.agent_statuses || {}, null, 2), detail: payload });
      } else if (line.type === "response_item" && payload.type === "function_call") {
        ensureTurn(line.timestamp).items.push({ kind: "tool_call", timestamp: line.timestamp, text: payload.name || "function_call", detail: payload });
      } else if (line.type === "response_item" && payload.type === "function_call_output") {
        ensureTurn(line.timestamp).items.push({ kind: "tool_output", timestamp: line.timestamp, text: payload.output || "", detail: payload });
      } else if (line.type === "response_item" && payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
        const text = textFromContent(payload.content);
        if (text && !text.startsWith("<subagent_notification>")) {
          const turn = ensureTurn(line.timestamp);
          const duplicate = turn.items.some((item) => item.text === text && (item.kind === payload.role || (payload.role === "assistant" && item.kind === "assistant")));
          if (!duplicate) turn.items.push({ kind: payload.role, timestamp: line.timestamp, phase: payload.phase || "", text });
        }
      }
    }
  }
  return turns.filter((turn) => turn.items.length || turn.usage);
}

function renderConversationTurns(turns) {
  if (!turns.length) return '<div class="muted">No conversation turns found.</div>';
  return `<div class="turns">${turns.map((turn, index) => {
    const usage = turn.usage ? Object.entries(turn.usage).map(([k, v]) => `<span class="pill">${escapeHtml(k)}: ${escapeHtml(v)}</span>`).join("") : "";
    return `<section class="turn card">
      <div class="turn-head"><b>Turn ${index + 1}</b><span class="muted">${escapeHtml(turn.started_at || "")}</span><span class="muted">${escapeHtml(path.basename(turn.rollout || ""))}</span></div>
      <div>${usage}</div>
      <div class="chat">${turn.items.map(renderConversationItem).join("")}</div>
    </section>`;
  }).join("")}</div>`;
}

function renderConversationItem(item) {
  const label = item.kind.replaceAll("_", " ");
  const body = item.kind === "tool_call" || item.kind === "tool_output" || item.kind === "subagent" || item.kind === "subagent_result"
    ? `<details><summary>${escapeHtml(item.text || label)}</summary><pre><code>${renderJson(item.detail || item.text)}</code></pre></details>`
    : `<div class="bubble-text">${escapeHtml(item.text || "")}</div>`;
  return `<div class="chat-row ${escapeHtml(item.kind)}"><div class="role">${escapeHtml(label)}${item.phase ? ` · ${escapeHtml(item.phase)}` : ""}</div>${body}</div>`;
}

function renderTokens(tokens) {
  if (!tokens.length) return '<div class="muted">No token headers captured. Use --extract-token.</div>';
  const map = new Map();
  for (const token of tokens) {
    const key = `${token.header || ""}\n${token.value || token.preview || ""}`;
    const entry = map.get(key) || { ...token, urls: [] };
    if (token.url && !entry.urls.includes(token.url)) entry.urls.push(token.url);
    map.set(key, entry);
  }
  return [...map.values()].map((token) => `<div class="card token-card">
    <div><b>${escapeHtml(token.header || "token")}</b> <span class="muted">${escapeHtml(token.timestamp || "")}</span></div>
    <pre class="token-value"><code>${escapeHtml(token.value || token.preview || "")}</code></pre>
    <div class="muted">${(token.urls || []).map((url) => `<div>${escapeHtml(url)}</div>`).join("")}</div>
  </div>`).join("");
}

function collectPromptContext(rollouts) {
  const contexts = [];
  for (const rollout of rollouts) {
    for (const line of rollout.lines || []) {
      const payload = line.payload || {};
      if (line.type === "session_meta") {
        if (payload.base_instructions?.text) {
          contexts.push({ title: "Base instructions", rollout: rollout.file, text: payload.base_instructions.text });
        }
        if (payload.dynamic_tools) {
          contexts.push({ title: "Dynamic tools", rollout: rollout.file, text: JSON.stringify(payload.dynamic_tools, null, 2) });
        }
      }
      if (line.type === "turn_context") {
        contexts.push({ title: `Turn context ${payload.turn_id || ""}`.trim(), rollout: rollout.file, text: JSON.stringify(payload, null, 2) });
      }
      if (line.type === "response_item" && payload.type === "message" && (payload.role === "system" || payload.role === "developer")) {
        contexts.push({ title: `${payload.role} message`, rollout: rollout.file, text: textFromContent(payload.content) });
      }
    }
  }
  return contexts;
}

function renderMarkdownItem(item) {
  const label = item.kind.replaceAll("_", " ");
  const lines = [`#### ${label}${item.phase ? ` (${item.phase})` : ""}`];
  if (item.timestamp) lines.push(`_time: ${item.timestamp}_`);
  if (item.kind === "tool_call") {
    lines.push("", `Tool: \`${item.detail?.name || item.text || "function_call"}\``);
    if (item.detail?.call_id) lines.push(`Call ID: \`${item.detail.call_id}\``);
    if (item.detail?.arguments) {
      lines.push("", fence(item.detail.arguments, "json"));
    } else {
      lines.push("", fence(JSON.stringify(item.detail || {}, null, 2), "json"));
    }
  } else if (item.kind === "tool_output" || item.kind === "subagent_result" || item.kind === "subagent") {
    const text = item.text || JSON.stringify(item.detail || {}, null, 2);
    lines.push("", fence(truncateText(text), looksLikeDiff(text) ? "diff" : ""));
  } else {
    lines.push("", truncateText(item.text || ""));
  }
  return lines.join("\n");
}

function readRolloutsForRun(runMeta) {
  const rollouts = (runMeta.rollouts || []).map((item) => {
    const lines = readJsonl(item.file);
    return { ...item, lines, summary: summarizeEvents(lines) };
  });
  return selectRelevantRollouts(rollouts, runMeta);
}

function selectRelevantRollouts(rollouts, runMeta = {}) {
  if (rollouts.length <= 1) return rollouts;
  const startedMs = parseIso(runMeta.started_at);
  const windowStart = startedMs == null ? null : startedMs - 5000;
  let roots = rollouts.filter((rollout) => {
    if (isSubagentRollout(rollout)) return false;
    const meta = sessionMetaFromRollout(rollout);
    const timestampMs = parseIso(meta.timestamp);
    return windowStart == null || timestampMs == null || timestampMs >= windowStart;
  });
  if (!roots.length) roots = rollouts.filter((rollout) => !isSubagentRollout(rollout)).slice(0, 1);

  const included = [];
  const ids = new Set();
  const include = (rollout) => {
    if (!rollout || included.includes(rollout)) return;
    included.push(rollout);
    const id = sessionMetaFromRollout(rollout).id;
    if (id) ids.add(id);
  };
  roots.sort((a, b) => (parseIso(sessionMetaFromRollout(a).timestamp) || 0) - (parseIso(sessionMetaFromRollout(b).timestamp) || 0)).forEach(include);

  let changed = true;
  while (changed) {
    changed = false;
    for (const rollout of rollouts) {
      if (!isSubagentRollout(rollout)) continue;
      if (!ids.has(parentThreadIdFromMeta(sessionMetaFromRollout(rollout)))) continue;
      if (included.includes(rollout)) continue;
      include(rollout);
      changed = true;
    }
  }
  return included.sort((a, b) => (parseIso(sessionMetaFromRollout(a).timestamp) || 0) - (parseIso(sessionMetaFromRollout(b).timestamp) || 0));
}

function readRolloutSessionMetaFile(file) {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").slice(0, 200);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "session_meta") return parsed.payload || {};
      } catch {
        // Keep scanning; malformed JSONL lines should not prevent trace rendering.
      }
    }
  } catch {
    // Missing or unreadable rollout files are ignored by discovery.
  }
  return {};
}

function sessionMetaFromRollout(rollout) {
  return (rollout.lines || []).find((line) => line.type === "session_meta")?.payload || {};
}

function isSubagentRollout(rollout) {
  const source = sessionMetaFromRollout(rollout).source;
  return Boolean(source && typeof source === "object" && source.subagent);
}

function isSubagentMeta(meta) {
  const source = meta?.source;
  return Boolean(source && typeof source === "object" && source.subagent);
}

function parentThreadIdFromMeta(meta) {
  return meta?.source?.subagent?.thread_spawn?.parent_thread_id || "";
}

function agentNicknameFromMeta(meta) {
  return meta?.agent_nickname || meta?.source?.subagent?.thread_spawn?.agent_nickname || "";
}

function agentRoleFromMeta(meta) {
  return meta?.agent_role || meta?.source?.subagent?.thread_spawn?.agent_role || "";
}

function formatDurationSeconds(seconds) {
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const sec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${sec}s`;
  const hours = Math.floor(minutes / 60);
  const min = minutes % 60;
  return `${hours}h ${min}m ${sec}s`;
}

function parseIso(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

function formatCodexMetadata(metadata) {
  const fields = [
    ["duration", "Duration"],
    ["duration_seconds", "Duration Seconds"],
    ["model", "Model"],
    ["model_provider", "Model Provider"],
    ["reasoning_effort", "Reasoning Effort"],
    ["model_context_window", "Context Window"],
    ["originator", "Originator"],
    ["cli_version", "CLI Version"],
    ["session_source", "Session Source"],
    ["collaboration_mode", "Collaboration Mode"],
    ["approval_policy", "Approval Policy"],
    ["sandbox_policy", "Sandbox"],
    ["personality", "Personality"],
    ["plan_type", "Plan"],
    ["summary", "Summary"],
    ["input_tokens", "Input Tokens"],
    ["cached_input_tokens", "Cached Input Tokens"],
    ["output_tokens", "Output Tokens"],
    ["reasoning_output_tokens", "Reasoning Output Tokens"],
    ["total_tokens", "Total Tokens"],
    ["last_turn_tokens", "Last Turn Tokens"],
    ["primary_rate_limit_used_percent", "Primary Rate Limit Used %"],
    ["git_branch", "Git Branch"],
    ["git_commit", "Git Commit"],
    ["first_event_at", "First Event At"],
    ["last_event_at", "Last Event At"],
  ];
  const lines = [];
  if (!Object.keys(metadata || {}).length) return lines;
  lines.push("## Codex Metadata", "");
  for (const [key, label] of fields) {
    if (metadata[key] == null || metadata[key] === "") continue;
    const value = typeof metadata[key] === "object" ? JSON.stringify(metadata[key]) : String(metadata[key]);
    lines.push(`**${label}:** \`${value}\`  `);
  }
  lines.push("", "---", "");
  return lines;
}

function collectCodexMetadata(rollout, runMeta = {}) {
  const lines = rollout.lines || [];
  const meta = sessionMetaFromRollout(rollout);
  const firstTs = lines.find((line) => line.timestamp)?.timestamp || runMeta.started_at || "";
  const lastTs = [...lines].reverse().find((line) => line.timestamp)?.timestamp || runMeta.finished_at || "";
  const firstCtx = lines.find((line) => line.type === "turn_context")?.payload || {};
  const lastToken = [...lines].reverse().find((line) => line.type === "event_msg" && line.payload?.type === "token_count")?.payload || {};
  const out = {};
  if (firstTs) out.first_event_at = firstTs;
  if (lastTs) out.last_event_at = lastTs;
  const startMs = parseIso(meta.timestamp) ?? parseIso(firstTs);
  const endMs = parseIso(lastTs);
  if (startMs != null && endMs != null) {
    out.duration_seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
    out.duration = formatDurationSeconds(out.duration_seconds);
  }
  for (const [src, dest] of [["originator", "originator"], ["cli_version", "cli_version"], ["model_provider", "model_provider"]]) {
    if (meta[src]) out[dest] = meta[src];
  }
  if (meta.source) out.session_source = meta.source;
  if (meta.git?.commit_hash) out.git_commit = meta.git.commit_hash;
  if (meta.git?.branch) out.git_branch = meta.git.branch;
  for (const [src, dest] of [["model", "model"], ["effort", "reasoning_effort"], ["approval_policy", "approval_policy"], ["personality", "personality"], ["summary", "summary"]]) {
    if (firstCtx[src]) out[dest] = firstCtx[src];
  }
  if (firstCtx.collaboration_mode?.mode) out.collaboration_mode = firstCtx.collaboration_mode.mode;
  if (firstCtx.sandbox_policy?.type) out.sandbox_policy = `${firstCtx.sandbox_policy.type}${firstCtx.sandbox_policy.network_access != null ? `, network=${firstCtx.sandbox_policy.network_access ? "on" : "off"}` : ""}`;
  const total = lastToken.info?.total_token_usage || {};
  const last = lastToken.info?.last_token_usage || {};
  for (const [src, dest] of [["input_tokens", "input_tokens"], ["cached_input_tokens", "cached_input_tokens"], ["output_tokens", "output_tokens"], ["reasoning_output_tokens", "reasoning_output_tokens"], ["total_tokens", "total_tokens"]]) {
    if (total[src] != null) out[dest] = total[src];
  }
  if (last.total_tokens != null) out.last_turn_tokens = last.total_tokens;
  if (lastToken.info?.model_context_window != null) out.model_context_window = lastToken.info.model_context_window;
  if (lastToken.rate_limits?.plan_type) out.plan_type = lastToken.rate_limits.plan_type;
  if (lastToken.rate_limits?.primary?.used_percent != null) out.primary_rate_limit_used_percent = lastToken.rate_limits.primary.used_percent;
  return out;
}

function extractTitleFromRollout(rollout) {
  const user = (rollout.lines || []).find((line) => line.type === "event_msg" && line.payload?.type === "user_message")?.payload?.message;
  return user ? String(user).split(/\s+/).join(" ").slice(0, 80) : "Untitled Session";
}

function safeMarkdownFileName(text, fallback = "session") {
  const safe = String(text || fallback)
    .normalize("NFKD")
    .replace(/[^\w\s.-]+/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .slice(0, 80)
    .replace(/^-+|-+$/g, "");
  return safe || fallback;
}

function subagentFileName(rollout, used = new Set()) {
  const meta = sessionMetaFromRollout(rollout);
  const id = meta.id || path.basename(rollout.file || "subagent");
  const label = agentNicknameFromMeta(meta) || agentRoleFromMeta(meta) || "subagent";
  const base = safeMarkdownFileName(`subagent-${label}-${id.slice(0, 8)}`, `subagent-${id.slice(0, 8)}`);
  let name = `${base}.md`;
  let i = 2;
  while (used.has(name)) name = `${base}-${i++}.md`;
  used.add(name);
  return name;
}

function buildSubagentLinkMap(subagents) {
  const used = new Set();
  const byId = new Map();
  const files = new Map();
  for (const rollout of subagents) {
    const meta = sessionMetaFromRollout(rollout);
    const file = subagentFileName(rollout, used);
    if (meta.id) byId.set(meta.id, file);
    files.set(file, rollout);
  }
  return { byId, files };
}

function subagentInfoFromToolOutput(output) {
  if (!output?.content) return {};
  try {
    const data = JSON.parse(output.content);
    if (typeof data.content === "string") {
      try {
        const nested = JSON.parse(data.content);
        return {
          id: nested.agent_id || nested.new_thread_id || nested.agent_path || "",
          nickname: nested.nickname || nested.new_agent_nickname || "",
        };
      } catch {
        // Fall through to the top-level shape below.
      }
    }
    return {
      id: data.agent_id || data.new_thread_id || data.agent_path || "",
      nickname: data.nickname || data.new_agent_nickname || "",
    };
  } catch {
    return {};
  }
}

function buildTraceTurns(rollout, events) {
  const turns = [];
  let current = null;
  let pendingContext = null;
  let pendingPromptMessages = [];
  const newTurn = (fields = {}) => ({
    turn_id: fields.turn_id || pendingContext?.turn_id || "",
    started_at: fields.started_at || "",
    completed_at: "",
    duration_ms: null,
    time_to_first_token_ms: null,
    user: fields.user || "",
    assistantParts: [],
    toolCalls: [],
    toolOutputs: new Map(),
    usage: null,
    context: fields.context || pendingContext,
    promptMessages: [...pendingPromptMessages],
  });
  const finish = (clearPrompts = true) => {
    if (current && (current.assistantParts.length || current.toolCalls.length || (current.user && !current.promptOnly))) turns.push(current);
    current = null;
    if (clearPrompts) pendingPromptMessages = [];
  };
  for (const [rolloutIndex, line] of (rollout.lines || []).entries()) {
    const payload = line.payload || {};
    if (line.type === "turn_context") pendingContext = payload;
    const promptMessage = line.type === "response_item" ? promptMessageFromResponseItem(line, rolloutIndex + 1) : null;
    if (promptMessage && !current) {
      pendingPromptMessages.push(promptMessage);
      continue;
    }
    if (line.type === "event_msg" && payload.type === "task_started") {
      finish();
      current = newTurn({ turn_id: payload.turn_id || pendingContext?.turn_id || "", started_at: line.timestamp || "", context: pendingContext });
      pendingPromptMessages = [];
    } else if (line.type === "event_msg" && payload.type === "user_message") {
      finish(false);
      current = newTurn({ started_at: line.timestamp || "", user: payload.message || "", context: pendingContext });
      pendingPromptMessages = [];
      if (payload.message && !current.promptMessages.some((message) => message.role === "user" && message.text === payload.message)) {
        current.promptMessages.push({ role: "user", source: "event_msg.user_message", rollout_index: rolloutIndex + 1, timestamp: line.timestamp || "", text: payload.message, audit_only: true });
      }
    } else if (!current && line.type === "event_msg") {
      current = newTurn({ started_at: line.timestamp || "", context: pendingContext });
    }
    if (!current) continue;
    if (promptMessage) {
      current.promptMessages.push(promptMessage);
      if (promptMessage.role === "user" && !current.user && !promptMessage.text.startsWith("<environment_context>") && !promptMessage.text.startsWith("<subagent_notification>")) current.user = promptMessage.text;
    } else if (line.type === "event_msg" && payload.type === "agent_message") {
      if (payload.message) current.assistantParts.push({ type: "text", text: payload.message, phase: payload.phase, timestamp: line.timestamp, rollout_index: rolloutIndex + 1 });
    } else if (line.type === "event_msg" && payload.type === "token_count") {
      current.usage = payload.info?.last_token_usage || payload.info?.total_token_usage || current.usage;
      current.total_usage = payload.info?.total_token_usage || current.total_usage;
      current.model_context_window = payload.info?.model_context_window || current.model_context_window;
      current.rate_limits = payload.rate_limits || current.rate_limits;
    } else if (line.type === "event_msg" && payload.type === "task_complete") {
      current.completed_at = line.timestamp || "";
      current.duration_ms = payload.duration_ms ?? null;
      current.time_to_first_token_ms = payload.time_to_first_token_ms ?? null;
      finish();
    } else if (line.type === "response_item" && payload.type === "function_call") {
      const call = { id: payload.call_id || "", name: payload.name || "function_call", input: parseJsonMaybe(payload.arguments), timestamp: line.timestamp, rollout_index: rolloutIndex + 1 };
      current.toolCalls.push(call);
      current.assistantParts.push({ type: "tool", call });
    } else if (line.type === "response_item" && payload.type === "function_call_output") {
      current.toolOutputs.set(payload.call_id || "", { content: normalizeToolOutput(payload.output), timestamp: line.timestamp, rollout_index: rolloutIndex + 1 });
    } else if (line.type === "response_item" && payload.type === "custom_tool_call") {
      const call = { id: payload.call_id || "", name: payload.name || "custom_tool_call", input: customToolInput(payload.name, payload.input), timestamp: line.timestamp, status: payload.status || "", rollout_index: rolloutIndex + 1 };
      current.toolCalls.push(call);
      current.assistantParts.push({ type: "tool", call });
    } else if (line.type === "response_item" && payload.type === "custom_tool_call_output") {
      current.toolOutputs.set(payload.call_id || "", { content: normalizeCustomToolOutput(payload.output), timestamp: line.timestamp, rollout_index: rolloutIndex + 1 });
    }
  }
  finish();
  const merged = [];
  for (const turn of turns) {
    const prev = merged[merged.length - 1];
    if (prev && prev.user && turn.user && prev.user === turn.user && !prev.assistantParts.length && !prev.toolCalls.length) {
      turn.promptMessages = [...(prev.promptMessages || []), ...(turn.promptMessages || [])];
      merged[merged.length - 1] = turn;
    } else {
      merged.push(turn);
    }
  }
  return merged.map((turn) => {
    const start = parseIso(turn.started_at);
    const end = parseIso(turn.completed_at);
    turn.api_events = (events || []).map((event, index) => ({ ...event, _traceIndex: index + 1 })).filter((event) => {
      const ms = parseIso(event.timestamp || event.request?.timestamp || event.response?.timestamp);
      if (ms == null || start == null) return false;
      const modelCaptureLeadMs = isRawModelHttpEvent(event) ? 5000 : 0;
      return ms >= start - modelCaptureLeadMs && (end == null || ms <= end);
    });
    return turn;
  });
}

function renderTokenUsageLines(usage, totalUsage, modelContextWindow, rateLimits) {
  const lines = [];
  lines.push("_Source: Codex rollout `token_count` events. This is model token usage._", "");
  if (usage) {
    lines.push("| Token Field | Last Turn | Total |", "| --- | ---: | ---: |");
    for (const key of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]) {
      lines.push(`| ${key} | ${usage[key] ?? ""} | ${totalUsage?.[key] ?? ""} |`);
    }
  } else {
    lines.push("No model token usage was found for this turn.");
  }
  if (modelContextWindow != null) lines.push("", `**Context Window:** \`${modelContextWindow}\`  `);
  if (rateLimits) lines.push(`**Rate Limits:** \`${JSON.stringify(rateLimits)}\`  `);
  return lines.join("\n");
}

function renderPromptMessagesForTurn(turn, sessionMeta) {
  const lines = [];
  lines.push("### Prompts Sent To Agent", "");
  if (sessionMeta.base_instructions?.text) {
    lines.push(detailsBlock("System prompt: base instructions", fence(fullText(sessionMeta.base_instructions.text), "")), "");
  }
  const seen = new Set();
  const messages = [];
  for (const message of turn.promptMessages || []) {
    const key = `${message.role}\n${message.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    messages.push(message);
  }
  if (messages.length) {
    messages.forEach((message, index) => {
      const title = `Prompt message ${index + 1}: ${message.role}${message.source ? ` (${message.source})` : ""}${message.timestamp ? ` @ ${message.timestamp}` : ""}`;
      lines.push(detailsBlock(title, fence(fullText(message.text), message.text.trim().startsWith("{") ? "json" : "")), "");
    });
  } else {
    lines.push("No per-turn prompt messages found in rollout.", "");
  }
  if (turn.context?.collaboration_mode?.settings?.developer_instructions) {
    lines.push(detailsBlock("Developer instructions from turn context", fence(fullText(turn.context.collaboration_mode.settings.developer_instructions), "")), "");
  }
  return lines.join("\n");
}

function renderTraceEnhancement(turn, sessionMeta) {
  const body = [];
  body.push("### Turn Timing", "");
  body.push(`**Turn ID:** \`${turn.turn_id || ""}\`  `);
  body.push(`**Started:** \`${turn.started_at || ""}\`  `);
  if (turn.completed_at) body.push(`**Completed:** \`${turn.completed_at}\`  `);
  if (turn.duration_ms != null) body.push(`**Duration ms:** \`${turn.duration_ms}\`  `);
  if (turn.time_to_first_token_ms != null) body.push(`**Time to first token ms:** \`${turn.time_to_first_token_ms}\`  `);
  body.push("", "### Token Usage", "", renderTokenUsageLines(turn.usage, turn.total_usage, turn.model_context_window, turn.rate_limits) || "No token usage captured.");
  body.push("", renderPromptMessagesForTurn(turn, sessionMeta));
  body.push("", "### Raw Turn Context", "", fence(JSON.stringify(turn.context || {}, null, 2), "json"));
  if (turn.api_events?.length) {
    body.push("", "### API Requests Captured During This Turn", "");
    body.push("Full request and response bodies are kept once in `Captured Request Log`; this turn links to those canonical entries.", "");
    body.push(renderTurnRequestTable(turn.api_events));
  }
  return detailsBlock("Agent Trace Details", body.join("\n"));
}

function renderTraceSummary({ turns, subagents, events, rawDumps, tokens }) {
  const toolCounts = new Map();
  let editCalls = 0;
  for (const turn of turns || []) {
    for (const call of turn.toolCalls || []) {
      toolCounts.set(call.name, (toolCounts.get(call.name) || 0) + 1);
      if (isEditTool(call.name)) editCalls += 1;
    }
  }
  const totalToolCalls = [...toolCounts.values()].reduce((sum, count) => sum + count, 0);
  const lines = ["## Trace Summary", ""];
  lines.push("| Metric | Count |", "| --- | ---: |");
  lines.push(`| Conversation turns | ${turns.length} |`);
  lines.push(`| Tool calls | ${totalToolCalls} |`);
  lines.push(`| Code edit tool calls | ${editCalls} |`);
  lines.push(`| Subagent conversations | ${subagents.length} |`);
  lines.push(`| Normalized API events | ${events.length} |`);
  lines.push(`| Raw request dump files | ${rawDumps.length} |`);
  lines.push(`| Captured auth headers | ${tokens.length} |`);
  if (toolCounts.size) {
    lines.push("", "### Tool Call Summary", "", "| Tool | Count |", "| --- | ---: |");
    [...toolCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).forEach(([name, count]) => {
      lines.push(`| ${mdEscapeInline(name)} | ${count} |`);
    });
  }
  return lines.join("\n");
}

function renderCc2mdAssistant(turn, subagentLinks = new Map()) {
  const parts = [];
  const renderedToolIds = new Set();
  for (const part of turn.assistantParts) {
    if (part.type === "text" && part.text) {
      parts.push(part.text);
      continue;
    }
    if (part.type !== "tool") continue;
    const call = part.call;
    renderedToolIds.add(call.id);
    const renderedTool = renderCc2mdToolUse(call.name, call.input);
    const output = turn.toolOutputs.get(call.id);
    if (isEditTool(call.name)) {
      const pieces = [renderedTool];
      if (output?.content) pieces.push(`**Result: ${call.name}**\n${fence(output.content)}`);
      parts.push(pieces.join("\n\n"));
    } else {
      parts.push(renderedTool);
      if (output?.content) parts.push(detailsBlock(`Result: ${call.name}`, `**Result: ${call.name}**\n${fence(output.content)}`));
      if (call.name === "spawn_agent") {
        const info = subagentInfoFromToolOutput(output);
        const file = info.id ? subagentLinks.get(info.id) : "";
        if (file) parts.push(`[→ Subagent: ${info.nickname || info.id}](${file})`);
      }
    }
  }
  for (const call of turn.toolCalls) {
    if (renderedToolIds.has(call.id)) continue;
    parts.push(renderCc2mdToolUse(call.name, call.input));
  }
  return parts.filter((part) => String(part || "").trim()).join("\n\n");
}

function requestEventUrl(event) {
  return event?.request?.url || event?.url || "";
}

function requestEventMethod(event) {
  return event?.request?.method || event?.method || event?.type || "event";
}

function requestEventStatus(event) {
  if (event?.response?.status_code != null) return String(event.response.status_code);
  if (event?.response?.status != null) return String(event.response.status);
  if (event?.error) return "error";
  return "";
}

function requestEventTime(event) {
  return event?.request?.timestamp || event?.timestamp || event?.response?.timestamp || "";
}

function shortUrl(value) {
  const text = String(value || "");
  if (!text) return "";
  try {
    const url = new URL(text);
    return `${url.host}${url.pathname}${url.search}`;
  } catch {
    return text.length > 90 ? `${text.slice(0, 87)}...` : text;
  }
}

function renderRequestOverviewTable(items) {
  const lines = ["| # | Time | Method | Status | Duration | URL |", "| ---: | --- | --- | --- | ---: | --- |"];
  items.forEach((item, index) => {
    const event = item.event;
    const n = item.index || event?._traceIndex || index + 1;
    const number = item.anchor ? `[${n}](#${item.anchor})` : n;
    lines.push([
      number,
      mdEscapeInline(requestEventTime(event)),
      mdEscapeInline(requestEventMethod(event)),
      mdEscapeInline(requestEventStatus(event)),
      event?.duration_ms != null ? event.duration_ms : "",
      mdEscapeInline(shortUrl(requestEventUrl(event) || item.label || "")),
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  });
  return lines.join("\n");
}

function renderTurnRequestTable(events) {
  return renderRequestOverviewTable((events || []).map((event) => ({
    event,
    index: event._traceIndex,
    anchor: event._traceIndex ? `request-log-${event._traceIndex}` : "",
    label: event.request?.url || event.url || event.type || `event ${event._traceIndex || ""}`,
  })));
}

function renderMaybeJsonBlock(value, lang = "json", { truncate = false } = {}) {
  if (value == null || value === "") return "_empty_";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "_empty_";
    try {
      return fence(JSON.stringify(JSON.parse(trimmed), null, 2), "json");
    } catch {
      return fence(truncate ? truncateText(value) : fullText(value), "");
    }
  }
  const json = JSON.stringify(value, null, 2);
  return fence(truncate ? truncateText(json) : json, lang);
}

function renderHeaders(headers) {
  if (!headers || !Object.keys(headers).length) return "_none_";
  const lines = ["| Header | Value |", "| --- | --- |"];
  for (const [key, value] of Object.entries(headers)) {
    lines.push(`| ${mdEscapeInline(key)} | ${mdEscapeInline(Array.isArray(value) ? value.join(", ") : value)} |`);
  }
  return lines.join("\n");
}

function renderRequestEventDetails(event, title, rawFile = "") {
  const lines = [];
  lines.push(`**${requestEventMethod(event)}** \`${requestEventUrl(event) || title}\`  `);
  if (rawFile) lines.push(`**Raw file:** \`${rawFile}\`  `);
  if (requestEventTime(event)) lines.push(`**Time:** \`${requestEventTime(event)}\`  `);
  if (event.duration_ms != null) lines.push(`**Duration:** \`${event.duration_ms}ms\`  `);
  if (requestEventStatus(event)) lines.push(`**Status:** \`${requestEventStatus(event)}\`  `);
  if (event.error) lines.push(`**Error:** \`${event.error}\`  `);

  lines.push("", "#### Request Headers", "", renderHeaders(event.request?.headers || event.headers));
  lines.push("", "#### Request Body", "", renderMaybeJsonBlock(event.request?.body ?? event.body));

  if (event.response || event.error) {
    lines.push("", "#### Response Headers", "", renderHeaders(event.response?.headers));
    lines.push("", "#### Response Body", "", renderMaybeJsonBlock(event.response?.body));
  }

  lines.push("", detailsBlock("Complete Raw Event JSON", fence(JSON.stringify(event, null, 2), "json")));
  return lines.join("\n");
}

function renderCapturedRequestLog(events, rawDumps, runDir) {
  const lines = ["## Captured Request Log", ""];
  lines.push(`Captured \`${events.length}\` normalized log events from \`logs.jsonl\`.`);
  lines.push(`Captured \`${rawDumps.length}\` raw dump files from \`raw/*.json\`.`, "");
  if (events.length) {
    const items = events.map((event, index) => ({ event, index: index + 1, anchor: `request-log-${index + 1}`, label: event.request?.url || event.url || event.type || `event ${index + 1}` }));
    lines.push("### Request Overview", "", renderRequestOverviewTable(items), "");
    lines.push("### Normalized Events (`logs.jsonl`)", "");
    events.forEach((event, index) => {
      const label = event.request?.url || event.type || `event ${index + 1}`;
      const summary = `${index + 1}. ${requestEventMethod(event)} ${shortUrl(label)}${requestEventStatus(event) ? ` [${requestEventStatus(event)}]` : ""}`;
      lines.push(`<a id="request-log-${index + 1}"></a>`);
      lines.push(detailsBlock(summary, renderRequestEventDetails(event, label)), "");
    });
  }
  if (rawDumps.length) {
    const items = rawDumps.map((dump, index) => ({ event: dump.data, label: path.relative(runDir, dump.file) || `raw ${index + 1}` }));
    lines.push("### Raw Dump Overview", "", renderRequestOverviewTable(items), "");
    lines.push("### Raw Dump Files (`raw/*.json`)", "");
    rawDumps.forEach((dump, index) => {
      const rel = path.relative(runDir, dump.file);
      const label = dump.data?.request?.url || dump.data?.type || rel;
      const summary = `${index + 1}. ${requestEventMethod(dump.data)} ${shortUrl(label)} (${rel})${requestEventStatus(dump.data) ? ` [${requestEventStatus(dump.data)}]` : ""}`;
      lines.push(detailsBlock(summary, renderRequestEventDetails(dump.data, label, rel)), "");
    });
  }
  return lines.join("\n");
}

function renderSubagentMarkdown(rollout, runMeta = {}) {
  const meta = sessionMetaFromRollout(rollout);
  const title = agentNicknameFromMeta(meta) || extractTitleFromRollout(rollout) || "Subagent";
  const md = [
    `# Subagent: ${title}`,
    "",
    `**Type:** ${agentRoleFromMeta(meta) || "unknown"}  `,
    `**Agent ID:** \`${meta.id || ""}\`  `,
    `**Rollout:** \`${rollout.file || ""}\`  `,
    "",
    "---",
    "",
  ];
  md.push(...formatCodexMetadata(collectCodexMetadata(rollout, runMeta)));
  const turns = buildTraceTurns(rollout, []);
  for (const turn of turns) {
    if (turn.user) md.push("**Prompt:**", "", turn.user, "");
    md.push(renderTraceEnhancement(turn, meta), "");
    const assistant = renderCc2mdAssistant(turn);
    if (assistant) md.push(assistant, "");
  }
  return `${md.join("\n")}\n`;
}

function renderCc2mdTraceMarkdown({ runDir, runMeta, events, tokens, rollouts, rawDumps = [] }) {
  const main = rollouts.find((rollout) => !isSubagentRollout(rollout)) || rollouts[0] || { lines: [], file: "" };
  const subagents = rollouts.filter((rollout) => rollout !== main && isSubagentRollout(rollout));
  const subagentMaps = buildSubagentLinkMap(subagents);
  const meta = sessionMetaFromRollout(main);
  const title = extractTitleFromRollout(main);
  const sessionId = meta.id || path.basename(main.file || runDir);
  const project = meta.cwd || runMeta.cwd || process.cwd();
  const ts = meta.timestamp ? new Date(meta.timestamp).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : "";
  const md = [`# ${title}`, "", `**Session:** \`${sessionId}\`  `, `**Project:** \`${project}\`  `];
  if (ts) md.push(`**Date:** ${ts}  `);
  md.push("", "---", "");
  md.push(...formatCodexMetadata(collectCodexMetadata(main, runMeta)));
  md.push("## Agent Trace Metadata", "");
  md.push(`**Trace Directory:** \`${path.resolve(runDir)}\`  `);
  md.push(`**Agent:** \`${runMeta.agent || "unknown"}\`  `);
  md.push(`**Command:** \`${[runMeta.command, ...(runMeta.args || [])].filter(Boolean).join(" ")}\`  `);
  if (runMeta.auth_mode) md.push(`**Auth Mode:** \`${runMeta.auth_mode}\`  `);
  if (runMeta.base_url) md.push(`**Base URL:** \`${runMeta.base_url}\`  `);
  md.push(`**Captured API Events:** \`${events.length}\`  `);
  md.push(`**Captured Auth Headers:** \`${tokens.length}\`  `, "", "---", "");
  if (tokens.length) {
    md.push("## Captured Auth Headers", "");
    const seen = new Set();
    let index = 0;
    for (const token of tokens) {
      const key = `${token.header || ""}\n${token.value || token.preview || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      index += 1;
      md.push(detailsBlock(`Token ${index}: ${token.header || "token"}`, [
        token.timestamp ? `**Time:** \`${token.timestamp}\`  ` : "",
        token.url ? `**URL:** \`${token.url}\`  ` : "",
        "",
        fence(token.value || token.preview || "", ""),
      ].filter((line) => line !== "").join("\n")), "");
    }
    md.push("---", "");
  }

  const turns = buildTraceTurns(main, events);
  md.push(renderTraceSummary({ turns, subagents, events, rawDumps, tokens }), "", "---", "");
  if (!turns.length) {
    md.push("No conversation turns found.");
  }
  for (const turn of turns) {
    if (turn.user) md.push("## User", "", turn.user, "");
    md.push(renderTraceEnhancement(turn, meta), "");
    const assistant = renderCc2mdAssistant(turn, subagentMaps.byId);
    if (assistant) md.push("## Assistant", "", assistant, "");
  }

  if (subagents.length) {
    md.push("---", "", "## Subagent Conversations", "");
    for (const [file, sub] of subagentMaps.files.entries()) {
      const subMeta = sessionMetaFromRollout(sub);
      const desc = agentNicknameFromMeta(subMeta) || subMeta.id || path.basename(sub.file);
      md.push(`- [→ Subagent: ${desc}](${file})`);
    }
    md.push("");
  }
  md.push("---", "", renderCapturedRequestLog(events, rawDumps, runDir));
  const files = new Map();
  for (const [file, rollout] of subagentMaps.files.entries()) {
    files.set(file, renderSubagentMarkdown(rollout, runMeta));
  }
  return { content: `${md.join("\n")}\n`, files };
}

function generateRunMarkdown(runDir, opts = {}) {
  const runMetaFile = path.join(runDir, "run.json");
  const runMeta = fs.existsSync(runMetaFile) ? readJsonFile(runMetaFile) : {};
  const logsFile = path.join(runDir, "logs.jsonl");
  const rawDir = path.join(runDir, "raw");
  const tokenFile = path.join(runDir, "tokens.jsonl");
  const events = readJsonl(logsFile);
  const tokens = readJsonl(tokenFile);
  const rawDumps = walkFiles(rawDir).filter((file) => file.endsWith(".json")).sort().map((file) => ({ file, data: readJsonFile(file) }));
  const rollouts = readRolloutsForRun(runMeta);
  const rendered = rollouts.length
    ? renderCc2mdTraceMarkdown({ runDir, runMeta, events, tokens, rollouts, rawDumps })
    : { content: renderRequestOnlyTraceMarkdown({ runDir, runMeta, events, tokens, rawDumps }), files: new Map() };
  const out = opts.outputFile || path.join(runDir, "report.md");
  fs.writeFileSync(out, rendered.content);
  const extraDir = path.dirname(out);
  for (const [file, content] of rendered.files || []) {
    fs.writeFileSync(path.join(extraDir, file), content);
  }
  return out;
}

function renderLegacyJsonlMarkdown({ inputFile, events }) {
  const summary = summarizeEvents(events);
  const md = ["# Agent Trace JSONL Report", "", `Source: \`${path.resolve(inputFile)}\``, "", "## Summary", ""];
  md.push("| Type | Count |", "| --- | ---: |");
  for (const [key, value] of Object.entries(summary.counts)) md.push(`| ${mdEscapeInline(key)} | ${value} |`);
  md.push("", "## Events", "");
  events.forEach((event, index) => {
    md.push(`### Event ${index + 1}: ${event.type || event.request?.url || "unknown"}`, "", fence(JSON.stringify(event, null, 2), "json"), "");
  });
  return `${md.join("\n")}\n`;
}

function textFromClaudeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content, null, 2);
  return content.map((item) => {
    if (typeof item === "string") return item;
    if (item?.text) return item.text;
    if (item?.content) return textFromClaudeContent(item.content);
    return JSON.stringify(item);
  }).filter(Boolean).join("\n");
}

function renderClaudePromptSummary(body) {
  const lines = [];
  if (!body || typeof body !== "object") return "";
  if (body.model) lines.push(`**Model:** \`${body.model}\`  `);
  if (body.max_tokens != null) lines.push(`**Max tokens:** \`${body.max_tokens}\`  `);
  if (body.stream != null) lines.push(`**Stream:** \`${body.stream}\`  `);
  if (body.thinking) lines.push(`**Thinking:** \`${JSON.stringify(body.thinking)}\`  `);
  if (body.output_config) lines.push(`**Output config:** \`${JSON.stringify(body.output_config)}\`  `);
  if (Array.isArray(body.system) && body.system.length) {
    lines.push("", "### System Prompt", "");
    body.system.forEach((item, index) => {
      lines.push(detailsBlock(`System ${index + 1}`, fence(truncateText(textFromClaudeContent([item])), "")), "");
    });
  }
  if (Array.isArray(body.messages) && body.messages.length) {
    lines.push("", "### Messages", "");
    body.messages.forEach((message, index) => {
      const role = message.role || `message ${index + 1}`;
      const text = textFromClaudeContent(message.content);
      if (role === "user") lines.push(`#### User Message ${index + 1}`, "", truncateText(text), "");
      else lines.push(detailsBlock(`${role} message ${index + 1}`, fence(truncateText(text), "")), "");
    });
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    lines.push("", "### Tools", "", fence(JSON.stringify(body.tools, null, 2), "json"));
  }
  return lines.join("\n");
}

function renderClaudeUsage(event) {
  const usage = event.response?.body?.usage || event.response?.body?.message?.usage;
  if (!usage || typeof usage !== "object") return "";
  const lines = ["### Token Usage", "", "| Field | Value |", "| --- | ---: |"];
  for (const [key, value] of Object.entries(usage)) lines.push(`| ${mdEscapeInline(key)} | ${mdEscapeInline(value)} |`);
  return lines.join("\n");
}

function renderRequestOnlyTraceMarkdown({ runDir, runMeta, events, tokens, rawDumps }) {
  const md = ["# Agent Trace Report", "", `**Session:** \`${path.basename(runDir)}\`  `, `**Project:** \`${process.cwd()}\`  `];
  if (runMeta.started_at) md.push(`**Date:** ${new Date(runMeta.started_at).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}  `);
  md.push("", "---", "", "## Agent Trace Metadata", "");
  md.push(`**Trace Directory:** \`${path.resolve(runDir)}\`  `);
  md.push(`**Agent:** \`${runMeta.agent || "unknown"}\`  `);
  md.push(`**Command:** \`${[runMeta.command, ...(runMeta.args || [])].filter(Boolean).join(" ")}\`  `);
  if (runMeta.upstream_url) md.push(`**Upstream URL:** \`${runMeta.upstream_url}\`  `);
  if (runMeta.base_url) md.push(`**Base URL:** \`${runMeta.base_url}\`  `);
  md.push(`**Captured API Events:** \`${events.length}\`  `);
  md.push(`**Captured Auth Headers:** \`${tokens.length}\`  `, "", "---", "");

  if (tokens.length) {
    md.push("## Captured Auth Headers", "");
    const seen = new Set();
    let index = 0;
    for (const token of tokens) {
      const key = `${token.header || ""}\n${token.value || token.preview || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      index += 1;
      md.push(detailsBlock(`Auth header ${index}: ${token.header || "header"}`, [
        token.timestamp ? `**Time:** \`${token.timestamp}\`  ` : "",
        token.url ? `**URL:** \`${token.url}\`  ` : "",
        "",
        fence(token.value || token.preview || "", ""),
      ].filter((line) => line !== "").join("\n")), "");
    }
    md.push("---", "");
  }

  const apiEvents = events.filter((event) => event.request?.body && typeof event.request.body === "object");
  if (apiEvents.length) {
    md.push("## Claude API Calls", "");
    apiEvents.forEach((event, index) => {
      const body = [];
      body.push(renderClaudePromptSummary(event.request.body));
      const usage = renderClaudeUsage(event);
      if (usage) body.push("", usage);
      body.push("", detailsBlock("Structured Request/Response", renderRequestEventDetails(event, event.request?.url || `request ${index + 1}`)));
      md.push(`### API Call ${index + 1}: ${requestEventMethod(event)} ${shortUrl(requestEventUrl(event))}`, "", body.filter(Boolean).join("\n"), "");
    });
    md.push("---", "");
  }

  md.push(renderCapturedRequestLog(events, rawDumps, runDir));
  return `${md.join("\n")}\n`;
}

function generateMarkdownFromJsonl(inputFile, outputFile, opts = {}) {
  const events = readJsonl(inputFile);
  fs.writeFileSync(outputFile, renderLegacyJsonlMarkdown({ inputFile, events }));
  return outputFile;
}

function loadTraceRun(runDir) {
  const runMetaFile = path.join(runDir, "run.json");
  const logsFile = path.join(runDir, "logs.jsonl");
  const rawDir = path.join(runDir, "raw");
  const tokenFile = path.join(runDir, "tokens.jsonl");
  const runMeta = fs.existsSync(runMetaFile) ? readJsonFile(runMetaFile) : {};
  const events = readJsonl(logsFile);
  const tokens = readJsonl(tokenFile);
  const rawDumps = walkFiles(rawDir).filter((file) => file.endsWith(".json")).sort().map((file) => ({ file, data: readJsonFile(file) }));
  const rollouts = readRolloutsForRun(runMeta);
  return { runDir, runMeta, logsFile, rawDir, tokenFile, events, tokens, rawDumps, rollouts };
}

function compactApiEvent(event, index, includeSensitive = false) {
  const source = includeSensitive ? event : redactSensitive(event);
  return {
    index,
    type: source.type || "",
    method: requestEventMethod(source),
    url: requestEventUrl(source),
    status: requestEventStatus(source),
    timestamp: requestEventTime(source),
    duration_ms: source.duration_ms ?? null,
    request: source.request || null,
    response: source.response || null,
    direction: source.direction || null,
    opcode: source.opcode ?? null,
    body: source.body ?? null,
    body_base64: source.body_base64 || null,
    body_encoding: source.body_encoding || null,
    body_sha256: source.body_sha256 || null,
    body_decoded_sha256: source.body_decoded_sha256 || null,
    error: source.error || null,
  };
}

function isRawModelHttpEvent(event) {
  return /\/v1\/(responses|chat\/completions)\b/.test(requestEventUrl(event)) || /\/backend-api\/codex\/responses\b/.test(requestEventUrl(event));
}

function hasCapturedRequestBody(event) {
  return event?.request?.body != null || Boolean(event?.request?.body_base64) || event?.body != null || Boolean(event?.body_base64);
}

function isRawModelRequestEvent(event) {
  if (event?.type === "websocket_frame") return event.direction === "client_to_upstream" && event.body?.type === "response.create";
  return hasCapturedRequestBody(event);
}

function isRawModelSuccessEvent(event) {
  if (event?.type === "websocket_frame") return event.direction === "upstream_to_client" && (event.body != null || Boolean(event.body_base64));
  const status = Number(requestEventStatus(event));
  return status >= 200 && status < 300;
}

function trainingRecordForTurn({ runDir, runMeta, rollout, turn, turnIndex, events, includeSensitive }) {
  const meta = sessionMetaFromRollout(rollout);
  const rawModelEvents = (turn.api_events || []).filter(isRawModelHttpEvent);
  const rawModelRequestBodyEvents = rawModelEvents.filter(isRawModelRequestEvent);
  const rawModelSuccessEvents = rawModelEvents.filter(isRawModelSuccessEvent);
  const promptMessages = [];
  if (meta.base_instructions?.text) promptMessages.push({ role: "system", source: "session_meta.base_instructions", timestamp: meta.timestamp || "", content: meta.base_instructions.text });
  const modelPromptMessages = (turn.promptMessages || []).filter((message) => !message.audit_only);
  const promptSource = modelPromptMessages.length ? modelPromptMessages : (turn.promptMessages || []);
  for (const message of promptSource) {
    promptMessages.push({
      role: message.role || "unknown",
      source: message.source || "",
      rollout_index: message.rollout_index ?? null,
      timestamp: message.timestamp || "",
      content: message.text || "",
      is_model_input: !message.audit_only,
    });
  }
  if (turn.context?.collaboration_mode?.settings?.developer_instructions) {
    promptMessages.push({ role: "developer", source: "turn_context.developer_instructions", rollout_index: null, timestamp: turn.started_at || "", content: turn.context.collaboration_mode.settings.developer_instructions, is_model_input: false });
  }
  const assistantText = turn.assistantParts.filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n\n");
  const toolCalls = (turn.toolCalls || []).map((call) => {
    const output = turn.toolOutputs.get(call.id);
    return {
      id: call.id || "",
      name: call.name || "",
      timestamp: call.timestamp || "",
      rollout_index: call.rollout_index ?? null,
      status: call.status || "",
      input: includeSensitive ? call.input : redactSensitive(call.input),
      output: output?.content ? stripAnsi(output.content) : "",
      output_timestamp: output?.timestamp || "",
      output_rollout_index: output?.rollout_index ?? null,
      is_edit: isEditTool(call.name),
    };
  });
  const apiEvents = (turn.api_events || []).map((event) => compactApiEvent(event, event._traceIndex || events.indexOf(event) + 1, includeSensitive));
  const rawModelRequests = rawModelRequestBodyEvents.map((event) => compactApiEvent(event, event._traceIndex || events.indexOf(event) + 1, includeSensitive));
  return {
    schema: "agent-trace.training.v1",
    trace: {
      dir: path.resolve(runDir),
      agent: runMeta.agent || "unknown",
      command: runMeta.command || "",
      args: runMeta.args || [],
      started_at: runMeta.started_at || "",
      finished_at: runMeta.finished_at || "",
      auth_mode: runMeta.auth_mode || "",
      provenance: {
        prompt_source: rawModelRequestBodyEvents.length ? "agent-trace proxy captured Responses request body" : "codex_rollout.response_item.message plus session_meta.base_instructions",
        output_source: rawModelSuccessEvents.length ? "agent-trace proxy captured Responses response body or websocket frames" : "codex_rollout.event_msg.agent_message and response_item tool events",
        api_source: "agent-trace local forwarding proxy logs",
        raw_model_http_events: rawModelEvents.length,
        raw_model_http_request_captured: rawModelEvents.length > 0,
        raw_model_http_request_body_captured: rawModelRequestBodyEvents.length > 0,
        raw_model_http_success_events: rawModelSuccessEvents.length,
      },
    },
    session: {
      id: meta.id || "",
      source: meta.source || "",
      is_subagent: isSubagentRollout(rollout),
      parent_thread_id: parentThreadIdFromMeta(meta),
      agent_role: agentRoleFromMeta(meta),
      agent_nickname: agentNicknameFromMeta(meta),
      rollout_file: rollout.file || "",
      cwd: meta.cwd || turn.context?.cwd || "",
    },
    turn: {
      index: turnIndex,
      id: turn.turn_id || "",
      started_at: turn.started_at || "",
      completed_at: turn.completed_at || "",
      duration_ms: turn.duration_ms,
      time_to_first_token_ms: turn.time_to_first_token_ms,
      token_usage: turn.usage || null,
      total_token_usage: turn.total_usage || null,
      model_context_window: turn.model_context_window || null,
      rate_limits: turn.rate_limits || null,
    },
    token_usage: {
      last_turn: turn.usage || null,
      total: turn.total_usage || null,
      model_context_window: turn.model_context_window || null,
      rate_limits: turn.rate_limits || null,
    },
    prompt_messages: promptMessages,
    assistant: {
      text: assistantText,
      parts: turn.assistantParts.map((part) => part.type === "tool" ? { type: "tool", call_id: part.call?.id || "", name: part.call?.name || "", rollout_index: part.call?.rollout_index ?? null } : part),
    },
    tool_calls: toolCalls,
    raw_turn_context: includeSensitive ? turn.context || null : redactSensitive(turn.context || null),
    raw_model_requests: rawModelRequests,
    api_events: apiEvents,
  };
}

function exportTrainingJsonl(runDir, outputFile, opts = {}) {
  const loaded = loadTraceRun(runDir);
  const records = [];
  for (const rollout of loaded.rollouts) {
    const turns = buildTraceTurns(rollout, isSubagentRollout(rollout) ? [] : loaded.events);
    turns.forEach((turn, index) => {
      records.push(trainingRecordForTurn({ ...loaded, rollout, turn, turnIndex: index + 1, includeSensitive: Boolean(opts.includeSensitive) }));
    });
  }
  fs.writeFileSync(outputFile, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));
  return { outputFile, records, loaded };
}

function validateTrace(runDir) {
  const errors = [];
  const warnings = [];
  const exists = (file, label, required = true) => {
    if (fs.existsSync(file)) return true;
    (required ? errors : warnings).push(`${label} is missing: ${file}`);
    return false;
  };
  exists(runDir, "trace directory");
  const loaded = loadTraceRun(runDir);
  exists(path.join(runDir, "run.json"), "run.json");
  exists(loaded.logsFile, "logs.jsonl", false);
  if (loaded.runMeta.agent === "codex") {
    if (!loaded.rollouts.length) errors.push("codex trace has no readable rollout files");
    if (loaded.rollouts.length && !loaded.rollouts.some((rollout) => !isSubagentRollout(rollout))) errors.push("codex trace has no main rollout");
  }
  if (loaded.rawDumps.length && loaded.events.length && loaded.rawDumps.length !== loaded.events.length) warnings.push(`raw dump count (${loaded.rawDumps.length}) differs from normalized event count (${loaded.events.length})`);
  const rawModelEvents = loaded.events.filter(isRawModelHttpEvent);
  const rawModelRequestBodyEvents = rawModelEvents.filter(isRawModelRequestEvent);
  const rawModelSuccessEvents = rawModelEvents.filter(isRawModelSuccessEvent);
  if (rawModelEvents.length && !rawModelSuccessEvents.length) warnings.push("raw model HTTP requests were captured, but no successful model response was captured");

  let turnCount = 0;
  let toolCount = 0;
  let editToolCount = 0;
  let turnsWithUsage = 0;
  let turnsWithPrompt = 0;
  let subagentCount = 0;
  let orderingIssues = 0;
  for (const rollout of loaded.rollouts) {
    if (isSubagentRollout(rollout)) subagentCount += 1;
    const turns = buildTraceTurns(rollout, isSubagentRollout(rollout) ? [] : loaded.events);
    for (const turn of turns) {
      turnCount += 1;
      if (turn.usage) turnsWithUsage += 1;
      if ((turn.promptMessages || []).length || turn.user) turnsWithPrompt += 1;
      toolCount += turn.toolCalls.length;
      editToolCount += turn.toolCalls.filter((call) => isEditTool(call.name)).length;
      const orderedParts = turn.assistantParts.map((part) => part.type === "tool" ? part.call?.rollout_index : part.rollout_index).filter((index) => index != null);
      for (let i = 1; i < orderedParts.length; i++) {
        if (orderedParts[i] < orderedParts[i - 1]) {
          orderingIssues += 1;
          warnings.push(`assistant part order decreased in turn ${turn.turn_id || turnCount}: ${orderedParts[i - 1]} -> ${orderedParts[i]}`);
        }
      }
      for (const call of turn.toolCalls) {
        if (call.id && !turn.toolOutputs.has(call.id)) warnings.push(`tool call has no output: ${call.name} ${call.id}`);
        const output = turn.toolOutputs.get(call.id);
        if (output?.rollout_index != null && call.rollout_index != null && output.rollout_index < call.rollout_index) {
          orderingIssues += 1;
          warnings.push(`tool output appears before call: ${call.name} ${call.id}`);
        }
      }
    }
  }
  if (loaded.rollouts.length && !turnCount) errors.push("no conversation turns were reconstructed from rollouts");
  if (turnCount && !turnsWithPrompt) warnings.push("no prompt messages were reconstructed");
  if (turnCount && !turnsWithUsage) warnings.push("no model token usage was reconstructed");

  const report = {
    ok: errors.length === 0,
    trace_dir: path.resolve(runDir),
    stats: {
      agent: loaded.runMeta.agent || "unknown",
      normalized_events: loaded.events.length,
      raw_dumps: loaded.rawDumps.length,
      auth_headers: loaded.tokens.length,
      rollouts: loaded.rollouts.length,
      subagents: subagentCount,
      turns: turnCount,
      turns_with_token_usage: turnsWithUsage,
      turns_with_prompt_messages: turnsWithPrompt,
      tool_calls: toolCount,
      edit_tool_calls: editToolCount,
      ordering_issues: orderingIssues,
      raw_model_http_events: rawModelEvents.length,
      raw_model_http_request_body_events: rawModelRequestBodyEvents.length,
      raw_model_http_success_events: rawModelSuccessEvents.length,
    },
    errors,
    warnings,
  };
  return report;
}

function htmlShell({ title, subtitle, runMeta, sections }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; --bg:#0f1115; --panel:#171b22; --text:#e8ebf2; --muted:#9aa4b2; --border:#303743; --accent:#64a8ff; --ok:#75d99c; }
    body { margin:0; font:14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
    header { padding:18px 24px; border-bottom:1px solid var(--border); position:sticky; top:0; background:var(--bg); z-index:1; }
    h1 { margin:0 0 4px; font-size:20px; }
    h2 { margin:24px 0 12px; font-size:16px; }
    main { padding:0 24px 36px; max-width:1440px; }
    a { color:var(--accent); }
    .muted { color:var(--muted); }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
    .card { border:1px solid var(--border); background:var(--panel); border-radius:8px; padding:12px; overflow:hidden; }
    .turns { display:grid; gap:12px; }
    .turn-head { display:flex; flex-wrap:wrap; gap:10px; align-items:baseline; margin-bottom:8px; }
    .chat { display:grid; gap:10px; margin-top:10px; }
    .chat-row { border-left:3px solid var(--border); padding:8px 10px; background:rgba(255,255,255,.025); border-radius:6px; }
    .chat-row.user { border-left-color:#64a8ff; }
    .chat-row.assistant { border-left-color:#75d99c; }
    .chat-row.tool_call, .chat-row.tool_output { border-left-color:#d7b56d; }
    .chat-row.subagent, .chat-row.subagent_result { border-left-color:#c58cff; }
    .role { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; margin-bottom:4px; }
    .bubble-text { white-space:pre-wrap; }
    .token-card { border-color:#6b3f3f; }
    .token-value { white-space:pre-wrap; word-break:break-all; border-top:0; background:rgba(255,255,255,.03); border-radius:6px; margin-top:8px; }
    details { border:1px solid var(--border); background:var(--panel); border-radius:8px; margin:10px 0; }
    summary { cursor:pointer; padding:10px 12px; color:var(--accent); }
    pre { overflow:auto; margin:0; padding:12px; border-top:1px solid var(--border); font-size:12px; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    .pill { display:inline-block; border:1px solid var(--border); border-radius:999px; padding:2px 8px; margin:2px 4px 2px 0; color:var(--muted); }
  </style>
</head>
<body>
  <header><h1>${escapeHtml(title)}</h1><div class="muted">${escapeHtml(subtitle || "")}</div></header>
  <main>
    <h2>Run</h2>
    <div class="grid">
      ${Object.entries(runMeta || {}).map(([key, value]) => `<div class="card"><b>${escapeHtml(key)}</b><br><code>${escapeHtml(value ?? "")}</code></div>`).join("")}
    </div>
    ${sections.join("\n")}
  </main>
</body>
</html>`;
}

function generateHtmlFromJsonl(inputFile, outputFile, opts = {}) {
  const events = readJsonl(inputFile);
  const summary = summarizeEvents(events);
  const filtered = opts.includeAllRequests ? events : events.filter((event) => {
    const messages = event.request?.body?.messages;
    return !messages || messages.length > 2;
  });
  const html = htmlShell({
    title: "Agent Trace Report",
    subtitle: path.resolve(inputFile),
    runMeta: { events: filtered.length, input: path.resolve(inputFile) },
    sections: [
      `<h2>Summary</h2><div>${Object.entries(summary.counts).map(([k, v]) => `<span class="pill">${escapeHtml(k)}: ${v}</span>`).join("")}</div>`,
      `<h2>Events</h2>${filtered.map((event, index) => `<details ${index === 0 ? "open" : ""}><summary>${escapeHtml(event.type || event.request?.url || `event ${index + 1}`)}</summary><pre><code>${renderJson(event)}</code></pre></details>`).join("")}`,
    ],
  });
  fs.writeFileSync(outputFile, html);
  return outputFile;
}

function generateRunHtml(runDir, opts = {}) {
  const runMetaFile = path.join(runDir, "run.json");
  const runMeta = fs.existsSync(runMetaFile) ? readJsonFile(runMetaFile) : {};
  const logsFile = path.join(runDir, "logs.jsonl");
  const rawDir = path.join(runDir, "raw");
  const tokenFile = path.join(runDir, "tokens.jsonl");
  const events = readJsonl(logsFile);
  const tokens = readJsonl(tokenFile);
  const rawDumps = walkFiles(rawDir).filter((file) => file.endsWith(".json")).sort().map((file) => ({ file, data: readJsonFile(file) }));
  const rollouts = (runMeta.rollouts || []).map((item) => {
    const lines = readJsonl(item.file);
    return { ...item, lines, summary: summarizeEvents(lines) };
  });
  const summary = summarizeEvents(events);
  const turns = buildConversationTurns(rollouts);
  const html = htmlShell({
    title: "Agent Trace",
    subtitle: path.resolve(runDir),
    runMeta: {
      agent: runMeta.agent || "unknown",
      started: runMeta.started_at || "",
      finished: runMeta.finished_at || "",
      exit: runMeta.exit ? JSON.stringify(runMeta.exit) : "",
      log: fs.existsSync(logsFile) ? logsFile : "",
    },
    sections: [
      `<h2>Summary</h2><div>${Object.entries(summary.counts).map(([k, v]) => `<span class="pill">${escapeHtml(k)}: ${v}</span>`).join("") || '<span class="muted">No JSONL events.</span>'}</div>`,
      `<h2>Conversation</h2>${renderConversationTurns(turns)}`,
      `<h2>Tokens</h2>${renderTokens(tokens)}`,
      `<h2>Agent Log</h2>${events.map((event, index) => `<details ${index === 0 ? "open" : ""}><summary>${escapeHtml(event.type || event.request?.url || `event ${index + 1}`)}</summary><pre><code>${renderJson(event)}</code></pre></details>`).join("")}`,
      `<h2>Codex Rollouts</h2>${rollouts.map((rollout) => `<details><summary>${escapeHtml(rollout.file)}</summary><div style="padding:0 12px 12px">${Object.entries(rollout.summary.counts).map(([k, v]) => `<span class="pill">${escapeHtml(k)}: ${v}</span>`).join("")}</div><pre><code>${renderJson(rollout.lines)}</code></pre></details>`).join("")}`,
      `<h2>Raw Dumps</h2>${rawDumps.map((dump, index) => `<details ${index === 0 && !events.length ? "open" : ""}><summary>${escapeHtml(path.relative(runDir, dump.file))}</summary><pre><code>${renderJson(dump.data)}</code></pre></details>`).join("")}`,
    ],
  });
  const out = opts.outputFile || path.join(runDir, "report.html");
  fs.writeFileSync(out, html);
  return out;
}

function generateIndex(traceDir) {
  const root = path.resolve(traceDir);
  mkdirp(root);
  const runs = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "run.json")))
    .map((dir) => ({ dir, meta: readJsonFile(path.join(dir, "run.json")) }))
    .sort((a, b) => String(b.meta.started_at || "").localeCompare(String(a.meta.started_at || "")));
  const sections = [`<h2>Sessions</h2>${runs.map((run) => `<div class="card"><a href="${escapeHtml(path.relative(root, path.join(run.dir, "report.html")))}">${escapeHtml(path.basename(run.dir))}</a><br><span class="muted">${escapeHtml(run.meta.agent || "")} ${escapeHtml(run.meta.started_at || "")}</span></div>`).join("")}`];
  const html = htmlShell({ title: "Agent Trace Index", subtitle: root, runMeta: { sessions: runs.length }, sections });
  const out = path.join(root, "index.html");
  fs.writeFileSync(out, html);
  return out;
}

function appendNodeOption(existing, loaderPath) {
  const requireArg = `--require ${loaderPath}`;
  return existing ? `${existing} ${requireArg}` : requireArg;
}

async function runClaude(opts) {
  const startedMs = Date.now();
  const runDir = path.resolve(opts.traceDir, `trace-${stamp()}`);
  mkdirp(runDir);
  const logFile = path.join(runDir, "logs.jsonl");
  const tokenFile = path.join(runDir, "tokens.jsonl");
  const upstreamUrl = opts.upstreamUrl || process.env.CLAUDE_TRACE_API_ENDPOINT || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const proxy = await startForwardProxy({ port: opts.port, upstreamUrl, openaiUpstreamUrl: upstreamUrl, runDir, logFile, tokenFile, extractToken: opts.extractToken });
  const baseUrl = `http://127.0.0.1:${proxy.port}`;
  const env = {
    ...process.env,
    AGENT_TRACE_AGENT: "cc",
    AGENT_TRACE_RUN_DIR: runDir,
    AGENT_TRACE_LOG_FILE: logFile,
    AGENT_TRACE_TOKEN_FILE: tokenFile,
    AGENT_TRACE_INCLUDE_ALL_REQUESTS: String(opts.includeAllRequests),
    AGENT_TRACE_EXTRACT_TOKEN: String(opts.extractToken),
    ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_TRACE_API_ENDPOINT: baseUrl,
    NODE_OPTIONS: appendNodeOption(process.env.NODE_OPTIONS || "", path.join(ROOT, "src", "cc-loader.cjs")),
  };
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  console.log(`agent-trace: tracing Claude Code to ${runDir}`);
  console.log(`agent-trace: proxy listening on ${proxy.port}`);
  const child = spawn(opts.ccBin, opts.agentArgs, { cwd: process.cwd(), stdio: "inherit", env });
  let exit = { code: 1, signal: null };
  try {
    exit = await waitForExitWithSignals(child);
  } finally {
    await shutdownProxy(proxy.port).catch((error) => console.error(`agent-trace: proxy shutdown failed: ${error.message || error}`));
  }
  const meta = { agent: "cc", started_at: new Date(startedMs).toISOString(), finished_at: new Date().toISOString(), command: opts.ccBin, args: opts.agentArgs, upstream_url: upstreamUrl, base_url: baseUrl, exit, log_file: logFile, token_file: tokenFile };
  writeJson(path.join(runDir, "run.json"), meta);
  const report = generateRunHtml(runDir);
  const markdown = generateRunMarkdown(runDir);
  console.log(`agent-trace: HTML report: ${report}`);
  console.log(`agent-trace: Markdown report: ${markdown}`);
  process.exitCode = exit.code ?? signalExitCode(exit.signal);
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function readCodexAuth() {
  try {
    return JSON.parse(fs.readFileSync(path.join(codexHome(), "auth.json"), "utf8"));
  } catch {
    return null;
  }
}

function resolveCodexAuth(opts) {
  if (!["auto", "api-key", "chatgpt-login"].includes(opts.auth)) throw new Error("--auth must be one of: auto, api-key, chatgpt-login");
  if ((opts.auth === "auto" || opts.auth === "api-key") && process.env.OPENAI_API_KEY) {
    return { mode: "api-key", configKey: "openai_base_url", upstreamUrl: opts.upstreamUrl || "https://api.openai.com/v1", openaiUpstreamUrl: opts.upstreamUrl || "https://api.openai.com/v1" };
  }
  if (opts.auth === "api-key") throw new Error("OPENAI_API_KEY is required when --auth api-key is used");
  const auth = readCodexAuth();
  if (auth?.auth_mode || auth?.tokens?.access_token) {
    return { mode: "chatgpt-login", configKey: "chatgpt_base_url", upstreamUrl: opts.upstreamUrl || "https://chatgpt.com/backend-api/codex", openaiUpstreamUrl: "https://api.openai.com/v1" };
  }
  throw new Error("no usable Codex auth found: set OPENAI_API_KEY or run codex login");
}

function sanitizeHeaders(headers) {
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

function stripProxyHeaders(headers) {
  const out = { ...headers };
  for (const key of Object.keys(out)) {
    if (["accept-encoding", "connection", "host", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"].includes(key.toLowerCase())) delete out[key];
  }
  return out;
}

function responseHeadersForClient(headers) {
  const out = stripProxyHeaders(headers);
  delete out["content-encoding"];
  delete out["content-length"];
  return out;
}

function readRequestBody(req) {
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

function bodyCapture(buffer, headers) {
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

function writeJsonl(file, event) {
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
}

function writeTokenFile(file, event) {
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort.
  }
}

function routeTarget(reqUrl, upstreamUrl, openaiUpstreamUrl) {
  const text = String(reqUrl || "/");
  const base = text === "/v1" || text.startsWith("/v1/") ? new URL(openaiUpstreamUrl || upstreamUrl) : new URL(upstreamUrl);
  const target = new URL(text, base);
  if (base.pathname !== "/" && !target.pathname.startsWith(base.pathname)) target.pathname = path.posix.join(base.pathname, target.pathname);
  return target;
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

function ensureCodexMitmCerts(runDir) {
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

function startCodexMitmProxy({ port, runDir, logFile, tokenFile, extractToken, certs }) {
  let counter = 0;
  const rawDir = path.join(runDir, "raw");
  mkdirp(rawDir);
  const secureContext = tls.createSecureContext({ key: certs.key, cert: certs.cert });
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === "/shutdown") {
      res.writeHead(200).end("ok");
      for (const socket of sockets) socket.destroy();
      server.close();
      return;
    }
    res.writeHead(501).end("agent-trace MITM proxy only supports CONNECT");
  });
  server.on("connect", (req, clientSocket, head) => {
    ignoreSocketErrors(clientSocket);
    sockets.add(clientSocket);
    clientSocket.on("close", () => sockets.delete(clientSocket));
    const [host, portText = "443"] = String(req.url || "").split(":");
    const targetPort = Number(portText || 443);
    if (host !== "chatgpt.com" || targetPort !== 443) {
      connectRawTarget(host, targetPort, (upstream) => {
        ignoreSocketErrors(upstream);
        sockets.add(upstream);
        upstream.on("close", () => sockets.delete(upstream));
        safeSocketWrite(clientSocket, "HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) safeSocketWrite(upstream, head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      }, (error) => clientSocket.destroy(error));
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
          try {
            fs.writeFileSync(path.join(rawDir, `${id}.json`), JSON.stringify(event, null, 2));
            writeJsonl(logFile, event);
          } catch {
            // Best effort; process shutdown can close files underneath us.
          }
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

function startForwardProxy({ port, upstreamUrl, openaiUpstreamUrl, runDir, logFile, tokenFile, extractToken }) {
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
    const requestRecord = { timestamp: new Date(started).toISOString(), method: req.method, url: target.toString(), headers: sanitizeHeaders(req.headers), ...bodyCapture(requestBody, req.headers) };
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
    server.listen(port ? Number(port) : 0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function shutdownProxy(port) {
  await new Promise((resolve) => {
    const socket = net.connect(Number(port), "127.0.0.1", () => socket.end("GET /shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"));
    socket.on("error", resolve);
    socket.on("close", resolve);
    socket.setTimeout(1000, () => socket.destroy());
  });
}

function findRecentCodexRollouts(startMs) {
  const root = path.join(codexHome(), "sessions");
  const windowStart = startMs - 5000;
  const candidates = walkFiles(root).filter((file) => file.endsWith(".jsonl")).map((file) => {
    const stat = fs.statSync(file);
    const meta = readRolloutSessionMetaFile(file);
    return { file, mtimeMs: stat.mtimeMs, timestampMs: parseIso(meta.timestamp), meta };
  }).filter((item) => item.mtimeMs >= windowStart || (item.timestampMs != null && item.timestampMs >= windowStart));

  let roots = candidates.filter((item) => !isSubagentMeta(item.meta) && item.timestampMs != null && item.timestampMs >= windowStart);
  if (!roots.length) roots = candidates.filter((item) => !isSubagentMeta(item.meta) && item.mtimeMs >= windowStart);

  const included = [];
  const ids = new Set();
  const include = (item) => {
    if (!item || included.some((existing) => existing.file === item.file)) return;
    included.push(item);
    if (item.meta?.id) ids.add(item.meta.id);
  };
  roots.sort((a, b) => (a.timestampMs || a.mtimeMs) - (b.timestampMs || b.mtimeMs)).forEach(include);

  let changed = true;
  while (changed) {
    changed = false;
    for (const item of candidates) {
      if (!isSubagentMeta(item.meta)) continue;
      if (!ids.has(parentThreadIdFromMeta(item.meta))) continue;
      if (included.some((existing) => existing.file === item.file)) continue;
      include(item);
      changed = true;
    }
  }

  return included.sort((a, b) => (a.timestampMs || a.mtimeMs) - (b.timestampMs || b.mtimeMs)).map(({ file, mtimeMs, timestampMs }) => ({ file, mtimeMs, timestampMs }));
}

async function runCodex(opts) {
  const startedMs = Date.now();
  const runDir = path.resolve(opts.traceDir, `trace-${stamp()}`);
  mkdirp(runDir);
  const logFile = path.join(runDir, "logs.jsonl");
  const tokenFile = path.join(runDir, "tokens.jsonl");
  const auth = resolveCodexAuth(opts);
  const useLoginMitm = auth.mode === "chatgpt-login" && opts.captureModelRequests;
  const proxy = useLoginMitm
    ? await startCodexMitmProxy({ port: opts.port, runDir, logFile, tokenFile, extractToken: opts.extractToken, certs: ensureCodexMitmCerts(runDir) })
    : await startForwardProxy({ port: opts.port, upstreamUrl: auth.upstreamUrl, openaiUpstreamUrl: auth.openaiUpstreamUrl, runDir, logFile, tokenFile, extractToken: opts.extractToken });
  const baseUrl = opts.baseUrl || (auth.mode === "api-key" ? `http://127.0.0.1:${proxy.port}/v1` : `http://127.0.0.1:${proxy.port}`);
  const args = useLoginMitm ? [...opts.agentArgs] : ["-c", `${auth.configKey}="${baseUrl}"`, ...opts.agentArgs];
  const env = useLoginMitm
    ? { ...process.env, HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, ALL_PROXY: `http://127.0.0.1:${proxy.port}`, https_proxy: `http://127.0.0.1:${proxy.port}`, http_proxy: `http://127.0.0.1:${proxy.port}`, all_proxy: `http://127.0.0.1:${proxy.port}`, CODEX_CA_CERTIFICATE: proxy.caPem }
    : process.env;
  writeJson(path.join(runDir, "codex-command.json"), { command: opts.codexBin, args, auth_mode: auth.mode, capture_mode: useLoginMitm ? "https-connect-mitm" : "base-url-forward-proxy" });
  console.log(`agent-trace: proxy listening on ${proxy.port}${useLoginMitm ? " (Codex HTTPS MITM)" : ""}`);
  console.log(`agent-trace: tracing Codex to ${runDir}`);
  const child = spawn(opts.codexBin, args, { cwd: process.cwd(), stdio: "inherit", env });
  let exit = { code: 1, signal: null };
  try {
    exit = await waitForExitWithSignals(child);
  } finally {
    if (useLoginMitm && typeof proxy.destroy === "function") proxy.destroy();
    else await shutdownProxy(proxy.port).catch((error) => console.error(`agent-trace: proxy shutdown failed: ${error.message || error}`));
  }
  const meta = { agent: "codex", started_at: new Date(startedMs).toISOString(), finished_at: new Date().toISOString(), command: opts.codexBin, args, auth_mode: auth.mode, capture_mode: useLoginMitm ? "https-connect-mitm" : "base-url-forward-proxy", upstream_url: auth.upstreamUrl, openai_upstream_url: auth.openaiUpstreamUrl, base_url: useLoginMitm ? null : baseUrl, mitm_ca: useLoginMitm ? proxy.caPem : null, exit, log_file: logFile, token_file: tokenFile, rollouts: findRecentCodexRollouts(startedMs) };
  writeJson(path.join(runDir, "run.json"), meta);
  const report = generateRunHtml(runDir);
  const markdown = generateRunMarkdown(runDir);
  console.log(`agent-trace: HTML report: ${report}`);
  console.log(`agent-trace: Markdown report: ${markdown}`);
  process.exitCode = exit.code ?? signalExitCode(exit.signal);
}

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) return usage();
  if (opts.generateHtml) {
    if (fs.existsSync(opts.generateHtml) && fs.statSync(opts.generateHtml).isDirectory()) {
      console.log(`HTML report: ${generateRunHtml(opts.generateHtml, { outputFile: opts.htmlOut || path.join(opts.generateHtml, "report.html") })}`);
      return;
    }
    const out = opts.htmlOut || opts.generateHtml.replace(/\.jsonl$/i, ".html");
    console.log(`HTML report: ${generateHtmlFromJsonl(opts.generateHtml, out, opts)}`);
    return;
  }
  if (opts.generateMd) {
    if (fs.existsSync(opts.generateMd) && fs.statSync(opts.generateMd).isDirectory()) {
      console.log(`Markdown report: ${generateRunMarkdown(opts.generateMd, { outputFile: opts.mdOut || path.join(opts.generateMd, "report.md") })}`);
      return;
    }
    const out = opts.mdOut || opts.generateMd.replace(/\.jsonl$/i, ".md");
    console.log(`Markdown report: ${generateMarkdownFromJsonl(opts.generateMd, out, opts)}`);
    return;
  }
  if (opts.exportTrainingJsonl) {
    const out = opts.trainingOut || path.join(opts.exportTrainingJsonl, "training.jsonl");
    const result = exportTrainingJsonl(opts.exportTrainingJsonl, out, opts);
    console.log(`Training JSONL: ${result.outputFile}`);
    console.log(`Training records: ${result.records.length}`);
    if (!opts.includeSensitive) console.log("Sensitive header-like fields were redacted. Use --include-sensitive only for private, trusted datasets.");
    return;
  }
  if (opts.validateTrace) {
    const report = validateTrace(opts.validateTrace);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (opts.index) {
    console.log(`Index: ${generateIndex(opts.traceDir)}`);
    return;
  }
  if (opts.agent === "codex") return runCodex(opts);
  return runClaude(opts);
}

try {
  if (!(await relaunchWithNodeEnvProxyIfNeeded())) {
    await main();
  }
} catch (error) {
  console.error(`agent-trace: ${error.message}`);
  process.exit(1);
}
