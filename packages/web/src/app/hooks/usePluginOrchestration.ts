"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useOrchestrationStream } from "./useOrchestrationStream";
import type { Conversation } from "./useConversations";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UsePluginOrchestrationParams = {
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
  /** Current active conversation ID */
  activeConversationId: string | null;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Plugin-side orchestration hook.
 *
 * When the plugin receives an execute_request with a workflowId, this hook:
 * 1. Opens an SSE stream to receive orchestration events
 * 2. Creates an orchestration conversation (if not already present)
 * 3. Does NOT auto-switch — user stays in their current chat
 * 4. Exposes banner state and switchToOrchestration() for manual navigation
 */
export function usePluginOrchestration({
  conversations,
  createConversation,
  switchConversation,
  activeConversationId,
}: UsePluginOrchestrationParams) {
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [orchConvId, setOrchConvId] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const knownWorkflowIds = useRef(new Set<string>());

  // SSE stream — connects when workflowId is set
  const stream = useOrchestrationStream(workflowId);

  // Track which workflowIds are currently being created to prevent race conditions
  const creatingForWorkflow = useRef(new Set<string>());

  // Called by useFigmaExecuteChannel when a workflowId is detected
  const handleOrchestrationDetected = useCallback(
    async (wfId: string) => {
      // Only process each workflowId once
      if (knownWorkflowIds.current.has(wfId)) return;
      knownWorkflowIds.current.add(wfId);
      setWorkflowId(wfId);

      // Check if conversation already exists for this workflow (match via metadata)
      const existing = conversations.find(
        (c) => (c.metadata as Record<string, unknown>)?.workflowId === wfId
      );
      if (existing) {
        setOrchConvId(existing.id);
        return;
      }

      // Prevent duplicate creation for the same workflowId
      if (creatingRef.current || creatingForWorkflow.current.has(wfId)) return;
      creatingRef.current = true;
      creatingForWorkflow.current.add(wfId);
      const conv = await createConversation({
        title: "Orchestration",
        metadata: { workflowId: wfId, source: "plugin" },
      });
      if (conv) {
        setOrchConvId(conv.id);
      }
      creatingRef.current = false;
    },
    [conversations, createConversation]
  );

  const switchToOrchestration = useCallback(() => {
    if (orchConvId) {
      switchConversation(orchConvId);
    }
  }, [orchConvId, switchConversation]);

  const isInOrchestrationConversation =
    orchConvId !== null && activeConversationId === orchConvId;

  // Keep the banner visible for at least 3 seconds after completion so the user
  // can see it before it disappears (especially in brave mode where orchestrations
  // complete very fast).
  const [delayedComplete, setDelayedComplete] = useState(false);
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (stream.completedStatus && workflowId !== null) {
      // Orchestration just completed — keep isActive true for 3s minimum
      completionTimerRef.current = setTimeout(() => {
        setDelayedComplete(true);
      }, 3000);
      return () => {
        if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
      };
    }
    // Reset when a new workflow starts
    setDelayedComplete(false);
  }, [stream.completedStatus, workflowId]);

  // Active when: workflowId is set AND (stream not completed OR waiting for delay timer)
  // Also consider "active" if we have an orchestration conversation but stream hasn't
  // connected yet (race in brave mode where execution finishes before SSE opens)
  const isActive = workflowId !== null && (!stream.completedStatus || !delayedComplete);
  const hasOrchestration = orchConvId !== null || isActive;

  // Reset when stream completes
  const reset = useCallback(() => {
    setWorkflowId(null);
    setOrchConvId(null);
    setDelayedComplete(false);
    if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
    knownWorkflowIds.current.clear();
  }, []);

  return {
    /** Callback to pass to useFigmaExecuteChannel */
    handleOrchestrationDetected,
    /** Whether the plugin has an active orchestration */
    isActive,
    /** Whether an orchestration conversation exists (even if stream completed) */
    hasOrchestration,
    /** Whether user is viewing the orchestration conversation */
    isInOrchestrationConversation,
    /** Switch to the orchestration conversation */
    switchToOrchestration,
    /** Reset state after orchestration completes */
    reset,
    /** Stream data for rendering */
    stream,
    /** Orchestration conversation ID */
    orchestrationConversationId: orchConvId,
  };
}
