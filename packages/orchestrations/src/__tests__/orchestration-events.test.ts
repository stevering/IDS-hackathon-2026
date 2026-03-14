import { describe, it, expect } from "vitest";
import {
  createOrchestratorState,
  getEventsSince,
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
// Tests — Cursor-based event reading (getEventsSince)
// ---------------------------------------------------------------------------

describe("getEventsSince — cursor-based event reading", () => {
  it("returns all events when sinceIndex is 0", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    state.eventLog.push(
      { type: "orchestrator_thinking", content: "step 1" },
      { type: "orchestrator_thinking", content: "step 2" },
      { type: "orchestrator_thinking", content: "step 3" },
    );

    const { events, cursor } = getEventsSince(state, 0);

    expect(events).toHaveLength(3);
    expect(cursor).toBe(3);
  });

  it("does NOT clear the event log after reading", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    state.eventLog.push(
      { type: "orchestrator_thinking", content: "event A" },
      { type: "orchestrator_thinking", content: "event B" },
    );

    getEventsSince(state, 0);

    expect(state.eventLog).toHaveLength(2);
  });

  it("returns only new events when sinceIndex matches previous cursor", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    state.eventLog.push(
      { type: "orchestrator_thinking", content: "event 1" },
      { type: "orchestrator_thinking", content: "event 2" },
    );

    // First read: get all events
    const first = getEventsSince(state, 0);
    expect(first.events).toHaveLength(2);
    expect(first.cursor).toBe(2);

    // Add more events
    state.eventLog.push(
      { type: "orchestrator_thinking", content: "event 3" },
    );

    // Second read: only new events since cursor=2
    const second = getEventsSince(state, first.cursor);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toEqual({ type: "orchestrator_thinking", content: "event 3" });
    expect(second.cursor).toBe(3);
  });

  it("returns empty events when cursor is up to date", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    state.eventLog.push(
      { type: "orchestrator_thinking", content: "event A" },
    );

    const { events, cursor } = getEventsSince(state, 1);
    expect(events).toHaveLength(0);
    expect(cursor).toBe(1);
  });

  it("multiple clients with independent cursors see all events", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));

    // Push initial events
    state.eventLog.push(
      { type: "orchestrator_thinking", content: "event 1" },
      { type: "orchestrator_thinking", content: "event 2" },
    );

    // Client A reads all events
    const clientA1 = getEventsSince(state, 0);
    expect(clientA1.events).toHaveLength(2);

    // Client B reads all events (same data — not cleared)
    const clientB1 = getEventsSince(state, 0);
    expect(clientB1.events).toHaveLength(2);

    // Push more events
    state.eventLog.push(
      { type: "orchestrator_thinking", content: "event 3" },
    );

    // Client A reads only new events
    const clientA2 = getEventsSince(state, clientA1.cursor);
    expect(clientA2.events).toHaveLength(1);
    expect(clientA2.events[0]).toEqual({ type: "orchestrator_thinking", content: "event 3" });

    // Client B reads only new events (same result)
    const clientB2 = getEventsSince(state, clientB1.cursor);
    expect(clientB2.events).toHaveLength(1);
    expect(clientB2.events[0]).toEqual({ type: "orchestrator_thinking", content: "event 3" });
  });

  it("late-connecting client (cursor=0) gets full history", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));

    // Simulate events over time
    state.eventLog.push(
      { type: "orchestrator_thinking", content: "early event" },
      { type: "orchestrator_directive", agentShortId: "a", content: "do stuff" },
      { type: "agent_report", agentShortId: "a", report: { status: "completed", timestamp: "t" } },
    );

    // A new client connects late with cursor=0
    const { events, cursor } = getEventsSince(state, 0);
    expect(events).toHaveLength(3);
    expect(cursor).toBe(3);
  });

  it("defaults sinceIndex to 0 when omitted", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    state.eventLog.push(
      { type: "orchestrator_thinking", content: "test" },
    );

    const { events, cursor } = getEventsSince(state);
    expect(events).toHaveLength(1);
    expect(cursor).toBe(1);
  });

  it("returned events are independent copies (no shared reference)", () => {
    const state = createOrchestratorState(makeParams([makeAgent("a")]));
    state.eventLog.push({ type: "orchestrator_thinking", content: "original" });

    const { events } = getEventsSince(state, 0);

    // Mutating the returned array should not affect state
    events.push({ type: "orchestrator_thinking", content: "injected" });
    expect(state.eventLog).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — Legacy drainEvents (deprecated, kept for backward compat)
// ---------------------------------------------------------------------------

describe("drainEvents (deprecated)", () => {
  it("returns and clears event log", () => {
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

    const first = drainEvents(state);
    expect(first).toHaveLength(2);

    const second = drainEvents(state);
    expect(second).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — createOrchestratorState isolation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests — getAgentViewStates isolation
// ---------------------------------------------------------------------------

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
    const state1 = createOrchestratorState(makeParams([makeAgent("a")]));
    state1.agents.get("a")!.status = "active";
    const views1 = getAgentViewStates(state1);
    expect(views1[0].status).toBe("active");

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

    expect(viewsB.find((v) => v.shortId === "x")?.status).toBe("pending");
    expect(viewsB.find((v) => v.shortId === "y")?.status).toBe("pending");
  });
});
