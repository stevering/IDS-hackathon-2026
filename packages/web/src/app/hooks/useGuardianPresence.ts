"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { parsePresenceState, type ClientType, type PresenceClient } from "@/types/presence";
import type { ConnectionStatus } from "./useFigmaExecuteChannel";

const CHANNEL_BASE = "guardian:execute";
const PRESENCE_SYNC_TIMEOUT_MS = 5 * 1000;

/**
 * Read-only presence hook for pages that need to display connected clients
 * (e.g. account page) without being a tracked client themselves.
 */
export function useGuardianPresence(): { clients: PresenceClient[]; loading: boolean; connectionStatus: ConnectionStatus } {
  const [clients, setClients] = useState<PresenceClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");

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
    let presenceSynced = false;

    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        setLoading(false);
        setConnectionStatus("connected");
        return;
      }

      const channelName = `${CHANNEL_BASE}:${data.user.id}`;
      channel = supabase.channel(channelName);

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
        .subscribe(() => {
          setLoading(false);
        });

      // Fallback: poll DB if Realtime doesn't sync within timeout
      fallbackTimer = setTimeout(async () => {
        if (presenceSynced) return;
        try {
          const res = await fetch("/api/clients?active=true");
          if (res.ok) {
            const { clients: dbClients } = await res.json();
            if (!presenceSynced && Array.isArray(dbClients) && dbClients.length > 0) {
              const fallback: PresenceClient[] = dbClients.map((db: { client_id: string; client_type: string; short_id: string; label?: string; file_key?: string; last_seen_at: string; agent_role?: string }) => ({
                type: (db.client_type as ClientType) ?? "webapp",
                clientId: db.client_id,
                shortId: db.short_id,
                label: db.label ?? db.client_type,
                fileKey: db.file_key ?? undefined,
                connectedAt: new Date(db.last_seen_at).getTime(),
                presenceRef: "",
                agentRole: (db.agent_role ?? "idle") as PresenceClient["agentRole"],
              }));
              setClients(fallback);
            }
          }
        } catch {
          // Ignore — Realtime will eventually sync
        }
        setConnectionStatus("connected");
      }, PRESENCE_SYNC_TIMEOUT_MS);
    });

    return () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      channel?.unsubscribe();
    };
  }, [handleSync]);

  return { clients, loading, connectionStatus };
}
