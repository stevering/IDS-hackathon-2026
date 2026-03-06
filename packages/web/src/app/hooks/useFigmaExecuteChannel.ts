"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import type { ExecuteCodeResult } from "./useFigmaPlugin";
import { parsePresenceState, type ClientType, type PresenceClient } from "@/types/presence";

const CHANNEL_BASE = "guardian:execute";

export type ClientInfo = {
  type: ClientType;
  label: string;
  fileKey?: string;
  mcpInfo?: PresenceClient["mcpInfo"];
};

/**
 * Subscribes to the Supabase Realtime channel "guardian:execute:{userId}",
 * handles MCP code-execution requests, tracks presence, and returns
 * the list of connected clients.
 */
export function useFigmaExecuteChannel(
  executeCode: (code: string, timeout?: number) => Promise<ExecuteCodeResult>,
  enabled: boolean,
  clientInfo?: ClientInfo
): { clients: PresenceClient[] } {
  const busy = useRef(false);
  const executeCodeRef = useRef(executeCode);
  executeCodeRef.current = executeCode;
  const [userId, setUserId] = useState<string | null>(null);
  const [clients, setClients] = useState<PresenceClient[]>([]);

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

  const handlePresenceSync = useCallback(
    (state: Record<string, { presence_ref: string; [key: string]: unknown }[]>) => {
      setClients(parsePresenceState(state));
    },
    []
  );

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
        if (busy.current) return;
        busy.current = true;

        try {
          const { requestId, code, timeout } = payload.payload as {
            requestId: string;
            code: string;
            timeout: number;
          };

          const result = await executeCodeRef.current(code, timeout);

          await channel.send({
            type: "broadcast",
            event: "execute_result",
            payload: {
              requestId,
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
      .on("presence", { event: "sync" }, () => {
        handlePresenceSync(
          channel.presenceState() as Record<
            string,
            { presence_ref: string; [key: string]: unknown }[]
          >
        );
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED" && clientInfoRef.current) {
          await channel.track({
            type: clientInfoRef.current.type,
            label: clientInfoRef.current.label,
            fileKey: clientInfoRef.current.fileKey,
            mcpInfo: clientInfoRef.current.mcpInfo,
            connectedAt: Date.now(),
          });
        }
      });

    return () => {
      channel.unsubscribe();
    };
  }, [enabled, userId, handlePresenceSync]);

  return { clients };
}
