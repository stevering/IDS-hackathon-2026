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

type Props = {
  conversation: Conversation;
  isActive: boolean;
  hasUnread: boolean;
  isParallel?: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
};

export function ConversationRow({
  conversation,
  isActive,
  hasUnread,
  isParallel,
  onSelect,
  onDelete,
  onRename,
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(conversation.title);
  const inputRef = useRef<HTMLInputElement>(null);

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
      {/* Type indicator */}
      {isParallel && (
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
      )}

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
  );
}
