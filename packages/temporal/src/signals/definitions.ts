/**
 * Temporal signal and query definitions.
 *
 * These are the Temporal-specific signal/query wrappers that
 * connect to the engine-agnostic signal types.
 */

import { defineSignal, defineQuery } from "@temporalio/workflow";
import type {
  DirectivePayload,
  AgentReportPayload,
  PeerMessagePayload,
  BroadcastPayload,
  SubConvInvitePayload,
  SubConvMessagePayload,
  SubConvClosePayload,
  SubConvResponsePayload,
  SubConvNotifyPayload,
  AgentDirectoryPayload,
  UserInputPayload,
  PluginDisconnectedPayload,
  AgentReadyPayload,
  AgentDeclinedPayload,
  GuardrailBlockedPayload,
  AgentActivityPayload,
} from "@guardian/orchestrations";
import type { OrchestrationStatusResponse } from "@guardian/orchestrations";

// ---------------------------------------------------------------------------
// Orchestrator workflow signals
// ---------------------------------------------------------------------------

/** Agent reports its status/result to the orchestrator */
export const agentReportSignal = defineSignal<[AgentReportPayload]>("agentReport");

/** User sends input during the orchestration */
export const userInputSignal = defineSignal<[UserInputPayload]>("userInput");

/** Agent notifies orchestrator about sub-conversation lifecycle */
export const subConvNotifySignal = defineSignal<[SubConvNotifyPayload]>("subConvNotify");

/** Agent sends a broadcast (orchestrator relays) */
export const broadcastSignal = defineSignal<[BroadcastPayload]>("broadcast");

/** Stop the orchestration */
export const stopSignal = defineSignal<[]>("stop");

/** Agent is ready */
export const agentReadySignal = defineSignal<[AgentReadyPayload]>("agentReady");

/** Agent declined */
export const agentDeclinedSignal = defineSignal<[AgentDeclinedPayload]>("agentDeclined");

/** Agent guardrail was triggered (blocked dangerous code) */
export const guardrailBlockedSignal = defineSignal<[GuardrailBlockedPayload]>("guardrailBlocked");

/** Agent internal activity (thinking, tool calls, code review) for UI visibility */
export const agentActivitySignal = defineSignal<[AgentActivityPayload]>("agentActivity");

// ---------------------------------------------------------------------------
// Agent workflow signals
// ---------------------------------------------------------------------------

/** Orchestrator sends a directive to an agent */
export const directiveSignal = defineSignal<[DirectivePayload]>("directive");

/** Peer-to-peer message from another agent */
export const peerMessageSignal = defineSignal<[PeerMessagePayload]>("peerMessage");

/** Broadcast message relayed from orchestrator or sent directly */
export const agentBroadcastSignal = defineSignal<[BroadcastPayload]>("agentBroadcast");

/** Sub-conversation invite */
export const subConvInviteSignal = defineSignal<[SubConvInvitePayload]>("subConvInvite");

/** Sub-conversation message */
export const subConvMessageSignal = defineSignal<[SubConvMessagePayload]>("subConvMessage");

/** Sub-conversation close */
export const subConvCloseSignal = defineSignal<[SubConvClosePayload]>("subConvClose");

/** Sub-conversation invite response */
export const subConvResponseSignal = defineSignal<[SubConvResponsePayload]>("subConvResponse");

/** Agent directory (set at startup) */
export const agentDirectorySignal = defineSignal<[AgentDirectoryPayload]>("agentDirectory");

/** Plugin disconnected notification */
export const pluginDisconnectedSignal = defineSignal<[PluginDisconnectedPayload]>("pluginDisconnected");

// ---------------------------------------------------------------------------
// Query definitions
// ---------------------------------------------------------------------------

/** Query the orchestration status (for SSE polling). Optional sinceIndex cursor for incremental reads. */
export const statusQuery = defineQuery<OrchestrationStatusResponse, [number?]>("status");
