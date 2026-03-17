import { describe, it, expect } from "vitest";
import {
  createAgentState,
  handleDirective,
  handlePeerMessage,
  handleBroadcast,
  handleSubConvMessage,
  handleAgentDirectory,
  handlePluginDisconnected,
  handleSubConvInvite,
  handleSubConvClose,
  processQueues,
  processLLMResponse,
  injectToolResult,
  reviewFigmaCode,
} from "../engine/agent-logic.js";
import type { AgentId } from "../types/signals.js";

function makeAgentId(shortId = "figma-1"): AgentId {
  return {
    shortId,
    workflowId: `wf-${shortId}`,
    label: `Agent ${shortId}`,
    type: "figma-plugin",
    pluginClientId: `client-${shortId}`,
  };
}

describe("createAgentState", () => {
  it("initializes with empty queues", () => {
    const state = createAgentState(makeAgentId());
    expect(state.directiveQueue).toHaveLength(0);
    expect(state.peerMessageQueue).toHaveLength(0);
    expect(state.broadcastQueue).toHaveLength(0);
    expect(state.subConvMessageQueue).toHaveLength(0);
    expect(state.subConvActive).toBeNull();
    expect(state.disconnected).toBe(false);
    expect(state.completed).toBe(false);
    expect(state.stepCount).toBe(0);
  });
});

describe("signal handlers", () => {
  it("handleDirective queues directive", () => {
    const state = createAgentState(makeAgentId());
    handleDirective(state, {
      directiveId: "d1",
      content: "Do something",
    });
    expect(state.directiveQueue).toHaveLength(1);
    expect(state.directiveQueue[0].content).toBe("Do something");
  });

  it("handlePeerMessage queues message", () => {
    const state = createAgentState(makeAgentId());
    handlePeerMessage(state, {
      fromAgentId: "figma-2",
      content: "Hello",
    });
    expect(state.peerMessageQueue).toHaveLength(1);
  });

  it("handleBroadcast queues broadcast", () => {
    const state = createAgentState(makeAgentId());
    handleBroadcast(state, {
      fromAgentId: "figma-2",
      content: "Announcement",
    });
    expect(state.broadcastQueue).toHaveLength(1);
  });

  it("handleSubConvMessage queues message", () => {
    const state = createAgentState(makeAgentId());
    handleSubConvMessage(state, {
      subConvId: "sc1",
      fromAgentId: "figma-2",
      content: "In sub-conv",
    });
    expect(state.subConvMessageQueue).toHaveLength(1);
  });

  it("handleAgentDirectory sets directory", () => {
    const state = createAgentState(makeAgentId());
    handleAgentDirectory(state, {
      agents: { "figma-2": makeAgentId("figma-2") },
      orchestratorWorkflowId: "orch-wf",
    });
    expect(state.agentDirectory.size).toBe(1);
    expect(state.orchestratorWorkflowId).toBe("orch-wf");
  });

  it("handlePluginDisconnected sets flag", () => {
    const state = createAgentState(makeAgentId());
    handlePluginDisconnected(state);
    expect(state.disconnected).toBe(true);
  });
});

describe("handleSubConvInvite", () => {
  it("accepts when no active sub-conversation", () => {
    const state = createAgentState(makeAgentId());
    handleAgentDirectory(state, {
      agents: { "figma-2": makeAgentId("figma-2") },
      orchestratorWorkflowId: "orch-wf",
    });

    const effect = handleSubConvInvite(state, {
      subConvId: "sc1",
      initiatorId: "figma-2",
      participantIds: ["figma-1"],
      topic: "Discuss colors",
      durationMs: 120_000,
    });

    expect(state.subConvActive).not.toBeNull();
    expect(state.subConvActive?.topic).toBe("Discuss colors");
    expect(effect?.type).toBe("send_sub_conv_response");
    if (effect?.type === "send_sub_conv_response") {
      expect(effect.response.accepted).toBe(true);
    }
  });

  it("declines when already in a sub-conversation", () => {
    const state = createAgentState(makeAgentId());
    handleAgentDirectory(state, {
      agents: { "figma-2": makeAgentId("figma-2"), "figma-3": makeAgentId("figma-3") },
      orchestratorWorkflowId: "orch-wf",
    });

    // Accept first invite
    handleSubConvInvite(state, {
      subConvId: "sc1",
      initiatorId: "figma-2",
      participantIds: ["figma-1"],
      topic: "First",
      durationMs: 120_000,
    });

    // Decline second invite
    const effect = handleSubConvInvite(state, {
      subConvId: "sc2",
      initiatorId: "figma-3",
      participantIds: ["figma-1"],
      topic: "Second",
      durationMs: 120_000,
    });

    expect(state.subConvActive?.id).toBe("sc1"); // Still first
    if (effect?.type === "send_sub_conv_response") {
      expect(effect.response.accepted).toBe(false);
    }
  });
});

