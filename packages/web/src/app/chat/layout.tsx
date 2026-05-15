"use client";

// Chat shell — mounted once per session, never remounts as the URL flips
// between /chat, /chat/<uuid-A>, /chat/<uuid-B>. Hooks whose state needs to
// survive sibling navigation (Figma bridge, execute channel, registry,
// conversations, MCP instances) live here. The page below renders only what
// changes with the active conversation (header status bars, messages, composer).
//
// See internal/docs/backlog/chat-layout-based-state-hoisting.md (Phase B).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useFigmaPlugin } from "../hooks/useFigmaPlugin";
import { useFigmaExecuteChannel } from "../hooks/useFigmaExecuteChannel";
import { useClientRegistry } from "../hooks/useClientRegistry";
import { useConversations } from "../hooks/useConversations";
import { useUserMCPInstances } from "../hooks/useUserMCPInstances";
import { ConversationSidebar } from "@/components/ConversationSidebar";
import {
  ChatShellContext,
  type ChatShellValue,
  type ExecuteCodeFn,
} from "@/lib/chat-shell-context";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  // ── Figma plugin bridge ─────────────────────────────────────────────
  const { isFigmaPlugin, figmaContext, sendToPlugin, executeCode, eventLog } = useFigmaPlugin();
  const clientTypeForChannel: "figma-plugin" | "webapp" = isFigmaPlugin ? "figma-plugin" : "webapp";
  const clientLabel = useMemo(() => {
    if (typeof navigator === "undefined") return "Browser";
    const ua = navigator.userAgent;
    if (isFigmaPlugin) {
      const isFigmaDesktop = /Figma/i.test(ua) || (!/Chrome|Firefox|Edg/i.test(ua) && /Safari/i.test(ua));
      return isFigmaDesktop ? "Figma-Desktop" : "Figma-Web";
    }
    return ua.split(" ").pop()?.split("/")[0] ?? "Browser";
  }, [isFigmaPlugin]);
  const clientFileKey = figmaContext?.fileKey ?? undefined;

  // Wait for the iframe handshake before declaring our client type to the
  // server. Without this gate, a plugin instance briefly registers as
  // "webapp / Safari" before isFigmaPlugin turns true.
  const isInIframe = typeof window !== "undefined" && window.parent !== window;
  const [iframeSettled, setIframeSettled] = useState(!isInIframe);
  useEffect(() => {
    if (!isInIframe) return;
    if (isFigmaPlugin) { setIframeSettled(true); return; }
    const timer = setTimeout(() => setIframeSettled(true), 500);
    return () => clearTimeout(timer);
  }, [isInIframe, isFigmaPlugin]);

  // ── Approval gate plumbing ──────────────────────────────────────────
  // The execute channel needs a single callback at hook init. _home installs
  // its gated wrapper into this ref on mount; we read from the ref on every
  // call so changes propagate without re-initializing the channel.
  const executeWrapperRef = useRef<ExecuteCodeFn | null>(null);
  const installExecuteWrapper = useCallback((wrapper: ExecuteCodeFn | null) => {
    executeWrapperRef.current = wrapper;
  }, []);
  const channelExecuteCode = useCallback<ExecuteCodeFn>(
    (code, timeout) => {
      const wrapper = executeWrapperRef.current;
      if (wrapper) return wrapper(code, timeout);
      // Fallback to raw executeCode during the layout-only mount window
      // (before _home installs its wrapper). In practice no execute_request
      // can arrive in that window.
      return executeCode(code, timeout);
    },
    [executeCode],
  );

  // ── Plugin live workflow detection ──────────────────────────────────
  const [liveDetectedWorkflowId, setLiveDetectedWorkflowId] = useState<string | null>(null);
  const orchDetectedCallback = useCallback((wfId: string) => {
    setLiveDetectedWorkflowId(wfId);
  }, []);

  // ── Client registry shortId (server-assigned) ───────────────────────
  const [registryShortId, setRegistryShortId] = useState<string | null>(null);

  // ── Execute channel ─────────────────────────────────────────────────
  const { clients, clientId: myClientId, connectionStatus, channelRef } = useFigmaExecuteChannel(
    channelExecuteCode,
    true,
    {
      type: clientTypeForChannel,
      label: clientLabel,
      fileKey: clientFileKey,
      figmaContext: isFigmaPlugin && figmaContext ? {
        fileName: figmaContext.fileName,
        fileUrl: figmaContext.fileUrl,
        pages: figmaContext.pages,
        currentPage: figmaContext.currentPage,
        currentUser: figmaContext.currentUser,
      } : undefined,
      serverShortId: registryShortId,
    },
    eventLog,
    isFigmaPlugin ? orchDetectedCallback : undefined,
  );

  // ── Client registry (server-side registration + heartbeat) ──────────
  const { shortId: serverShortId, rename: renameClient } = useClientRegistry(
    myClientId,
    clientTypeForChannel,
    clientLabel,
    clientFileKey,
    !!myClientId && iframeSettled,
  );

  useEffect(() => {
    if (serverShortId && serverShortId !== registryShortId) {
      setRegistryShortId(serverShortId);
    }
  }, [serverShortId, registryShortId]);

  const myDisplayShortId = registryShortId ?? clients.find((c) => c.clientId === myClientId)?.shortId ?? myClientId;

  // ── URL is the source of truth ───────────────────────────────────────
  const router = useRouter();
  const routeParams = useParams();
  const pathname = usePathname();
  const urlId = Array.isArray(routeParams?.id)
    ? (routeParams.id[0] ?? null)
    : ((routeParams?.id as string | undefined) ?? null);
  const wantsFreshChat = pathname === "/chat";

  // ── Conversations (list + mutations) ────────────────────────────────
  const convHook = useConversations(myClientId, !!myClientId, urlId, wantsFreshChat);

  // ── MCP instances ───────────────────────────────────────────────────
  const mcpInstances = useUserMCPInstances();

  // ── Sidebar UI state ────────────────────────────────────────────────
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    const stored = localStorage.getItem("guardian-sidebar-collapsed");
    if (stored === "true") setSidebarCollapsed(true);
  }, []);
  const toggleSidebar = useCallback(() => {
    if (window.innerWidth < 768) {
      setSidebarOpen((prev) => !prev);
    } else {
      setSidebarCollapsed((prev) => {
        const next = !prev;
        localStorage.setItem("guardian-sidebar-collapsed", String(next));
        return next;
      });
    }
  }, []);

  // ── Context value ───────────────────────────────────────────────────
  const shellValue: ChatShellValue = {
    // Figma plugin bridge
    isFigmaPlugin,
    figmaContext,
    sendToPlugin,
    executeCodeRaw: executeCode,
    eventLog,
    // Approval gate plumbing
    installExecuteWrapper,
    // Execute channel
    clients,
    myClientId,
    connectionStatus,
    channelRef,
    // Client registry
    serverShortId,
    renameClient,
    myDisplayShortId,
    registryShortId,
    setRegistryShortId,
    // Plugin live workflow detection
    liveDetectedWorkflowId,
    setLiveDetectedWorkflowId,
    // Conversations
    conversations: convHook.conversations,
    allConversations: convHook.allConversations,
    childrenMap: convHook.childrenMap,
    activeConversation: convHook.activeConversation,
    activeConversationId: convHook.activeConversationId,
    parallelConversations: convHook.parallelConversations,
    loadConversations: convHook.loadConversations,
    createConversation: convHook.createConversation,
    switchConversation: convHook.switchConversation,
    deleteConversation: convHook.deleteConversation,
    updateTitle: convHook.updateTitle,
    renameConversation: convHook.renameConversation,
    setActiveConversation: convHook.setActiveConversation,
    ensureConversation: convHook.ensureConversation,
    // MCP instances
    mcpInstances,
    // Sidebar UI state
    sidebarOpen,
    setSidebarOpen,
    sidebarCollapsed,
    toggleSidebar,
  };

  return (
    <ChatShellContext.Provider value={shellValue}>
      <div className="relative flex h-screen text-white overflow-hidden">
        {/* Mobile backdrop — dim only; blur comes from the sidebar's own glass-sidebar */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 md:hidden bg-black/30"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        {/* Sidebar — mobile: fixed full-width drawer, desktop: relative column */}
        <div className={`${
          sidebarOpen
            ? "fixed top-0 left-0 z-50 w-full sm:w-72 h-full translate-x-0"
            : "fixed top-0 left-0 z-50 w-full sm:w-72 h-full -translate-x-full"
        } ${sidebarCollapsed ? "md:w-12" : "md:w-72"} md:relative md:top-auto md:left-auto md:z-10 md:h-full md:translate-x-0 transition-all duration-200 glass-sidebar`}>
          <ConversationSidebar
            conversations={convHook.conversations}
            activeId={urlId}
            onSwitch={(id) => {
              router.push(`/chat/${id}`, { scroll: false });
              // Fire-and-forget: still updates the server-side is_active marker.
              convHook.switchConversation(id);
              setSidebarOpen(false);
            }}
            onCreate={() => {
              router.push("/chat", { scroll: false });
              setSidebarOpen(false);
            }}
            onDelete={async (id) => {
              await convHook.deleteConversation(id);
              if (id === urlId) {
                // After deleting the active conv, fall back to /chat (welcome).
                router.push("/chat", { scroll: false });
              }
            }}
            onRename={convHook.renameConversation}
            collapsed={sidebarCollapsed}
            onToggleCollapse={toggleSidebar}
            childrenMap={convHook.childrenMap}
            activeWorkflowId={null}
          />
        </div>

        <div className="flex-1 flex flex-col min-w-0 relative">
          {children}
        </div>
      </div>
    </ChatShellContext.Provider>
  );
}
