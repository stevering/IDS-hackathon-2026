"use client";

/**
 * Subscribes to the Desktop Companion heartbeat channel
 * (guardian:devices:${userId}) via Supabase Realtime broadcast and exposes
 * the live state of every device the user has companions running on.
 *
 * Used by:
 *   - Account page → Local services section
 *   - TargetSelector in chat → show online/offline dot on local instances
 *
 * The hook is passive: it only reads broadcasts. The canonical state
 * (which services are enabled / dismissed) still lives in the DB and is
 * fetched by useUserMCPInstances; this hook layers the "live" metadata
 * on top (is the device online, what services did it just discover).
 */

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  devicesChannelName,
  BRIDGE_HELLO_EVENT,
  DEVICE_ONLINE_TTL_MS,
  type BridgeHeartbeat,
  type BridgeHeartbeatInstance,
  type DiscoveredService,
} from "@guardian/orchestrations/mcp";

export type LiveDeviceState = {
  deviceId: string;
  deviceName: string;
  osInfo: string;
  overlayVersion: string;
  lastSeenAt: number;
  online: boolean;
  /** Instances currently running on this device (already enabled in DB). */
  instances: BridgeHeartbeatInstance[];
  /** Services detected via port scan but not yet registered. */
  discovered: DiscoveredService[];
};

export type BridgeHeartbeatState = {
  /** Keyed by deviceId → live status snapshot from the latest heartbeat. */
  devices: Map<string, LiveDeviceState>;
  /** Whether Realtime has connected at least once. */
  connected: boolean;
};

export function useBridgeHeartbeat(): BridgeHeartbeatState {
  const [state, setState] = useState<BridgeHeartbeatState>({
    devices: new Map(),
    connected: false,
  });

  // We keep the latest map in a ref so the staleness sweeper
  // (interval below) always sees the current state without re-subscribing.
  const devicesRef = useRef<Map<string, LiveDeviceState>>(new Map());

  useEffect(() => {
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let staleSweep: ReturnType<typeof setInterval> | null = null;

    const updateDevices = (mutator: (m: Map<string, LiveDeviceState>) => void) => {
      const next = new Map(devicesRef.current);
      mutator(next);
      devicesRef.current = next;
      setState((prev) => ({ ...prev, devices: next }));
    };

    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) return;
      const channelName = devicesChannelName(data.user.id);
      channel = supabase.channel(channelName);

      channel
        .on("broadcast", { event: BRIDGE_HELLO_EVENT }, ({ payload }: { payload: BridgeHeartbeat }) => {
          if (!payload || payload.type !== "bridge-hello") return;

          updateDevices((m) => {
            m.set(payload.deviceId, {
              deviceId: payload.deviceId,
              deviceName: payload.deviceName,
              osInfo: payload.osInfo,
              overlayVersion: payload.overlayVersion,
              lastSeenAt: payload.publishedAt,
              online: true,
              instances: payload.instances,
              discovered: payload.discoveredServices ?? [],
            });
          });
        })
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            setState((prev) => ({ ...prev, connected: true }));
          }
        });
    });

    // Sweep stale devices every 10s — if we haven't heard from a companion
    // in DEVICE_ONLINE_TTL_MS, mark it offline. We keep the row so the UI
    // can still display its last-known instances (as offline).
    staleSweep = setInterval(() => {
      const now = Date.now();
      let changed = false;
      const next = new Map(devicesRef.current);
      for (const [id, d] of next) {
        const isOnline = now - d.lastSeenAt < DEVICE_ONLINE_TTL_MS;
        if (isOnline !== d.online) {
          next.set(id, { ...d, online: isOnline });
          changed = true;
        }
      }
      if (changed) {
        devicesRef.current = next;
        setState((prev) => ({ ...prev, devices: next }));
      }
    }, 10_000);

    return () => {
      if (staleSweep) clearInterval(staleSweep);
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  return state;
}