describe("handleSubConvClose", () => {
  it("clears active sub-conversation", () => {
    const state = createAgentState(makeAgentId());
    state.subConvActive = {
      id: "sc1",
      initiatorId: "figma-2",
      participantIds: ["figma-1"],
      topic: "Test",
      durationMs: 120_000,
      startedAt: new Date().toISOString(),
    };

    handleSubConvClose(state, { subConvId: "sc1", reason: "completed" });
    expect(state.subConvActive).toBeNull();
  });

  it("ignores close for different sub-conversation", () => {
    const state = createAgentState(makeAgentId());
    state.subConvActive = {
      id: "sc1",
      initiatorId: "figma-2",
      participantIds: ["figma-1"],
      topic: "Test",
      durationMs: 120_000,
      startedAt: new Date().toISOString(),
    };

    handleSubConvClose(state, { subConvId: "sc-OTHER", reason: "completed" });
    expect(state.subConvActive).not.toBeNull();
  });
});

describe("processQueues", () => {
  it("produces call_llm effect when there is input", () => {
    const state = createAgentState(makeAgentId());
    handleDirective(state, { directiveId: "d1", content: "Do stuff" });

    const effects = processQueues(state);
    expect(effects.some((e) => e.type === "call_llm")).toBe(true);
    expect(state.directiveQueue).toHaveLength(0);
    expect(state.messageHistory).toHaveLength(1);
    expect(state.messageHistory[0].content).toContain("[Orchestrator task] Do stuff");
  });

  it("produces wait_for_input when queues are empty", () => {
    const state = createAgentState(makeAgentId());
    const effects = processQueues(state);
    expect(effects).toHaveLength(1);
    expect(effects[0].type).toBe("wait_for_input");
  });

  it("reports interrupted when disconnected", () => {
    const state = createAgentState(makeAgentId());
    handleDirective(state, { directiveId: "d1", content: "Work" });
    handlePluginDisconnected(state);

    const effects = processQueues(state);
    expect(effects.some((e) => e.type === "report_to_orchestrator")).toBe(true);
    expect(effects.some((e) => e.type === "complete")).toBe(true);
    expect(state.completed).toBe(true);
  });

  it("injects peer messages with prefix", () => {
    const state = createAgentState(makeAgentId());
    handlePeerMessage(state, { fromAgentId: "figma-2", content: "Hey" });

    processQueues(state);
    expect(state.messageHistory[0].content).toBe("[Message from #figma-2] Hey");
  });

  it("injects broadcast messages with prefix", () => {
    const state = createAgentState(makeAgentId());
    handleBroadcast(state, { fromAgentId: "figma-2", content: "All" });

    processQueues(state);
    expect(state.messageHistory[0].content).toBe("[Broadcast from #figma-2] All");
  });

  it("injects sub-conv messages with prefix", () => {
    const state = createAgentState(makeAgentId());
    handleSubConvMessage(state, {
      subConvId: "sc1",
      fromAgentId: "figma-2",
      content: "Thread msg",
    });

    processQueues(state);
    expect(state.messageHistory[0].content).toBe(
      "[Sub-conversation with #figma-2] Thread msg"
    );
  });
});

