"use client";

import type { PresenceClient } from "@/types/presence";

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function typeIcon(type: PresenceClient["type"]): string {
  switch (type) {
    case "figma-plugin": return "F";
    case "webapp": return "W";
    case "overlay": return "O";
  }
}

function typeLabel(type: PresenceClient["type"]): string {
  switch (type) {
    case "figma-plugin": return "Figma Plugin";
    case "webapp": return "Webapp";
    case "overlay": return "Overlay";
  }
}

type Props = {
  clients: PresenceClient[];
  loading?: boolean;
};

export function ConnectedClients({ clients, loading }: Props) {
  if (loading) {
    return (
      <section className="mb-8 p-4 rounded-xl bg-white/[0.04] border border-white/[0.08]">
        <h2 className="text-sm font-medium mb-3">Connected Clients</h2>
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-16 rounded-xl bg-white/[0.03] animate-pulse" />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="mb-8 p-4 rounded-xl bg-white/[0.04] border border-white/[0.08]">
      <h2 className="text-sm font-medium mb-3">
        Connected Clients
        {clients.length > 0 && (
          <span className="ml-2 text-xs text-white/40">{clients.length}</span>
        )}
      </h2>

      {clients.length === 0 ? (
        <p className="text-xs text-white/30">No clients connected</p>
      ) : (
        <div className="space-y-2">
          {clients.map((client) => (
            <div
              key={client.presenceRef}
              className="px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.06]"
            >
              <div className="flex items-center gap-3">
                {/* Type badge */}
                <div className="w-7 h-7 rounded-md bg-white/[0.08] flex items-center justify-center text-xs font-mono text-white/60 shrink-0">
                  {typeIcon(client.type)}
                </div>

                {/* Main info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                    <span className="text-sm font-medium truncate">
                      {typeLabel(client.type)}
                    </span>
                    <span className="text-xs font-mono text-white/40">
                      {client.shortId}
                    </span>
                  </div>
                  <div className="text-xs text-white/40 mt-0.5 truncate">
                    {client.label}
                    {client.fileKey && (
                      <span className="ml-2 text-white/25">
                        File: {client.fileKey.slice(0, 8)}...
                      </span>
                    )}
                  </div>
                </div>

                {/* Connected time */}
                <span className="text-xs text-white/25 shrink-0">
                  {timeAgo(client.connectedAt)}
                </span>
              </div>

              {/* MCP sub-info */}
              {client.mcpInfo && (
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
