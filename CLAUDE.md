# DS AI Guardian Project Instructions

When you have to write code in the monorepo or show a snippet of code, you must do it in full English language (comments, code).

In any AI chat, discuss in the user language, based on the user messages, ignoring snippets of code or logs (probably in English).

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
- **Write JSON files in parallel** too (multiple Write tool calls in same message).
- **`pollwait`** replaces `poll` and `listen`. It checks DB first (catches SSE gap), then waits for SSE push (no polling).
- **Always relaunch `pollwait`** after responding.
- **Temp files in `tmp/`** (repo), never `/tmp/` (system).

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

- code_review: `APPROVED` or `REJECTED: <reason>`
- file_review: `VERIFIED: <description>` or `ISSUE: <description>`
- agent/orchestrator: free-form text + optional toolCalls

### Timeout

120s (normal) or 30 min (slow delegation mode).