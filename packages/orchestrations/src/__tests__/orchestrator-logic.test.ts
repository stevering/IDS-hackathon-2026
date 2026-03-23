import { describe, it, expect } from "vitest";
import {
  createOrchestratorState,
  generateStartEffects,
  generateDirectoryEffects,
  generatePlanningCall,
  processPlanningResponse,
  generateBriefAndFirstCall,
  processOrchestratorLLMResponse,
  getOrchestratorTools,
  processReports,
  processCoordinationResponse,
  processUserInput,
  checkCompletion,
  handleCancellation,
  handleBroadcastRelay,
  getAgentViewStates,
  getEventsSince,
  drainEvents,
} from "../engine/orchestrator-logic.js";
import type { StartOrchestrationParams, AgentState } from "../types/agents.js";
import type { AgentId, AgentReportPayload } from "../types/signals.js";

function makeAgent(shortId: string, workflowId?: string): AgentId {
  return {
    shortId,
    workflowId: workflowId ?? `wf-${shortId}`,
    label: `Agent ${shortId}`,
    type: "figma-plugin",
    fileName: `${shortId}.fig`,
  };
}

function makeParams(agents: AgentId[]): StartOrchestrationParams {
  return {
    userId: "user-1",
    task: "Create a design system",
    targetAgents: agents,
  };
}

describe("createOrchestratorState", () => {
  it("initializes with correct defaults", () => {
    const agents = [makeAgent("a"), makeAgent("b")];
    const state = createOrchestratorState(makeParams(agents));

    expect(state.status).toBe("active");
    expect(state.agents.size).toBe(2);
    expect(state.agents.get("a")?.status).toBe("pending");
    expect(state.agents.get("b")?.status).toBe("pending");
    expect(state.messageHistory).toHaveLength(0);
    expect(state.pendingReports).toHaveLength(0);
    expect(state.maxDurationMs).toBe(600_000);
  });

  it("uses custom maxDurationMs", () => {
    const state = createOrchestratorState({
      ...makeParams([makeAgent("a")]),
      maxDurationMs: 300_000,
    });
    expect(state.maxDurationMs).toBe(300_000);
  });
});

describe("generateStartEffects", () => {
  it("generates one start_agent effect per agent", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a"), makeAgent("b")]));
    const effects = generateStartEffects(state);

    expect(effects).toHaveLength(2);
    expect(effects[0].type).toBe("start_agent");
    expect(effects[1].type).toBe("start_agent");
  });
});

describe("generateDirectoryEffects", () => {
  it("sends directory to all agents with workflow IDs", () => {
    const agents = [makeAgent("a", "wf-a"), makeAgent("b", "wf-b")];
    const state = createOrchestratorState(makeParams(agents));

    const effects = generateDirectoryEffects(state, "orch-wf");

    expect(effects).toHaveLength(2);
    for (const e of effects) {
      expect(e.type).toBe("send_directory");
      if (e.type === "send_directory") {
        expect(e.directory.orchestratorWorkflowId).toBe("orch-wf");
        expect(Object.keys(e.directory.agents)).toHaveLength(2);
      }
    }
  });
});

describe("generatePlanningCall", () => {
  it("adds a user message and returns a call_llm effect", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    const effect = generatePlanningCall(state);

    expect(effect.type).toBe("call_llm");
    expect(state.messageHistory).toHaveLength(1);
    expect(state.messageHistory[0].role).toBe("user");
    expect(state.messageHistory[0].content).toContain("Create a design system");
    expect(state.messageHistory[0].content).toContain("#a");
  });
});

describe("processPlanningResponse", () => {
  it("parses directives from LLM response and generates effects", () => {
    const agents = [makeAgent("a", "wf-a"), makeAgent("b", "wf-b")];
    const state = createOrchestratorState(makeParams(agents));

    const llmResponse = `[DIRECTIVE:#a]
Create buttons
[/DIRECTIVE]

[DIRECTIVE:#b]
Create colors
[/DIRECTIVE]`;

    const effects = processPlanningResponse(state, llmResponse);

    const directiveEffects = effects.filter((e) => e.type === "send_directive");
    expect(directiveEffects).toHaveLength(2);

    expect(state.agents.get("a")?.status).toBe("active");
    expect(state.agents.get("b")?.status).toBe("active");
    expect(state.messageHistory).toHaveLength(1); // assistant message added
  });
});

