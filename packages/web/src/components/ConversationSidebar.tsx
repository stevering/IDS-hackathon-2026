"use client";

import { useState, useMemo, useEffect, type ReactNode } from "react";
import type { Conversation } from "@/app/hooks/useConversations";
import { ConversationRow } from "./ConversationRow";

// ── Date grouping ───────────────────────────────────────────────────────────

type DateGroup = { label: string; conversations: Conversation[] };

function groupByDate(convs: Conversation[]): DateGroup[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86_400_000;
  const weekStart = todayStart - 7 * 86_400_000;
  const monthStart = todayStart - 30 * 86_400_000;

  const groups: Record<string, Conversation[]> = {
    Today: [],
    Yesterday: [],
    "Previous 7 days": [],
    "Previous 30 days": [],
    Older: [],
  };

  for (const c of convs) {
    const t = new Date(c.updated_at).getTime();
    if (t >= todayStart) groups.Today.push(c);
    else if (t >= yesterdayStart) groups.Yesterday.push(c);
    else if (t >= weekStart) groups["Previous 7 days"].push(c);
    else if (t >= monthStart) groups["Previous 30 days"].push(c);
    else groups.Older.push(c);
  }

  return Object.entries(groups)
    .filter(([, list]) => list.length > 0)
    .map(([label, list]) => ({ label, conversations: list }));
}

// ── Client info type ────────────────────────────────────────────────────────

type KnownClient = {
  client_id: string;
  short_id: string;
  client_type: string;
  label: string | null;
};

function clientBadge(clientType: string): { letter: string; bg: string; text: string } {
  switch (clientType) {
    case "figma-plugin": return { letter: "F", bg: "bg-violet-500/15", text: "text-violet-400/70" };
    case "overlay": return { letter: "O", bg: "bg-amber-500/15", text: "text-amber-400/70" };
    default: return { letter: "W", bg: "bg-white/10", text: "text-white/40" };
  }
}

// ── Props ───────────────────────────────────────────────────────────────────

