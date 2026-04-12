"use client";

/**
 * "Local services" section of the Account page.
 *
 * Groups local services by Desktop Companion (device), and for each device
 * lists: active / offline / disabled / ignored services + DISCOVERED (scan results
 * not yet registered). The user can Enable / Ignore / Disable / Remove each.
 */

import { useState } from "react";
import { useLocalServicesView, type LocalServiceView, type LocalServiceStatus } from "@/app/hooks/useLocalServicesView";

export function LocalServicesSection() {
  const view = useLocalServicesView();
  const [showIgnored, setShowIgnored] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Enable a discovered service (POST to create the row).
  const enableDiscovered = async (deviceId: string, svc: LocalServiceView) => {
    const key = `${deviceId}:${svc.presetType}:${svc.url ?? ""}`;
    setBusy(key);
    try {
      await fetch("/api/user/mcp-instances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preset_type: svc.presetType,
          device_id: deviceId,
          config: svc.url ? { url: svc.url } : {},
        }),
      });
      await view.reload();
    } finally {
      setBusy(null);
    }
  };

  // Ignore a discovered service: create a row with enabled=false + dismissed=true.
  const ignoreDiscovered = async (deviceId: string, svc: LocalServiceView) => {
    const key = `${deviceId}:${svc.presetType}:${svc.url ?? ""}`;
    setBusy(key);
    try {
      const createRes = await fetch("/api/user/mcp-instances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preset_type: svc.presetType,
          device_id: deviceId,
          config: svc.url ? { url: svc.url } : {},
        }),
      });
      const created = await createRes.json();
      if (created.id) {
        await fetch(`/api/user/mcp-instances?id=${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false, dismissed: true }),
        });
      }
      await view.reload();
    } finally {
      setBusy(null);
    }
  };

  const toggleEnabled = async (instanceId: string, next: boolean) => {
    setBusy(instanceId);
    try {
      await fetch(`/api/user/mcp-instances?id=${instanceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next, dismissed: false }),
      });
      await view.reload();
    } finally {
      setBusy(null);
    }
  };

  const removeInstance = async (instanceId: string) => {
    setBusy(instanceId);
    try {
      await fetch(`/api/user/mcp-instances?id=${instanceId}`, { method: "DELETE" });
      await view.reload();
    } finally {
      setBusy(null);
    }
  };

  const restoreIgnored = async (instanceId: string) => {
    // Un-ignore: keep the row but clear dismissed so it shows up as a regular discovered again.
    // Simpler: just delete the row, and it'll reappear as discovered on the next heartbeat.
    await removeInstance(instanceId);
  };

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-medium">Local services</h2>
        {view.devices.some((d) => d.services.some((s) => s.status === "ignored")) && (
          <button
            onClick={() => setShowIgnored((v) => !v)}
            className="text-[11px] text-white/40 hover:text-white/70"
          >
            {showIgnored ? "Hide ignored" : "Show ignored"}
          </button>
        )}
      </div>
      <p className="text-xs text-white/40 mb-4">
        Services running on your machine, bridged via the Guardian Desktop Companion.
      </p>

      {view.loading ? (
        <div className="h-20 rounded-xl bg-white/[0.04] animate-pulse" />
      ) : view.devices.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-3">
          {view.devices.map((d) => (
            <DeviceCard
              key={d.deviceId}
              device={d}
              showIgnored={showIgnored}
              busy={busy}
              onEnable={(svc) => enableDiscovered(d.deviceId, svc)}
              onIgnore={(svc) => ignoreDiscovered(d.deviceId, svc)}
              onToggleEnabled={toggleEnabled}
              onRemove={removeInstance}
              onRestoreIgnored={restoreIgnored}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function EmptyState() {
  return (
    <div className="px-4 py-6 rounded-xl bg-white/[0.04] border border-white/[0.08] text-center">
      <p className="text-sm text-white/30 mb-2">No Desktop Companion detected</p>
      <p className="text-xs text-white/20">
        Install the Guardian Desktop Companion on your machine to bridge local MCP services
        (Figma Desktop, Cursor, Claude Code, IntelliJ, etc).
      </p>
    </div>
  );
}

type DeviceCardProps = {
  device: ReturnType<typeof useLocalServicesView>["devices"][number];
  showIgnored: boolean;
  busy: string | null;
  onEnable: (svc: LocalServiceView) => void;
  onIgnore: (svc: LocalServiceView) => void;
  onToggleEnabled: (instanceId: string, next: boolean) => void;
  onRemove: (instanceId: string) => void;
  onRestoreIgnored: (instanceId: string) => void;
};

function DeviceCard({
  device, showIgnored, busy, onEnable, onIgnore, onToggleEnabled, onRemove, onRestoreIgnored,
}: DeviceCardProps) {
  const visibleServices = device.services.filter((s) => showIgnored || s.status !== "ignored");
  const lastSeenAgo = device.lastSeenAt
    ? formatAgo(Date.now() - device.lastSeenAt)
    : null;

  return (
    <div className="rounded-xl bg-white/[0.04] border border-white/[0.08] overflow-hidden">
      {/* Device header */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-white/[0.03] border-b border-white/[0.06]">
        <span className={`w-2 h-2 rounded-full shrink-0 ${device.online ? "bg-emerald-400" : "bg-white/25"}`} />
        <span className="text-sm font-medium truncate">{device.deviceName}</span>
        <span className="text-[11px] text-white/35">
          {device.online ? "online" : lastSeenAgo ? `last seen ${lastSeenAgo}` : "offline"}
        </span>
        {device.overlayVersion && (
          <span className="text-[10px] text-white/25 font-mono ml-auto">v{device.overlayVersion}</span>
        )}
      </div>

      {/* Services */}
      {visibleServices.length === 0 ? (
        <div className="px-4 py-3 text-xs text-white/30">No services yet</div>
      ) : (
        <div className="divide-y divide-white/[0.05]">
          {visibleServices.map((svc, i) => (
            <ServiceRow
              key={svc.instanceId ?? `${svc.presetType}:${svc.url}:${i}`}
              service={svc}
              busyKey={busy}
              deviceId={device.deviceId}
              onEnable={() => onEnable(svc)}
              onIgnore={() => onIgnore(svc)}
              onToggleEnabled={onToggleEnabled}
              onRemove={onRemove}
              onRestoreIgnored={onRestoreIgnored}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type ServiceRowProps = {
  service: LocalServiceView;
  busyKey: string | null;
  deviceId: string;
  onEnable: () => void;
  onIgnore: () => void;
  onToggleEnabled: (instanceId: string, next: boolean) => void;
  onRemove: (instanceId: string) => void;
  onRestoreIgnored: (instanceId: string) => void;
};

function ServiceRow({
  service, busyKey, deviceId, onEnable, onIgnore, onToggleEnabled, onRemove, onRestoreIgnored,
}: ServiceRowProps) {
  const discoveredKey = `${deviceId}:${service.presetType}:${service.url ?? ""}`;
  const isBusy = busyKey === service.instanceId || busyKey === discoveredKey;
  const meta = [
    service.toolCount != null ? `${service.toolCount} tools` : null,
    service.label ? service.label : null,
    service.url ? shortenUrl(service.url) : null,
  ].filter(Boolean).join("  ·  ");

  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <StatusDot status={service.status} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm truncate">{service.displayName}</span>
          <span className="text-[9px] px-1 py-0.5 rounded bg-white/[0.06] text-white/35 font-mono">
            {service.protocolBadge}
          </span>
          <StatusBadge status={service.status} />
        </div>
        {meta && <p className="text-[11px] text-white/30 truncate">{meta}</p>}
        {service.error && (
          <p className="text-[11px] text-amber-300/70 truncate" title={service.error}>
            {service.error}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {service.status === "discovered" && (
          <>
            <button
              onClick={onEnable}
              disabled={isBusy}
              className="text-xs px-2.5 py-1 rounded-md bg-emerald-500/15 border border-emerald-500/25 hover:bg-emerald-500/25 text-emerald-300 disabled:opacity-40"
            >
              Enable
            </button>
            <button
              onClick={onIgnore}
              disabled={isBusy}
              className="text-xs px-2 py-1 rounded-md text-white/40 hover:text-white/70 disabled:opacity-40"
            >
              Ignore
            </button>
          </>
        )}
        {(service.status === "active" || service.status === "active_offline") && service.instanceId && (
          <>
            <button
              onClick={() => onToggleEnabled(service.instanceId!, false)}
              disabled={isBusy}
              className="text-xs px-2 py-1 rounded-md text-white/40 hover:text-white/70 disabled:opacity-40"
            >
              Disable
            </button>
            <button
              onClick={() => onRemove(service.instanceId!)}
              disabled={isBusy}
              className="text-xs px-2 py-1 rounded-md text-red-400/70 hover:text-red-400 disabled:opacity-40"
            >
              Remove
            </button>
          </>
        )}
        {service.status === "disabled" && service.instanceId && (
          <>
            <button
              onClick={() => onToggleEnabled(service.instanceId!, true)}
              disabled={isBusy}
              className="text-xs px-2.5 py-1 rounded-md bg-emerald-500/15 border border-emerald-500/25 hover:bg-emerald-500/25 text-emerald-300 disabled:opacity-40"
            >
              Enable
            </button>
            <button
              onClick={() => onRemove(service.instanceId!)}
              disabled={isBusy}
              className="text-xs px-2 py-1 rounded-md text-red-400/70 hover:text-red-400 disabled:opacity-40"
            >
              Remove
            </button>
          </>
        )}
        {service.status === "ignored" && service.instanceId && (
          <button
            onClick={() => onRestoreIgnored(service.instanceId!)}
            disabled={isBusy}
            className="text-xs px-2 py-1 rounded-md text-white/40 hover:text-white/70 disabled:opacity-40"
          >
            Restore
          </button>
        )}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: LocalServiceStatus }) {
  const cls =
    status === "active" ? "bg-emerald-400" :
    status === "discovered" ? "bg-sky-400" :
    status === "active_offline" ? "bg-amber-400/60" :
    status === "disabled" ? "bg-white/25" :
    /* ignored */ "bg-white/10";
  return <span className={`w-2 h-2 rounded-full shrink-0 ${cls}`} />;
}

function StatusBadge({ status }: { status: LocalServiceStatus }) {
  if (status === "discovered") {
    return <span className="text-[9px] px-1 py-0.5 rounded bg-sky-500/15 text-sky-300 font-medium tracking-wide">DISCOVERED</span>;
  }
  if (status === "active_offline") {
    return <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-300 font-medium">OFFLINE</span>;
  }
  if (status === "disabled") {
    return <span className="text-[9px] px-1 py-0.5 rounded bg-white/[0.08] text-white/40 font-medium">DISABLED</span>;
  }
  if (status === "ignored") {
    return <span className="text-[9px] px-1 py-0.5 rounded bg-white/[0.04] text-white/30 font-medium">IGNORED</span>;
  }
  return null; // "active" → no badge, the green dot speaks for itself
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

function formatAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
