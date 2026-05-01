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
  /** Create a new conversation */
  createConversation: (opts?: {
    title?: string;
    parentId?: string;
    orchestrationId?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<Conversation | null>;
  /** Switch to a conversation */
  switchConversation: (id: string) => void;
  /** When true, suppress auto-switch on sub-conv creation (plugin behavior) */
  isFigmaPlugin?: boolean;
};

type UseOrchestrationConversationReturn = {
  /** Whether the user is currently viewing the orchestration conversation */
  isInOrchestrationConversation: boolean;
  /** The orchestration conversation ID (null if not created yet) */
  orchestrationConversationId: string | null;
  /** Switch to the orchestration conversation */
  switchToOrchestration: () => void;
  /** Switch back to the previous (pre-orchestration) conversation */
  switchBackToChat: () => void;
  /** Whether an orchestration conversation exists (active or completed) */
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
 * Manages the orchestration conversation lifecycle:
 * - Creates a conversation linked to the workflowId when orchestration starts
 * - Auto-switches to the orchestration conversation
 * - Keeps state after completion so the banner remains visible
 * - Provides navigation between orchestration and previous conversation
 */
export function useOrchestrationConversation({
  workflowId,
  activeConversationId,
  conversations,
  createConversation,
  switchConversation,
  isFigmaPlugin = false,
}: UseOrchestrationConversationParams): UseOrchestrationConversationReturn {
  const [orchestrationConvId, setOrchestrationConvId] = useState<string | null>(null);
  const previousConvIdRef = useRef<string | null>(null);
  const creatingRef = useRef(false);
  // Track which workflowIds have already been processed to prevent duplicates
  const processedWorkflowIds = useRef(new Set<string>());
  // Track the last known workflowId so we can find the conv even after completion
  const lastWorkflowIdRef = useRef<string | null>(null);

  // When a NEW workflowId arrives (different from the last one), dismiss the
  // previous orchestration so the UI starts fresh for the new workflow.
  if (workflowId && lastWorkflowIdRef.current && workflowId !== lastWorkflowIdRef.current) {
    // Reset state for the previous orchestration
    setOrchestrationConvId(null);
    previousConvIdRef.current = activeConversationId;
    // Don't clear processedWorkflowIds — keep history to avoid re-processing old ones
  }

  if (workflowId) {
    lastWorkflowIdRef.current = workflowId;
  }

  const searchId = workflowId ?? lastWorkflowIdRef.current;

  // Find existing orchestration conversation:
  // 1. If we have a workflowId hint, prefer the matching child conv
  // 2. Fallback: any child of the active conv whose metadata carries a workflowId.
  //    Lets the parent-chat banner ("voir collab") light up from sidebar history
  //    alone, without requiring a live workflowId in this session.
  const existingOrchConv = (() => {
    if (searchId) {
      const byWorkflow = conversations.find(
        (c) => (c.metadata as Record<string, unknown>)?.workflowId === searchId
      );
      if (byWorkflow) return byWorkflow;
    }
    if (activeConversationId) {
      const childOrch = conversations
        .filter((c) => c.parent_id === activeConversationId)
        .filter((c) => !!(c.metadata as Record<string, unknown>)?.workflowId)
        .at(-1);
      if (childOrch) return childOrch;
    }
    return null;
  })();

  // Create orchestration conversation when workflowId is set
  useEffect(() => {
    if (!workflowId || creatingRef.current) return;
    // Already processed this workflowId — skip to prevent duplicates
    if (processedWorkflowIds.current.has(workflowId)) {
      // Still sync the conv id if we find one in the conversations list
      if (existingOrchConv && !orchestrationConvId) {
        setOrchestrationConvId(existingOrchConv.id);
      }
      return;
    }
    // Already have one for this workflow
    if (existingOrchConv) {
      processedWorkflowIds.current.add(workflowId);
      setOrchestrationConvId(existingOrchConv.id);
      return;
    }
    // Already created in this session
    if (orchestrationConvId) return;

    // Mark as processed before starting the async creation
    processedWorkflowIds.current.add(workflowId);
    creatingRef.current = true;

    // Save current conversation before switching
    previousConvIdRef.current = activeConversationId;

    (async () => {
      console.log("[OrchConv] Creating sub-conversation for workflowId:", workflowId, "parentId:", activeConversationId);
      // Link as sub-conversation of the current chat via parentId
      const conv = await createConversation({
        title: "Orchestration",
        parentId: activeConversationId ?? undefined,
        metadata: { workflowId },
      });
      if (conv) {
        console.log("[OrchConv] Created sub-conversation:", conv.id, "parent:", conv.parent_id);
        setOrchestrationConvId(conv.id);
        // Auto-switch to the orchestration conversation (webapp only).
        // Plugin keeps the user on the parent chat — they navigate via the banner.
        if (!isFigmaPlugin) {
          switchConversation(conv.id);
        }
      } else {
        console.warn("[OrchConv] Failed to create sub-conversation");
      }
      creatingRef.current = false;
    })();
  }, [workflowId, existingOrchConv, orchestrationConvId, activeConversationId, createConversation, switchConversation, isFigmaPlugin]);

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
    processedWorkflowIds.current.clear();
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