describe("processReports", () => {
  it("processes pending reports and injects into LLM history", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a", "wf-a")]));
    state.agents.get("a")!.status = "active";

    state.pendingReports.push({
      agentShortId: "a",
      status: "in_progress",
      summary: "Working on it",
    });

    const effects = processReports(state);

    expect(state.pendingReports).toHaveLength(0);
    expect(state.messageHistory).toHaveLength(1);
    expect(state.messageHistory[0].content).toContain("#a");
    expect(state.messageHistory[0].content).toContain("in_progress");

    const llmCalls = effects.filter((e) => e.type === "call_llm");
    expect(llmCalls).toHaveLength(1);
  });

  it("marks agent as completed on completed report", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a", "wf-a")]));
    state.agents.get("a")!.status = "active";

    state.pendingReports.push({
      agentShortId: "a",
      status: "completed",
      summary: "Done!",
    });

    processReports(state);
    expect(state.agents.get("a")?.status).toBe("completed");
  });

  it("returns empty effects when no reports", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    const effects = processReports(state);
    expect(effects).toHaveLength(0);
  });
});

describe("processCoordinationResponse", () => {
  it("parses AGENT_DONE markers and marks agents completed", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a", "wf-a")]));
    state.agents.get("a")!.status = "active";

    const effects = processCoordinationResponse(
      state,
      "Good job! [AGENT_DONE:#a] Task complete."
    );

    expect(state.agents.get("a")?.status).toBe("completed");
    const statusEvents = effects.filter((e) => e.type === "emit_event");
    expect(statusEvents.length).toBeGreaterThan(0);
  });

  it("broadcasts to active agents excluding done ones", () => {
    const agents = [makeAgent("a", "wf-a"), makeAgent("b", "wf-b")];
    const state = createOrchestratorState(makeParams(agents));
    state.agents.get("a")!.status = "active";
    state.agents.get("b")!.status = "active";

    const effects = processCoordinationResponse(
      state,
      "[AGENT_DONE:#a] Keep going #b!"
    );

    const broadcasts = effects.filter((e) => e.type === "broadcast_to_agents");
    expect(broadcasts).toHaveLength(1);
    if (broadcasts[0].type === "broadcast_to_agents") {
      expect(broadcasts[0].excludeShortIds).toContain("a");
    }
  });
});

describe("processUserInput", () => {
  it("injects user input into history and triggers LLM call", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    state.userInputQueue.push({ content: "Focus on the button first" });

    const effects = processUserInput(state);

    expect(state.userInputQueue).toHaveLength(0);
    expect(state.messageHistory).toHaveLength(1);
    expect(state.messageHistory[0].content).toContain("Focus on the button first");

    const llmCalls = effects.filter((e) => e.type === "call_llm");
    expect(llmCalls).toHaveLength(1);
  });

  it("returns empty when no input", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    const effects = processUserInput(state);
    expect(effects).toHaveLength(0);
  });
});

