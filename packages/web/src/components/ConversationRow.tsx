"use client";

import { useState, useRef, useEffect } from "react";
import type { Conversation } from "@/app/hooks/useConversations";

// ── Relative time helper ────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric" });
}

// ── Component ───────────────────────────────────────────────────────────────

type ClientInfo = {
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

type Props = {
  conversation: Conversation;
  isActive: boolean;
  hasUnread: boolean;
  isParallel?: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  /** Sub-conversations (collabs) linked via parent_id */
  children?: Conversation[];
  /** Currently active workflowId (to auto-expand) */
  activeWorkflowId?: string | null;
  /** Currently active conversation ID (to highlight active child) */
  activeId?: string | null;
  /** Switch to a child conversation */
  onSwitchChild?: (id: string) => void;
  /** Client info for the badge */
  clientInfo?: ClientInfo;
};

export function ConversationRow({
  conversation,
  isActive,
  hasUnread,
  isParallel,
  onSelect,
  onDelete,
  onRename,
  children,
  activeWorkflowId,
  activeId,
  onSwitchChild,
  clientInfo,
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(conversation.title);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasChildren = children && children.length > 0;

  // Auto-expand when a child's workflowId matches the active one
  const hasActiveChild = hasChildren && children.some(
    (c) => (c.metadata as Record<string, unknown>)?.workflowId === activeWorkflowId
      || c.id === activeId
  );
  const [expanded, setExpanded] = useState(hasActiveChild);

  // Auto-expand when a child becomes active
  useEffect(() => {
    if (hasActiveChild) setExpanded(true);
  }, [hasActiveChild]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== conversation.title) {
      onRename(trimmed);
    } else {
      setEditValue(conversation.title);
    }
    setEditing(false);
  };

  return (
    <div>
      {/* Main row */}
      <div
        onClick={editing ? undefined : onSelect}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors cursor-pointer group ${
          isActive
            ? "bg-white/10 text-white/90 border-l-2 border-violet-500"
            : "text-white/60 hover:bg-white/5 hover:text-white/80 border-l-2 border-transparent"
        }`}
      >
        {/* Expand chevron for conversations with children */}
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className="shrink-0 text-white/30 hover:text-white/60 cursor-pointer p-0"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="currentColor"
              className={`transition-transform ${expanded ? "rotate-90" : ""}`}
            >
              <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
            </svg>
          </button>
        ) : isParallel ? (
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="shrink-0 text-violet-400/60"
          >
            <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M3 4l17 17" />
          </svg>
        ) : null}

        {/* Title or edit input */}
        {editing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setEditValue(conversation.title);
                setEditing(false);
              }
            }}
            className="flex-1 min-w-0 bg-white/10 border border-white/20 rounded px-1.5 py-0.5 text-xs text-white outline-none focus:border-violet-500/50"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="flex-1 text-left truncate min-w-0">
            {conversation.title}
          </span>
        )}

        {/* Time */}
        {!editing && (
          <span className="text-[10px] text-white/25 shrink-0">
            {relativeTime(conversation.updated_at)}
          </span>
        )}

        {/* Client badge [W] [F] with tooltip */}
        {!editing && clientInfo && (() => {
          const badge = clientBadge(clientInfo.client_type);
          const tooltipText = `${clientInfo.short_id}\n${clientInfo.label ?? clientInfo.client_type}`;
          return (
            <span
              className={`w-4 h-4 rounded text-[9px] flex items-center justify-center shrink-0 ${badge.bg} ${badge.text}`}
              title={tooltipText}
            >
              {badge.letter}
            </span>
          );
        })()}

        {/* Children count badge (when collapsed) */}
        {hasChildren && !expanded && !editing && (
          <span className="text-[10px] text-violet-400/60 shrink-0">
            ({children.length})
          </span>
        )}

        {/* Unread badge */}
        {hasUnread && !isActive && !editing && (
          <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0" />
        )}

        {/* Hover actions */}
        {!editing && (
          <>
            {confirmDelete ? (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                className="text-red-400 hover:text-red-300 text-[10px] shrink-0 cursor-pointer"
              >
                confirm?
              </span>
            ) : (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDelete(true);
                  setTimeout(() => setConfirmDelete(false), 3000);
                }}
                className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-white/60 transition-opacity shrink-0 cursor-pointer"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </span>
            )}
          </>
        )}
      </div>

      {/* Children (sub-conversations / collabs) */}
      {hasChildren && expanded && (
        <div className="ml-3 border-l border-white/5">
          {children.map((child) => {
            const wfId = (child.metadata as Record<string, unknown>)?.workflowId as string | undefined;
            const isChildActive = child.id === activeId;
            const isRunning = wfId === activeWorkflowId;

            return (
              <div
                key={child.id}
                onClick={() => onSwitchChild?.(child.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] cursor-pointer transition-colors ${
                  isChildActive
                    ? "bg-white/10 text-white/90"
                    : "text-white/45 hover:bg-white/5 hover:text-white/70"
                }`}
              >
                {/* Status icon */}
                {isRunning ? (
                  <svg className="animate-spin h-3 w-3 shrink-0 text-amber-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-emerald-400/60">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
                <span className="truncate min-w-0">{child.title}</span>
                <span className="text-[10px] text-white/20 shrink-0 ml-auto">
                  {relativeTime(child.updated_at)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
