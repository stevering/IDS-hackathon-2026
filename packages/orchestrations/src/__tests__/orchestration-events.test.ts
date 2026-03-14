import { describe, it, expect } from "vitest";
import {
  createOrchestratorState,
  drainEvents,
  getAgentViewStates,
} from "../engine/orchestrator-logic.js";
import type { StartOrchestrationParams } from "../types/agents.js";
import type { AgentId } from "../types/signals.js";

// ---------------------------------------------------------------------------
// Helpers (same pattern as orchestrator-logic.test.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests — Conversation isolation: event draining and state boundaries
// ---------------------------------------------------------------------------

describe("Conversation isolation — drainEvents", () => {
  it("drainEvents clears the event log completely", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    state.eventLog.push(
      { type: "orchestrator_thinking", content: "step 1" },
      { type: "orchestrator_thinking", content: "step 2" },
      { type: "orchestrator_thinking", content: "step 3" },
    );

    const drained = drainEvents(state);

    expect(drained).toHaveLength(3);
    expect(state.eventLog).toHaveLength(0);
  });

  it("subsequent drain after clear returns empty array", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    state.eventLog.push(
      { type: "orchestrator_thinking", content: "event A" },
      { type: "orchestrator_thinking", content: "event B" },
    );

    // First drain: should return the 2 events
    const first = drainEvents(state);
    expect(first).toHaveLength(2);

    // Second drain: should return nothing (state was cleared)
    const second = drainEvents(state);
    expect(second).toHaveLength(0);
  });

  it("drained events are independent copies (no shared reference)", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    state.eventLog.push({ type: "orchestrator_thinking", content: "original" });

    const drained = drainEvents(state);

    // Mutating the returned array should not affect state
    drained.push({ type: "orchestrator_thinking", content: "injected" });
    expect(state.eventLog).toHaveLength(0);
  });

  it("new events added after drain do not include old events", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));

    // Simulate first conversation: some events
    state.eventLog.push(
      { type: "orchestrator_thinking", content: "conv1-event1" },
      { type: "orchestrator_thinking", content: "conv1-event2" },
    );
    const conv1Events = drainEvents(state);
    expect(conv1Events).toHaveLength(2);

    // Simulate second conversation: new events
    state.eventLog.push(
      { type: "orchestrator_thinking", content: "conv2-event1" },
    );
    const conv2Events = drainEvents(state);

    expect(conv2Events).toHaveLength(1);
    expect(conv2Events[0]).toEqual({
      type: "orchestrator_thinking",
      content: "conv2-event1",
    });
  });
});

describe("Conversation isolation — createOrchestratorState", () => {
  it("initializes with an empty eventLog", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    expect(state.eventLog).toHaveLength(0);
  });

  it("each call creates an independent state (no shared references)", () => {
    const agents = [makeAgent("a")];
    const state1 = createOrchestratorState(makeParams(agents));
    const state2 = createOrchestratorState(makeParams(agents));

    state1.eventLog.push({ type: "orchestrator_thinking", content: "only in state1" });

    expect(state1.eventLog).toHaveLength(1);
    expect(state2.eventLog).toHaveLength(0);
  });

  it("new state has empty messageHistory, pendingReports, and userInputQueue", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a"), makeAgent("b")]));
    expect(state.messageHistory).toHaveLength(0);
    expect(state.pendingReports).toHaveLength(0);
    expect(state.userInputQueue).toHaveLength(0);
  });
});

describe("Conversation isolation — getAgentViewStates", () => {
  it("returns correct agent states from fresh state", () => {
    const state = createOrchestratorState(
      makeParams([makeAgent("a"), makeAgent("b")]),
    );
    const views = getAgentViewStates(state);

    expect(views).toHaveLength(2);
    expect(views.every((v) => v.status === "pending")).toBe(true);
    expect(views.every((v) => v.lastReport === undefined)).toBe(true);
  });

  it("agent view states reflect current status, not previous conversation state", () => {
    // Simulate first conversation: agent was active
    const state1 = createOrchestratorState(makeParams([makeAgent("a")]));
    state1.agents.get("a")!.status = "active";
    const views1 = getAgentViewStates(state1);
    expect(views1[0].status).toBe("active");

    // Simulate switching conversation: new state should be pending
    const state2 = createOrchestratorState(makeParams([makeAgent("a")]));
    const views2 = getAgentViewStates(state2);
    expect(views2[0].status).toBe("pending");
  });

  it("view states from one state object do not leak to another", () => {
    const agents = [makeAgent("x"), makeAgent("y")];
    const stateA = createOrchestratorState(makeParams(agents));
    const stateB = createOrchestratorState(makeParams(agents));

    stateA.agents.get("x")!.status = "completed";
    stateA.agents.get("y")!.status = "active";

    const viewsA = getAgentViewStates(stateA);
    const viewsB = getAgentViewStates(stateB);

    expect(viewsA.find((v) => v.shortId === "x")?.status).toBe("completed");
    expect(viewsA.find((v) => v.shortId === "y")?.status).toBe("active");

    // State B should still be fresh
    expect(viewsB.find((v) => v.shortId === "x")?.status).toBe("pending");
    expect(viewsB.find((v) => v.shortId === "y")?.status).toBe("pending");
  });
});
