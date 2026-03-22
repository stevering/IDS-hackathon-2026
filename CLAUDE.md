# DS AI Guardian Project Instructions

When you have to write code in the monorepo or show a snippet of code, you must do it in full English language (comments, code).

In any AI chat, discuss in the user language, based on the user messages, ignoring snippets of code or logs (probably in English).

Each time you modify a file, you have to update the documentation in:
- `docs/architectures/*.md`

## Dev environment

- `pnpm dev` logs are written live to `logs/dev.log` at project root. Always check this file to verify server restarts, hot reloads, or errors — don't ask the user to paste terminal output.
- The Temporal worker (`@guardian/temporal`) bundles workflows via webpack at startup. Changes in `packages/orchestrations/src/` trigger an auto-restart thanks to `--watch-path` in the dev script.

If you need a temprary directory for operations, create one here in the project root, in `tmp/`.

- Activities in `packages/temporal/src/activities/` are NOT hot-reloaded — the Temporal worker must be restarted to pick up changes.

## LLM call delegation (dev-only)

When the user enables "LLM call delegation" in Account > Developers, orchestration LLM calls are delegated to you. You act as the LLM instead of the AI provider.

### Method: `scripts/intercept.sh` (direct curl PostgREST — ~0.1s per call)

**NEVER use `mcp__supabase__execute_sql` for intercepts** — it goes through the Management API (~5s). The script uses direct curl to PostgREST (~0.1s).

### Flow

1. Launch `./scripts/intercept.sh pollwait` in background (`run_in_background=true`, `timeout=600000`)
2. When notified, read the output file — it lists pending intercepts
3. Write response JSON files in `tmp/` using the Write tool (multiple files in parallel)
4. Respond using `batch` (runs all sub-commands in parallel internally):
   ```bash
   ./scripts/intercept.sh batch "send id1 tmp/f1.json" "ack id2 msg" "done id3 summary"
   ```
5. Repeat from step 1

### Rules

- **Use `batch`** for all responses: one tool call, parallel internally. Never use `&` in bash (triggers security prompt).
- **MANDATORY: Use the Write tool** for ALL JSON response files. **NEVER use `cat`, heredoc (`<<`), or `echo`** in Bash to create JSON files — heredocs with JSON braces trigger security prompts ("expansion obfuscation") that the user must manually approve every time. The Write tool creates files silently with no approval needed.
- **Write JSON files in parallel** too (multiple Write tool calls in same message).
- **Unique test directory**: at the START of each interception session, create a unique directory `tmp/<orchestration-id>/` (e.g. `tmp/orch-6285962c-1773965776732/`). Write ALL response JSON files and payload files into this directory. This keeps tests isolated and avoids "File has not been read yet" errors from leftover files.
- **Unique file names per intercept**: name each response file after the intercept ID it responds to: `tmp/<orch-id>/<intercept-id>.json` (e.g. `tmp/orch-xxx/intercept-1773966111373-spkl.json`). NEVER reuse a filename within a session — each intercept gets its own file. This prevents Write tool errors from file-already-exists and makes debugging easier.
- **`pollwait`** replaces `poll` and `listen`. It checks DB first (catches SSE gap), then waits for SSE push (no polling).
- **Always relaunch `pollwait`** after responding.
- **Temp files in `tmp/<orch-id>/`** (repo), never `/tmp/` (system).

### Script commands

```
pollwait                     — block until pending (DB check + SSE push). Use this.
approve <id> [<id>...]       — APPROVED (code_review, batch)
verify <id> [<id>...]        — VERIFIED (file_review, batch)
done <id> "summary"          — signal_task_complete
markdone <id> #agent         — mark_agent_done
ack <id> "message"           — orchestrator text-only ack
send <id> <file.json>        — respond with JSON file (for toolCalls)
poll                         — instant check (no wait)
status                       — recent intercept timeline
```

### Response formats

- code_review: `approve <id>` → responds `APPROVED`
- file_review: `verify <id>` → responds `VERIFIED`
- agent/orchestrator: `send <id> <file.json>` → responds with JSON content + toolCalls

### JSON file format for `send`

The `send` command does a PostgREST PATCH. The JSON file **must** have this exact structure:

