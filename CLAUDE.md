# DS AI Guardian Project Instructions

When you have to write code in the monorepo or show a snippet of code, you must do it in full English language (comments, code).

In any AI chat, discuss in the user language, based on the user messages, ignoring snippets of code or logs (probably in English).

When you need to change the UIs:
- the UI is a viewer, always ask yourself if the change is to be made in the backend or in the frontend.
- everything the user can do with the UI has to be available in the backend (via API or MCP)
- always use the already developed components and ask for building a new one or update an existing one.

Each time you modify a file, you have to update the documentation in:
- `docs/architecture/*.md`

Each time you modify a file, if something changed and impacts the `README.md`, you have to update the documentation in:
- `README.md`

Backlog and TODOs are in `internal/docs/backlog/*`.

## Dev environment

### Two Supabase environments — don't confuse them

| | Local (Docker) | Cloud (prod/preview) |
|---|---|---|
| **What** | Supabase running in Docker via `supabase start` | Supabase project `ookghxkvzdnqicjdslej` (eu-west-3) |
| **Used by** | `pnpm dev` (local development) | Vercel deployments (preview + production) |
| **Container** | `supabase_db_IDS-hackathon-2026` | N/A |
| **Apply SQL** | `docker exec -i supabase_db_IDS-hackathon-2026 psql -U postgres -d postgres < file.sql` | `mcp__supabase__apply_migration` (MCP tool) |

**Important**:
- The MCP Supabase tools (`mcp__supabase__*`) **always target cloud** — they cannot reach the local Docker DB.
- To apply SQL on local Docker, use `docker exec ... psql` via Bash.
- **NEVER use `mcp__supabase__apply_migration` when the user says "local" or "test locally"** — it will apply to cloud/prod.
- When in doubt, ask: "Local Docker or cloud Supabase?"
- **After `supabase db reset`**: re-apply the vault fix. On local Docker, `postgres` is not superuser — vault RPCs must be owned by `supabase_admin`:
  ```bash
  docker exec -i supabase_db_IDS-hackathon-2026 psql -h 127.0.0.1 -U supabase_admin -d postgres < supabase/local-only/fix-vault-ownership.sql
  ```
- **Applying migrations locally**: use `supabase_admin` for vault-related SQL, `postgres` for the rest:
  ```bash
  # Regular migrations (no vault)
  docker exec -i supabase_db_IDS-hackathon-2026 psql -U postgres -d postgres < supabase/migrations/XXX.sql
  # Vault-related migrations (needs superuser)
  docker exec -i supabase_db_IDS-hackathon-2026 psql -h 127.0.0.1 -U supabase_admin -d postgres < supabase/migrations/XXX.sql
  ```

### Deploy to preview procedure

When pushing code that includes DB migrations, follow this order:

1. **Backward compatibility check** (MANDATORY before any push):
   - Does the OLD deployed code still work after applying the new migration?
   - Does the NEW code handle old data gracefully (missing JSONB fields, old column values)?
   - If rollback needed, does the new schema still work with the old code?
   - If any answer is "no" → split into expand + contract migrations (see "Backward compatibility" section above).

2. **Check for pending migrations**:
   ```bash
   ls supabase/migrations/*.sql  # compare with what's applied in prod
   ```

3. **Apply migrations to cloud FIRST** (before code deploy):
   ```
   mcp__supabase__apply_migration(project_id="ookghxkvzdnqicjdslej", name="...", query="...")
   ```
   - If migration drops/replaces RPCs (e.g., `upsert_api_key` → `insert_api_key`), the old preview will break briefly until the new code is deployed.
   - For breaking migrations: apply migration + push code as close together as possible.

4. **Push the code** (Vercel auto-deploys preview):
   ```bash
   git push origin feat/preview
   ```

5. **Verify preview** after deploy completes:
   - Check the preview URL
   - Test the affected features (account page, chat, etc.)

