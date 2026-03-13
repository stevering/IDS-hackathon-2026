/**
 * Client-safe entry point for Next.js API routes.
 *
 * This file re-exports only the client-safe parts of @guardian/temporal
 * using extensionless imports that turbopack can resolve.
 * Workflow functions are NOT exported here — they only work inside the
 * Temporal webpack sandbox.
 */

// Client
export { getTemporalClient, getTaskQueue } from "./client";

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
} from "./signals/definitions";

// Activity types
export type {
  LLMActivities,
  FigmaActivities,
  PresenceActivities,
  PersistenceActivities,
} from "./activities/types";

// Workflow types only
export type { AgentWorkflowInput } from "./workflows/types";
