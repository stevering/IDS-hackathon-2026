"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { GlassDropdown } from "./GlassDropdown";

export type DotStatus = "active" | "offline" | "not-configured";

export type TargetItem = {
  id: string;
  kind: "plugin" | "mcp";
  label: string;
  status: DotStatus;
  tooltip: string;
  description: string;
  clientId?: string;
};

type Props = {
  items: TargetItem[];
  label: string;
  tooltip?: string;
  emptyDescription?: string;
  selected: string | null;
  onSelect: (id: string | null) => void;
};

function StatusDot({ status, className = "" }: { status: DotStatus; className?: string }) {
  const base = "w-2 h-2 rounded-full shrink-0";
  if (status === "active") {
    return <div className={`${base} bg-emerald-400 ${className}`} />;
  }
  if (status === "offline") {
    return <div className={`${base} bg-white/30 ${className}`} />;
  }
  return <div className={`${base} bg-transparent border border-white/30 ${className}`} />;
}

function InfoIcon({ title }: { title: string }) {
  return (
    <span title={title} className="shrink-0 text-white/25 hover:text-white/50 transition-colors cursor-help">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.2a5.8 5.8 0 110 11.6A5.8 5.8 0 018 2.2zM8 4.5a.75.75 0 110 1.5.75.75 0 010-1.5zm-.75 3h1.5v4h-1.5v-4z" />
      </svg>
    </span>
  );
}

export function TargetSelector({ items, label, tooltip, emptyDescription, selected, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const activeItems = items.filter((i) => i.status === "active");
  const selectedItem = items.find((i) => i.id === selected);

  // Auto-select when exactly one active item; deselect when none active
  useEffect(() => {
    if (activeItems.length === 1 && selected !== activeItems[0].id) {
      onSelect(activeItems[0].id);
    } else if (activeItems.length === 0 && selected !== null) {
      onSelect(null);
    }
  }, [activeItems, selected, onSelect]);

  // Deselect if the selected item is no longer active
  useEffect(() => {
    if (selected && selectedItem && selectedItem.status !== "active") {
      onSelect(null);
    }
  }, [selected, selectedItem, onSelect]);

  const handleClose = useCallback(() => setOpen(false), []);

  // No items at all (all MCPs disabled) — static label with info icon
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-white/30">
        <StatusDot status="not-configured" />
        <span className="hidden sm:inline">{label}</span>
        {emptyDescription && <InfoIcon title={emptyDescription} />}
      </div>
    );
  }

  // No active items but has inactive items — dropdown to show what's offline/not configured
  if (activeItems.length === 0) {
    return (
      <div className="relative">
        <button
          ref={btnRef}
          onClick={() => setOpen(!open)}
          title={tooltip}
          className="flex items-center gap-1.5 text-xs text-white/30 hover:text-white/50 transition-colors cursor-pointer"
        >
          <StatusDot status="not-configured" />
          <span className="hidden sm:inline">{label}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <GlassDropdown open={open} onClose={handleClose} anchorRef={btnRef} side="top" align="left" width={240}>
          {items.map((item) => (
            <div
              key={item.id}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-white/30 cursor-default"
            >
              <StatusDot status={item.status} />
              <span className="flex-1 text-left truncate">{item.label}</span>
              <InfoIcon title={item.description} />
            </div>
          ))}
        </GlassDropdown>
      </div>
    );
  }

  // Exactly one active item and no inactive items — show directly, no dropdown
  if (activeItems.length === 1 && items.length === 1) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-white/70" title={tooltip}>
        <StatusDot status="active" />
        <span className="hidden sm:inline">{activeItems[0].label}</span>
      </div>
    );
  }

  // Multiple items (or 1 active + inactive) — dropdown
  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => setOpen(!open)}
        title={tooltip}
        className="flex items-center gap-1.5 text-xs text-white/70 hover:text-white/90 transition-colors cursor-pointer"
      >
        <StatusDot status={selectedItem?.status ?? "not-configured"} />
        <span className="hidden sm:inline">
          {selectedItem ? selectedItem.label : label}
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <GlassDropdown open={open} onClose={handleClose} anchorRef={btnRef} side="top" align="left" width={240}>
        {items.map((item) => {
          const isActive = item.status === "active";
          return (
            <button
              key={item.id}
              disabled={!isActive}
              onClick={() => {
                if (isActive) {
                  onSelect(item.id);
                  setOpen(false);
                }
              }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${
                isActive
                  ? "text-white/70 hover:bg-white/10 cursor-pointer"
                  : "text-white/25 cursor-default"
              }`}
            >
              <StatusDot status={item.status} />
              <span className="flex-1 text-left truncate">{item.label}</span>
              <InfoIcon title={item.description} />
              {selected === item.id && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-emerald-400 shrink-0">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              )}
            </button>
          );
        })}
      </GlassDropdown>
    </div>
  );
}
