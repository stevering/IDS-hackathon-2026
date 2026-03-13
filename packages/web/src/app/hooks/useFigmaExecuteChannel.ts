"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { type ExecuteCodeResult, type PluginEvent, pushPluginEvent } from "./useFigmaPlugin";
import { parsePresenceState, type ClientType, type PresenceClient } from "@/types/presence";
import type { OrchestrationCallbacks } from "./useOrchestration";

const CHANNEL_BASE = "guardian:execute";

export type ClientInfo = {
  type: ClientType;
  label: string;
  fileKey?: string;
  mcpInfo?: PresenceClient["mcpInfo"];
  figmaContext?: PresenceClient["figmaContext"];
  serverShortId?: string | null;
};

/**
 * Subscribes to the Supabase Realtime channel "guardian:execute:{userId}",
 * handles MCP code-execution requests (filtered by targetClientId in the payload),
 * tracks presence, and returns connected clients.
 */
export function useFigmaExecuteChannel(
  executeCode: (code: string, timeout?: number) => Promise<ExecuteCodeResult>,
  enabled: boolean,
  clientInfo?: ClientInfo,
  orchestrationCallbacksRef?: React.RefObject<OrchestrationCallbacks>,
  eventLogRef?: React.RefObject<PluginEvent[]>,
): { clients: PresenceClient[]; clientId: string; channelRef: React.RefObject<ReturnType<ReturnType<typeof createClient>["channel"]> | null> } {
  const busy = useRef(false);
  const executeCodeRef = useRef(executeCode);
  executeCodeRef.current = executeCode;
  const [userId, setUserId] = useState<string | null>(null);
  const [clients, setClients] = useState<PresenceClient[]>([]);

  // Self-generated stable client ID — persists across navigations via sessionStorage
  const clientId = useRef("");
  if (clientId.current === "" && typeof window !== "undefined") {
    const stored = sessionStorage.getItem("guardian:clientId");
    if (stored) {
      clientId.current = stored;
    } else {
      clientId.current = Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem("guardian:clientId", clientId.current);
    }
  }

  // Resolve userId from Supabase auth on mount
  useEffect(() => {
    if (!enabled) return;
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) setUserId(data.user.id);
    });
  }, [enabled]);

  // Stable reference to clientInfo to avoid re-subscribing on every render
  const clientInfoRef = useRef(clientInfo);
  clientInfoRef.current = clientInfo;
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>["channel"]> | null>(null);

  const handlePresenceSync = useCallback(
    (state: Record<string, { presence_ref: string; [key: string]: unknown }[]>) => {
      setClients(parsePresenceState(state));
    },
    []
  );

  // Helper: re-track presence on the current channel
  const retrackPresence = useCallback(async () => {
    const ch = channelRef.current;
    const info = clientInfoRef.current;
    if (!ch || !info) return;
    await ch.track({
      clientId: clientId.current,
      type: info.type,
      label: info.label,
      fileKey: info.fileKey,
      mcpInfo: info.mcpInfo,
      figmaContext: info.figmaContext,
      serverShortId: info.serverShortId ?? undefined,
      connectedAt: Date.now(),
    });
  }, []);

  // Subscribe to the user-scoped channel
  useEffect(() => {
    if (!enabled || !userId) return;

    const channelName = `${CHANNEL_BASE}:${userId}`;
    const supabase = createClient();
    const channel = supabase.channel(channelName, {
      config: { presence: { key: userId } },
    });

    channel
      .on("broadcast", { event: "execute_request" }, async (payload) => {
        const { requestId, code, timeout, targetClientId } = payload.payload as {
          requestId: string;
          code: string;
          timeout: number;
          targetClientId?: string;
        };

        // Log ALL observed requests (before filtering) — from=mcp-server, to=targetClientId
        if (eventLogRef?.current) pushPluginEvent(eventLogRef.current, { dir: "in", channel: "supabase", type: "execute_request", from: "mcp-server", to: targetClientId ?? "broadcast", summary: `code=${code}` });

        // Only figma-plugin clients should execute code — webapps must not respond
        if (clientInfoRef.current?.type !== "figma-plugin") return;

        // Only respond if this client is the target (or no target specified)
        if (targetClientId && targetClientId !== clientId.current) return;

        if (busy.current) return;
        busy.current = true;

        try {
          const result = await executeCodeRef.current(code, timeout);

          if (eventLogRef?.current) pushPluginEvent(eventLogRef.current, { dir: "out", channel: "supabase", type: "execute_result", from: clientId.current, to: "mcp-server", summary: result.success ? `ok ${typeof result.result === "string" ? result.result : JSON.stringify(result.result ?? "")}` : `err ${result.error ?? "unknown"}` });

          await channel.send({
            type: "broadcast",
            event: "execute_result",
            payload: {
              requestId,
              senderClientId: clientId.current,
              success: result.success,
              result: result.result,
              error: result.error,
            },
          });
        } catch {
          // Silently ignore execution errors
        } finally {
          busy.current = false;
        }
      })
      // Log execute_result broadcasts from other clients (e.g. Figma plugin reporting completion)
      .on("broadcast", { event: "execute_result" }, (payload) => {
        const { senderClientId, success, result, error } = payload.payload as {
          senderClientId?: string;
          success: boolean;
          result?: unknown;
          error?: string;
        };
        if (eventLogRef?.current) {
          pushPluginEvent(eventLogRef.current, {
            dir: "in",
            channel: "supabase",
            type: "execute_result",
            from: senderClientId,
            to: "mcp-server",
            summary: success
              ? `ok ${typeof result === "string" ? result : JSON.stringify(result ?? "")}`
              : `err ${error ?? "unknown"}`,
          });
        }
      })
      // Collaborative Agents — orchestration events forwarded to useOrchestration via callback ref.
      // When TEMPORAL_ENABLED is set, orchestration signals flow through Temporal instead
      // of Supabase RT broadcasts. These handlers remain for backwards compatibility
      // but are effectively no-ops when no callbacks are registered.
      .on("broadcast", { event: "orchestration_invite" }, (payload) => {
        if (eventLogRef?.current) pushPluginEvent(eventLogRef.current, { dir: "in", channel: "supabase", type: "orchestration_invite" });
        orchestrationCallbacksRef?.current?.onInvite?.(payload.payload);
      })
      .on("broadcast", { event: "orchestration_accept" }, (payload) => {
        if (eventLogRef?.current) pushPluginEvent(eventLogRef.current, { dir: "in", channel: "supabase", type: "orchestration_accept" });
        orchestrationCallbacksRef?.current?.onAccept?.(payload.payload);
      })
      .on("broadcast", { event: "orchestration_decline" }, (payload) => {
        if (eventLogRef?.current) pushPluginEvent(eventLogRef.current, { dir: "in", channel: "supabase", type: "orchestration_decline" });
        orchestrationCallbacksRef?.current?.onDecline?.(payload.payload);
      })
      .on("broadcast", { event: "agent_request" }, (payload) => {
        if (eventLogRef?.current) pushPluginEvent(eventLogRef.current, { dir: "in", channel: "supabase", type: "agent_request" });
        orchestrationCallbacksRef?.current?.onAgentRequest?.(payload.payload);
      })
      .on("broadcast", { event: "agent_response" }, (payload) => {
        if (eventLogRef?.current) pushPluginEvent(eventLogRef.current, { dir: "in", channel: "supabase", type: "agent_response" });
        orchestrationCallbacksRef?.current?.onAgentResponse?.(payload.payload);
      })
      .on("broadcast", { event: "agent_message" }, (payload) => {
        if (eventLogRef?.current) pushPluginEvent(eventLogRef.current, { dir: "in", channel: "supabase", type: "agent_message" });
        orchestrationCallbacksRef?.current?.onAgentMessage?.(payload.payload);
      })
      .on("broadcast", { event: "orchestration_tick" }, (payload) => {
        if (eventLogRef?.current) pushPluginEvent(eventLogRef.current, { dir: "in", channel: "supabase", type: "orchestration_tick" });
        orchestrationCallbacksRef?.current?.onTick?.(payload.payload);
      })
      .on("broadcast", { event: "orchestration_end" }, (payload) => {
        if (eventLogRef?.current) pushPluginEvent(eventLogRef.current, { dir: "in", channel: "supabase", type: "orchestration_end" });
        orchestrationCallbacksRef?.current?.onEnd?.(payload.payload);
      })
      .on("broadcast", { event: "sub_conversation_start" }, (payload) => {
        if (eventLogRef?.current) pushPluginEvent(eventLogRef.current, { dir: "in", channel: "supabase", type: "sub_conversation_start" });
        orchestrationCallbacksRef?.current?.onSubConversationStart?.(payload.payload);
      })
      .on("broadcast", { event: "sub_conversation_end" }, (payload) => {
        if (eventLogRef?.current) pushPluginEvent(eventLogRef.current, { dir: "in", channel: "supabase", type: "sub_conversation_end" });
        orchestrationCallbacksRef?.current?.onSubConversationEnd?.(payload.payload);
      })
      .on("presence", { event: "sync" }, () => {
        handlePresenceSync(
          channel.presenceState() as Record<
            string,
            { presence_ref: string; [key: string]: unknown }[]
          >
        );
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await retrackPresence();
        }
      });

    channelRef.current = channel;

    return () => {
      channelRef.current = null;
      channel.unsubscribe();
    };
  }, [enabled, userId, handlePresenceSync, retrackPresence]);

  // Re-sync presence when the tab becomes visible after being hidden (e.g. overnight idle).
  // The Supabase Realtime WebSocket may have silently disconnected; even if it auto-reconnects,
  // the local presence state can be stale. Force a re-track + state read on visibility change.
  useEffect(() => {
    if (!enabled) return;

    const handleVisibility = async () => {
      if (document.visibilityState !== "visible") return;
      const ch = channelRef.current;
      if (!ch) return;

      // Re-track our own presence so other clients see us
      await retrackPresence();

      // Read the latest presence state (other clients may have joined/left while hidden)
      handlePresenceSync(
        ch.presenceState() as Record<
          string,
          { presence_ref: string; [key: string]: unknown }[]
        >
      );
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [enabled, handlePresenceSync, retrackPresence]);

  // Re-track presence when serverShortId becomes available
  const serverShortId = clientInfo?.serverShortId;
  useEffect(() => {
    if (!serverShortId || !channelRef.current || !clientInfoRef.current) return;
    channelRef.current.track({
      clientId: clientId.current,
      type: clientInfoRef.current.type,
      label: clientInfoRef.current.label,
      fileKey: clientInfoRef.current.fileKey,
      mcpInfo: clientInfoRef.current.mcpInfo,
      figmaContext: clientInfoRef.current.figmaContext,
      serverShortId,
      connectedAt: Date.now(),
    });
  }, [serverShortId]);

  return { clients, clientId: clientId.current, channelRef };
}
