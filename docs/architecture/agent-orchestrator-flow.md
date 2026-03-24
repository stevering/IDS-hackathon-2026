# Agent ↔ Orchestrator Communication Flow

How agents report to the orchestrator and how the orchestrator dispatches directives.

## Agent Text-Only Response Handling

When the agent LLM responds with text but no structured tool calls, the engine applies a series of guards before deciding what to do.

### Detection Pipeline (agent-logic.ts → processLLMResponse)

```
LLM responds with text, no toolCalls
│
├─ Pattern: [Called tool: toolName(...)]
│  → Nudge: "Use structured tool_use, not text"
│  → Retry LLM (does NOT count as idle)
│
├─ Pattern: ```js ... figma. ... ```
│  → Nudge: "Call figma_plugin_execute with the code"
│  → Retry LLM (does NOT count as idle)
│
├─ Idle count ≥ 5 (after directive received)
│  → Report FAILED to orchestrator
│  → Agent completes (terminal)
│
├─ Idle count = 3
│  → Warning injected: "Call a tool or signal_task_complete"
│  → Falls through to generic nudge below
│
└─ Otherwise (generic text, no tool intent detected)
   → Nudge: "You MUST call a tool to make progress"
   → Retry LLM (does NOT report to orchestrator)
   → Idle counter increments (if directive received)
```

**Key behavior:** Text-only responses never generate `report_to_orchestrator(status: "in_progress")`. This prevents raw code/plans from being forwarded to the orchestrator as fake progress, which previously caused directive pileup.

**Standby exception:** When the agent is in standby (`inStandby = true`, after `signal_task_complete`), text-only responses skip the nudge entirely and return `wait_for_input`. This prevents a cycle where broadcasts from the orchestrator wake the agent, it writes "awaiting directive" text, the nudge pushes it to retry, and it loops until FAILED — while the real directive sits in the queue.

## Shared Guardian Rules (agent + orchestrator)

Both agents and the orchestrator apply the same text-based tool call detection in orchestration mode:

### `[Called tool:]` nudge
When the LLM writes `[Called tool: toolName(...)]` in text instead of a structured tool call, Guardian nudges it to retry with proper `tool_use`. This prevents broken tool calls from being broadcast to agents (orchestrator) or silently ignored (agent).

The nudge:
- Does NOT count toward the idle text counter (the LLM tried, just used the wrong mechanism)
- Retries the LLM call immediately
- Prevents the text from being broadcast/forwarded

### Event categories
| Event type | Category | Meaning |
|---|---|---|
| `orchestrator_reasoning` | `thinking` | Internal reasoning (amber badge, dev-only) |
| `orchestrator_text` | `message` | Public text response (blue badge) |
| `reasoning` (agent) | `thinking` | Internal reasoning (amber badge, dev-only) |
| `assistant_text` (agent) | `message` | Public text response (blue badge) |

## Message Metadata Tags

All `role: "user"` messages injected into LLM conversation histories are wrapped with XML metadata tags identifying the source, target, and event type.

### XML format (default)

```xml
<message from="orchestrator" to="agent-#Figma-Desktop-pomipo" event="orchestrator_directive">
Create the color palette in container 601:81
</message>
```

### Bracket format (per-model fallback)

```
[from: orchestrator | to: agent-#Figma-Desktop-pomipo | event: orchestrator_directive]
Create the color palette in container 601:81
```

### Event vocabulary

| Event | From → To | When |
|---|---|---|
| `orchestrator_directive` | orchestrator → agent | Task assignment |
| `agent_report` | agent → orchestrator | Directive completion/failure report |
| `guardian_feedback` | guardian-engine → agent/orchestrator | Nudges, warnings, tool result summaries |
| `orchestrator_broadcast` | orchestrator/agent → all | Broadcast to all agents |
| `user_input` | user → orchestrator | Human message |
| `peer_message` | agent → agent | Direct peer or sub-conversation message |
| `orchestrator_brief` | guardian-engine → orchestrator | Initial task briefing |

### Per-model config

The `guardian_model_config` Supabase table stores per-model format preference. Models not in the table default to XML. The config is cached in-memory (24h TTL) in the Temporal worker, alongside the Gateway capabilities cache.

### What is NOT wrapped

- `role: "system"` — system prompt (already distinguished by role)
- `role: "assistant"` — LLM's own output (the LLM knows it wrote this)
- `role: "tool"` — tool results (already structured via `toolCallId`)

## SSE Event Traceability

Every LLM input and output is emitted as an SSE event, persisted in `orchestration_events` (DB), and visible in the UI.

### Orchestrator LLM events

