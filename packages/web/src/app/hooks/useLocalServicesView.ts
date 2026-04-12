"use client";

/**
 * Composite hook for the Account page "Local services" section.
 *
 * Merges three data sources:
 *   1. DB instances (from useUserMCPInstances) — what the user has enabled/dismissed
 *   2. Device presence heartbeat (from useBridgeHeartbeat) — what the companion reports live
 *   3. Registry presets — for display names and fallback URLs
 *
 * Produces a tree: device → services, where each service has a status:
 *   - "active"           → in DB, enabled=true, companion reports it online
 *   - "active_offline"   → in DB, enabled=true, companion offline OR service not in heartbeat
 *   - "disabled"         → in DB, enabled=false, dismissed=false (user disabled but kept)
 *   - "ignored"          → in DB, enabled=false, dismissed=true (user said "no thanks")
 *   - "discovered"       → NOT in DB, companion reports via scan
 */

import { useMemo } from "react";
import { BUILTIN_PRESETS } from "@guardian/orchestrations/mcp";
import { useUserMCPInstances, type MCPInstance } from "./useUserMCPInstances";
import { useBridgeHeartbeat, type LiveDeviceState } from "./useBridgeHeartbeat";

export type LocalServiceStatus =
  | "active"
  | "active_offline"
  | "disabled"
  | "ignored"
  | "discovered";

export type LocalServiceView = {
  /** For in-DB services: user_mcp_instances.id. For discovered: undefined. */
  instanceId?: string;
  presetType: string;
  /** Display name — from DB if active, from preset otherwise. */
  displayName: string;
  /** Slug label used in tool prefix (only for in-DB services). */
  label?: string;
  /** URL where the service is reachable (for http/sse transports). */
  url?: string;
  /** Tool count — live from heartbeat if available, else from last discovery. */
  toolCount?: number;
  status: LocalServiceStatus;
  /** Populated when discovery or connection failed, surfaced to the user. */
  error?: string;
  /** The protocol tag shown in the UI ("MCP"). Future: "REST", "GraphQL", etc. */
  protocolBadge: string;
};

export type DeviceView = {
  deviceId: string;
  deviceName: string;
  online: boolean;
  lastSeenAt: number | null;
  overlayVersion?: string;
  osInfo?: string;
  services: LocalServiceView[];
};

export type LocalServicesView = {
  devices: DeviceView[];
  /** True while the initial DB fetch is in flight. */
  loading: boolean;
  /** Reload the DB half (heartbeat is push-based, no reload needed). */
  reload: () => Promise<void> | void;
  /** Whether we've received at least one heartbeat. */
  bridgeConnected: boolean;
};

/**
 * Build a device-keyed map from the heartbeat.
 * Each map value is the latest heartbeat snapshot for that device.
 */
function buildLiveByDevice(
  heartbeatDevices: Map<string, LiveDeviceState>,
): Map<string, LiveDeviceState> {
  return heartbeatDevices;
}

/**
 * Build a device-keyed map from DB instances.
 * Returns: deviceId → list of instances registered on that device.
 */
function buildDbByDevice(instances: MCPInstance[]): Map<string, MCPInstance[]> {
  const result = new Map<string, MCPInstance[]>();
  for (const inst of instances) {
    if (inst.scope !== "local" || !inst.device) continue;
    const list = result.get(inst.device.id) ?? [];
    list.push(inst);
    result.set(inst.device.id, list);
  }
  return result;
}

/**
 * Compute a service's effective status from the DB row + live heartbeat.
 */
function deriveStatus(
  inst: MCPInstance,
  liveInstance:
    | { online: boolean; toolCount?: number; error?: string }
    | undefined,
): { status: LocalServiceStatus; error?: string; toolCount?: number } {
  if (!inst.enabled) {
    // A row exists but enabled=false. Distinguish dismissed vs just disabled.
    return { status: inst.dismissed ? "ignored" : "disabled" };
  }

  // enabled=true
  if (liveInstance?.online) {
    return { status: "active", toolCount: liveInstance.toolCount, error: liveInstance.error };
  }
  return { status: "active_offline", error: liveInstance?.error };
}

export function useLocalServicesView(): LocalServicesView {
  const dbHook = useUserMCPInstances();
  const heartbeat = useBridgeHeartbeat();

  const devices = useMemo<DeviceView[]>(() => {
    const dbByDevice = buildDbByDevice(dbHook.localInstances);
    const liveByDevice = buildLiveByDevice(heartbeat.devices);

    // Union of device IDs seen in DB or via heartbeat.
    const allDeviceIds = new Set<string>([
      ...dbByDevice.keys(),
      ...liveByDevice.keys(),
    ]);

    const result: DeviceView[] = [];

    for (const deviceId of allDeviceIds) {
      const liveDevice = liveByDevice.get(deviceId);
      const dbInstances = dbByDevice.get(deviceId) ?? [];

      // Resolve device name + metadata:
      //   - If live heartbeat present → use it (authoritative)
      //   - Else pick the first DB instance's stored device.name
      const anyDbInst = dbInstances[0];
      const dbDeviceName = anyDbInst?.device?.name ?? "Unknown device";
      const deviceName = liveDevice?.deviceName ?? dbDeviceName;
      const lastSeenAt = liveDevice?.lastSeenAt
        ?? (anyDbInst?.device?.last_seen_at ? new Date(anyDbInst.device.last_seen_at).getTime() : null);
      const online = liveDevice?.online ?? (anyDbInst?.device?.online ?? false);

      const services: LocalServiceView[] = [];

      // 1. Registered services (from DB), overlaid with live heartbeat state.
      for (const inst of dbInstances) {
        const preset = BUILTIN_PRESETS[inst.preset_type];
        const liveInst = liveDevice?.instances.find((li) => li.instanceId === inst.id);
        const { status, error, toolCount } = deriveStatus(inst, liveInst);
        services.push({
          instanceId: inst.id,
          presetType: inst.preset_type,
          displayName: inst.display_name ?? preset?.display_name ?? inst.preset_type,
          label: inst.label,
          url: (inst.config as { url?: string })?.url,
          toolCount: toolCount ?? liveInst?.toolCount,
          status,
          error,
          protocolBadge: "MCP",
        });
      }

      // 2. Discovered services (heartbeat only, not in DB).
      // The overlay already filters out services whose URL matches an active
      // client, so anything in discovered[] is truly "not yet registered".
      for (const disc of liveDevice?.discovered ?? []) {
        // Skip if a DB instance with the same preset + URL already exists
        // (defensive — the overlay should have filtered, but we double-check).
        const alreadyRegistered = dbInstances.some(
          (i) =>
            i.preset_type === disc.presetType &&
            (i.config as { url?: string })?.url === disc.url,
        );
        if (alreadyRegistered) continue;

        const preset = BUILTIN_PRESETS[disc.presetType];
        services.push({
          presetType: disc.presetType,
          displayName: disc.serverName ?? preset?.display_name ?? disc.presetType,
          url: disc.url,
          toolCount: disc.toolCount,
          status: "discovered",
          protocolBadge: "MCP",
        });
      }

      result.push({
        deviceId,
        deviceName,
        online,
        lastSeenAt,
        overlayVersion: liveDevice?.overlayVersion,
        osInfo: liveDevice?.osInfo,
        services,
      });
    }

    // Sort: online devices first, then by deviceName.
    result.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.deviceName.localeCompare(b.deviceName);
    });

    return result;
  }, [dbHook.localInstances, heartbeat.devices]);

  return {
    devices,
    loading: dbHook.loading,
    reload: dbHook.reload,
    bridgeConnected: heartbeat.connected,
  };
}