describe("checkCompletion", () => {
  it("returns complete when all agents are done", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a"), makeAgent("b")]));
    state.agents.get("a")!.status = "completed";
    state.agents.get("a")!.confirmedByAgent = true;
    state.agents.get("b")!.status = "completed";
    state.agents.get("b")!.confirmedByAgent = true;

    const effect = checkCompletion(state);
    expect(effect).not.toBeNull();
    expect(effect?.type).toBe("complete");
  });

  it("returns null when agents are still active", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a"), makeAgent("b")]));
    state.agents.get("a")!.status = "completed";
    state.agents.get("a")!.confirmedByAgent = true;
    state.agents.get("b")!.status = "active";

    const effect = checkCompletion(state);
    expect(effect).toBeNull();
  });

  it("detects timeout", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    state.startedAt = Date.now() - 700_000; // 11+ minutes ago

    const effect = checkCompletion(state);
    expect(effect?.type).toBe("complete");
    expect(state.status).toBe("timed_out");
  });

  it("treats interrupted agents as done", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    state.agents.get("a")!.status = "interrupted";
    state.agents.get("a")!.confirmedByAgent = true;

    const effect = checkCompletion(state);
    expect(effect?.type).toBe("complete");
  });

  it("sets status to 'failed' when single agent failed", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    state.agents.get("a")!.status = "failed";
    state.agents.get("a")!.confirmedByAgent = true;

    const effect = checkCompletion(state);
    expect(effect?.type).toBe("complete");
    expect(state.status).toBe("failed");
    if (effect?.type === "complete") {
      expect(effect.result.status).toBe("failed");
    }
  });

  it("sets status to 'failed' when all agents failed", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a"), makeAgent("b")]));
    state.agents.get("a")!.status = "failed";
    state.agents.get("a")!.confirmedByAgent = true;
    state.agents.get("b")!.status = "failed";
    state.agents.get("b")!.confirmedByAgent = true;

    const effect = checkCompletion(state);
    expect(effect?.type).toBe("complete");
    expect(state.status).toBe("failed");
    if (effect?.type === "complete") {
      expect(effect.result.status).toBe("failed");
    }
  });

  it("sets status to 'completed_with_errors' when some agents failed and some completed", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a"), makeAgent("b"), makeAgent("c")]));
    state.agents.get("a")!.status = "completed";
    state.agents.get("a")!.confirmedByAgent = true;
    state.agents.get("b")!.status = "failed";
    state.agents.get("b")!.confirmedByAgent = true;
    state.agents.get("c")!.status = "completed";
    state.agents.get("c")!.confirmedByAgent = true;

    const effect = checkCompletion(state);
    expect(effect?.type).toBe("complete");
    expect(state.status).toBe("completed_with_errors");
    if (effect?.type === "complete") {
      expect(effect.result.status).toBe("completed_with_errors");
    }
  });

  it("uses agentState.status=completed even when lastReport is missing", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a"), makeAgent("b")]));
    // Agent A has a report
    state.agents.get("a")!.status = "completed";
    state.agents.get("a")!.confirmedByAgent = true;
    state.agents.get("a")!.lastReport = {
      status: "completed",
      summary: "Done A",
      timestamp: new Date().toISOString(),
    };
    // Agent B was marked completed via [AGENT_DONE] but never sent a report
    state.agents.get("b")!.status = "completed";
    state.agents.get("b")!.confirmedByAgent = true;
    state.agents.get("b")!.lastReport = undefined;

    const effect = checkCompletion(state);
    expect(effect?.type).toBe("complete");
    if (effect?.type === "complete") {
      expect(effect.result.agentResults["a"].status).toBe("completed");
      expect(effect.result.agentResults["b"].status).toBe("completed");
    }
  });
});

describe("handleCancellation", () => {
  it("cancels active agents and returns complete effect", () => {
    const agents = [makeAgent("a", "wf-a"), makeAgent("b", "wf-b")];
    const state = createOrchestratorState(makeParams(agents));
    state.agents.get("a")!.status = "active";
    state.agents.get("b")!.status = "completed";

    const effects = handleCancellation(state);

    expect(state.status).toBe("cancelled");

    const cancels = effects.filter((e) => e.type === "cancel_agent");
    expect(cancels).toHaveLength(1); // only active agent

    const completes = effects.filter((e) => e.type === "complete");
    expect(completes).toHaveLength(1);
  });
});

describe("handleBroadcastRelay", () => {
  it("generates broadcast and emit effects", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));

    const effects = handleBroadcastRelay(state, {
      fromAgentId: "a",
      content: "Hello everyone",
    });

    const broadcasts = effects.filter((e) => e.type === "broadcast_to_agents");
    expect(broadcasts).toHaveLength(1);
    if (broadcasts[0].type === "broadcast_to_agents") {
      expect(broadcasts[0].excludeShortIds).toContain("a");
    }
  });
});

describe("getAgentViewStates", () => {
  it("maps all agents to view states", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a"), makeAgent("b")]));
    state.agents.get("a")!.status = "active";

    const views = getAgentViewStates(state);
    expect(views).toHaveLength(2);
    expect(views.find((v) => v.shortId === "a")?.status).toBe("active");
    expect(views.find((v) => v.shortId === "b")?.status).toBe("pending");
  });
});

describe("getEventsSince", () => {
  it("returns events from cursor without clearing", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    state.eventLog.push({ type: "orchestrator_thinking", content: "test" });
    state.eventLog.push({ type: "orchestrator_thinking", content: "test2" });

    const { events, cursor } = getEventsSince(state, 0);
    expect(events).toHaveLength(2);
    expect(cursor).toBe(2);
    // Events are NOT cleared
    expect(state.eventLog).toHaveLength(2);
  });

  it("returns only new events from a given cursor", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    state.eventLog.push({ type: "orchestrator_thinking", content: "old" });
    state.eventLog.push({ type: "orchestrator_thinking", content: "new" });

    const { events, cursor } = getEventsSince(state, 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "orchestrator_thinking", content: "new" });
    expect(cursor).toBe(2);
  });
});