describe("processLLMResponse", () => {
  it("reports in-progress when no tool calls", () => {
    const state = createAgentState(makeAgentId());

    const effects = processLLMResponse(state, "I'm working on it");

    expect(state.messageHistory).toHaveLength(1);
    expect(state.stepCount).toBe(1);

    const reports = effects.filter((e) => e.type === "report_to_orchestrator");
    expect(reports).toHaveLength(1);
    if (reports[0].type === "report_to_orchestrator") {
      expect(reports[0].report.status).toBe("in_progress");
    }
  });

  it("handles signal_task_complete tool call", () => {
    const state = createAgentState(makeAgentId());

    const effects = processLLMResponse(state, "Done!", [
      {
        id: "tc1",
        name: "signal_task_complete",
        arguments: { summary: "All done" },
      },
    ]);

    expect(state.completed).toBe(true);
    expect(effects.some((e) => e.type === "report_to_orchestrator")).toBe(true);
    expect(effects.some((e) => e.type === "complete")).toBe(true);
  });

  it("handles send_peer_message tool call", () => {
    const state = createAgentState(makeAgentId());
    state.agentDirectory.set("figma-2", makeAgentId("figma-2"));

    const effects = processLLMResponse(state, "Sending msg", [
      {
        id: "tc1",
        name: "send_peer_message",
        arguments: { targetAgentId: "figma-2", content: "Need help" },
      },
    ]);

    const peerEffects = effects.filter((e) => e.type === "send_peer_message");
    expect(peerEffects).toHaveLength(1);
  });

  it("handles figma_plugin_execute tool call (review_and_execute effect)", () => {
    const state = createAgentState(makeAgentId());

    const effects = processLLMResponse(state, "Executing", [
      {
        id: "tc1",
        name: "figma_plugin_execute",
        arguments: { code: "figma.createRectangle()" },
      },
    ]);

    // Should produce a review_and_execute_figma_code effect
    const reviewExecEffects = effects.filter((e) => e.type === "review_and_execute_figma_code");
    expect(reviewExecEffects).toHaveLength(1);
    if (reviewExecEffects[0].type === "review_and_execute_figma_code") {
      expect(reviewExecEffects[0].code).toBe("figma.createRectangle()");
      expect(reviewExecEffects[0].toolCallId).toBe("tc1");
    }

    // No tool result injected by engine (adapter handles it after review+exec)
    const toolResults = state.messageHistory.filter((m) => m.role === "tool");
    expect(toolResults).toHaveLength(0);
  });

  it("rejects figma code with known issues via linter", () => {
    const state = createAgentState(makeAgentId());

    const effects = processLLMResponse(state, "Setting fill", [
      {
        id: "tc1",
        name: "figma_plugin_execute",
        arguments: { code: "circle.fills = [{type: 'SOLID', color: {r: 0, g: 1, b: 0, a: 1}}]" },
      },
    ]);

    // No review_and_execute effect — rejected by linter
    const reviewExecEffects = effects.filter((e) => e.type === "review_and_execute_figma_code");
    expect(reviewExecEffects).toHaveLength(0);

    // Error injected into history
    const lastMsg = state.messageHistory[state.messageHistory.length - 1];
    expect(lastMsg.role).toBe("tool");
    expect(lastMsg.content).toContain("codeReview");
  });

  it("blocks signal_task_complete when failures > successes", () => {
    const state = createAgentState(makeAgentId());
    state.execStats = { success: 1, fail: 3 };

    processLLMResponse(state, "All done", [
      { id: "tc1", name: "signal_task_complete", arguments: { summary: "Done" } },
    ]);

    expect(state.completed).toBe(false);
    const lastMsg = state.messageHistory[state.messageHistory.length - 1];
    expect(lastMsg.role).toBe("tool");
    expect(lastMsg.content).toContain("WARNING");
  });

  it("allows signal_task_complete when successes >= failures", () => {
    const state = createAgentState(makeAgentId());
    state.execStats = { success: 3, fail: 1 };

    const effects = processLLMResponse(state, "All done", [
      { id: "tc1", name: "signal_task_complete", arguments: { summary: "Done" } },
    ]);

    expect(state.completed).toBe(true);
    expect(effects.some((e) => e.type === "complete")).toBe(true);
  });

  it("handles start_sub_conversation tool call", () => {
    const state = createAgentState(makeAgentId());
    state.agentDirectory.set("figma-2", makeAgentId("figma-2"));

    const effects = processLLMResponse(state, "Starting sub-conv", [
      {
        id: "tc1",
        name: "start_sub_conversation",
        arguments: { participantIds: ["figma-2"], topic: "Colors" },
      },
    ]);

    expect(state.subConvActive).not.toBeNull();
    const inviteEffects = effects.filter((e) => e.type === "send_sub_conv_invite");
    expect(inviteEffects).toHaveLength(1);
  });

  it("completes when MAX_STEPS reached", () => {
    const state = createAgentState(makeAgentId());
    state.stepCount = 19; // One below MAX_STEPS

    const effects = processLLMResponse(state, "Step 20", [
      { id: "tc1", name: "send_peer_message", arguments: { targetAgentId: "x", content: "y" } },
    ]);

    expect(state.completed).toBe(true);
    expect(effects.some((e) => e.type === "complete")).toBe(true);
  });
});

