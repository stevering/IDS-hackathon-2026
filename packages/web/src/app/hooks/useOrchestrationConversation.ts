"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Conversation } from "./useConversations";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UseOrchestrationConversationParams = {
  /** Active Temporal workflow ID (null when idle) */
  workflowId: string | null;
  /** Current active conversation ID */
  activeConversationId: string | null;
  /** All conversations */
  conversations: Conversation[];
  /** Switch to a conversation */
  switchConversation: (id: string) => void;
  /** When true, suppress auto-switch to the orchestration sub-conv (plugin behavior) */
  isFigmaPlugin?: boolean;
};

type UseOrchestrationConversationReturn = {
  /** Whether the user is currently viewing the orchestration conversation */
  isInOrchestrationConversation: boolean;
  /** The orchestration conversation ID (null when not yet propagated to the front state) */
  orchestrationConversationId: string | null;
  /** Switch to the orchestration conversation */
  switchToOrchestration: () => void;
  /** Switch back to the previous (pre-orchestration) conversation */
  switchBackToChat: () => void;
  /** Whether an orchestration conversation is known (active or completed) */
  hasActiveOrchestration: boolean;
  /** Whether the active conversation is the parent or sub-conv of the orchestration */
  isRelatedToOrchestration: boolean;
  /** Dismiss the orchestration (clear state, e.g. after user acknowledges completion) */
  dismiss: () => void;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Viewer-only hook around the orchestration sub-conversation.
 *
 * Sub-conversations are created exclusively by the server (via
 * /api/orchestration/start). This hook never creates anything — it only:
 *   - Finds the existing orchestration sub-conv from the conversations list
 *     (matched by workflowId in metadata, or by being the active conv itself).
 *   - Auto-switches the user to it on first detection (webapp only).
 *   - Provides navigation helpers between the sub-conv and the parent chat.
 *
 * If the sub-conv is not yet present in the front state (Realtime propagation
 * lag from a brand-new server-side insert), the hook simply waits — the next
 * render with an updated conversations array will pick it up.
 */
export function useOrchestrationConversation({
  workflowId,
  activeConversationId,
  conversations,
  switchConversation,
  isFigmaPlugin = false,
}: UseOrchestrationConversationParams): UseOrchestrationConversationReturn {
  const [orchestrationConvId, setOrchestrationConvId] = useState<string | null>(null);
  const previousConvIdRef = useRef<string | null>(null);
  // Workflows we've already auto-switched to in this session, so we don't
  // repeatedly steal focus if the user navigates away.
  const autoSwitchedWorkflowIds = useRef(new Set<string>());
  // Track the last known workflowId so we can find the conv even after completion
  const lastWorkflowIdRef = useRef<string | null>(null);

  // When a NEW workflowId arrives (different from the last one), reset the
  // local conv-id state so the next render resolves it for the new workflow.
  if (workflowId && lastWorkflowIdRef.current && workflowId !== lastWorkflowIdRef.current) {
    setOrchestrationConvId(null);
    previousConvIdRef.current = activeConversationId;
  }

  if (workflowId) {
    lastWorkflowIdRef.current = workflowId;
  }

  const searchId = workflowId ?? lastWorkflowIdRef.current;

  // Find existing orchestration conversation:
  // 1. If we have a workflowId hint, prefer the matching conv (created by
  //    the server in /api/orchestration/start).
  // 2. If the active conv IS itself an orch sub-conv (has metadata.workflowId),
  //    return it. Covers: user clicks an orch sub-conv from the sidebar after
  //    a refresh / once it has completed (no live workflowId in state).
  // 3. Fallback: any child of the active conv whose metadata carries a workflowId.
  //    Lets the parent-chat banner ("voir collab") light up from sidebar history.
  const existingOrchConv = (() => {
    if (searchId) {
      const byWorkflow = conversations.find(
        (c) => (c.metadata as Record<string, unknown>)?.workflowId === searchId
      );
      if (byWorkflow) return byWorkflow;
    }
    if (activeConversationId) {
      const activeConv = conversations.find((c) => c.id === activeConversationId);
      if (activeConv && (activeConv.metadata as Record<string, unknown>)?.workflowId) {
        return activeConv;
      }
      const childOrch = conversations
        .filter((c) => c.parent_id === activeConversationId)
        .filter((c) => !!(c.metadata as Record<string, unknown>)?.workflowId)
        .at(-1);
      if (childOrch) return childOrch;
    }
    return null;
  })();

  // Sync local state + auto-switch when the server-created sub-conv appears
  // in the conversations list. Auto-switch fires once per workflowId (webapp
  // only — plugin lets the user navigate via the banner).
  useEffect(() => {
    if (!workflowId || !existingOrchConv) return;

    if (orchestrationConvId !== existingOrchConv.id) {
      setOrchestrationConvId(existingOrchConv.id);
    }

    if (autoSwitchedWorkflowIds.current.has(workflowId)) return;
    autoSwitchedWorkflowIds.current.add(workflowId);

    if (!isFigmaPlugin && activeConversationId !== existingOrchConv.id) {
      previousConvIdRef.current = activeConversationId;
      switchConversation(existingOrchConv.id);
    }
  }, [workflowId, existingOrchConv, orchestrationConvId, activeConversationId, switchConversation, isFigmaPlugin]);

  const effectiveOrchConvId = orchestrationConvId ?? existingOrchConv?.id ?? null;

  const isInOrchestrationConversation =
    effectiveOrchConvId !== null && activeConversationId === effectiveOrchConvId;

  const switchToOrchestration = useCallback(() => {
    if (effectiveOrchConvId) {
      previousConvIdRef.current = activeConversationId;
      switchConversation(effectiveOrchConvId);
    }
  }, [effectiveOrchConvId, activeConversationId, switchConversation]);

  const switchBackToChat = useCallback(() => {
    // Use parent_id of the active orchestration conversation (most reliable)
    const orchConv = existingOrchConv ?? conversations.find(c => c.id === effectiveOrchConvId);
    const parentTarget = orchConv?.parent_id;
    const target = parentTarget ?? previousConvIdRef.current;
    if (target) {
      switchConversation(target);
    }
  }, [switchConversation, existingOrchConv, conversations, effectiveOrchConvId]);

  const dismiss = useCallback(() => {
    setOrchestrationConvId(null);
    lastWorkflowIdRef.current = null;
    previousConvIdRef.current = null;
    autoSwitchedWorkflowIds.current.clear();
  }, []);

  // Is the current conversation related to this orchestration? (parent or sub-conv)
  const orchConvObj = existingOrchConv ?? conversations.find(c => c.id === effectiveOrchConvId);
  const parentConvId = orchConvObj?.parent_id ?? null;
  const isRelatedToOrchestration = effectiveOrchConvId !== null && (
    activeConversationId === effectiveOrchConvId ||  // viewing the sub-conv
    activeConversationId === parentConvId            // viewing the parent conv
  );

  return {
    isInOrchestrationConversation,
    orchestrationConversationId: effectiveOrchConvId,
    switchToOrchestration,
    switchBackToChat,
    hasActiveOrchestration: effectiveOrchConvId !== null,
    isRelatedToOrchestration,
    dismiss,
  };
}
