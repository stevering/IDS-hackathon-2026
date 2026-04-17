# Orchestration Failure Reporting

How the Temporal orchestrator workflow surfaces errors to the webapp UI.

## Overview

The orchestrator workflow (`orchestratorWorkflow()`) runs Phases 1-4: agent startup, directory broadcast, LLM planning, and the coordination loop. Any uncaught throw (e.g. invalid prompt, activity crash) is caught at the top level. The catch block transitions the orchestration to a `"failed"` state and marks all active agents as failed. Control then falls through to the Final Save block, which emits `orchestration_completed` with `status: "failed"` and an `error` field carrying the original message.

## Event flow

```
Activity throws (e.g. Zod validation in callLLM)
  -> catch: state.status = "failed", agents set to "failed"
  -> Final Save: push orchestration_completed { status: "failed", error: "..." }
  -> flushDurableEvents(): persist to orchestration_events table (Supabase)
  -> saveOrchestrationState(): update orchestrations row
  -> return OrchestrationResult { status: "failed" }
```

## SSE delivery

The SSE stream (`/api/orchestration/[id]/stream`) picks up the failure via two paths:

- **Live**: the polling loop queries the workflow via `statusQuery`. When `status !== "active"`, it emits `orchestration_completed` to the client and closes.
- **Replay** (reconnect / late join): `replayFromDb()` reads persisted events from the `orchestration_events` table, extracts the completion status, and streams it.

## UI consumption

```
SSE: { type: "orchestration_completed", status: "failed", error: "..." }
  -> useOrchestrationStream: sets completedStatus = "failed", error = message
  -> useTemporalOrchestration: derives isActive = false, exposes streamError
  -> OrchestrationBanner: red banner "Orchestration failed -- <error>"
```

The `OrchestrationBanner` component accepts an optional `errorMessage` prop. When the completion status is `"failed"` or `"completed_with_errors"`, the error detail is displayed inline (truncated, with full text in a tooltip).

## Key files

| File | Role |
|---|---|
| `packages/temporal/src/workflows/orchestrator.ts` | Top-level try/catch in `orchestratorWorkflow()`, Final Save block |
| `packages/orchestrations/src/types/events.ts` | `orchestration_completed` event type (includes optional `error`) |
| `packages/web/src/app/hooks/useOrchestrationStream.ts` | SSE consumer, extracts `error` from completion events |
| `packages/web/src/app/hooks/useTemporalOrchestration.ts` | Derives `isActive`, exposes `streamError` |
| `packages/web/src/components/OrchestrationBanner.tsx` | Renders status + error message |
| `packages/web/src/app/api/orchestration/[id]/stream/route.ts` | SSE endpoint (live poll + DB replay) |
