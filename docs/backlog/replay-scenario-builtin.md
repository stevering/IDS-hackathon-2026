# Built-in Replay Scenario for Orchestration Benchmarking

## Context

We currently have an external replay system (`scripts/replay-engine.py`) that intercepts LLM calls via the `intercept_queue` Supabase table and responds with pre-recorded templates. This works but adds **~4s of overhead per intercept** due to the DB polling round-trip (2s polling interval × 2 hops).

This overhead makes it impossible to benchmark the real platform pipeline performance (Temporal dispatch, orchestrator logic, Figma execution) in isolation — the intercept mechanism dominates the non-Figma latency.

## Proposal

Integrate the replay mechanism directly into `callLLM()` in the Temporal worker, bypassing the intercept queue entirely when a replay scenario is active.

## Current architecture (external replay)

```
Temporal workflow
  → callLLM activity
    → INSERT into intercept_queue           (~100ms DB write)
    → poll every 2s for response            (0-2000ms wait)
    → external replay detects via SSE/poll  (0-2000ms)
    → external replay writes response       (~100ms)
    → poll detects response                 (0-2000ms wait)
    → callLLM returns result
  → orchestrator processes
  → next cycle
```

**Measured overhead**: ~4s per intercept, ~15s total for a 3-agent orchestration (excluding Figma execution).

## Proposed architecture (built-in replay)

```
Temporal workflow
  → callLLM activity
    → if (replayScenario) {
        matchTemplate(purpose, agentRole, step)
        substituteNodeIds(template, nodeIdRegistry)
        return response                     (~1ms)
      }
  → orchestrator processes
  → next cycle
```

**Expected overhead**: ~1ms per LLM call. Total pipeline overhead reduced to pure Temporal + orchestrator logic (~50-100ms).

## Implementation

### 1. Scenario storage

Reuse the existing template format from `scripts/replay-collab-scenario-templates/`:

```
scripts/replay-collab-scenario-templates/<scenario-name>/
├── scenario.json           # metadata, agent roles, options
└── templates/
    ├── orchestrator__init.json
    ├── agent-A__step-0.json
    ├── agent-A__step-1.json
    ├── agent-A__done.json
    ├── code_review__default.json   (implicit: auto-approve)
    ├── file_review__default.json   (implicit: auto-verify)
    └── ...
```

Templates contain `{{AGENT_A}}`, `{{NODE_C_0}}`, `{{TIMESTAMP}}` placeholders that are substituted at runtime.

### 2. Changes to `packages/temporal/src/activities/llm.ts`

In `callLLM()`, before the existing delegation/passthrough logic:

```ts
// Early return if replay scenario is active
if (replayScenario) {
  const template = replayEngine.match(purpose, agentRole, step, messages);
  if (template) {
    const response = replayEngine.substitute(template, nodeIdRegistry, agentMap);
    // Capture node IDs from Figma execution results in messages
    replayEngine.extractNodeIds(messages, agentRole, step);
    return {
      content: response.response_content,
      toolCalls: response.response_tool_calls,
      replayedFrom: template._match,
    };
  }
  // No matching template → fall through to normal LLM call
}
```

For `code_review` and `file_review` purposes, return instant APPROVED/VERIFIED without template lookup.

### 3. Replay engine module

New file: `packages/orchestrations/src/engine/replay-engine.ts`

```ts
interface ReplayEngine {
  loadScenario(scenarioDir: string): void;
  discoverAgents(systemPrompt: string): void;  // maps shortIds → roles A/B/C
  match(purpose: string, agentRole: string, step: number, messages: Message[]): Template | null;
  substitute(template: Template, nodeIds: Map<string, string>, agentMap: Map<string, string>): Response;
  extractNodeIds(messages: Message[], role: string, step: number): void;
}
```

Port the matching logic from `scripts/replay-engine.py`:
- State detection from payload messages (initial-directive, post-execution-success, broadcast, etc.)
- Template matching by (purpose, role, step, state) with fallback chain
- Node ID capture from "Created node IDs: [...]" in tool results
- Placeholder substitution (agent names, node IDs, timestamps)

### 4. Activation mechanism

Option A — **Environment variable**:
```env
REPLAY_SCENARIO=mini-design-system
```
Set in `.env.local`, read by the Temporal worker at startup.

Option B — **Per-orchestration option** (via `start_collab`):
```ts
start_collab({
  task: "...",
  agents: [...],
  replayScenario: "mini-design-system"  // optional
})
```
Passed through to the Temporal workflow as a workflow input.

Option C — **UI toggle** (Account > Developers):
- Dropdown to select a scenario (or "None")
- Stored in user settings
- Read by `callLLM` via the user's delegation config

**Recommendation**: Option B for dev/testing, Option C for production benchmarking.

### 5. Code review / File review handling

In replay mode, these are short-circuited entirely:
- `code_review` → return `{ content: "APPROVED" }` instantly
- `file_review` → return `{ content: "VERIFIED" }` instantly

No template needed — the code was pre-validated when the scenario was recorded.

### 6. Figma execution

Figma execution still happens normally — the agent sends `figma_plugin_execute` to the real Figma plugin. This is the whole point: measure real Figma execution time without LLM overhead.

The only difference: node IDs from execution results are captured by the replay engine for substitution in subsequent templates (e.g., `{{NODE_C_0}}` → the actual ID returned by Figma).

## Benchmarking output

The replay engine should emit timing metrics:

```ts
interface ReplayMetrics {
  orchestrationId: string;
  scenario: string;
  totalDurationMs: number;
  interceptCount: number;
  phases: {
    name: string;           // "orchestrator_init", "agent_A_step_0", etc.
    purpose: string;
    durationMs: number;     // time from intercept creation to next intercept
    figmaExecMs?: number;   // time spent in Figma execution (if applicable)
    templateMatchMs: number; // time to match + substitute template
  }[];
  summary: {
    totalFigmaMs: number;
    totalPipelineMs: number;
    totalReplayMs: number;
    agentCount: number;
    figmaExecCount: number;
  };
}
```

Logged to console and optionally stored in `orchestration_events` for the UI.

## Expected results

| Metric | External replay | Built-in replay | Improvement |
|--------|----------------|-----------------|-------------|
| Per-intercept overhead | ~4s | ~1ms | ~4000x |
| Total pipeline overhead (3 agents) | ~15s | ~0.1s | ~150x |
| Total orchestration time | ~62s | ~47s | ~25% faster |
| Figma execution time | ~45s | ~45s | Same (incompressible) |

The built-in replay isolates the true platform performance: **Temporal dispatch + orchestrator logic + Figma execution**.

## Out of scope (future)

- **Scenario recording**: A `record-scenario` mode that captures a live interception session and outputs a template directory. The template format is already designed to support this.
- **Regression testing**: Run the same scenario repeatedly and compare metrics to detect performance regressions.
- **CI integration**: Run replay scenarios in headless mode (mock Figma execution) for pipeline performance testing without Figma Desktop.
