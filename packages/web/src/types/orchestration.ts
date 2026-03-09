/**
 * Collaborative Agents — Orchestration types
 *
 * These types define the payloads for Supabase Realtime broadcast events
 * used in the Collaborative Agents mode. All events are sent on the
 * channel `guardian:execute:{userId}` (same-user scope).
 */

// ---------------------------------------------------------------------------
// Agent roles
// ---------------------------------------------------------------------------

export type AgentRole = "idle" | "orchestrator" | "collaborator";

// ---------------------------------------------------------------------------
// Orchestration session (mirrors DB table)
// ---------------------------------------------------------------------------

export type Orchestration = {
  id: string;
  userId: string;
  orchestratorClientId: string;
  conversationId: string;
  status: "active" | "completed" | "cancelled";
  createdAt: string;
  completedAt: string | null;
};

// ---------------------------------------------------------------------------
// Broadcast event payloads
// ---------------------------------------------------------------------------

/** Base fields shared by all orchestration events */
type OrchestrationEventBase = {
  orchestrationId: string;
  senderId: string;
  senderShortId: string;
  conversationId: string;
};

/** Orchestrator invites a collaborator to join */
export type OrchestrationInvitePayload = OrchestrationEventBase & {
  task: string;
  context: Record<string, unknown>;
  expectedResult?: string;
};

/** Collaborator accepts an orchestration invite */
export type OrchestrationAcceptPayload = OrchestrationEventBase & {
  accepted: true;
  collaboratorConversationId: string;
};

/** Collaborator declines an orchestration invite */
export type OrchestrationDeclinePayload = OrchestrationEventBase & {
  accepted: false;
  reason?: string;
};

/** Orchestrator sends a task request to a collaborator */
export type AgentRequestPayload = OrchestrationEventBase & {
  requestId: string;
  targetClientId: string;
  content: string;
  context: Record<string, unknown>;
  expectedResult?: string;
  wantScreenshot?: boolean;
};

/** Collaborator sends a status/result back to the orchestrator */
export type AgentResponsePayload = OrchestrationEventBase & {
  requestId: string;
  status: "in_progress" | "completed" | "failed" | "needs_input";
  summary?: string;
  result?: Record<string, unknown>;
  screenshot?: string;
  changes?: AgentChange[];
};

/** Description of a single change made by a collaborator */
export type AgentChange = {
  type: "create" | "update" | "delete" | "style" | "layout" | "other";
  description: string;
  nodeId?: string;
  nodeName?: string;
};

/** Free-form inter-agent message (can come from either side) */
export type AgentMessagePayload = OrchestrationEventBase & {
  content: string;
  mentions?: string[];
  insertInActive?: boolean;
};

// ---------------------------------------------------------------------------
// Broadcast event union
// ---------------------------------------------------------------------------

export type OrchestrationEvent =
  | { event: "orchestration_invite"; payload: OrchestrationInvitePayload }
  | { event: "orchestration_accept"; payload: OrchestrationAcceptPayload }
  | { event: "orchestration_decline"; payload: OrchestrationDeclinePayload }
  | { event: "agent_request"; payload: AgentRequestPayload }
  | { event: "agent_response"; payload: AgentResponsePayload }
  | { event: "agent_message"; payload: AgentMessagePayload };

// ---------------------------------------------------------------------------
// User settings
// ---------------------------------------------------------------------------

export type UserCollaborationSettings = {
  autoAccept: boolean;
};
