"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR, { mutate as globalMutate } from "swr";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Conversation = {
  id: string;
  user_id: string;
  client_id: string | null;
  title: string;
  is_active: boolean;
  parent_id: string | null;
  orchestration_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ConversationMessage = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system" | "agent";
  content: string;
  parts: unknown[] | null;
  sender_client_id: string | null;
  sender_short_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Manages conversation CRUD and switching for the current user/client.
 * Fetches conversations on mount, creates a default one if none exists,
 * and provides methods to switch, create, delete, and rename conversations.
 */
export function useConversations(
  clientId: string,
  enabled = true,
  preferredInitialId: string | null = null,
  wantsFreshChat: boolean = false,
) {
  // The preferred initial id is captured once on first load so that a URL like
  // /chat/<id> can drive which conversation is selected. After init, switching
  // is owned by the page-level URL sync effects.
  const preferredInitialIdRef = useRef(preferredInitialId);
  preferredInitialIdRef.current = preferredInitialId;
  // When the user is on /chat (no id) we force fresh-chat mode — even if they
  // have existing conversations — so a remount triggered by router.replace
  // doesn't silently fall back to the is_active conv and re-push /chat/<id>.
  const wantsFreshChatRef = useRef(wantsFreshChat);
  wantsFreshChatRef.current = wantsFreshChat;
  // SWR holds the conversation list. revalidateOnFocus is disabled because
  // the Figma plugin iframe loses/regains focus on every Figma action — without
  // this guard we would burst-fetch /api/conversations every few seconds.
  const swrKey = enabled && clientId ? "/api/conversations" : null;
  const {
    data: swrData,
    isLoading: swrLoading,
    mutate: mutateConversations,
  } = useSWR<{ conversations: Conversation[] }>(
    swrKey,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn("[Conversations] GET /api/conversations failed:", res.status, await res.text().catch(() => ""));
        return { conversations: [] };
      }
      return res.json();
    },
    { revalidateOnFocus: false, revalidateOnReconnect: false },
  );
  const conversations: Conversation[] = useMemo(() => swrData?.conversations ?? [], [swrData]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const loading = swrLoading;
  const initialized = useRef(false);
  const clientIdRef = useRef(clientId);
  clientIdRef.current = clientId;
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;

  // ── Derived state ──────────────────────────────────────────────────────

  const activeConversation = conversations.find((c) => c.id === activeConversationId) ?? null;

  // Root conversations (no parent) — for the sidebar list
  const rootConversations = useMemo(
    () => conversations.filter((c) => !c.parent_id),
    [conversations],
  );

  // Children map: parentId → sub-conversations (collabs)
  const childrenMap = useMemo(() => {
    const map = new Map<string, Conversation[]>();
    for (const c of conversations) {
      if (c.parent_id) {
        const children = map.get(c.parent_id) ?? [];
        children.push(c);
        map.set(c.parent_id, children);
      }
    }
    return map;
  }, [conversations]);

  const parallelConversations = conversations.filter(
    (c) =>
      (c.orchestration_id !== null || !!(c.metadata as Record<string, unknown>)?.workflowId) &&
      c.id !== activeConversationId,
  );

  // ── Load conversations ─────────────────────────────────────────────────
  // Backed by SWR — `loadConversations` forces a revalidation and returns the
  // refreshed list. Callers that used the old fetch-and-return shape still get
  // a Conversation[] result.

  const loadConversations = useCallback(async (): Promise<Conversation[] | undefined> => {
    const result = await mutateConversations();
    return result?.conversations;
  }, [mutateConversations]);

  // ── Initial conversation pick (URL-aware) ─────────────────────────────
  // Fires once after the SWR list resolves. Phase D made the URL the source
  // of truth for activeConversationId at the page level, so this only matters
  // for the hook's internal `activeConversationId` state (kept for backward
  // compatibility with consumers that still read it, e.g. the legacy
  // ensureConversation path).

  useEffect(() => {
    if (!enabled || !clientId) return;
    if (initialized.current) return;
    if (swrLoading) return;
    if (!swrData) return;

    const convs = swrData.conversations ?? [];
    console.log("[Conversations] Initializing for clientId:", clientId);
    console.log("[Conversations] Loaded:", convs.length, "conversations");

    if (convs.length === 0) {
      console.log("[Conversations] No conversations — entering fresh-chat mode");
      setActiveConversationId(null);
    } else if (wantsFreshChatRef.current) {
      console.log("[Conversations] /chat (no id) — entering fresh-chat mode despite existing convs");
      setActiveConversationId(null);
    } else {
      const preferred = preferredInitialIdRef.current;
      const fromUrl = preferred ? convs.find((c) => c.id === preferred) : null;
      const active = convs.find((c) => c.is_active && c.client_id === clientId);
      const selectedId = fromUrl?.id ?? active?.id ?? convs[0]?.id ?? null;
      console.log(
        "[Conversations] Selected active:",
        selectedId,
        fromUrl ? "(from URL)" : "(from is_active flag)",
      );
      setActiveConversationId(selectedId);
    }
    initialized.current = true;
  }, [enabled, clientId, swrLoading, swrData]);

  // ── Create conversation (internal helper) ──────────────────────────────

  const createConversationInternal = useCallback(
    async (opts?: {
      title?: string;
      parentId?: string;
      orchestrationId?: string;
      metadata?: Record<string, unknown>;
    }): Promise<Conversation | null> => {
      try {
        const res = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: opts?.title ?? "New conversation",
            clientId: clientIdRef.current,
            parentId: opts?.parentId,
            orchestrationId: opts?.orchestrationId,
            metadata: opts?.metadata,
          }),
        });
        if (!res.ok) {
          console.warn("[Conversations] POST /api/conversations failed:", res.status, await res.text().catch(() => ""));
          return null;
        }
        const { conversation } = await res.json();
        if (conversation) {
          // Optimistically prepend to the SWR cache so the sidebar updates
          // instantly without waiting for the next revalidation.
          mutateConversations(
            (prev) => prev
              ? { conversations: [conversation, ...prev.conversations] }
              : { conversations: [conversation] },
            { revalidate: false },
          );
        }
        return conversation ?? null;
      } catch (err) {
        console.warn("[Conversations] createConversation error:", err);
        return null;
      }
    },
    [],
  );

  // ── Public methods ─────────────────────────────────────────────────────

  const createConversation = useCallback(
    async (opts?: {
      title?: string;
      parentId?: string;
      orchestrationId?: string;
      metadata?: Record<string, unknown>;
    }): Promise<Conversation | null> => {
      // Sub-conv / orch-conv creations still hit the DB immediately —
      // they are server-driven flows that need a real id (e.g. Étape 2/3).
      if (opts?.parentId || opts?.orchestrationId || opts?.metadata?.workflowId) {
        return createConversationInternal(opts);
      }

      // Standalone "+ New conversation" click: defer DB persistence (ChatGPT
      // / Claude / Gemini pattern). Setting activeConversationId to null puts
      // the UI in "fresh chat" mode (welcome screen). The conv is actually
      // inserted at first message send via ensureConversation in page.tsx,
      // which avoids cluttering the sidebar with empty placeholder convs.
      setActiveConversationId(null);
      return null;
    },
    [createConversationInternal],
  );

  const switchConversation = useCallback(
    (id: string) => {
      setActiveConversationId(id);

      // Mark as active on server (fire-and-forget)
      fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: true, clientId: clientIdRef.current }),
      }).catch(() => {});
    },
    [],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      await fetch(`/api/conversations/${id}`, { method: "DELETE" }).catch(() => {});
      mutateConversations(
        (prev) => prev
          ? { conversations: prev.conversations.filter((c) => c.id !== id) }
          : prev,
        { revalidate: false },
      );
      if (activeConversationId === id) {
        // Internal state fallback. Page-level Phase D code drives the URL.
        setActiveConversationId(null);
      }
    },
    [activeConversationId, mutateConversations],
  );

  const updateTitle = useCallback(async (id: string, title: string) => {
    await fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }).catch(() => {});
    mutateConversations(
      (prev) => prev
        ? { conversations: prev.conversations.map((c) => (c.id === id ? { ...c, title } : c)) }
        : prev,
      { revalidate: false },
    );
  }, [mutateConversations]);

  const setActiveConversationById = useCallback(
    async (id: string) => {
      setActiveConversationId(id);
      fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: true, clientId: clientIdRef.current }),
      }).catch(() => {});
    },
    [],
  );

  // Safety-net: ensure there is an active conversation, creating one if needed.
  const ensureConversation = useCallback(async (): Promise<string | null> => {
    // If we already have one, return it
    const existing = activeConversationIdRef.current;
    if (existing) return existing;

    console.log("[Conversations] ensureConversation: no active conversation, creating one...");
    const conv = await createConversationInternal();
    if (conv) {
      setActiveConversationId(conv.id);
      initialized.current = true;
      return conv.id;
    }
    return null;
  }, [createConversationInternal]);

  return {
    conversations: rootConversations,
    allConversations: conversations,
    childrenMap,
    activeConversation,
    activeConversationId,
    parallelConversations,
    loading,
    loadConversations,
    createConversation,
    switchConversation,
    deleteConversation,
    updateTitle,
    renameConversation: updateTitle,
    setActiveConversation: setActiveConversationById,
    ensureConversation,
  };
}
