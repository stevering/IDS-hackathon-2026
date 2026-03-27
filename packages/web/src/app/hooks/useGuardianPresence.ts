"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { parsePresenceState, type PresenceClient } from "@/types/presence";
import type { ConnectionStatus } from "./useFigmaExecuteChannel";

const CHANNEL_BASE = "guardian:execute";
const PRESENCE_SYNC_TIMEOUT_MS = 5 * 1000;
const PRESENCE_KEEPALIVE_MS = 10 * 1000;

/**
 * Read-only presence hook for pages that need to display connected clients
 * (e.g. account page) without being a tracked client themselves.
 * Includes keepalive-based WS health check and fallback DB polling.
 */
export function useGuardianPresence(): { clients: PresenceClient[]; loading: boolean; connectionStatus: ConnectionStatus } {
  const [clients, setClients] = useState<PresenceClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [reconnectKey, setReconnectKey] = useState(0);
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>["channel"]> | null>(null);

  const handleSync = useCallback(
    (state: Record<string, { presence_ref: string; [key: string]: unknown }[]>) => {
      setClients(parsePresenceState(state));
      setConnectionStatus("connected");
      setLoading(false);
    },
    []
  );

  useEffect(() => {
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    let presenceSynced = false;

    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        setLoading(false);
        setConnectionStatus("connected");
        return;
      }

      const channelName = `${CHANNEL_BASE}:${data.user.id}`;
      channel = supabase.channel(channelName);
      channelRef.current = channel;

      channel
        .on("presence", { event: "sync" }, () => {
          presenceSynced = true;
          handleSync(
            channel!.presenceState() as Record<
              string,
              { presence_ref: string; [key: string]: unknown }[]
            >
          );
        })
        .subscribe();

      // Fallback: if Realtime doesn't sync within timeout, stop loading
      // so ConnectedClients can show DB clients with their real online/offline status.
      // We do NOT inject fake presence clients — only Realtime determines who is online.
      fallbackTimer = setTimeout(() => {
        if (presenceSynced) return;
        console.warn("[GuardianPresence] Presence sync timeout — ending loading state");
        setConnectionStatus("connected");
        setLoading(false);
      }, PRESENCE_SYNC_TIMEOUT_MS);

      // Keepalive: check WS health every 10s
      keepaliveTimer = setInterval(() => {
        const ch = channelRef.current;
        if (!ch) return;

        const socket = (ch as unknown as { socket?: { isConnected?: () => boolean } }).socket;
        const wsConnected = socket?.isConnected?.() ?? true;

        if (!wsConnected) {
          console.warn("[GuardianPresence] WebSocket dead, forcing reconnect...");
          setClients([]);
          setConnectionStatus("reconnecting");
          setReconnectKey((k) => k + 1);
        }
      }, PRESENCE_KEEPALIVE_MS);
    });

    return () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      channelRef.current = null;
      channel?.unsubscribe();
    };
  }, [handleSync, reconnectKey]);

  // Expose debug helper on window for manual testing
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as unknown as Record<string, unknown>).__guardianPresenceDebug = {
      forceReconnect: () => {
        console.log("[GuardianPresence] Debug: forcing reconnect...");
        setClients([]);
        setConnectionStatus("reconnecting");
        setReconnectKey((k) => k + 1);
      },
      getStatus: () => ({ connectionStatus, clientCount: clients.length, loading }),
    };
  }, [connectionStatus, clients.length, loading]);

  return { clients, loading, connectionStatus };
}
