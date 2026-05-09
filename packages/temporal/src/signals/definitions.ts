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

/** Terminate agent — sent by orchestrator via mark_agent_done */
export const terminateAgentSignal = defineSignal("terminateAgent");

// ---------------------------------------------------------------------------
// Chat workflow signals
// ---------------------------------------------------------------------------

/** User sends a new message in chat (follow-up or first message while workflow is idle) */
export const chatNewMessageSignal = defineSignal<[ChatNewMessagePayload]>("chatNewMessage");

/** User cancels the current chat generation */
export const chatCancelSignal = defineSignal("chatCancel");

/** Chat new message payload */
export type ChatNewMessagePayload = {
  content: string;
  /** Client-generated message ID (for dedup) */
  messageId?: string;
  /** Optional images attached to the message */
  images?: string[];
  /**
   * Optional model override for this turn. The /api/chat-temporal/[id]/message
   * route re-reads `user_settings` on every follow-up and passes the currently
   * preferred model here — so the workflow uses the freshest user preference
   * instead of the model that was baked in at workflow start. If omitted, the
   * workflow keeps using its previous model.
   */
  modelOverride?: string;
  /**
   * Optional Figma plugin clientId override for this turn. Mirrors
   * `modelOverride` so the user can switch the paired plugin per-message
   * (e.g. via the QCM disambiguation flow). Semantics:
   *   - `string`     → use this plugin for plugin-bound tool calls this turn
   *   - `null`       → unpair (REST-only mode this turn)
   *   - `undefined`  → keep the previous turn's value (no change)
   */
  pluginClientIdOverride?: string | null;
  /**
   * Optional per-turn disambiguation context. The frontend recomputes the
   * resolver on every send — when it returns "ambiguous" it forwards the
   * candidate list here so the worker's `request_target_disambiguation`
   * tool can synthesize an up-to-date QCM block. Semantics:
   *   - object     → set/replace currentPendingDisambiguation
   *   - null       → clear (resolver no longer ambiguous)
   *   - undefined  → keep the previous turn's value
   */
  pendingDisambiguationOverride?: {
    category: "design" | "code";
    candidates: { targetId: string; shortId: string; label: string; fileName?: string; fileKey?: string }[];
    suggestionTargetId: string;
  } | null;
  /** Per-turn override for the resolver kinds. Worker uses these for the
   *  code-bound enforcement (mirror of design plugin-bound). `null` means
   *  unset / not applicable; `undefined` means "no change from previous". */
  designPairingKindOverride?: "explicit" | "auto-resolved" | "ambiguous" | "no-plugin" | null;
  codePairingKindOverride?: "explicit" | "auto-resolved" | "ambiguous" | "none" | null;
};

/** Chat workflow status returned by chatStatusQuery */
export type ChatWorkflowStatus = {
  conversationId: string;
  status: "idle" | "streaming" | "tool_executing" | "completed" | "cancelled" | "error";
  /** Current streaming request ID (for Realtime subscription) */
  streamingRequestId?: string;
  /** Current step in the LLM ↔ tool loop */
  currentStep: number;
  /** Error message if status is "error" */
  errorMessage?: string;
};

// ---------------------------------------------------------------------------
// Query definitions
// ---------------------------------------------------------------------------

/** Query the orchestration status (for SSE polling). Optional sinceIndex cursor for incremental reads. */
export const statusQuery = defineQuery<OrchestrationStatusResponse, [number?]>("status");

/** Query the chat workflow status */
export const chatStatusQuery = defineQuery<ChatWorkflowStatus>("chatStatus");

/**
 * Query the chat workflow's bound conversationId.
 * Used as a defense-in-depth check: the /api/chat-temporal/[id]/message route
 * queries this before signalling a workflow, and if the client's requested
 * conversationId doesn't match, the route falls back to starting a new workflow
 * instead of cross-contaminating conversations with messages from the wrong one.
 */
export const chatConversationIdQuery = defineQuery<string>("chatConversationId");
