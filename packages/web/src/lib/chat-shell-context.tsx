"use client";

// Chat shell context — mounted once in app/chat/layout.tsx, consumed by the
// page tree below. Holds the hooks whose state must survive navigation between
// sibling conversations (/chat/A → /chat/B). Without this, Next.js remounts
// the page on every URL change and the sidebar, MCP list, Realtime channels
// etc. tear down and re-fetch, producing the 250-400ms flicker.
//
// See internal/docs/backlog/chat-layout-based-state-hoisting.md for context.

import { createContext, useContext } from "react";
import type {
  FigmaPluginContext,
  ExecuteCodeResult,
  PluginEvent,
  useFigmaPlugin,
} from "@/app/hooks/useFigmaPlugin";
import type { PresenceClient } from "@/types/presence";
import type { Conversation } from "@/app/hooks/useConversations";
import type {
  ConnectionStatus,
} from "@/app/hooks/useFigmaExecuteChannel";
import type { createClient } from "@/lib/supabase/client";
import type { useUserMCPInstances } from "@/app/hooks/useUserMCPInstances";

type ChannelRef = React.RefObject<
  ReturnType<ReturnType<typeof createClient>["channel"]> | null
>;

export type ExecuteCodeFn = (
  code: string,
  timeout?: number,
) => Promise<ExecuteCodeResult>;

export type ChatShellValue = {
  // ── Figma plugin bridge ──────────────────────────────────────────────
  isFigmaPlugin: boolean;
  figmaContext: FigmaPluginContext | null;
  sendToPlugin: (type: string, data?: Record<string, unknown>) => void;
  /** Raw, un-gated executeCode coming straight from useFigmaPlugin. */
  executeCodeRaw: ExecuteCodeFn;
  /**
   * Mutable ref to a bounded plugin-event log. Typed as the actual return of
   * useFigmaPlugin so `current` stays non-nullable (matches the pre-context
   * shape and avoids `current ?? []` noise at every call site).
   */
  eventLog: ReturnType<typeof useFigmaPlugin>["eventLog"];

  // ── Approval gate plumbing ───────────────────────────────────────────
  /**
   * _home.tsx installs its gated wrapper here on mount. The execute channel
   * (mounted in the layout) calls the installed wrapper for every incoming
   * execution request. When _home is not yet mounted, the wrapper is null and
   * the channel falls back to raw executeCode (un-gated). In practice _home
   * mounts within a tick of the layout so this fallback never fires for user
   * actions — it only matters for the very first paint.
   */
  installExecuteWrapper: (wrapper: ExecuteCodeFn | null) => void;

  // ── Execute channel ──────────────────────────────────────────────────
  clients: PresenceClient[];
  myClientId: string;
  connectionStatus: ConnectionStatus;
  channelRef: ChannelRef;

  // ── Client registry ──────────────────────────────────────────────────
  serverShortId: string | null;
  renameClient: (newShortId: string) => Promise<boolean>;
  myDisplayShortId: string;
  registryShortId: string | null;
  setRegistryShortId: (id: string | null) => void;

  // ── Plugin live workflow detection ───────────────────────────────────
  /** Set by the channel when a plugin postMessage carries a workflowId. */
  liveDetectedWorkflowId: string | null;
  setLiveDetectedWorkflowId: (id: string | null) => void;

  // ── Conversations ────────────────────────────────────────────────────
  conversations: Conversation[];
  allConversations: Conversation[];
  childrenMap: Map<string, Conversation[]>;
  activeConversation: Conversation | null;
  activeConversationId: string | null;
  parallelConversations: Conversation[];
  loadConversations: () => Promise<Conversation[] | undefined>;
  createConversation: (opts?: {
    title?: string;
    parentId?: string;
    orchestrationId?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<Conversation | null>;
  switchConversation: (id: string) => void;
  deleteConversation: (id: string) => Promise<void>;
  updateTitle: (id: string, title: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  setActiveConversation: (id: string) => Promise<void>;
  ensureConversation: () => Promise<string | null>;

  // ── MCP instances ────────────────────────────────────────────────────
  mcpInstances: ReturnType<typeof useUserMCPInstances>;

  // ── Sidebar UI state ─────────────────────────────────────────────────
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
};

export const ChatShellContext = createContext<ChatShellValue | null>(null);

export function useChatShell(): ChatShellValue {
  const ctx = useContext(ChatShellContext);
  if (!ctx) {
    throw new Error(
      "useChatShell must be used within <ChatShellContext.Provider> (app/chat/layout.tsx)",
    );
  }
  return ctx;
}
