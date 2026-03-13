/**
 * Sub-conversation lifecycle management.
 *
 * Handles the scoped thread model where agents can open side-channels
 * while the main task continues in parallel.
 */

import type { SubConversationState } from "../types/agents.js";
import type { SubConvInvitePayload, SubConvClosePayload } from "../types/signals.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_SUB_CONV_DURATION_MS = 120_000; // 2 minutes
export const MAX_SUB_CONV_DURATION_MS = 300_000; // 5 minutes

// ---------------------------------------------------------------------------
// Create sub-conversation state
// ---------------------------------------------------------------------------

export function createSubConversation(
  invite: SubConvInvitePayload
): SubConversationState {
  return {
    id: invite.subConvId,
    initiatorId: invite.initiatorId,
    participantIds: invite.participantIds,
    topic: invite.topic,
    durationMs: Math.min(invite.durationMs, MAX_SUB_CONV_DURATION_MS),
    startedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Check if sub-conversation has timed out
// ---------------------------------------------------------------------------

export function isSubConvTimedOut(subConv: SubConversationState): boolean {
  const elapsed = Date.now() - new Date(subConv.startedAt).getTime();
  return elapsed >= subConv.durationMs;
}

// ---------------------------------------------------------------------------
// Generate timeout close payload
// ---------------------------------------------------------------------------

export function createTimeoutClose(subConv: SubConversationState): SubConvClosePayload {
  return {
    subConvId: subConv.id,
    reason: "timeout",
  };
}

// ---------------------------------------------------------------------------
// Validate that an agent can join a sub-conversation
// ---------------------------------------------------------------------------

export function canJoinSubConversation(
  currentSubConv: SubConversationState | null,
  invite: SubConvInvitePayload
): { canJoin: boolean; reason?: string } {
  if (currentSubConv !== null) {
    return {
      canJoin: false,
      reason: `Already in sub-conversation "${currentSubConv.topic}" (${currentSubConv.id})`,
    };
  }

  return { canJoin: true };
}