**Important rules**:
- **NEVER write a `try{} catch{}` without logging the error in the `catch`
- **NEVER apply `supabase/local-only/*` to cloud** — those are local Docker workarounds only.
- **Migration order matters**: if migration N+1 depends on N, apply them sequentially.
- **Rétrocompatibilité**: prefer `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP IF EXISTS` to avoid errors if re-applied.
- **Breaking RPCs**: if a migration changes a function signature (e.g., `delete_api_key(TEXT)` → `delete_api_key(UUID)`), always `DROP` the old signature first to avoid overload ambiguity.
- **Vault access**: NEVER use `INSERT INTO vault.secrets` — use `SELECT vault.create_secret(secret)` instead. NEVER use `DELETE FROM vault.secrets` + re-insert — use `PERFORM vault.update_secret(id, new_secret)`. Direct vault table access fails with "permission denied for function _crypto_aead_det_noncegen" because `postgres` is not superuser on Supabase cloud. The `vault.create_secret()` and `vault.update_secret()` functions are owned by `supabase_admin` (SECURITY DEFINER) and bypass this restriction.

### Backward compatibility — "expand then contract"

Every change to DB schema, RPCs, or stored data formats (JSONB fields, etc.) MUST be backward-compatible with the currently deployed code. The old code and the new code will coexist briefly during deploys.

**Golden rule: expand first, contract later.**

| Operation | Safe pattern | Dangerous pattern |
|---|---|---|
| **Add column** | `ADD COLUMN ... DEFAULT NULL` or `DEFAULT '{}'` | `ADD COLUMN ... NOT NULL` (breaks old rows) |
| **Add JSONB field** | Just write it — old rows have `{}`, read with `?.field ?? null` | Requiring the field without fallback |
| **Rename column** | Add new → write both → backfill → drop old (2 migrations) | `ALTER TABLE RENAME COLUMN` (breaks old code) |
| **Change column type** | Add new col → dual-write → backfill → drop old | `ALTER COLUMN TYPE` (breaks old code) |
| **Drop column** | Stop reading/writing in code → deploy → then `DROP COLUMN` | `DROP COLUMN` while code still SELECTs it |
| **Change RPC signature** | `DROP old_sig` + `CREATE new_sig` in same migration | `CREATE OR REPLACE` with different params (creates overload) |
| **Replace RPC** | Migration N: create new (old still works) → Migration N+1: drop old | Drop + create in one migration (brief downtime) |

**Reading stored data defensively:**
- JSONB: always `metadata?.field ?? fallback` — never assume a field exists
- If you rename a JSONB key (e.g., `keyHint` → `key_hint`), read both: `metadata?.key_hint ?? metadata?.keyHint ?? null`
- Columns: `SELECT col` on a dropped column = crash. Always drop code references first.

**Before every push to preview or prod, verify:**
1. Can the OLD deployed code work with the NEW database schema? (migration applied before code deploys)
2. Can the NEW code work with data written by the OLD code? (old rows, old JSONB shapes)
3. If we need to rollback the code, does the NEW schema still work with the OLD code?

If any answer is "no", split into two migrations (expand, then contract after old code is gone).

### Rollback procedure

- **Code rollback**: revert the commit and push, or promote an older Vercel deployment.
- **DB rollback**: migrations are NOT auto-reversible. Two strategies:
  1. **Preferred (future)**: never `DROP` an old RPC in the same migration that creates its replacement. Use two migrations:
     - Migration N: create new RPC (old still exists, both work)
     - Migration N+1 (after old code is gone from all deployments): drop old RPC
  2. **Emergency**: manually re-create the old RPCs via `mcp__supabase__apply_migration`.
- **If both code + DB need rollback**: rollback DB first (re-create old RPCs), then rollback code.