```json
{
  "status": "responded",
  "response_content": "text message here",
  "response_tool_calls": [
    { "id": "tc-1", "name": "tool_name", "arguments": { "key": "value" } }
  ],
  "responded_by": "claude_code_sse",
  "responded_at": "2026-03-19T10:00:00Z"
}
```

**Format rules:**
- `arguments` (NOT `input`) for tool calls
- `response_tool_calls` is a JSONB array — use `[]` if no tool calls
- `responded_at` in ISO 8601 format
- Missing any of `status`/`responded_by` → 400 error

### CRITICAL: You ARE the LLM — generate real responses, not acks

When intercepting, you **replace** the AI provider. You must respond with intelligent content and toolCalls.

**NEVER respond with just "OK" or simple acks to `purpose=orchestrator` or `purpose=agent` intercepts.**
This creates empty message loops where the orchestrator broadcasts your "OK" to agents, agents reply "OK"
back, and nothing ever gets done. No Figma components get created.

### How to respond by purpose

**`purpose=orchestrator`** — You are the orchestrator's brain. Respond with toolCalls to coordinate:

Orchestrator tools (exact parameter names from `orchestrator-logic.ts`):
- `send_agent_directive` — params: `agentShortId` (required), **`content`** (required, NOT `directive`), `expectedResult` (optional)
- `mark_agent_done` — params: `agentShortId`
- `broadcast_to_agents` — params: `message`

Example (`tmp/orch-directives.json`):
```json
{
  "status": "responded",
  "response_content": "Assigning tasks to both agents.",
  "response_tool_calls": [
    {
      "id": "tc1",
      "name": "send_agent_directive",
      "arguments": {
        "agentShortId": "#Figma-Desktop-vopope",
        "content": "Create a Color Palette frame with 3 swatches (Primary #2563EB, Secondary #7C3AED, Neutral #6B7280). Each = 80x80 rect + label. Use figma_plugin_execute."
      }
    },
    {
      "id": "tc2",
      "name": "send_agent_directive",
      "arguments": {
        "agentShortId": "#Figma-Desktop-sudode",
        "content": "Create a Button set with Primary (blue fill, white text) and Secondary (white fill, blue stroke). Each 140x44. Use figma_plugin_execute."
      }
    }
  ],
  "responded_by": "claude_code_sse",
  "responded_at": "2026-03-19T10:00:00Z"
}
```

**`purpose=agent`** — You are the agent's brain. Respond with toolCalls to execute Figma code:

Agent tools: `figma_plugin_execute` (params: `code`), `signal_task_complete` (params: `summary`),
`send_peer_message`, `broadcast_message`, `start_sub_conversation`.

Example (`tmp/agent-colors.json`):
```json
{
  "status": "responded",
  "response_content": "Creating the color palette.",
  "response_tool_calls": [
    {
      "id": "tc1",
      "name": "figma_plugin_execute",
      "arguments": {
        "code": "await figma.loadFontAsync({family:'Inter',style:'Regular'});\nconst f=figma.createFrame(); f.name='Colors'; f.layoutMode='VERTICAL'; /* ... */\nreturn {success:true};"
      }
    }
  ],
  "responded_by": "claude_code_sse",
  "responded_at": "2026-03-19T10:00:00Z"
}
```

**`purpose=code_review`** — Read the code in the payload. If correct: `approve <id>`. If wrong: `REJECTED: <reason>`.
**`purpose=file_review`** — Read the execution result in the payload. If correct: `verify <id>`. If wrong: `ISSUE: <description>`.

### Orchestrator state machine — adapt response to conversation state

The orchestrator loops with different states. **Do NOT re-send the same directives every time.**

| Conversation state | What to respond |
|---|---|
| 2 messages (system + user "New orchestration started") | `send_agent_directive` for each agent |
| Tool results from `send_agent_directive` OK | Ack text: "Directives sent, waiting for agents." |
| Agent reports "task complete" in conversation | `mark_agent_done` for completed agents |
| All agents marked done | Final summary text (ack) |

### Orchestration lifecycle (typical cycle, but NOT rigid)

