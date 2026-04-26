# agent-trace

Trace Claude Code and Codex CLI sessions, keep local JSON artifacts, and generate self-contained HTML and Markdown reports.

The CLI is intentionally shaped like `claude-trace`, but it supports both agents:

```sh
agent-trace cc
agent-trace codex
```

`agent-trace cc` runs Claude Code through a local forwarding proxy by setting `ANTHROPIC_BASE_URL`, then writes request/response pairs to JSONL. A Node loader is still injected as a fallback for older Node-based Claude Code builds, but current native Claude Code builds are captured by the proxy.

`agent-trace codex` uses a local forwarding proxy because Codex CLI is a native binary. It points Codex at `chatgpt_base_url` when you are logged in with `codex login`, or `openai_base_url` when `OPENAI_API_KEY` is present.

## Install

From this repository:

```sh
npm install -g .
```

During development:

```sh
node ./bin/agent-trace.js --help
```

## Claude Code

Use your Claude Code proxy endpoint if needed:

```sh
export CLAUDE_TRACE_API_ENDPOINT=http://localhost:8082
```

Start Claude Code and record traffic:

```sh
agent-trace cc
```

Run a one-shot Claude Code prompt and record traffic:

```sh
agent-trace cc -- -p "explain this repo" --model sonnet
```

Record all API requests:

```sh
agent-trace cc --include-all-requests
```

Run Claude with arguments:

```sh
agent-trace cc --run-with chat --model sonnet-3.5
```

Extract auth headers seen in Claude Code API traffic:

```sh
agent-trace cc --extract-token
```

`agent-trace` without a subcommand defaults to `cc`, so this also works:

```sh
agent-trace --include-all-requests
```

## Codex

Start Codex and record traffic:

```sh
agent-trace codex
```

Capture auth headers into `tokens.jsonl` while showing only safe previews unless token extraction is enabled:

```sh
agent-trace codex --extract-token
```

When `--extract-token` is used, `report.html` and `report.md` render the full captured auth header value in the auth section. Treat the reports as sensitive.

Pass normal Codex arguments after `--`:

```sh
agent-trace codex -- -C /path/to/repo --search "find the parser entry point"
```

Force ChatGPT login mode:

```sh
agent-trace codex --auth chatgpt-login
```

Force API-key mode:

```sh
export OPENAI_API_KEY=...
agent-trace codex --auth api-key
```

Override proxy URLs when Codex changes provider paths:

```sh
agent-trace codex --base-url http://127.0.0.1:5055 --upstream-url https://chatgpt.com/backend-api/codex
```

Experimental: also proxy `openai_base_url` to try to capture the main Responses API WebSocket:

```sh
agent-trace codex --capture-model-requests --extract-token
```

For ChatGPT-login Codex sessions this may fail if the login token is not accepted by the public Responses API endpoint. The default Codex mode keeps the session working and visualizes the Codex rollout JSONL, including model messages and token usage.

## Reports

Trace runs are written to `.agent-trace/trace-YYYY-MM-DD-HH-MM-SS/`.

Each run includes:

- `logs.jsonl`: normalized trace events
- `tokens.jsonl`: captured auth headers when `--extract-token` is used; file mode is set to `0600`
- `raw/*.json`: raw Codex proxy dumps when using Codex mode
- `run.json`: command and session metadata
- `report.html`: self-contained browser report
- `report.md`: Markdown report for reading, search, and sharing inside private tooling
- `subagent-*.md`: separate Markdown pages for subagent conversations, linked from `report.md`

The Markdown report follows the `cc2md` conversation shape: session header, `## Codex Metadata`, repeated `## User` / `## Assistant` blocks, `**Tool: name**` tool calls, collapsible tool results, and fenced `diff` blocks for edit-like tools. User input stays prominent in the normal `## User` blocks. `agent-trace` adds richer per-turn `<details>` sections with timing, model token usage, cached token usage, the exact prompt messages sent to the agent, folded system/developer/environment context, raw turn context, captured API requests, and captured auth headers. Captured requests are rendered as Markdown overview tables plus per-request details for method, URL, status, duration, headers, body, response, and complete raw JSON. The final `Captured Request Log` section contains every normalized `logs.jsonl` event and every raw `raw/*.json` dump so startup requests and unmatched proxy traffic are not lost.

Generate HTML from a JSONL log:

```sh
agent-trace --generate-html logs.jsonl report.html
```

Generate Markdown from a trace directory:

```sh
agent-trace --generate-md .agent-trace/trace-YYYY-MM-DD-HH-MM-SS
```

Generate Markdown from a JSONL log:

```sh
agent-trace --generate-md logs.jsonl report.md
```

Include all requests in a generated HTML report:

```sh
agent-trace --generate-html logs.jsonl report.html --include-all-requests
```

Generate an index for all local runs:

```sh
agent-trace --index
```

The index is written to:

```sh
.agent-trace/index.html
```

## Validation and Training Export

Validate that a trace has the expected files, readable Codex rollouts, reconstructed turns, token usage, tool calls, edit calls, and subagent links:

```sh
agent-trace --validate-trace .agent-trace/trace-YYYY-MM-DD-HH-MM-SS
```

Export a structured JSONL dataset for downstream training or fine-tuning preprocessing:

```sh
agent-trace --export-training-jsonl .agent-trace/trace-YYYY-MM-DD-HH-MM-SS
```

The export writes `training.jsonl`. Each row is one reconstructed turn and includes:

- trace/session metadata, including subagent parent thread IDs
- exact prompt messages sent to the agent, including system/developer/user messages when available
- assistant text and structured assistant parts
- tool calls, tool inputs, tool outputs, and whether the tool is an edit tool
- per-turn and cumulative model token usage, including cached input tokens
- timing fields such as turn duration and time to first token
- captured API request/response events linked to the turn
- `rollout_index` fields that point back to the exact Codex rollout JSONL line order

Training export redacts sensitive header-like fields by default, including `authorization`, cookies, API keys, and token fields. For a fully private, controlled dataset you can opt into the unredacted export:

```sh
agent-trace --export-training-jsonl .agent-trace/trace-YYYY-MM-DD-HH-MM-SS training.full.jsonl --include-sensitive
```

Treat unredacted exports as secrets.

For Codex login-mode sessions, `agent-trace` treats Codex rollout `response_item.message` entries as the authoritative recorded model input and rollout `agent_message` / tool events as the authoritative recorded output stream. The local proxy still captures HTTP requests it can see, but the raw model HTTP payload is only marked as captured when `/v1/responses` or `/v1/chat/completions` traffic is actually present. Check `trace.provenance.raw_model_http_request_captured` in `training.jsonl`.

## Notes

- Trace output can contain prompts, code, file contents, tool output, and model responses. Treat `.agent-trace/` as private.
- Claude Code tracing uses a local Anthropic-compatible forwarding proxy and sets `ANTHROPIC_BASE_URL` for the launched process. `CLAUDE_TRACE_API_ENDPOINT` or `--upstream-url` can point that proxy at another Anthropic-compatible upstream.
- Codex tracing works for logged-in use by routing `chatgpt_base_url` through a local loopback proxy. The main model request is also represented via Codex's rollout JSONL. Full raw main Responses API proxying is experimental because login-mode Codex may use credentials that are not accepted by the public API endpoint when `openai_base_url` is overridden.
- `--extract-token` writes sensitive headers to `tokens.jsonl` and renders them in `report.html` and `report.md`. Use it only in a private terminal and do not publish trace artifacts.
