"use client";

import { useState, useRef, useEffect } from "react";
import type { PresenceClient } from "@/types/presence";

type Props = {
  clients: PresenceClient[];
  filterType: "figma-plugin" | "webapp" | "overlay";
  label: string;
  selected: string | null;
  onSelect: (presenceRef: string | null) => void;
};

export function ClientSelector({ clients, filterType, label, selected, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const filtered = clients.filter((c) => c.type === filterType);
  const selectedClient = filtered.find((c) => c.clientId === selected);

  // Auto-select the only client
  useEffect(() => {
    if (filtered.length === 1 && selected !== filtered[0].clientId) {
      onSelect(filtered[0].clientId);
    } else if (filtered.length === 0 && selected !== null) {
      onSelect(null);
    }
  }, [filtered, selected, onSelect]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  if (filtered.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-white/30">
        <div className="w-2 h-2 rounded-full bg-white/15" />
        <span className="hidden sm:inline">{label}</span>
      </div>
    );
  }

  if (filtered.length === 1) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-white/70">
        <div className="w-2 h-2 rounded-full bg-emerald-400" />
        <span className="hidden sm:inline">
          {filtered[0].shortId} {filtered[0].label}
        </span>
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-white/70 hover:text-white/90 transition-colors cursor-pointer"
      >
        <div className="w-2 h-2 rounded-full bg-emerald-400" />
        <span className="hidden sm:inline">
          {selectedClient ? `${selectedClient.shortId} ${selectedClient.label}` : label}
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute top-full right-0 mt-1 min-w-[180px] rounded-lg border border-white/10 py-1 z-50"
          style={{
            background: "rgba(20,20,20,0.95)",
            backdropFilter: "blur(12px)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          }}
        >
          {filtered.map((client) => (
            <button
              key={client.presenceRef}
              onClick={() => {
                onSelect(client.clientId);
                setOpen(false);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-white/70 hover:bg-white/10 transition-colors cursor-pointer"
            >
              <div className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
              <span className="flex-1 text-left truncate">
                {client.shortId} {client.label}
              </span>
              {selected === client.clientId && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-emerald-400 shrink-0">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
