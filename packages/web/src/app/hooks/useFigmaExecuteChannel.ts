"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { type ExecuteCodeResult, type PluginEvent, pushPluginEvent } from "./useFigmaPlugin";
import { parsePresenceState, type ClientType, type PresenceClient } from "@/types/presence";


const CHANNEL_BASE = "guardian:execute";
const PRESENCE_KEEPALIVE_MS = 10 * 1000; // Re-track presence every 10 seconds (faster sync in preview)
const PRESENCE_SYNC_TIMEOUT_MS = 5 * 1000; // Fallback to DB polling if no Realtime sync within 5s

export type ConnectionStatus = "connecting" | "connected" | "reconnecting";

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
  eventLogRef?: React.RefObject<PluginEvent[]>,
  onOrchestrationDetected?: (workflowId: string) => void,
): { clients: PresenceClient[]; clientId: string; connectionStatus: ConnectionStatus; channelRef: React.RefObject<ReturnType<ReturnType<typeof createClient>["channel"]> | null> } {
  const onOrchestrationDetectedRef = useRef(onOrchestrationDetected);
  onOrchestrationDetectedRef.current = onOrchestrationDetected;
  const busy = useRef(false);
  const executeCodeRef = useRef(executeCode);
  executeCodeRef.current = executeCode;
  const [userId, setUserId] = useState<string | null>(null);
  const [clients, setClients] = useState<PresenceClient[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [reconnectKey, setReconnectKey] = useState(0); // Increment to force full channel recreation

  // Self-generated stable client ID.
  // - Webapp (top-level): localStorage → same ID across tabs/refreshes in the same browser.
  // - Plugin (iframe): sessionStorage → unique ID per iframe (each Figma plugin is a separate agent).
  const clientId = useRef("");
  if (clientId.current === "" && typeof window !== "undefined") {
    const isIframe = window.self !== window.top;
    const storage = isIframe ? sessionStorage : localStorage;
    const stored = storage.getItem("guardian:clientId");
    if (stored) {
      clientId.current = stored;
    } else {
      // Migrate from sessionStorage if webapp was previously using it
      const legacy = !isIframe ? sessionStorage.getItem("guardian:clientId") : null;
      if (legacy) {
        clientId.current = legacy;
      } else {
        clientId.current = Math.random().toString(36).slice(2, 10);
      }
      storage.setItem("guardian:clientId", clientId.current);
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
    let presenceSynced = false;
    const channel = supabase.channel(channelName, {
      config: { presence: { key: userId } },
    });

    channel
      .on("broadcast", { event: "execute_request" }, async (payload) => {
        const { requestId, code, timeout, targetClientId, workflowId } = payload.payload as {
          requestId: string;
          code: string;
          timeout: number;
          targetClientId?: string;
          workflowId?: string;
        };

        // Notify about orchestration workflowId (once per unique ID)
        if (workflowId && onOrchestrationDetectedRef.current) {
          onOrchestrationDetectedRef.current(workflowId);
        }

        // Log ALL observed requests (before filtering) — from=mcp-server, to=targetClientId
        if (eventLogRef?.current) pushPluginEvent(eventLogRef.current, { dir: "in", channel: "supabase", type: "execute_request", from: "mcp-server", to: targetClientId ?? "broadcast", summary: `code=${code}` });

        // Only figma-plugin clients should execute code — webapps must not respond
        if (clientInfoRef.current?.type !== "figma-plugin") return;

        // Only respond if this client is the target (or no target specified)
        if (targetClientId && targetClientId !== clientId.current) return;

        if (busy.current) return;
        busy.current = true;

        // Phase 2: Send ACK immediately so the server knows we received the request
        try {
          await channel.send({
            type: "broadcast",
            event: "execute_ack",
            payload: {
              requestId,
              senderClientId: clientId.current,
              status: "awaiting_approval" as const,
            },
          });
        } catch {
          // Non-fatal: server will still wait for result even without ack
        }

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
      .on("presence", { event: "sync" }, () => {
        presenceSynced = true;
        setConnectionStatus("connected");
        handlePresenceSync(
          channel.presenceState() as Record<
            string,
            { presence_ref: string; [key: string]: unknown }[]
          >
        );
      })
      .on("broadcast", { event: "connect_fc_port" }, (payload) => {
        const { port, targetClientId } = payload.payload as { port: number; targetClientId?: string };
        // Only forward to this plugin instance
        if (targetClientId && targetClientId !== clientId.current) return;
        if (clientInfoRef.current?.type !== "figma-plugin") return;
        console.log(`[ExecuteChannel] Forwarding connect_fc_port (port ${port}) to plugin`);
        // Forward to plugin UI via postMessage
        if (typeof window !== "undefined") {
          window.parent.postMessage({ source: "figpal-webapp", type: "CONNECT_FC_PORT", data: { port } }, "*");
        }
      })
      .on("broadcast", { event: "connect_fc_cloud_relay" }, (payload) => {
        const { code, targetClientId } = payload.payload as { code: string; targetClientId?: string };
        console.log(`[ExecuteChannel] Received connect_fc_cloud_relay broadcast`, { code, targetClientId, myClientId: clientId.current, myType: clientInfoRef.current?.type });
        if (targetClientId && targetClientId !== clientId.current) {
          console.log(`[ExecuteChannel] Skipping — targetClientId mismatch (${targetClientId} !== ${clientId.current})`);
          return;
        }
        if (clientInfoRef.current?.type !== "figma-plugin") {
          console.log(`[ExecuteChannel] Skipping — not a figma-plugin client (type=${clientInfoRef.current?.type})`);
          return;
        }
        console.log(`[ExecuteChannel] Forwarding connect_fc_cloud_relay (code ${code}) to plugin`);
        if (typeof window !== "undefined") {
          window.parent.postMessage({ source: "figpal-webapp", type: "CONNECT_FC_CLOUD_RELAY", data: { code } }, "*");
        }
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await retrackPresence();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          // Channel failed to join — the keepalive timer will detect the dead WS
          // and trigger a full reconnect via reconnectKey increment.
          console.warn(`[ExecuteChannel] Channel ${status}, keepalive will handle reconnect`);
        }
      });

    channelRef.current = channel;

    // Keep Realtime auth in sync with token refreshes.
    // Without this, the JWT expires after ~1h and the channel silently dies.
    const { data: { subscription: authSub } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token) {
        supabase.realtime.setAuth(session.access_token);
      }
    });

    // Fallback: if no Realtime presence sync arrives within PRESENCE_SYNC_TIMEOUT_MS,
    // just end the connecting state. We do NOT inject fake presence clients —
    // only Realtime determines who is truly online.
    const fallbackTimer = setTimeout(() => {
      if (presenceSynced) return;
      console.warn("[ExecuteChannel] Presence sync timeout — ending connecting state");
      setConnectionStatus("connected");
    }, PRESENCE_SYNC_TIMEOUT_MS);

    // Presence keepalive: periodically check connection health and re-track.
    // If the WebSocket is dead, increment reconnectKey to force a full channel recreation
    // (the useEffect will re-run, creating a new Supabase client + channel from scratch).
    const keepaliveTimer = setInterval(async () => {
      const ch = channelRef.current;
      if (!ch) return;

      // Check the actual WebSocket connection, not just the channel state.
      // channel.state stays "joined" even after silent WS disconnect.
      const socket = (ch as unknown as { socket?: { isConnected?: () => boolean } }).socket;
      const wsConnected = socket?.isConnected?.() ?? true;

      if (!wsConnected) {
        console.warn("[ExecuteChannel] WebSocket dead, clearing clients and forcing full reconnect...");
        setClients([]);
        setConnectionStatus("reconnecting");
        setReconnectKey((k) => k + 1); // Triggers useEffect cleanup + re-run
        return;
      }

      // WS is alive — just re-track presence
      try {
        await retrackPresence();
      } catch {
        console.warn("[ExecuteChannel] Presence re-track failed, forcing full reconnect...");
        setClients([]);
        setConnectionStatus("reconnecting");
        setReconnectKey((k) => k + 1);
      }
    }, PRESENCE_KEEPALIVE_MS);

    return () => {
      clearTimeout(fallbackTimer);
      clearInterval(keepaliveTimer);
      authSub.unsubscribe();
      channelRef.current = null;
      channel.unsubscribe();
    };
  }, [enabled, userId, reconnectKey, handlePresenceSync, retrackPresence]);

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

  return { clients, clientId: clientId.current, connectionStatus, channelRef };
}
