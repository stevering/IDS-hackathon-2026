# Log redaction — what never goes to stdout

Worker logs (Temporal worker) flow into two places that are **not** governed by Supabase RLS:

- **Railway logs** — visible to anyone with Railway dashboard access for the service.
- **Temporal Cloud workflow history** — exception messages thrown from activities are persisted in the workflow event history (Frankfurt). Replays surface them in the UI.

User and LLM **conversation content must never reach either**. The only place it lives is the Supabase tables (`messages`, `orchestration_events`, `chat_messages`, etc.) protected by RLS.

## Helper

`packages/temporal/src/lib/redact.ts` exposes four functions that produce log-safe metadata:

| Helper | Returns | Use for |
|---|---|---|
| `redactArgs(args)` | `{argKeys, argSize}` | Tool call arguments, MCP tool inputs |
| `redactResult(result)` | `{resultSize, resultKeys, resultIsError}` | Tool / MCP / Figma execution results |
| `redactMessage(m)` | `{role, contentLen, toolCallCount}` | Single chat message dumps |
| `redactPayload(p)` | `{payloadKeys, payloadSize}` | Realtime broadcast payloads |

Output is restricted to primitives (string / number / boolean), so it composes directly with `LogContext` in `lib/log.ts`.

## Banned patterns

```ts
// 🔴 NEVER
log.info("call", { args: JSON.stringify(args).slice(0, 200) });
log.info("done", { result: JSON.stringify(result).slice(0, 500) });
throw new Error(`bad response: ${JSON.stringify(parsed)}`);

// ✅ INSTEAD
log.info("call", redactArgs(args));
log.info("done", redactResult(result));
throw new Error(`bad response (fields=${Object.keys(parsed).join(",")})`);
```

`.slice()` on serialized content is **not** a sanitiser — the first N characters of a prompt or LLM response are still the user's data.

## Where the helper is wired

| File | What was logging content | Now |
|---|---|---|
| `activities/llm.ts` | `rawTc` of empty-args tool calls | `Object.keys(tc)` only |
| `activities/llm-streaming.ts` | per-message JSON dump on multi-turn | `redactMessage` shape |
| `activities/mcp.ts` (×3) | tool args + results truncated | `redactArgs` / `redactResult` |
| `activities/guardian-meta-tools.ts` | meta-tool args truncated | `redactArgs` |
| `activities/chat-broadcast.ts` | full broadcast payload truncated | `redactPayload` |
| `activities/figma-execute.ts` | 100-char preview of plugin result | `resultLen` only |
| `activities/oauth-refresh.ts` | full OAuth response in error msg | field names only |

## Out of scope

- **Activity payloads** sent to Temporal Cloud (input/output of `activity.execute`) **do** contain conversation content — that is how workflows pass data between activities. Mitigation lives elsewhere: data converter encryption, retention policy on Temporal Cloud namespace.
- **Realtime broadcasts** to the browser carry conversation content by design (the user is the recipient). RLS does not apply to Realtime channels — the channel name (`guardian:chat:{conversationId}`) is the access control. Auditing channel naming is a separate concern.
- **`emit_activity` events** persisted to `orchestration_events` (`packages/orchestrations/src/engine/`) carry LLM responses and tool args. They live in Supabase under RLS. Acceptable.

## Tests

`src/__tests__/redact.test.ts` asserts each helper's output is free of a fixed list of fake secrets (email, API key, Figma code, French sentence). Add new secret patterns to `SECRETS` if a future helper handles a new shape.

## Related

- `internal/docs/backlog/rgpd-pii-leakage-audit.md` — full RGPD audit, this doc covers point 3 (no conversation content in logs).
- `internal/docs/backlog/legal-compliance-public-launch.md` — broader privacy/legal scope for public launch.
