"use client";

import { useState, useRef, useCallback } from "react";
import { GlassDropdown } from "./GlassDropdown";
import type { Conversation } from "@/app/hooks/useConversations";

type Props = {
  conversations: Conversation[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  unreadIds?: Set<string>;
};

export function ConversationSwitcher({
  conversations,
  activeId,
  onSwitch,
  onCreate,
  onDelete,
  unreadIds,
}: Props) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const handleClose = useCallback(() => setOpen(false), []);

  const active = conversations.find((c) => c.id === activeId);
  const hasUnread = unreadIds && unreadIds.size > 0;

  // Separate parallel (orchestration) conversations from standalone ones
  const standalone = conversations.filter((c) => !c.orchestration_id);
  const parallel = conversations.filter((c) => !!c.orchestration_id);

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-white/70 hover:text-white/90 transition-colors cursor-pointer max-w-[180px]"
      >
        {/* Chat icon */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="shrink-0"
        >
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
        <span className="truncate hidden sm:inline">
          {active ? active.title : "New conversation"}
        </span>
        {hasUnread && (
          <span className="w-2 h-2 rounded-full bg-violet-400 shrink-0" />
        )}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className="shrink-0"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <GlassDropdown
        open={open}
        onClose={handleClose}
        anchorRef={btnRef}
        side="bottom"
        align="left"
        width={280}
      >
        <div className="max-h-[320px] overflow-y-auto">
          {/* New conversation button */}
          <button
            onClick={() => {
              onCreate();
              setOpen(false);
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-white/50 hover:text-white/80 hover:bg-white/10 transition-colors cursor-pointer border-b border-white/10"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>New conversation</span>
          </button>

          {/* Standalone conversations */}
          {standalone.map((conv) => (
            <ConversationItem
              key={conv.id}
              conversation={conv}
              isActive={conv.id === activeId}
              hasUnread={unreadIds?.has(conv.id) ?? false}
              onSelect={() => {
                onSwitch(conv.id);
                setOpen(false);
              }}
              onDelete={() => onDelete(conv.id)}
            />
          ))}

          {/* Parallel (orchestration) conversations */}
          {parallel.length > 0 && (
            <>
              <div className="px-3 py-1.5 text-[10px] text-white/30 uppercase tracking-wider border-t border-white/10 mt-1">
                Collaborative
              </div>
              {parallel.map((conv) => (
                <ConversationItem
                  key={conv.id}
                  conversation={conv}
                  isActive={conv.id === activeId}
                  hasUnread={unreadIds?.has(conv.id) ?? false}
                  isParallel
                  onSelect={() => {
                    onSwitch(conv.id);
                    setOpen(false);
                  }}
                  onDelete={() => onDelete(conv.id)}
                />
              ))}
            </>
          )}

          {conversations.length === 0 && (
            <div className="px-3 py-4 text-xs text-white/30 text-center">
              No conversations yet
            </div>
          )}
        </div>
      </GlassDropdown>
    </div>
  );
}

function ConversationItem({
  conversation,
  isActive,
  hasUnread,
  isParallel,
  onSelect,
  onDelete,
}: {
  conversation: Conversation;
  isActive: boolean;
  hasUnread: boolean;
  isParallel?: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <button
      onClick={onSelect}
      className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors cursor-pointer group ${
        isActive
          ? "bg-white/10 text-white/90"
          : "text-white/60 hover:bg-white/5 hover:text-white/80"
      }`}
    >
      {/* Parallel indicator */}
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

      {/* Title */}
      <span className="flex-1 text-left truncate min-w-0">
        {conversation.title}
      </span>

      {/* Unread badge */}
      {hasUnread && !isActive && (
        <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0" />
      )}

      {/* Delete button */}
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
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </span>
      )}
    </button>
  );
}
