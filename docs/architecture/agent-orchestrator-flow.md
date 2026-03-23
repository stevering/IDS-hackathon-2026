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

## Orchestrator Directive Guard

The orchestrator uses `send_agent_directive` tool calls to assign work to agents. A guard prevents sending a new directive to an agent that hasn't completed its current one.

### Guard Logic (orchestrator-logic.ts → processOrchestratorLLMResponse)

```
send_agent_directive(agentShortId, content)
│
├─ Agent not found → Error: "not found"
│
├─ Agent status = "active" AND lastReport.status ≠ "completed"
│  → Error: "Agent is still working on a directive. Wait for completed."
│  → No directive sent
│
├─ Agent confirmedByAgent AND status ∈ {failed, completed, interrupted}
│  → Error: "Agent has already terminated"
│  → No directive sent
│
└─ Otherwise
   → Directive sent, agent status set to "active"
```

### State Transitions

```
Agent receives directive
  → status = "active", lastReport = undefined

Agent calls signal_task_complete
  → report_to_orchestrator(status: "completed")
  → agent enters standby (inStandby = true, wait_for_input)

Orchestrator receives completed report
  → lastReport.status = "completed"
  → Can now send a new directive (guard passes)

Agent receives new directive (standby)
  → inStandby = false, resumes LLM loop
```

### Why Not Just Use Agent Status?

The guard checks `lastReport.status` instead of just `agentState.status` because:
- `status = "active"` means "has a directive" but doesn't tell you if it's done
- `lastReport.status = "completed"` means the agent finished and is in standby
- Without `lastReport`, the agent hasn't reported anything yet → still working

## Reporting to Orchestrator

Only these events generate `report_to_orchestrator`:

| Trigger | Status | Summary |
|---|---|---|
| `signal_task_complete` tool call | `completed` | Agent-provided summary |
| Idle text loop (5 consecutive) | `failed` | "Agent FAILED: N text responses..." |
| MAX_STEPS reached | `failed` | "Agent could not complete within N steps" |
| Plugin disconnected | `interrupted` | "Plugin disconnected" |

Text-only responses do **not** generate reports. The agent retries silently.
