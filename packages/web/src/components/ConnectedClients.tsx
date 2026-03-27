"use client";

import { useEffect, useState, useRef } from "react";
import type { PresenceClient } from "@/types/presence";
import type { ConnectionStatus } from "@/app/hooks/useFigmaExecuteChannel";

// ── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function typeIcon(type: string): string {
  switch (type) {
    case "figma-plugin": return "F";
    case "webapp": return "W";
    case "overlay": return "O";
    default: return "?";
  }
}

function typeLabel(type: string): string {
  switch (type) {
    case "figma-plugin": return "Figma Plugin";
    case "webapp": return "Webapp";
    case "overlay": return "Overlay";
    default: return type;
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

type DbClient = {
  id: string;
  client_id: string;
  client_type: string;
  short_id: string;
  label: string | null;
  file_key: string | null;
  last_seen_at: string;
  created_at: string;
  agent_role: string;
};

type MergedClient = {
  clientId: string;
  shortId: string;
  type: string;
  label: string;
  fileKey?: string;
  lastSeen: string;
  createdAt: string;
  online: boolean;
  agentRole: string;
  mcpInfo?: PresenceClient["mcpInfo"];
  figmaContext?: PresenceClient["figmaContext"];
};

// ── Props ───────────────────────────────────────────────────────────────────

type Props = {
  clients: PresenceClient[];  // Realtime presence (online clients)
  loading?: boolean;
  connectionStatus?: ConnectionStatus;
};

// ── Component ───────────────────────────────────────────────────────────────

export function ConnectedClients({ clients: presenceClients, loading, connectionStatus }: Props) {
  const [dbClients, setDbClients] = useState<DbClient[]>([]);
  const [dbLoading, setDbLoading] = useState(true);

  // Fetch all registered clients from DB on mount
  useEffect(() => {
    fetch("/api/clients")
      .then((res) => res.json())
      .then(({ clients }) => setDbClients(clients ?? []))
      .catch(() => {})
      .finally(() => setDbLoading(false));
  }, []);

  // Cache presence-only clients so they transition to offline smoothly
  // instead of disappearing when they leave presence but aren't yet in DB.
  const seenPresenceOnly = useRef<Map<string, MergedClient>>(new Map());

  // Re-fetch DB when a presence client disappears (may now be registered in DB as offline)
  const prevPresenceIds = useRef(new Set<string>());
  useEffect(() => {
    const currentIds = new Set(presenceClients.map((c) => c.clientId));
    const prevIds = prevPresenceIds.current;
    prevPresenceIds.current = currentIds;

    // Check if any client left
    let clientLeft = false;
    for (const id of prevIds) {
      if (!currentIds.has(id)) { clientLeft = true; break; }
    }
    if (clientLeft) {
      fetch("/api/clients")
        .then((res) => res.json())
        .then(({ clients }) => {
          setDbClients(clients ?? []);
          // Clean up cached presence-only entries that are now in DB
          const dbIds = new Set((clients ?? []).map((c: DbClient) => c.client_id));
          for (const id of seenPresenceOnly.current.keys()) {
            if (dbIds.has(id)) seenPresenceOnly.current.delete(id);
          }
        })
        .catch(() => {});
    }
  }, [presenceClients]);

  // Merge DB clients with Realtime presence
  const onlineSet = new Set(presenceClients.map((c) => c.clientId));
  const dbClientIds = new Set(dbClients.map((db) => db.client_id));

  const merged: MergedClient[] = dbClients.map((db) => {
    const rt = presenceClients.find((p) => p.clientId === db.client_id);
    return {
      clientId: db.client_id,
      shortId: rt?.shortId ?? db.short_id,
      type: db.client_type,
      label: rt?.label ?? db.label ?? db.client_type,
      fileKey: rt?.fileKey ?? db.file_key ?? undefined,
      lastSeen: db.last_seen_at,
      createdAt: db.created_at,
      online: onlineSet.has(db.client_id),
      agentRole: rt?.agentRole ?? db.agent_role,
      mcpInfo: rt?.mcpInfo,
      figmaContext: rt?.figmaContext,
    };
  });

  // Add presence-only clients (not yet in DB) — cache them so they
  // transition to offline instead of disappearing when they leave presence.
  for (const rt of presenceClients) {
    if (!dbClientIds.has(rt.clientId)) {
      const entry: MergedClient = {
        clientId: rt.clientId,
        shortId: rt.shortId,
        type: rt.type,
        label: rt.label,
        fileKey: rt.fileKey,
        lastSeen: new Date(rt.connectedAt).toISOString(),
        createdAt: new Date(rt.connectedAt).toISOString(),
        online: true,
        agentRole: rt.agentRole ?? "idle",
        mcpInfo: rt.mcpInfo,
        figmaContext: rt.figmaContext,
      };
      seenPresenceOnly.current.set(rt.clientId, entry);
      merged.push(entry);
    }
  }

  // Show cached presence-only clients that left presence as offline
  for (const [id, cached] of seenPresenceOnly.current) {
    if (!onlineSet.has(id) && !dbClientIds.has(id)) {
      merged.push({ ...cached, online: false });
    }
  }

  // Stable sort: keep existing order, append newcomers at the end.
  // On refresh, falls back to clientId order.
  const knownOrder = useRef<string[]>([]);
  const orderMap = new Map(knownOrder.current.map((id, i) => [id, i]));
  merged.sort((a, b) => {
    const ai = orderMap.get(a.clientId) ?? Infinity;
    const bi = orderMap.get(b.clientId) ?? Infinity;
    if (ai !== bi) return ai - bi;
    // Both new — sort by clientId for determinism
    return a.clientId.localeCompare(b.clientId);
  });
  knownOrder.current = merged.map((c) => c.clientId);

  const isLoading = loading || dbLoading;

  if (isLoading) {
    return (
      <section className="mb-8 p-4 rounded-xl bg-white/[0.04] border border-white/[0.08]">
        <h2 className="text-sm font-medium mb-3">
          Clients
          {connectionStatus && connectionStatus !== "connected" && (
            <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded ${
              connectionStatus === "reconnecting"
                ? "bg-amber-500/15 text-amber-400"
                : "bg-blue-500/15 text-blue-400"
            }`}>
              {connectionStatus === "reconnecting" ? "reconnecting..." : "connecting..."}
            </span>
          )}
        </h2>
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-16 rounded-xl bg-white/[0.03] animate-pulse" />
          ))}
        </div>
      </section>
    );
  }

  const onlineCount = merged.filter((c) => c.online).length;

  return (
    <section className="mb-8 p-4 rounded-xl bg-white/[0.04] border border-white/[0.08]">
      <h2 className="text-sm font-medium mb-3">
        Clients
        <span className="ml-2 text-xs text-white/40">
          {onlineCount} online / {merged.length} registered
        </span>
        {connectionStatus && connectionStatus !== "connected" && (
          <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded ${
            connectionStatus === "reconnecting"
              ? "bg-amber-500/15 text-amber-400"
              : "bg-blue-500/15 text-blue-400"
          }`}>
            {connectionStatus === "reconnecting" ? "reconnecting..." : "connecting..."}
          </span>
        )}
      </h2>

      {merged.length === 0 ? (
        <p className="text-xs text-white/30">No clients registered</p>
      ) : (
        <div className="space-y-2">
          {merged.map((client) => (
            <div
              key={client.clientId}
              className={`px-4 py-3 rounded-xl border ${
                client.online
                  ? "bg-white/[0.04] border-white/[0.06]"
                  : "bg-white/[0.02] border-white/[0.04] opacity-60"
              }`}
            >
              <div className="flex items-center gap-3">
                {/* Type badge */}
                <div className={`w-7 h-7 rounded-md flex items-center justify-center text-xs font-mono shrink-0 ${
                  client.online ? "bg-white/[0.08] text-white/60" : "bg-white/[0.04] text-white/30"
                }`}>
                  {typeIcon(client.type)}
                </div>

                {/* Main info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${
                      client.online ? "bg-emerald-400" : "bg-white/20"
                    }`} />
                    <span className="text-sm font-medium truncate">
                      {typeLabel(client.type)}
                    </span>
                    <span className="text-xs font-mono text-white/40">
                      {client.shortId}
                    </span>
                  </div>
                  <div className="text-xs text-white/40 mt-0.5 truncate">
                    {client.label}
                    {client.figmaContext?.fileName && (
                      <span className="ml-2 text-white/25">
                        {client.figmaContext.fileName}
                      </span>
                    )}
                    {!client.figmaContext?.fileName && client.fileKey && (
                      <span className="ml-2 text-white/25">
                        File: {client.fileKey.slice(0, 8)}...
                      </span>
                    )}
                  </div>
                </div>

                {/* Status */}
                <div className="text-right shrink-0">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    client.online
                      ? "bg-emerald-500/15 text-emerald-400"
                      : "bg-white/5 text-white/30"
                  }`}>
                    {client.online ? "online" : "offline"}
                  </span>
                  <div className="text-[10px] text-white/20 mt-0.5">
                    {timeAgo(client.lastSeen)}
                  </div>
                </div>
              </div>

              {/* MCP sub-info (only for online clients) */}
              {client.online && client.mcpInfo && (
                <div className="ml-10 mt-2 space-y-1">
                  {client.mcpInfo.figma && (
                    <div className="flex items-center gap-2 text-xs text-white/35">
                      <div
                        className={`w-1.5 h-1.5 rounded-full ${client.mcpInfo.figma.connected ? "bg-emerald-400" : "bg-white/20"}`}
                      />
                      <span>Figma MCP: {client.mcpInfo.figma.mode}</span>
                    </div>
                  )}
                  {client.mcpInfo.code && (
                    <div className="flex items-center gap-2 text-xs text-white/35">
                      <div
                        className={`w-1.5 h-1.5 rounded-full ${client.mcpInfo.code.connected ? "bg-emerald-400" : "bg-white/20"}`}
                      />
                      <span className="truncate">
                        Code MCP: {client.mcpInfo.code.path}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
