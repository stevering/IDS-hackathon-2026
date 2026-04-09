// Types
export * from "./types/index.js";

// Interfaces
export * from "./interfaces/index.js";

// Engine logic
export {
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
  processGuardrailBlocked,
  processAgentActivities,
  getAgentViewStates,
  getEventsSince,
  drainEvents,
  DEFAULT_MAX_DURATION_MS,
  IDLE_NUDGE_MS,
  GRACE_PERIOD_MS,
  type OrchestratorState,
  type OrchestratorEffect,
} from "./engine/orchestrator-logic.js";

export {
  createAgentState,
  handleDirective,
  handlePeerMessage,
  handleBroadcast,
  handleSubConvMessage,
  handleAgentDirectory,
  handlePluginDisconnected,
  handleTerminate,
  handleSubConvInvite,
  handleSubConvClose,
  processQueues,
  processLLMResponse,
  injectToolResult,
  reviewFigmaCode,
  recordExecResult,
  MAX_STEPS,
  type AgentWorkflowState,
  type AgentEffect,
} from "./engine/agent-logic.js";

export {
  createSubConversation,
  isSubConvTimedOut,
  createTimeoutClose,
  canJoinSubConversation,
  DEFAULT_SUB_CONV_DURATION_MS,
  MAX_SUB_CONV_DURATION_MS,
} from "./engine/sub-conversation.js";

export {
  resolveTargetWorkflowId,
  resolveBroadcastTargets,
  validatePeerTarget,
} from "./engine/routing.js";

// Logic utilities
export * from "./logic/index.js";

// MCP registry + bridge protocol
// Web (Turbopack) uses subpath: import ... from "@guardian/orchestrations/mcp"
// Temporal/overlay (tsx/vitest) uses this barrel re-export via .js extensions:
export * from "./mcp/registry.js";
export * from "./mcp/bridge-protocol.js";