| LLM exchange | SSE event type | UI visibility |
|---|---|---|
| System prompt | `system_prompt` | dev mode (collapsed) |
| Brief (task + agents) | `orchestrator_brief` | dev mode |
| LLM reasoning | `orchestrator_reasoning` | dev mode |
| LLM text response | `orchestrator_text` | normal mode |
| LLM tool call | `orchestrator_tool_call` | dev mode |
| Tool result | `orchestrator_tool_result` | dev mode |
| Directive sent | `orchestrator_directive` | normal mode |
| Agent report received | `orchestrator_input` + `agent_report` | normal mode (report) |
| Guardian feedback (nudges) | `guardian_feedback` | normal mode (orange) |

### Agent LLM events

| LLM exchange | SSE event type (via `agent_activity`) | UI visibility |
|---|---|---|
| System prompt | `guardian_message [system_prompt]` | dev mode |
| Directive received | `guardian_message [directive received]` | dev mode |
| Broadcast received | `guardian_message [broadcast from...]` | dev mode |
| LLM reasoning | `reasoning` | dev mode |
| LLM text response | `assistant_text` | dev mode |
| LLM tool call | `tool_call` | dev mode |
| Tool result | `external_tool_result` | dev mode |
| Code review / file review | `code_verified` / `file_review_llm_response` | dev mode |
| Guardian nudge | `guardian_message` | dev mode |

### Temporal signals (not directly traced)

Temporal signals between workflows are not emitted as SSE events. Their effects are visible:
- `directiveSignal` → `orchestrator_directive` + `agent_activity [directive received]`
- `agentReportSignal` → `agent_report` + `orchestrator_input`
- `terminateSignal` → `agent_status_changed`
- `agentDirectorySignal` → not traced (infrastructure: peer routing table)

## Orchestrator Directive Guard

The orchestrator uses `send_agent_directive` tool calls to assign work to agents. A guard prevents sending a new directive to an agent that hasn't completed its current one.

### Guard Logic (orchestrator-logic.ts → processOrchestratorLLMResponse)

```
send_agent_directive(agentShortId, content)
│
├─ Agent not found → Error: "not found"
│
├─ Agent confirmedByAgent AND status ∈ {failed, completed, interrupted}
│  → Error: "Agent has already terminated"
│  → No directive sent
│
├─ Agent status = "active" AND lastReport exists AND lastReport.status ∉ {"completed", "directive_done"}
│  → Error: "Agent is still working on a directive."
│  → No directive sent
│
└─ Otherwise (first directive with no lastReport, or agent in standby)
   → Directive sent
   → status = "active", lastReport = { status: "in_progress" }
```

### Agent Report Statuses

| Status | Meaning | Guard behavior |
|---|---|---|
| `"directive_done"` | Agent completed the directive, stays alive for more work (standby) | Allows new directive |
| `"in_progress"` | Agent is actively working | Blocks new directive |
| `"completed"` | Agent workflow terminated successfully | Terminal — blocks directive |
| `"failed"` | Agent failed (idle loop, max steps) | Terminal — blocks directive |
| `"interrupted"` | Plugin disconnected | Terminal — blocks directive |

### State Transitions

```
Child workflow started (orchestrator.ts)
  → status = "active", lastReport = undefined

First directive sent (send_agent_directive)
  → lastReport = { status: "in_progress" }
  → Guard now blocks further directives

Agent calls signal_task_complete
  → report_to_orchestrator(status: "directive_done")
  → agent enters standby (inStandby = true, wait_for_input)

Orchestrator receives directive_done report
  → lastReport.status = "directive_done"
  → Can now send a new directive (guard passes)

New directive sent
  → lastReport = { status: "in_progress" } (blocks duplicates)
  → agent resumes LLM loop (inStandby = false)

Orchestrator calls mark_agent_done
  → terminate signal sent → agent workflow ends
```

### Key Design Decisions

- **`directive_done` vs `completed`**: `signal_task_complete` reports `"directive_done"` (not `"completed"`) because `"completed"` sets `confirmedByAgent = true` and permanently blocks new directives. `"directive_done"` keeps the agent alive for sequential directives.
- **`lastReport = in_progress` on send**: When a directive is sent, `lastReport` is immediately set to `{ status: "in_progress" }`. This prevents the LLM from sending duplicate directives in the same response (the guard sees "still working" for subsequent tool calls).
- **No lastReport = first directive**: When `lastReport` is `null`, the agent hasn't received any directive yet. The guard allows the first directive through.

## Reporting to Orchestrator

Only these events generate `report_to_orchestrator`:

| Trigger | Status | Summary |
|---|---|---|
| `signal_task_complete` tool call | `directive_done` | Agent-provided summary + node IDs |
| Idle text loop (5 consecutive) | `failed` | "Agent FAILED: N text responses..." |
| MAX_STEPS reached | `failed` | "Agent could not complete within N steps" |
| Plugin disconnected | `interrupted` | "Plugin disconnected" |