```
1. orchestrator (init)     → send_agent_directive per agent
2. agent step 0 (briefing) → figma_plugin_execute (Figma code)
3. code_review             → read code, then approve/reject
4. file_review             → read result, then verify/issue
5. agent step N (post-exec)→ signal_task_complete
6. orchestrator (loop)     → mark_agent_done per completed agent
7. orchestrator (final)    → ack with summary text
8. 0 pending               → orchestration done
```

**This cycle is NOT always linear.** The orchestrator can send multiple directives
to the same agent (e.g., "create colors" then "now add typography"). An `agent` step N
might be a NEW directive requiring `figma_plugin_execute`, not always `signal_task_complete`.

### MANDATORY: Read the payload files before responding

When `poll`/`pollwait` runs, it outputs a **summary line** per intercept AND writes the **full payload**
to `tmp/<request_id>.payload.json`. Always read the payload file before responding.

**Stdout** (summary for quick scanning):
```
intercept-id | purpose | agent | step N | directive: ... | last_msg: ...
[PAYLOADS] Full payloads written to tmp/<request_id>.payload.json — read these before responding
```

**Payload file** (`tmp/<request_id>.payload.json`) contains:
```json
{
  "purpose": "agent",
  "agent": "#Figma-Desktop-vopope",
  "step": "2",
  "directive": "Create a Color Palette...",
  "exec_stats": { "success": 1, "fail": 0 },
  "messages": [ /* full conversation history */ ],
  "tools": [ /* available tool definitions */ ]
}
```

**Read the payload file** (via the Read tool) to decide how to respond:
- `purpose=agent`: check `messages[-1]` — is it `[Orchestrator task] ...` (→ new task, `figma_plugin_execute`) or a `tool_result` (→ `signal_task_complete`)?
- `purpose=orchestrator`: check last messages — agent reports? tool results? Adapt response accordingly.
- `purpose=code_review`: read the **code** in the messages — is it correct? Then `approve` or `REJECTED`.
- `purpose=file_review`: read the **execution result** and diff — is it correct? Then `verify` or `ISSUE`.

### Interception workflow

1. Launch `pollwait` in background
2. **While waiting**: pre-write JSON response files in `tmp/` for expected intercepts (agent code, orchestrator directives). This way you can respond faster when intercepts arrive.
3. When intercepts arrive, **read the payload of each** to understand the context
4. Route each intercept to the right response based on purpose + payload content
5. Respond via `batch`:
   ```bash
   ./scripts/intercept.sh batch "send orch-id tmp/orch.json" "send agent1-id tmp/a1.json" "approve review-id"
   ```
6. Relaunch `pollwait`
7. Between each cycle, tell the user what happened and what's expected next

### Timeouts and slow mode

| Mode | Timeout per LLM call | Orchestration timeout |
|---|---|---|
| Normal | 120 seconds | Default workflow |
| Slow (`devSlowDelegation`) | **30 minutes** | **4 hours** |

Slow mode is enabled in Account > Developers > "Slow delegation".

**Recommendation**: always enable slow mode when Claude Code does interception — reading payloads +
writing JSON + sending easily exceeds 120s.

## Orchestration LLM interception (dev-only)

When using `start_collab` to launch multi-agent orchestrations, you can optionally intercept and respond to all LLM calls made by agents and the orchestrator (code reviews, file reviews, agent briefing, etc.). This allows you to act as the LLM provider instead of the platform's AI.

### When to offer interception

After calling `start_collab`, **ask the user** if they want to enable LLM interception. Do not automatically start interception — it is opt-in.

### How to intercept (if user accepts)

1. Launch `./scripts/intercept.sh pollwait` in background (`run_in_background=true`, `timeout=600000`)
2. When intercepts arrive, respond immediately — use pre-written JSON files when possible
3. Generate real LLM responses with toolCalls — **do NOT just ack with "OK"**
4. Write JSON response files in `tmp/` using the Write tool (parallel)
5. Respond using `batch`:
   ```bash
   ./scripts/intercept.sh batch "send id1 tmp/response.json" "approve id2" "verify id3"
   ```
6. Relaunch `pollwait` after responding to continue intercepting

**See sections above** for JSON format, tool parameters, orchestrator state machine, and lifecycle.

### When not to intercept

If the user declines interception, the orchestration runs with the platform's default AI provider. Agents and orchestrator proceed without human intervention on LLM calls.