describe("drainEvents (deprecated)", () => {
  it("returns and clears event log", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    state.eventLog.push({ type: "orchestrator_thinking", content: "test" });
    state.eventLog.push({ type: "orchestrator_thinking", content: "test2" });

    const events = drainEvents(state);
    expect(events).toHaveLength(2);
    expect(state.eventLog).toHaveLength(0);
  });
});

// =========================================================================
// New tool-based orchestrator flow
// =========================================================================

describe("getOrchestratorTools", () => {
  it("returns tools with agent IDs in description", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a"), makeAgent("b")]));
    const tools = getOrchestratorTools(state);

    expect(tools).toHaveLength(3);
    const directive = tools.find((t) => t.name === "send_agent_directive");
    expect(directive).toBeDefined();
    expect(directive!.description).toContain("a");
    expect(directive!.description).toContain("b");

    expect(tools.find((t) => t.name === "mark_agent_done")).toBeDefined();
    expect(tools.find((t) => t.name === "broadcast_to_agents")).toBeDefined();
  });
});

describe("generateBriefAndFirstCall", () => {
  it("injects system + user messages and returns call_llm with tools", () => {
    const agents = [makeAgent("a", "wf-a"), makeAgent("b", "wf-b")];
    const state = createOrchestratorState(makeParams(agents));

    const effects = generateBriefAndFirstCall(state);

    // System prompt + user brief injected into history
    expect(state.messageHistory).toHaveLength(2);
    expect(state.messageHistory[0].role).toBe("system");
    expect(state.messageHistory[0].content).toContain("send_agent_directive");
    expect(state.messageHistory[1].role).toBe("user");
    expect(state.messageHistory[1].content).toContain("Create a design system");
    expect(state.messageHistory[1].content).toContain("a");

    // Returns call_llm with tools
    const llmCall = effects.find((e) => e.type === "call_llm");
    expect(llmCall).toBeDefined();
    if (llmCall?.type === "call_llm") {
      expect(llmCall.tools).toBeDefined();
      expect(llmCall.tools!.length).toBeGreaterThan(0);
    }
  });
});

