# DS AI Guardian Project Instructions

When you have to write code in the monorepo or show a snippet of code, you must do it in full English language (comments, code).

In any AI chat, discuss in the user language, based on the user messages, ignoring snippets of code or logs (probably in English).

## Dev environment

- `pnpm dev` logs are written live to `logs/dev.log` at project root. Always check this file to verify server restarts, hot reloads, or errors — don't ask the user to paste terminal output.
- The Temporal worker (`@guardian/temporal`) bundles workflows via webpack at startup. Changes in `packages/orchestrations/src/` trigger an auto-restart thanks to `--watch-path` in the dev script.

If you need a temprary directory for operations, create one here in the project root, in `tmp/`.

- Activities in `packages/temporal/src/activities/` are NOT hot-reloaded — the Temporal worker must be restarted to pick up changes.

## LLM call delegation (dev-only)

When the user enables "LLM call delegation" in Account > Developers, orchestration code_review and file_review calls are delegated to you via Supabase Realtime. You act as the reviewer instead of the AI provider.

To listen for intercepts, start a background SSE stream:
```bash
export $(grep -v '^#' .env.local | grep STORAGE_SUPABASE_SERVICE_ROLE_KEY | xargs) && \
curl -s -N \
  -H "x-mcp-service-key: $STORAGE_SUPABASE_SERVICE_ROLE_KEY" \
  -H "x-mcp-user-id: <USER_ID>" \
  "http://localhost:3000/api/intercept/stream"
```
Each `data:` line is a JSON request with `requestId`, `context.purpose`, and `llm.messages`. Respond with the `respond_to_intercept` MCP tool. Timeout: 120s.