Text-only responses do **not** generate reports. The agent retries silently.

## LLM Reasoning Extraction

Models that support native reasoning (e.g. kimi-k2.5, grok) return reasoning content alongside the main response. The Temporal worker (`llm.ts → callLLMDirect`) extracts it via `result.reasoningText` (AI SDK v6 / LMS v3).

### How it works

```
Gateway model (e.g. moonshotai/kimi-k2.5)
  → Moonshot API returns reasoning_content field
  → Vercel AI Gateway transforms to LMS v3 { type: "reasoning", text: "..." } parts
  → AI SDK generateText() exposes via result.reasoning / result.reasoningText
  → callLLMDirect returns { reasoning: "..." } in LLMCallResult
  → processLLMResponse emits { action: "reasoning" } activity (separate from "thinking")
```

### Key details

- **Models with native reasoning** (Gateway tag `"reasoning"`): the Gateway transforms provider-specific reasoning (e.g. Moonshot's `reasoning_content`) into LMS v3 `{ type: "reasoning" }` parts. No middleware needed — `result.reasoningText` works directly.
- **Models without native reasoning** (e.g. `openai/gpt-4o`, `google/gemini-2.0-flash`): `callLLMDirect` wraps the model with `extractReasoningMiddleware({ tagName: "thinking" })` and injects a `<thinking>` instruction into the system prompt. The middleware extracts `<thinking>...</thinking>` tags from text into reasoning parts.
- `result.reasoning` parts have `type: "reasoning"` (not `type: "text"`) — this is the AI SDK v6 (LMS v3) format.
- kimi-k2.5 has thinking enabled by default (no `providerOptions` needed).

### Model traceability

Every LLM call returns `modelId` (the actual resolved model, e.g. `"moonshotai/kimi-k2.5"` or `"xai/grok-4-1-fast-non-reasoning"` for free tier). This flows through:
- `LLMCallResult.modelId` → `processLLMResponse` / `processOrchestratorLLMResponse`
- Agent activities: `reasoning.modelId`, `assistant_text.modelId`
- Orchestrator events: `orchestrator_text.modelId`, `orchestrator_reasoning.modelId`
- Persisted in `orchestration_events.payload` (JSONB) automatically
- Displayed in the UI event log as `[model-id]` badge

### Gateway capabilities cache

The Temporal worker maintains an in-memory cache of the Vercel AI Gateway model catalog (`https://ai-gateway.vercel.sh/v1/models`), refreshed every 24h. The cache stores which model IDs have the `"reasoning"` tag, used to decide whether to apply the middleware fallback. Same pattern as `model-pricing.ts`.

## Agent Figma Tool Strategy

When Figma Console MCP tools (`figmaconsole_*`) are available, the agent system prompt is slimmed down to promote high-level tools over raw code execution.

### Tool Priority (when figmaconsole_ available)

```
1. Dedicated figmaconsole_ tools (create_child, set_fills, set_text, resize_node, etc.)
   → High-level, structured parameters, no Figma Plugin API knowledge needed

2. figmaconsole_figma_execute (raw code) — LAST RESORT
   → Only for operations with no dedicated tool (auto-layout, effects, gradients)
   → Figma API reference is lazily injected on first use
```

### Slim vs Full System Prompt

| Condition | Prompt variant | Figma section size |
|---|---|---|
| `hasExternalFigmaTools = true` (figmaconsole_ MCP connected) | **Slim**: tool priority + brief workflow, no API reference | ~40 lines (~1.5K tokens) |
| `hasExternalFigmaTools = false` (no MCP, figma_plugin_execute only) | **Full**: phases 1/2/3, worked example, full API Quick Reference | ~260 lines (~8K tokens) |

### Lazy API Reference Injection

When the slim prompt is active and the agent calls `figma_execute` for the first time:

```
Agent calls figmaconsole_figma_execute (or figma_plugin_execute)
│
├─ state.figmaApiDocsInjected = false AND state.externalTools.length > 0
│  → Inject FIGMA_API_EXECUTE_SUPPLEMENT as guardian_feedback message
│  → Set state.figmaApiDocsInjected = true
│  → Contains: 14 critical gotchas, ID handoff pattern, recovery rules, worked example
│
└─ state.figmaApiDocsInjected = true
   → Skip (already injected)
```

The supplement (~80 lines) is injected as a `role: "user"` message with `event="guardian_feedback"` right after the tool result. This gives the agent the API context for its next code call without bloating the initial system prompt.

### Tool List (getAgentTools)

When `figmaconsole_figma_execute` is in `state.externalTools`:
- Engine-built `figma_plugin_execute` is **not added** (avoids duplicate raw code capability)
- `lookup_figma_docs` is always available (for on-demand full API docs)