describe("processOrchestratorLLMResponse", () => {
  it("handles send_agent_directive tool call", () => {
    const agents = [makeAgent("a", "wf-a"), makeAgent("b", "wf-b")];
    const state = createOrchestratorState(makeParams(agents));

    const effects = processOrchestratorLLMResponse(
      state,
      "Assigning work to agents.",
      [
        {
          id: "tc1",
          name: "send_agent_directive",
          arguments: { agentShortId: "#a", content: "Create buttons" },
        },
        {
          id: "tc2",
          name: "send_agent_directive",
          arguments: { agentShortId: "b", content: "Create colors" },
        },
      ]
    );

    // Directives sent
    const directives = effects.filter((e) => e.type === "send_directive");
    expect(directives).toHaveLength(2);

    // Agents marked active
    expect(state.agents.get("a")?.status).toBe("active");
    expect(state.agents.get("b")?.status).toBe("active");

    // Tool results injected into history
    const toolResults = state.messageHistory.filter((m) => m.role === "tool");
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0].content).toContain("success");

    // Continuation call_llm effect
    const continuation = effects.find((e) => e.type === "call_llm");
    expect(continuation).toBeDefined();

    // Events emitted
    const directiveEvents = state.eventLog.filter(
      (e) => e.type === "orchestrator_directive"
    );
    expect(directiveEvents).toHaveLength(2);
  });

  it("handles mark_agent_done tool call", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a", "wf-a")]));
    state.agents.get("a")!.status = "active";

    processOrchestratorLLMResponse(state, "Agent done.", [
      { id: "tc1", name: "mark_agent_done", arguments: { agentShortId: "a" } },
    ]);

    expect(state.agents.get("a")?.status).toBe("completed");
  });

  it("falls back to text [DIRECTIVE] parsing when no tool calls", () => {
    const agents = [makeAgent("a", "wf-a")];
    const state = createOrchestratorState(makeParams(agents));

    const effects = processOrchestratorLLMResponse(
      state,
      "[DIRECTIVE:#a]\nCreate buttons\n[/DIRECTIVE]"
    );

    const directives = effects.filter((e) => e.type === "send_directive");
    expect(directives).toHaveLength(1);
    expect(state.agents.get("a")?.status).toBe("active");
  });

  it("broadcasts text when no tool calls and no directives", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a", "wf-a")]));
    state.agents.get("a")!.status = "active";

    const effects = processOrchestratorLLMResponse(
      state,
      "Keep up the good work!"
    );

    const broadcasts = effects.filter((e) => e.type === "broadcast_to_agents");
    expect(broadcasts).toHaveLength(1);
  });

  it("handles unknown agent gracefully", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a", "wf-a")]));

    const effects = processOrchestratorLLMResponse(state, "", [
      {
        id: "tc1",
        name: "send_agent_directive",
        arguments: { agentShortId: "unknown", content: "Do something" },
      },
    ]);

    // No send_directive effect for unknown agent
    const directives = effects.filter((e) => e.type === "send_directive");
    expect(directives).toHaveLength(0);

    // Error injected as tool result
    const toolResult = state.messageHistory.find(
      (m) => m.role === "tool" && m.toolCallId === "tc1"
    );
    expect(toolResult?.content).toContain("not found");
  });

  it("resolves agent shortId with # prefix when map keys have #", () => {
    // Production scenario: shortIds stored with # prefix
    const state = createOrchestratorState(
      makeParams([makeAgent("#Figma-Desktop-abc", "wf-abc")])
    );

    const effects = processOrchestratorLLMResponse(state, "", [
      {
        id: "tc1",
        name: "send_agent_directive",
        arguments: { agentShortId: "#Figma-Desktop-abc", content: "Do work" },
      },
    ]);

    const directives = effects.filter((e) => e.type === "send_directive");
    expect(directives).toHaveLength(1);
    expect(state.agents.get("#Figma-Desktop-abc")?.status).toBe("active");
  });

  it("resolves agent shortId with ## prefix (LLM double-hash)", () => {
    const state = createOrchestratorState(
      makeParams([makeAgent("#Figma-Desktop-abc", "wf-abc")])
    );

    const effects = processOrchestratorLLMResponse(state, "", [
      {
        id: "tc1",
        name: "send_agent_directive",
        arguments: { agentShortId: "##Figma-Desktop-abc", content: "Do work" },
      },
    ]);

    const directives = effects.filter((e) => e.type === "send_directive");
    expect(directives).toHaveLength(1);
    expect(state.agents.get("#Figma-Desktop-abc")?.status).toBe("active");
  });

  it("rejects directive to agent with active directive (not yet completed)", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a", "wf-a")]));
    state.agents.get("a")!.status = "active";
    // No lastReport or lastReport.status !== "completed" → agent is still working

    const effects = processOrchestratorLLMResponse(state, "", [
      {
        id: "tc1",
        name: "send_agent_directive",
        arguments: { agentShortId: "a", content: "Do something else" },
      },
    ]);

    // No directive sent — blocked by guard
    const directives = effects.filter((e) => e.type === "send_directive");
    expect(directives).toHaveLength(0);

    // Error injected as tool result
    const toolResult = state.messageHistory.find(
      (m) => m.role === "tool" && m.toolCallId === "tc1"
    );
    expect(toolResult?.content).toContain("still working");
  });

  it("allows directive to agent that completed previous directive (standby)", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a", "wf-a")]));
    state.agents.get("a")!.status = "active";
    state.agents.get("a")!.lastReport = {
      status: "completed",
      summary: "Done with first task",
      timestamp: new Date().toISOString(),
    };

    const effects = processOrchestratorLLMResponse(state, "", [
      {
        id: "tc1",
        name: "send_agent_directive",
        arguments: { agentShortId: "a", content: "Now do second task" },
      },
    ]);

    // Directive should be sent — agent completed previous work
    const directives = effects.filter((e) => e.type === "send_directive");
    expect(directives).toHaveLength(1);
  });

  it("resolves agent shortId without # when map keys have #", () => {
    const state = createOrchestratorState(
      makeParams([makeAgent("#Figma-Desktop-abc", "wf-abc")])
    );

    const effects = processOrchestratorLLMResponse(state, "", [
      {
        id: "tc1",
        name: "send_agent_directive",
        arguments: { agentShortId: "Figma-Desktop-abc", content: "Do work" },
      },
    ]);

    const directives = effects.filter((e) => e.type === "send_directive");
    expect(directives).toHaveLength(1);
    expect(state.agents.get("#Figma-Desktop-abc")?.status).toBe("active");
  });
});