type ConversationSidebarProps = {
  conversations: Conversation[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  unreadIds?: Set<string>;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** @deprecated Settings moved to Account page. Prop kept for compat, ignored. */
  settingsContent?: ReactNode;
  childrenMap: Map<string, import("@/app/hooks/useConversations").Conversation[]>;
  activeWorkflowId?: string | null;
};

// ── Component ───────────────────────────────────────────────────────────────

export function ConversationSidebar({
  conversations,
  activeId,
  onSwitch,
  onCreate,
  onDelete,
  onRename,
  unreadIds,
  collapsed,
  onToggleCollapse,
  childrenMap,
  activeWorkflowId,
}: ConversationSidebarProps) {
  const tab = "conversations" as const;
  const [search, setSearch] = useState("");
  const [clientFilter, setClientFilter] = useState<string | null>(null); // null = all
  const [filterOpen, setFilterOpen] = useState(false);
  const [knownClients, setKnownClients] = useState<KnownClient[]>([]);

  // Fetch known clients for the filter dropdown
  useEffect(() => {
    fetch("/api/clients")
      .then((res) => res.json())
      .then(({ clients }) => setKnownClients(clients ?? []))
      .catch(() => {});
  }, []);

  // Build a lookup for client_id → KnownClient
  const clientLookup = useMemo(() => {
    const map = new Map<string, KnownClient>();
    for (const c of knownClients) map.set(c.client_id, c);
    return map;
  }, [knownClients]);

  // Filter & group conversations
  const filteredStandalone = useMemo(() => {
    let list = conversations;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((c) => c.title.toLowerCase().includes(q));
    }
    if (clientFilter) {
      list = list.filter((c) => c.client_id === clientFilter);
    }
    return list;
  }, [conversations, search, clientFilter]);

  const groupedStandalone = useMemo(() => groupByDate(filteredStandalone), [filteredStandalone]);

  // ── Collapsed rail ──────────────────────────────────────────────────────

  if (collapsed) {
    return (
      <div className="hidden md:flex flex-col items-center py-3 gap-3 w-12 h-full shrink-0">
        {/* Toggle expand */}
        <button
          onClick={onToggleCollapse}
          className="p-2 rounded-md hover:bg-white/10 text-white/40 hover:text-white/80 transition-colors cursor-pointer"
          title="Expand sidebar"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>
        {/* New conversation */}
        <button
          onClick={onCreate}
          className="p-2 rounded-md hover:bg-white/10 text-white/40 hover:text-white/80 transition-colors cursor-pointer"
          title="New conversation"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        {/* Spacer */}
        <div className="flex-1" />
        {/* Tab icons */}
        <button
          onClick={() => { onToggleCollapse(); }}
          className={`p-2 rounded-md transition-colors cursor-pointer ${tab === "conversations" ? "text-white/80 bg-white/10" : "text-white/40 hover:text-white/60 hover:bg-white/5"}`}
          title="Conversations"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
        </button>
        {/* Settings tab removed — connections managed in Account page */}
      </div>
    );
  }

  // ── Expanded sidebar ────────────────────────────────────────────────────

  const renderConversationList = () => (
    <div className="flex-1 overflow-y-auto">
      {/* Search + client filter */}
      <div className="px-3 pt-3 pb-2 space-y-1.5">
        <div className="flex gap-1.5">
          {/* Search input */}
          <div className="relative flex-1">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="w-full bg-white/5 border border-white/10 rounded-md pl-8 pr-3 py-1.5 text-xs text-white placeholder:text-white/25 focus:outline-none focus:border-white/25"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 cursor-pointer"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          {/* Client filter dropdown */}
          {knownClients.length > 1 && (
            <div className="relative">
              <button
                onClick={() => setFilterOpen(!filterOpen)}
                className={`px-2 py-1.5 text-[10px] rounded-md border transition-colors cursor-pointer whitespace-nowrap ${
                  clientFilter
                    ? "bg-violet-500/15 border-violet-500/25 text-violet-300"
                    : "bg-white/5 border-white/10 text-white/40 hover:text-white/60"
                }`}
              >
                {clientFilter
                  ? (clientLookup.get(clientFilter)?.short_id ?? "?").slice(0, 6)
                  : "All"}
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="inline ml-0.5">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              {filterOpen && (
                <div className="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-md border border-white/10 bg-[rgba(10,10,10,0.9)] backdrop-blur-xl shadow-lg overflow-hidden">
                  <button
                    onClick={() => { setClientFilter(null); setFilterOpen(false); }}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors cursor-pointer ${
                      !clientFilter ? "bg-white/10 text-white/80" : "text-white/50 hover:bg-white/5"
                    }`}
                  >
                    All clients
                  </button>
                  {knownClients.map((kc) => {
                    const badge = clientBadge(kc.client_type);
                    return (
                      <button
                        key={kc.client_id}
                        onClick={() => { setClientFilter(kc.client_id); setFilterOpen(false); }}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors cursor-pointer ${
                          clientFilter === kc.client_id ? "bg-white/10 text-white/80" : "text-white/50 hover:bg-white/5"
                        }`}
                      >
                        <span className={`w-4 h-4 rounded text-[9px] flex items-center justify-center ${badge.bg} ${badge.text}`}>
                          {badge.letter}
                        </span>
                        <span className="truncate">{kc.short_id}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* New conversation button */}
      <button
        onClick={onCreate}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-white/50 hover:text-white/80 hover:bg-white/10 transition-colors cursor-pointer border-b border-white/10"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span>New conversation</span>
      </button>

      {/* Conversations grouped by date (with expandable children) */}
      {groupedStandalone.map((group) => (
        <div key={group.label}>
          <div className="px-3 py-1.5 text-[10px] text-white/30 uppercase tracking-wider mt-1">
            {group.label}
          </div>
          {group.conversations.map((conv) => (
            <ConversationRow
              key={conv.id}
              conversation={conv}
              isActive={conv.id === activeId}
              hasUnread={unreadIds?.has(conv.id) ?? false}
              onSelect={() => onSwitch(conv.id)}
              onDelete={() => onDelete(conv.id)}
              onRename={(title) => onRename(conv.id, title)}
              children={childrenMap.get(conv.id)}
              activeWorkflowId={activeWorkflowId}
              activeId={activeId}
              onSwitchChild={(id) => onSwitch(id)}
              clientInfo={conv.client_id ? clientLookup.get(conv.client_id) : undefined}
            />
          ))}
        </div>
      ))}

      {/* Empty state */}
      {filteredStandalone.length === 0 && (
        <div className="px-3 py-8 text-xs text-white/30 text-center">
          {search ? "No conversations match your search" : "No conversations yet"}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col h-full w-full sm:w-72 shrink-0">
      {/* Header with tabs + collapse button */}
      <div className="flex items-stretch border-b border-white/10 shrink-0">
        <button
          className="flex-1 flex items-center justify-center gap-1.5 py-3 text-xs text-white/80 bg-white/5"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
          <span className="hidden sm:inline">Chats</span>
        </button>
        <div className="w-px self-stretch bg-white/10" />
        <button
          onClick={onToggleCollapse}
          className="px-2.5 py-3 text-white/40 hover:text-white/80 hover:bg-white/5 transition-colors cursor-pointer"
          title="Collapse sidebar"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 19l-7-7 7-7" />
            <path d="M18 5v14" />
          </svg>
        </button>
      </div>

      {/* Content — always conversations (settings moved to Account page) */}
      {renderConversationList()}
    </div>
  );
}
