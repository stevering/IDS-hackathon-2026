import { describe, it, expect } from "vitest";
import {
  createAgentState,
  processLLMResponse,
  processQueues,
  type AgentWorkflowState,
} from "../engine/agent-logic.js";
import type { AgentId, LLMToolDefinition } from "../index.js";

function makeAgentId(shortId = "figma-1"): AgentId {
  return {
    shortId,
    workflowId: `wf-${shortId}`,
    label: `Agent ${shortId}`,
    type: "figma-plugin",
    pluginClientId: `client-${shortId}`,
  };
}

function makeStateWithExternalTools(tools: LLMToolDefinition[]): AgentWorkflowState {
  const state = createAgentState(makeAgentId());
  state.externalTools = tools;
  state.orchestratorWorkflowId = "orch-test";
  state.lastDirectiveContent = "Test directive";
  // Inject system message so processLLMResponse works
  state.messageHistory.push({ role: "system", content: "You are a test agent." });
  return state;
}

const MOCK_MCP_TOOLS: LLMToolDefinition[] = [
  {
    name: "figmaconsole_create_child",
    description: "Create a child node",
    parameters: {
      type: "object",
      properties: {
        parentId: { type: "string" },
        type: { type: "string" },
      },
      required: ["parentId", "type"],
    },
  },
  {
    name: "figmaconsole_set_fills",
    description: "Set fills on a node",
    parameters: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        fills: { type: "array" },
      },
      required: ["nodeId", "fills"],
    },
  },
  {
    name: "github_search_code",
    description: "Search code in a repository",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
];

describe("External MCP tools in agent engine", () => {
  describe("externalTools in agent state", () => {
    it("starts with no external tools by default", () => {
      const state = createAgentState(makeAgentId());
      expect(state.externalTools).toBeUndefined();
    });

    it("accepts external tools", () => {
      const state = makeStateWithExternalTools(MOCK_MCP_TOOLS);
      expect(state.externalTools).toHaveLength(3);
    });
  });

  describe("processLLMResponse with external tools", () => {
    it("produces execute_external_tool effect for known MCP tool", () => {
      const state = makeStateWithExternalTools(MOCK_MCP_TOOLS);

      const effects = processLLMResponse(
        state,
        "I'll create a child node.",
        [
          {
            id: "tc-1",
            name: "figmaconsole_create_child",
            arguments: { parentId: "0:1", type: "FRAME" },
          },
        ],
      );

      const externalEffects = effects.filter((e) => e.type === "execute_external_tool");
      expect(externalEffects).toHaveLength(1);

      const ext = externalEffects[0];
      if (ext.type !== "execute_external_tool") throw new Error("Wrong type");
      expect(ext.toolName).toBe("figmaconsole_create_child");
      expect(ext.arguments).toEqual({ parentId: "0:1", type: "FRAME" });
      expect(ext.toolCallId).toBe("tc-1");
    });

    it("produces execute_external_tool for github tools", () => {
      const state = makeStateWithExternalTools(MOCK_MCP_TOOLS);

      const effects = processLLMResponse(
        state,
        "Searching code...",
        [
          {
            id: "tc-2",
            name: "github_search_code",
            arguments: { query: "function createFrame" },
          },
        ],
      );

      const externalEffects = effects.filter((e) => e.type === "execute_external_tool");
      expect(externalEffects).toHaveLength(1);

      const ext = externalEffects[0];
      if (ext.type !== "execute_external_tool") throw new Error("Wrong type");
      expect(ext.toolName).toBe("github_search_code");
    });

    it("injects error for truly unknown tools", () => {
      const state = makeStateWithExternalTools(MOCK_MCP_TOOLS);

      processLLMResponse(
        state,
        "Calling unknown tool",
        [
          {
            id: "tc-3",
            name: "nonexistent_tool",
            arguments: {},
          },
        ],
      );

      // The error should be injected as a tool result in the message history
      const toolResult = state.messageHistory.find(
        (m) => m.role === "tool" && m.toolCallId === "tc-3",
      );
      expect(toolResult).toBeDefined();
      expect(toolResult!.content).toContain("Unknown tool");
    });

    it("handles mixed engine + MCP tool calls", () => {
      const state = makeStateWithExternalTools(MOCK_MCP_TOOLS);

      const effects = processLLMResponse(
        state,
        "Doing multiple things",
        [
          {
            id: "tc-mcp",
            name: "figmaconsole_set_fills",
            arguments: { nodeId: "1:2", fills: [] },
          },
          {
            id: "tc-engine",
            name: "broadcast_message",
            arguments: { content: "Hello everyone" },
          },
        ],
      );

      const externalEffects = effects.filter((e) => e.type === "execute_external_tool");
      const broadcastEffects = effects.filter((e) => e.type === "send_broadcast");

      expect(externalEffects).toHaveLength(1);
      expect(broadcastEffects).toHaveLength(1);
    });

    it("includes external tools when processQueues generates call_llm", () => {
      const state = makeStateWithExternalTools(MOCK_MCP_TOOLS);
      // Add a directive to the queue so processQueues triggers call_llm
      state.directiveQueue.push({
        directiveId: "test-directive-1",
        content: "Create a frame",
      });

      const effects = processQueues(state);

      const callLlmEffect = effects.find((e) => e.type === "call_llm");
      expect(callLlmEffect).toBeDefined();
      if (callLlmEffect?.type !== "call_llm") throw new Error("Wrong type");

      const toolNames = callLlmEffect.tools.map((t) => t.name);
      expect(toolNames).toContain("figmaconsole_create_child");
      expect(toolNames).toContain("figmaconsole_set_fills");
      expect(toolNames).toContain("github_search_code");
      // Also has engine tools
      expect(toolNames).toContain("signal_task_complete");
      expect(toolNames).toContain("figma_plugin_execute");
    });
  });
});
