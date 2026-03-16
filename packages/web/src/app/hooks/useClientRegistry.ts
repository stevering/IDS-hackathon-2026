"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientType } from "@/types/presence";

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

type InternalState = {
  shortId: string | null;
  registered: boolean;
};

type RegistryState = InternalState & {
  rename: (newShortId: string) => Promise<boolean>;
};

/**
 * Registers the current client instance with the server-side registry
 * and maintains a periodic heartbeat. Returns a stable, server-assigned shortId.
 */
export function useClientRegistry(
  clientId: string,
  clientType: ClientType,
  label: string,
  fileKey?: string,
  enabled = true
): RegistryState {
  const [state, setState] = useState<InternalState>({ shortId: null, registered: false });
  const fileKeyRef = useRef(fileKey);
  fileKeyRef.current = fileKey;
  const labelRef = useRef(label);
  labelRef.current = label;
  const clientIdRef = useRef(clientId);
  clientIdRef.current = clientId;

  useEffect(() => {
    if (!enabled || !clientId) return;

    let heartbeatTimer: ReturnType<typeof setInterval>;
    let cancelled = false;

    fetch("/api/clients/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId,
        clientType,
        label,
        fileKey: fileKey ?? null,
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        console.log("[ClientRegistry] register response:", data);
        if (!cancelled && data.shortId) {
          setState({ shortId: data.shortId, registered: true });
        }
      })
      .catch((err) => {
        console.warn("[ClientRegistry] register failed:", err);
      });

    heartbeatTimer = setInterval(() => {
      fetch("/api/clients/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          fileKey: fileKeyRef.current ?? null,
          label: labelRef.current ?? null,
        }),
      }).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);

    // Don't unregister on beforeunload — F5 fires beforeunload too,
    // which would delete the client and lose the shortId.
    // Stale clients are cleaned up automatically after 24h without heartbeat.

    return () => {
      cancelled = true;
      clearInterval(heartbeatTimer);
    };
  }, [enabled, clientId, clientType, label, fileKey]);

  const rename = useCallback(async (newShortId: string): Promise<boolean> => {
    const trimmed = newShortId.trim();
    if (trimmed.length < 2 || trimmed.length > 30) return false;

    try {
      const res = await fetch("/api/clients/rename", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: clientIdRef.current, shortId: trimmed }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      setState((s) => ({ ...s, shortId: data.shortId }));
      return true;
    } catch {
      return false;
    }
  }, []);

  return { ...state, rename };
}