- `pnpm dev` logs are written live to `logs/dev.log` at project root. Always check this file to verify server restarts, hot reloads, or errors — don't ask the user to paste terminal output.
- The Temporal worker (`@guardian/temporal`) uses `tsx --watch` with two watch paths: `src/` and `../orchestrations/src/`. Changes in either path auto-restart the worker (workflows, activities, and engine logic are all picked up).
  - **Important**: do NOT switch back to `node --watch --import tsx/esm` — it has a bug where `--watch` and `--watch-path` flags are not propagated to the respawned child, so the worker only restarts once then stops watching.

If you need a temprary directory for operations, create one here in the project root, in `tmp/`.

## Patched dependencies

### `@ai-sdk/mcp@1.0.36` — MCP protocol version header downgrade

Local patch: `patches/@ai-sdk__mcp@1.0.36.patch` (wired through `pnpm.patchedDependencies` in the root `package.json`).

**Why**: the upstream `HttpMCPTransport` / `SseMCPTransport` hardcode `mcp-protocol-version: <LATEST_PROTOCOL_VERSION>` in every request and never honour the version negotiated during `initialize`. This violates the MCP spec and breaks handshakes with any server that supports a version older than the SDK's latest — notably **Figma Dev Mode MCP** (supports up to `2025-06-18` while the SDK sends `2025-11-25`), which rejects the follow-up `notifications/initialized` with HTTP 400 "Unsupported protocol version".

**What the patch does**: stores `result.protocolVersion` on the transport after init and uses it in `commonHeaders()` (`this.protocolVersion ?? LATEST_PROTOCOL_VERSION`). Aligned with the official `@modelcontextprotocol/sdk` behaviour and the MCP spec:
> The protocol version sent by the client SHOULD be the one negotiated during initialization.

**Upstream issue**: https://github.com/vercel/ai/issues/14413 — when this is fixed upstream and released, drop the patch and bump the dep.

**Reminder**: if you bump `@ai-sdk/mcp`, `pnpm install` will try to re-apply the patch against the new dist. Expect a conflict on newer versions — either regenerate the patch (`pnpm patch`) against the new source or delete `patches/@ai-sdk__mcp@1.0.36.patch` + the `pnpm.patchedDependencies` entry if the fix landed upstream.

## Supabase client in Electron / Node (non-browser)

When you create a `@supabase/supabase-js` client outside the browser (Electron main process, Temporal worker, Node script, etc.), browser-only assumptions break in subtle ways:

### 1. Auto-refresh of the access_token requires explicit start

`autoRefreshToken: true` (the default) only works in the browser because supabase-js relies on `document.visibilitychange` to schedule refreshes. In Node/Electron there is no such event, so the JWT silently expires after ~1h and every authenticated call (`rpc()`, RLS-backed queries, Realtime auth) starts failing with `JWT expired`.

**Always call `await supabase.auth.startAutoRefresh()` after `setSession()`** in non-browser code, and `await supabase.auth.stopAutoRefresh()` on teardown. Example: `packages/electron-overlay/src/main/mcp-bridge.ts` (`GuardianBridge.start` / `stop`).

### 2. Realtime auth must be re-synced on each token refresh

`supabase.realtime.setAuth(accessToken)` is called once at startup, but a refreshed token isn't propagated automatically. The WebSocket eventually disconnects with `auth_expired`. Fix by hooking `onAuthStateChange`:

```ts
this.supabase.auth.onAuthStateChange((_event, session) => {
  if (session?.access_token) {
    this.supabase.realtime.setAuth(session.access_token);
  }
});
```

### 3. Realtime WebSocket — use the `ws` package, not Electron's built-in

Electron main's global `WebSocket` interferes with Supabase Realtime's handshake (observed: `channel.subscribe()` consistently times out, even though the same supabase-js setup works in pure Node). Force the `ws` npm package via `realtime.transport`:

```ts
import WebSocket from "ws";
createSupabaseClient(url, key, {
  realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket },
});
```

### 4. Order of operations in `start()`

Subscribe to Realtime channels **before** opening long-lived HTTP/SSE connections to local services (e.g. local MCP servers on 127.0.0.1). Heavy local socket activity opened first can saturate the Electron network slot and stall the WS upgrade.

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