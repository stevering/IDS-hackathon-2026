// Client
export { getTemporalClient, getTaskQueue } from "./client.js";

// Signal/query definitions (for use by API routes)
export {
  agentReportSignal,
  userInputSignal,
  subConvNotifySignal,
  broadcastSignal,
  stopSignal,
  statusQuery,
  directiveSignal,
  peerMessageSignal,
  agentBroadcastSignal,
  subConvInviteSignal,
  subConvMessageSignal,
  subConvCloseSignal,
  subConvResponseSignal,
  agentDirectorySignal,
  pluginDisconnectedSignal,
  agentReadySignal,
  agentDeclinedSignal,
} from "./signals/definitions.js";

// Activity types
export type {
  LLMActivities,
  FigmaActivities,
  PresenceActivities,
  PersistenceActivities,
} from "./activities/types.js";

// Workflow names (for client.workflow.start)
export { orchestratorWorkflow } from "./workflows/orchestrator.js";
export { agentWorkflow } from "./workflows/agent.js";
export type { AgentWorkflowInput } from "./workflows/agent.js";
