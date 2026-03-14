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
    orchestrationId?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<Conversation | null>;
  /** Switch to a conversation */
  switchConversation: (id: string) => void;
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

  // Find existing orchestration conversation for this workflowId
  // orchestration_id is UUID (legacy), so we match via metadata.workflowId instead
  const existingOrchConv = searchId
    ? conversations.find(
        (c) => (c.metadata as Record<string, unknown>)?.workflowId === searchId
      )
    : null;

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
      // Don't pass orchestrationId (UUID column) — use metadata instead
      const conv = await createConversation({
        title: "Orchestration",
        metadata: { workflowId },
      });
      if (conv) {
        setOrchestrationConvId(conv.id);
        // Auto-switch to the orchestration conversation
        switchConversation(conv.id);
      }
      creatingRef.current = false;
    })();
  }, [workflowId, existingOrchConv, orchestrationConvId, activeConversationId, createConversation, switchConversation]);

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
    const target = previousConvIdRef.current;
    if (target) {
      switchConversation(target);
    }
  }, [switchConversation]);

  const dismiss = useCallback(() => {
    setOrchestrationConvId(null);
    lastWorkflowIdRef.current = null;
    previousConvIdRef.current = null;
    processedWorkflowIds.current.clear();
  }, []);

  return {
    isInOrchestrationConversation,
    orchestrationConversationId: effectiveOrchConvId,
    switchToOrchestration,
    switchBackToChat,
    hasActiveOrchestration: effectiveOrchConvId !== null,
    dismiss,
  };
}
