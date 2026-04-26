import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const cli = path.join(root, "bin", "agent-trace.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trace-smoke-"));
const trace = path.join(tmp, "trace");
const rollouts = path.join(tmp, "rollouts");
const raw = path.join(trace, "raw");
fs.mkdirSync(trace, { recursive: true });
fs.mkdirSync(rollouts, { recursive: true });
fs.mkdirSync(raw, { recursive: true });

const mainRollout = path.join(rollouts, "main.jsonl");
const subRollout = path.join(rollouts, "sub.jsonl");
const mainId = "main-thread";
const subId = "sub-thread";

function writeJsonl(file, rows) {
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

writeJsonl(mainRollout, [
  { type: "session_meta", timestamp: "2026-04-26T00:00:00.000Z", payload: { id: mainId, timestamp: "2026-04-26T00:00:00.000Z", source: "exec", cwd: tmp, base_instructions: { text: "system prompt" } } },
  { type: "turn_context", timestamp: "2026-04-26T00:00:00.100Z", payload: { turn_id: "turn-1", cwd: tmp, model: "gpt-test", collaboration_mode: { mode: "default", settings: { developer_instructions: "developer prompt" } } } },
  { type: "event_msg", timestamp: "2026-04-26T00:00:00.200Z", payload: { type: "user_message", message: "change value and inspect files" } },
  { type: "response_item", timestamp: "2026-04-26T00:00:00.300Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "change value and inspect files" }] } },
  { type: "response_item", timestamp: "2026-04-26T00:00:01.000Z", payload: { type: "function_call", call_id: "call-exec", name: "exec_command", arguments: "{\"cmd\":\"rg --files\"}" } },
  { type: "response_item", timestamp: "2026-04-26T00:00:01.100Z", payload: { type: "function_call_output", call_id: "call-exec", output: "{\"content\":\"index.js\\n\"}" } },
  { type: "response_item", timestamp: "2026-04-26T00:00:02.000Z", payload: { type: "custom_tool_call", call_id: "call-patch", name: "apply_patch", input: "*** Begin Patch\n*** Update File: index.js\n@@\n-export const value = 1;\n+export const value = 2;\n*** End Patch\n" } },
  { type: "response_item", timestamp: "2026-04-26T00:00:02.100Z", payload: { type: "custom_tool_call_output", call_id: "call-patch", output: "{\"output\":\"Success. Updated the following files:\\nM index.js\\n\",\"metadata\":{\"exit_code\":0}}" } },
  { type: "response_item", timestamp: "2026-04-26T00:00:03.000Z", payload: { type: "function_call", call_id: "call-spawn", name: "spawn_agent", arguments: "{\"agent_type\":\"explorer\",\"message\":\"inspect final files\"}" } },
  { type: "response_item", timestamp: "2026-04-26T00:00:03.100Z", payload: { type: "function_call_output", call_id: "call-spawn", output: "{\"content\":\"{\\\"agent_id\\\":\\\"sub-thread\\\",\\\"nickname\\\":\\\"Ada\\\"}\"}" } },
  { type: "response_item", timestamp: "2026-04-26T00:00:04.000Z", payload: { type: "function_call", call_id: "call-wait", name: "wait_agent", arguments: "{\"targets\":[\"sub-thread\"]}" } },
  { type: "response_item", timestamp: "2026-04-26T00:00:04.100Z", payload: { type: "function_call_output", call_id: "call-wait", output: "{\"content\":\"completed\"}" } },
  { type: "event_msg", timestamp: "2026-04-26T00:00:05.000Z", payload: { type: "agent_message", message: "Done.", phase: "final" } },
  { type: "event_msg", timestamp: "2026-04-26T00:00:05.100Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, total_tokens: 12 }, total_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, total_tokens: 12 }, model_context_window: 1000 } } },
  { type: "event_msg", timestamp: "2026-04-26T00:00:05.200Z", payload: { type: "task_complete", duration_ms: 5000, time_to_first_token_ms: 800 } },
]);

writeJsonl(subRollout, [
  { type: "session_meta", timestamp: "2026-04-26T00:00:03.200Z", payload: { id: subId, timestamp: "2026-04-26T00:00:03.200Z", source: { subagent: { thread_spawn: { parent_thread_id: mainId, agent_nickname: "Ada", agent_role: "explorer" } } }, cwd: tmp, base_instructions: { text: "sub system" } } },
  { type: "turn_context", timestamp: "2026-04-26T00:00:03.300Z", payload: { turn_id: "sub-turn", cwd: tmp, model: "gpt-test" } },
  { type: "event_msg", timestamp: "2026-04-26T00:00:03.400Z", payload: { type: "user_message", message: "inspect final files" } },
  { type: "response_item", timestamp: "2026-04-26T00:00:03.500Z", payload: { type: "function_call", call_id: "sub-exec", name: "exec_command", arguments: "{\"cmd\":\"rg --files\"}" } },
  { type: "response_item", timestamp: "2026-04-26T00:00:03.600Z", payload: { type: "function_call_output", call_id: "sub-exec", output: "{\"content\":\"index.js\\n\"}" } },
  { type: "event_msg", timestamp: "2026-04-26T00:00:03.900Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 1, total_tokens: 6 }, total_token_usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 1, total_tokens: 6 }, model_context_window: 1000 } } },
  { type: "event_msg", timestamp: "2026-04-26T00:00:04.000Z", payload: { type: "task_complete", duration_ms: 700, time_to_first_token_ms: 100 } },
]);

const event = {
  type: "api_pair",
  request: {
    timestamp: "2026-04-26T00:00:01.500Z",
    method: "POST",
    url: "https://chatgpt.com/backend-api/codex/test",
    headers: { authorization: "Bearer real-secret-token", "content-type": "application/json" },
    body: { messages: [{ role: "user", content: "hello" }] },
  },
  response: { status_code: 200, headers: {}, body: { ok: true } },
  duration_ms: 42,
};
writeJsonl(path.join(trace, "logs.jsonl"), [event]);
fs.writeFileSync(path.join(raw, "000001.json"), JSON.stringify(event, null, 2));
writeJsonl(path.join(trace, "tokens.jsonl"), [{ header: "authorization", value: "Bearer real-secret-token", preview: "Bearer r...oken" }]);
fs.writeFileSync(path.join(trace, "run.json"), JSON.stringify({ agent: "codex", started_at: "2026-04-26T00:00:00.000Z", finished_at: "2026-04-26T00:00:06.000Z", command: "codex", args: [], rollouts: [{ file: mainRollout }, { file: subRollout }] }, null, 2));

execFileSync(process.execPath, [cli, "--generate-md", trace], { stdio: "pipe" });
execFileSync(process.execPath, [cli, "--export-training-jsonl", trace], { stdio: "pipe" });
const validation = JSON.parse(execFileSync(process.execPath, [cli, "--validate-trace", trace], { encoding: "utf8" }));

const report = fs.readFileSync(path.join(trace, "report.md"), "utf8");
const training = fs.readFileSync(path.join(trace, "training.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(validation.ok, `validation failed: ${JSON.stringify(validation)}`);
assert(report.includes("## Trace Summary"), "report missing trace summary");
assert(report.includes("**Tool: apply_patch**"), "report missing apply_patch");
assert(report.includes("```diff"), "report missing diff block");
assert(report.includes("[→ Subagent: Ada]"), "report missing subagent link");
assert(training.length === 2, "training export should include main and subagent turns");
assert(training[0].tool_calls.some((call) => call.name === "apply_patch" && call.is_edit), "training export missing edit tool");
assert(JSON.stringify(training).includes("Bearer r...oken"), "training export should keep token preview");
assert(!JSON.stringify(training).includes("real-secret-token"), "training export leaked secret token");

console.log(`smoke ok: ${trace}`);
