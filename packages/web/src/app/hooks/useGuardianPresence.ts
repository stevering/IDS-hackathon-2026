"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { parsePresenceState, type PresenceClient } from "@/types/presence";

const CHANNEL_BASE = "guardian:execute";

/**
 * Read-only presence hook for pages that need to display connected clients
 * (e.g. account page) without being a tracked client themselves.
 */
export function useGuardianPresence(): { clients: PresenceClient[]; loading: boolean } {
  const [clients, setClients] = useState<PresenceClient[]>([]);
  const [loading, setLoading] = useState(true);

  const handleSync = useCallback(
    (state: Record<string, { presence_ref: string; [key: string]: unknown }[]>) => {
      setClients(parsePresenceState(state));
      setLoading(false);
    },
    []
  );

  useEffect(() => {
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;

    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        setLoading(false);
        return;
      }

      const channelName = `${CHANNEL_BASE}:${data.user.id}`;
      channel = supabase.channel(channelName);

      channel
        .on("presence", { event: "sync" }, () => {
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
    });

    return () => {
      channel?.unsubscribe();
    };
  }, [handleSync]);

  return { clients, loading };
}
