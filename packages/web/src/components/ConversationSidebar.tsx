"use client";

import { useState, useMemo, type ReactNode } from "react";
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

// ── Orchestration check ─────────────────────────────────────────────────────

function isOrchestration(c: Conversation): boolean {
  return !!c.orchestration_id || !!(c.metadata as Record<string, unknown>)?.workflowId;
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
  settingsContent: ReactNode;
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
  settingsContent,
}: ConversationSidebarProps) {
  const [tab, setTab] = useState<"conversations" | "settings">("conversations");
  const [search, setSearch] = useState("");

  // Filter & group conversations
  const standalone = useMemo(() => conversations.filter((c) => !isOrchestration(c)), [conversations]);
  const collaborative = useMemo(() => conversations.filter(isOrchestration), [conversations]);

  const filteredStandalone = useMemo(() => {
    if (!search.trim()) return standalone;
    const q = search.toLowerCase();
    return standalone.filter((c) => c.title.toLowerCase().includes(q));
  }, [standalone, search]);

  const filteredCollaborative = useMemo(() => {
    if (!search.trim()) return collaborative;
    const q = search.toLowerCase();
    return collaborative.filter((c) => c.title.toLowerCase().includes(q));
  }, [collaborative, search]);

  const groupedStandalone = useMemo(() => groupByDate(filteredStandalone), [filteredStandalone]);
  const groupedCollaborative = useMemo(() => groupByDate(filteredCollaborative), [filteredCollaborative]);

  // ── Collapsed rail ──────────────────────────────────────────────────────

  if (collapsed) {
    return (
      <div className="hidden md:flex flex-col items-center py-3 gap-3 w-12 h-full glass-sidebar shrink-0">
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
          onClick={() => { setTab("conversations"); onToggleCollapse(); }}
          className={`p-2 rounded-md transition-colors cursor-pointer ${tab === "conversations" ? "text-white/80 bg-white/10" : "text-white/40 hover:text-white/60 hover:bg-white/5"}`}
          title="Conversations"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
        </button>
        <button
          onClick={() => { setTab("settings"); onToggleCollapse(); }}
          className={`p-2 rounded-md transition-colors cursor-pointer ${tab === "settings" ? "text-white/80 bg-white/10" : "text-white/40 hover:text-white/60 hover:bg-white/5"}`}
          title="Settings"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>
    );
  }

  // ── Expanded sidebar ────────────────────────────────────────────────────

  const renderConversationList = () => (
    <div className="flex-1 overflow-y-auto">
      {/* Search */}
      <div className="px-3 pt-3 pb-2">
        <div className="relative">
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
            placeholder="Search conversations..."
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

      {/* Standalone conversations grouped by date */}
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
            />
          ))}
        </div>
      ))}

      {/* Collaborative conversations */}
      {groupedCollaborative.length > 0 && (
        <>
          <div className="px-3 py-1.5 text-[10px] text-white/30 uppercase tracking-wider border-t border-white/10 mt-2">
            Collaborative
          </div>
          {groupedCollaborative.map((group) => (
            <div key={`collab-${group.label}`}>
              <div className="px-3 py-1 text-[10px] text-white/20 tracking-wider">
                {group.label}
              </div>
              {group.conversations.map((conv) => (
                <ConversationRow
                  key={conv.id}
                  conversation={conv}
                  isActive={conv.id === activeId}
                  hasUnread={unreadIds?.has(conv.id) ?? false}
                  isParallel
                  onSelect={() => onSwitch(conv.id)}
                  onDelete={() => onDelete(conv.id)}
                  onRename={(title) => onRename(conv.id, title)}
                />
              ))}
            </div>
          ))}
        </>
      )}

      {/* Empty state */}
      {filteredStandalone.length === 0 && filteredCollaborative.length === 0 && (
        <div className="px-3 py-8 text-xs text-white/30 text-center">
          {search ? "No conversations match your search" : "No conversations yet"}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col h-full w-full sm:w-72 glass-sidebar shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-white/10">
        <span className="text-xs font-semibold text-white/60 uppercase tracking-wider">
          {tab === "conversations" ? "Conversations" : "Settings"}
        </span>
        <button
          onClick={onToggleCollapse}
          className="p-1 rounded-md hover:bg-white/10 text-white/40 hover:text-white/80 transition-colors cursor-pointer"
          title="Collapse sidebar"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 19l-7-7 7-7" />
            <path d="M18 5v14" />
          </svg>
        </button>
      </div>

      {/* Tab content */}
      {tab === "conversations" ? renderConversationList() : (
        <div className="flex-1 overflow-y-auto p-4">
          {settingsContent}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex items-center border-t border-white/10 shrink-0">
        <button
          onClick={() => setTab("conversations")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs transition-colors cursor-pointer ${
            tab === "conversations" ? "text-white/80 bg-white/5" : "text-white/40 hover:text-white/60"
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
          <span className="hidden sm:inline">Chats</span>
        </button>
        <div className="w-px h-4 bg-white/10" />
        <button
          onClick={() => setTab("settings")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs transition-colors cursor-pointer ${
            tab === "settings" ? "text-white/80 bg-white/5" : "text-white/40 hover:text-white/60"
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span className="hidden sm:inline">Settings</span>
        </button>
      </div>
    </div>
  );
}
