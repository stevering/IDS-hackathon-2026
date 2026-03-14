"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useOrchestrationStream } from "./useOrchestrationStream";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Plugin-side orchestration hook (simplified).
 *
 * When the plugin receives an execute_request with a workflowId, this hook:
 * 1. Opens an SSE stream to receive orchestration events
 * 2. Tracks the active workflowId
 * 3. Exposes a boolean toggle (isViewingOrchestration) for panel switching
 * 4. Provides sendUserInput() to message the orchestrator LLM
 *
 * No conversation logic — the plugin does not create/switch conversations.
 */
export function usePluginOrchestration() {
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [isViewingOrchestration, setIsViewingOrchestration] = useState(false);
  const knownWorkflowIds = useRef(new Set<string>());

  // SSE stream — connects when workflowId is set
  const stream = useOrchestrationStream(workflowId);

  // Called by useFigmaExecuteChannel when a workflowId is detected
  const handleOrchestrationDetected = useCallback((wfId: string) => {
    // Only process each workflowId once
    if (knownWorkflowIds.current.has(wfId)) return;
    knownWorkflowIds.current.add(wfId);
    setWorkflowId(wfId);
  }, []);

  // Panel visibility controls
  const showOrchestration = useCallback(() => {
    setIsViewingOrchestration(true);
  }, []);

  const hideOrchestration = useCallback(() => {
    setIsViewingOrchestration(false);
  }, []);

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
  const isActive = workflowId !== null && (!stream.completedStatus || !delayedComplete);
  const hasOrchestration = workflowId !== null || isActive;

  // Send user input to the orchestrator LLM via signal
  const sendUserInput = useCallback(
    async (content: string, targetAgentId?: string) => {
      if (!workflowId) return;
      try {
        await fetch(`/api/orchestration/${workflowId}/signal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            signal: "userInput",
            payload: { content, targetAgentId },
          }),
        });
      } catch (err) {
        console.error("[usePluginOrchestration] sendUserInput failed:", err);
      }
    },
    [workflowId]
  );

  // Reset when stream completes
  const reset = useCallback(() => {
    setWorkflowId(null);
    setIsViewingOrchestration(false);
    setDelayedComplete(false);
    if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
    knownWorkflowIds.current.clear();
  }, []);

  return {
    /** Callback to pass to useFigmaExecuteChannel */
    handleOrchestrationDetected,
    /** Whether the plugin has an active orchestration */
    isActive,
    /** Whether an orchestration exists (even if stream completed) */
    hasOrchestration,
    /** Whether the user is currently viewing the orchestration panel */
    isViewingOrchestration,
    /** Show the orchestration panel */
    showOrchestration,
    /** Hide the orchestration panel (back to chat) */
    hideOrchestration,
    /** Send user input to the orchestrator LLM */
    sendUserInput,
    /** Reset state after orchestration completes */
    reset,
    /** Stream data for rendering */
    stream,
    /** Current workflow ID */
    workflowId,
  };
}
