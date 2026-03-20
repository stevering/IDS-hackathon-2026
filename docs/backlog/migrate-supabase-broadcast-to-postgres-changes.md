# Migrate Supabase Realtime: Broadcast → Postgres Changes

## Problem

Guardian uses Supabase Realtime in **Broadcast** mode (ephemeral pub/sub) for 3 critical communications. Broadcast is fire-and-forget — no delivery guarantee, no buffering, no ack. This has forced costly workarounds:

- **LLM intercept**: 2s DB polling fallback in `llm.ts` → adds 0-2s latency per intercept
- **Figma execution**: 30s timeout with no retry on lost messages
- **Presence**: Custom keepalive + auto-reconnect logic (`b4f6a60`)

## Solution

Migrate to **Postgres Changes** — Supabase RT listens to the Postgres WAL. The push is triggered by the DB write itself. If the row exists, the event is guaranteed.

```
Broadcast:  INSERT into DB + separate broadcast (can be lost) + 2s poll as safety net
Pg Changes: INSERT into DB → automatic push via WAL. No broadcast. No polling.
```

## 3 usages to migrate

### 1. LLM Intercept (high priority)

Table `intercept_queue` already exists. Replace `channel.on("broadcast")` + `setInterval(2000)` with:

```ts
channel.on("postgres_changes", {
  event: "UPDATE",
  schema: "public",
  table: "intercept_queue",
  filter: `request_id=eq.${requestId}`
}, handler);
```

Remove: 2s polling loop, broadcast on response side.
Gain: 0-2000ms → ~50-150ms per intercept response detection.

Files: `llm.ts`, `llm-intercept.ts`, `stream/route.ts`

### 2. Figma Execution (medium priority)

No table today → create `figma_exec_queue` (request_id, code, status, result). Plugin listens for INSERTs, writes result as UPDATE.

Gain: reliability (no more lost messages), persistence (debug/audit trail), same latency.

Files: `figma-execute.ts`, `figma-bridge.ts`, `useFigmaExecuteChannel.ts`

### 3. Presence (low priority)

The `clients` table with `heartbeat_client` RPC already exists — it's the workaround we built because Presence was unreliable. Listen to UPDATEs on `clients` via Postgres Changes instead of Presence mode.

Gain: remove ~50 lines of keepalive/reconnect workaround code.

Files: `presence.ts`, `useGuardianPresence.ts`

## Supabase config (one-time)

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE intercept_queue;
ALTER PUBLICATION supabase_realtime ADD TABLE figma_exec_queue;  -- after table creation
ALTER PUBLICATION supabase_realtime ADD TABLE clients;
```

## Expected latency

| Usage | Broadcast + workarounds | Postgres Changes |
|---|---|---|
| LLM intercept | 200-4200ms | ~50-150ms |
| Figma execution | ~100ms or 30s timeout | ~100-200ms (reliable) |
| Presence | ~100ms + keepalive jitter | ~100ms (reliable) |

## Risks

- **Supabase load**: each subscriber creates a replication slot listener. Mitigation: use precise filters (`filter: request_id=eq.xxx`).
- **Payload size**: Postgres Changes sends the full row by default. Keep columns lean or use column filters.
- **Rollback**: keep Broadcast code behind a feature flag during transition.

## Implementation order

1. LLM intercept (table exists, biggest gain, direct impact on replay/benchmark)
2. Figma execution (new table needed, reliability gain)
3. Presence (cleanup, table exists)

Each migration is independent — one PR per usage.
