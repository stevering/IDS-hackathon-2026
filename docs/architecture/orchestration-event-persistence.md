# Orchestration Event Persistence

How orchestration events are stored, replayed, and cleaned up across time.

## Event Types

### Durable Events (kept permanently)

These events form the narrative of a collaboration — who said what, what was done.

| Event | Avg Size | Description | Payload Fields |
|---|---|---|---|
| `orchestration_started` | ~480 B | Emitted once at collab start | `orchestrationId`, `agents[]` (shortId, label, type, fileName, status) |
| `orchestrator_brief` | ~5 KB | The orchestrator's full plan/briefing sent before directives | `content` (markdown text with task description, agent list, instructions) |
| `orchestrator_directive` | ~430 B | An instruction sent from orchestrator to a specific agent | `agentShortId`, `content` (the instruction text) |
| `agent_report` | ~1.1 KB | An agent reporting progress or completion of a directive | `agentShortId`, `report` { status, summary, timestamp, changes[], nodeIds[] } |
| `orchestration_completed` | ~58 B | Final event marking the end of the collab | `status` ("completed" / "completed_with_errors" / "failed" / "cancelled" / "timed_out") |

Durable events are also written to the `messages` table for the orchestration conversation:
- `orchestration_started` → role: `system`
- `orchestrator_brief` → role: `assistant`
- `orchestrator_directive` → role: `assistant`
- `agent_report` → role: `agent`
- `orchestration_completed` → role: `system`

### Ephemeral Events (cleaned up after 7 days)

These events provide the real-time streaming experience — thinking animations, code execution details, status changes.

| Event | Avg Size | Description | Payload Fields |
|---|---|---|---|
| `agent_activity` | ~1.8 KB | Real-time agent execution details (the biggest event type, ~58% of total storage) | `agentShortId`, `activities[]` — each activity has an `action` field: |
| | | — `thinking`: agent's plan + token usage (promptTokens, completionTokens) | `content`, `usage` |
| | | — `tool_call`: Figma code to execute (full source code) | `toolName`, `summary` (the code) |
| | | — `code_review_passed` / `code_review_llm_approved`: code review verdict | `codeSnippet`, `response`, `usage` |
| | | — `code_executed`: execution result (success/fail, node IDs) | `success`, `summary` |
| | | — `file_review_llm_response`: canvas diff review with verdict + **base64 screenshot** | `verdict`, `status`, `code`, `diff`, `afterScreenshot` (base64), `usage` |
| | | — `guardian_message`: full result message sent back to the agent | `message` (text with diff, node IDs, review verdict) |
| `orchestrator_input` | ~1.1 KB | What the orchestrator LLM received (agent reports, user input) — mirrors `agent_report` from the LLM's perspective | `content` (injected text), `fromAgentShortId` |
| `orchestrator_thinking` | ~400 B | The orchestrator LLM's text response after processing inputs | `content` (response text), `usage` { promptTokens, completionTokens, totalTokens }, `intercepted?` |
| `orchestrator_tool_call` | ~456 B | The orchestrator calling a tool (send_agent_directive, mark_agent_done, broadcast) | `toolName`, `args` (tool parameters) |
| `orchestrator_tool_result` | ~193 B | Result of an orchestrator tool call | `toolName`, `result` (text), `isError` |
| `agent_status_changed` | ~93 B | Agent status transition (pending → active → completed/failed) | `agentShortId`, `status` |

### Never Persisted

| Event | Description |
|---|---|
| `timer_tick` | Countdown timer updates (remainingMs, totalMs) — only relevant during live streaming |

## Storage Proportions

Based on a real 3-agent collab (1087 events total):

| Category | Events | Size | % of Total |
|---|---|---|---|
| **Ephemeral** | 868 | 892 KB | **81%** |
| — `agent_activity` | 360 | 629 KB | 58% |
| — `orchestrator_input` | 136 | 150 KB | 14% |
| — `orchestrator_thinking` | 96 | 37 KB | 3% |
| — `orchestrator_tool_call` | 68 | 30 KB | 3% |
| — `orchestrator_tool_result` | 68 | 13 KB | 1% |
| — `agent_status_changed` | 140 | 13 KB | 1% |
| **Durable** | 219 | 204 KB | **19%** |
| — `agent_report` | 136 | 151 KB | 14% |
| — `orchestrator_directive` | 60 | 25 KB | 2% |
| — `orchestrator_brief` | 4 | 21 KB | 2% |
| — `orchestration_started` | 4 | 2 KB | <1% |
| — `orchestration_completed` | 15 | 1 KB | <1% |

The 7-day cleanup removes **81% of storage** while keeping the full narrative.

## Display Scenarios

### Live (Temporal workflow active)

| Aspect | Behavior |
|---|---|
| **Source** | Temporal workflow query via SSE polling (1s interval) |
| **Events** | All events streamed in real-time (~60+ per collab) |
| **Experience** | Full streaming: thinking animations, status spinners, code execution details, timer countdown, tool calls visible |

### Recent (< 7 days, workflow finished)

| Aspect | Behavior |
|---|---|
| **Source** | DB replay from `orchestration_events` table (all events, durable + ephemeral) |
| **Events** | All events replayed at once (~60+) |
| **Experience** | Same content as live but displayed instantly (no streaming animation). Agent activities, thinking, tool calls all visible. |

### After 7 days (ephemeral events cleaned up)

| Aspect | Behavior |
|---|---|
| **Source** | DB replay from `orchestration_events` table (durable events only) |
| **Events** | ~10-20 events (started, brief, directives, reports, completed) |
| **Experience** | Narrative summary: the brief, each directive sent, each agent report, completion status. No thinking/tool calls/agent execution details. |

### Routing Logic (stream route)

```
GET /api/orchestration/[id]/stream

1. Check DB: is there an orchestration_completed event?
   → YES: replay durable events from DB (skip Temporal entirely)
   → NO: try Temporal...

2. Connect to Temporal workflow
   → OK: poll query, stream events via SSE
   → Connection failed: fallback to DB replay
   → Query "not found": workflow gone, replay from DB
   → 5 consecutive errors: fallback to DB replay
```

## Implementation

### Persistence (Temporal activity)

Events are persisted server-side by the `persistDurableEvents` Temporal activity, called as a micro-batch at the end of each orchestrator loop iteration. All events are sent to the activity; it marks each as `durable: true/false` based on type.

Durable events are also written to the `messages` table for the orchestration conversation.

### Cleanup (Supabase function)

```sql
-- cleanup_old_orchestration_events()
-- Deletes ephemeral events older than 7 days
DELETE FROM orchestration_events
WHERE durable = false
  AND created_at < now() - INTERVAL '7 days';
```

### Database Schema

```sql
orchestration_events (
  id          UUID PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  agent_id    TEXT,
  payload     JSONB NOT NULL,
  durable     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)
```