describe("reviewFigmaCode", () => {
  it("rejects code with alpha in color objects", () => {
    const code = "const node = figma.createRectangle();\nnode.fills = [{type: 'SOLID', color: {r: 1, g: 0, b: 0, a: 1}}]";
    const issues = reviewFigmaCode(code);
    expect(issues.some(i => i.includes('"a" key'))).toBe(true);
  });

  it("rejects figma.currentPage = assignment", () => {
    const issues = reviewFigmaCode("figma.currentPage = somePage;");
    expect(issues.some(i => i.includes("setCurrentPageAsync"))).toBe(true);
  });

  it("rejects partial code with undeclared variables", () => {
    const issues = reviewFigmaCode("ellipse.fills = [{type: 'SOLID', color: {r: 1, g: 0, b: 0}}];");
    expect(issues.some(i => i.includes("Undeclared variable"))).toBe(true);
    expect(issues.some(i => i.includes("ellipse"))).toBe(true);
  });

  it("accepts self-contained code with declared variables", () => {
    const code = `const ellipse = figma.createEllipse();
ellipse.resize(100, 100);
ellipse.fills = [{type: 'SOLID', color: {r: 1, g: 0, b: 0}}];`;
    const issues = reviewFigmaCode(code);
    expect(issues).toHaveLength(0);
  });

  it("does not flag figma globals", () => {
    const code = "figma.currentPage.selection = [figma.createEllipse()];";
    const issues = reviewFigmaCode(code);
    expect(issues).toHaveLength(0);
  });

  it("does not flag arrow function params", () => {
    const code = `const page = figma.currentPage;
const frame = page.children.find(child => child.type === 'FRAME');`;
    const issues = reviewFigmaCode(code);
    expect(issues).toHaveLength(0);
  });

  it("does not flag single-param arrow without parens", () => {
    const code = `const page = figma.currentPage;
const items = page.children.filter(n => n.visible);`;
    const issues = reviewFigmaCode(code);
    expect(issues).toHaveLength(0);
  });

  it("rejects figma.currentPage.width", () => {
    const code = `const centerX = figma.currentPage.width / 2;`;
    const issues = reviewFigmaCode(code);
    expect(issues.some(i => i.includes("width") || i.includes("infinite"))).toBe(true);
  });

  it("rejects page.width when page is used for dimensions", () => {
    const code = `const page = figma.currentPage;
const centerX = page.width / 2;`;
    const issues = reviewFigmaCode(code);
    expect(issues.some(i => i.includes("infinite"))).toBe(true);
  });

  it("accepts code using figma.viewport.center", () => {
    const code = `const center = figma.viewport.center;
const ellipse = figma.createEllipse();
ellipse.x = center.x - 50;`;
    const issues = reviewFigmaCode(code);
    expect(issues).toHaveLength(0);
  });
});

describe("injectToolResult", () => {
  it("adds tool result to message history", () => {
    const state = createAgentState(makeAgentId());
    injectToolResult(state, "tc1", '{"success": true}');

    expect(state.messageHistory).toHaveLength(1);
    expect(state.messageHistory[0].role).toBe("tool");
    expect(state.messageHistory[0].toolCallId).toBe("tc1");
  });
});
