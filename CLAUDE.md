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

### Fastest method: direct SQL via Supabase MCP (recommended)

Intercepts are stored in the `intercept_queue` table. Use `mcp__supabase__execute_sql` to poll and respond:

```sql
-- Poll pending intercepts
SELECT request_id, purpose, agent_short_id, model, current_directive, step_count,
       request_payload->'messages' as messages, created_at
FROM intercept_queue
WHERE user_id = '<USER_ID>' AND status = 'pending'
ORDER BY created_at;

-- Respond to an intercept
UPDATE intercept_queue
SET status = 'responded',
    response_content = 'APPROVED',
    responded_by = 'claude_code_sql',
    responded_at = now()
WHERE request_id = '<REQUEST_ID>';

-- Respond with toolCalls
UPDATE intercept_queue
SET status = 'responded',
    response_content = 'Directives assigned.',
    response_tool_calls = '[{"id":"tc-1","name":"send_agent_directive","arguments":{"agentShortId":"#agent","content":"..."}}]'::jsonb,
    responded_by = 'claude_code_sql',
    responded_at = now()
WHERE request_id = '<REQUEST_ID>';
```

### Alternative: SSE stream (background listener)

```bash
export $(grep -v '^#' .env.local | grep STORAGE_SUPABASE_SERVICE_ROLE_KEY | xargs) && \
curl -s -N \
  -H "x-mcp-service-key: $STORAGE_SUPABASE_SERVICE_ROLE_KEY" \
  -H "x-mcp-user-id: <USER_ID>" \
  "http://localhost:3000/api/intercept/stream?purpose=agent,orchestrator"
```

### Alternative: MCP tools

- `watch_intercepts(timeoutMs?)` — checks table first, then listens for broadcast
- `respond_to_intercept(requestId, content, toolCalls?)` — updates table + broadcasts

### Response formats

- code_review: `APPROVED` or `REJECTED: <reason>`
- file_review: `VERIFIED: <description>` or `ISSUE: <description>`
- agent/orchestrator: free-form text + optional toolCalls

Timeout: 120s (normal) or 30 min (slow delegation mode).