"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { ExecuteCodeResult } from "./useFigmaPlugin";

const CHANNEL_BASE = "guardian:execute";

/**
 * Subscribes to the Supabase Realtime channel "guardian:execute:{userId}" and
 * listens for MCP code-execution requests. When a request arrives, it calls
 * executeCode (postMessage to the Figma plugin) and broadcasts the result back.
 *
 * Channels are scoped per user so messages are isolated between users.
 * Replaces the old polling-based useFigmaExecutePoller.
 */
export function useFigmaExecuteChannel(
  executeCode: (code: string, timeout?: number) => Promise<ExecuteCodeResult>,
  enabled: boolean
) {
  const busy = useRef(false);
  const executeCodeRef = useRef(executeCode);
  executeCodeRef.current = executeCode;
  const [userId, setUserId] = useState<string | null>(null);

  // Resolve userId from Supabase auth on mount
  useEffect(() => {
    if (!enabled) return;
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) setUserId(data.user.id);
    });
  }, [enabled]);

  // Subscribe to the user-scoped channel
  useEffect(() => {
    if (!enabled || !userId) return;

    const channelName = `${CHANNEL_BASE}:${userId}`;
    const supabase = createClient();
    const channel = supabase.channel(channelName);

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
      .subscribe();

    return () => {
      channel.unsubscribe();
    };
  }, [enabled, userId]);
}
