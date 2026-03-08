"use client";

import { useEffect, useRef, useState } from "react";
import type { ClientType } from "@/types/presence";

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

type RegistryState = {
  shortId: string | null;
  registered: boolean;
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
  const [state, setState] = useState<RegistryState>({ shortId: null, registered: false });
  const fileKeyRef = useRef(fileKey);
  fileKeyRef.current = fileKey;
  const labelRef = useRef(label);
  labelRef.current = label;

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

    // Unregister when the tab/window is closed
    const unregisterPayload = JSON.stringify({ clientId });
    const handleBeforeUnload = () => {
      navigator.sendBeacon("/api/clients/unregister", new Blob([unregisterPayload], { type: "application/json" }));
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      cancelled = true;
      clearInterval(heartbeatTimer);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [enabled, clientId, clientType, label, fileKey]);

  return state;
}
