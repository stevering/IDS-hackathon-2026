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
  clientInfo?: ClientInfo
): { clients: PresenceClient[]; clientId: string } {
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

        // Only respond if this client is the target (or no target specified)
        if (targetClientId && targetClientId !== clientId.current) return;

        if (busy.current) return;
        busy.current = true;

        try {
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
            clientId: clientId.current,
            type: clientInfoRef.current.type,
            label: clientInfoRef.current.label,
            fileKey: clientInfoRef.current.fileKey,
            mcpInfo: clientInfoRef.current.mcpInfo,
            figmaContext: clientInfoRef.current.figmaContext,
            serverShortId: clientInfoRef.current.serverShortId ?? undefined,
            connectedAt: Date.now(),
          });
        }
      });

    channelRef.current = channel;

    return () => {
      channelRef.current = null;
      channel.unsubscribe();
    };
  }, [enabled, userId, handlePresenceSync]);

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

  return { clients, clientId: clientId.current };
}
