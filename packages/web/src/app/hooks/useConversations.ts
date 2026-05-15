"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
export function useConversations(clientId: string, enabled = true, preferredInitialId: string | null = null) {
  // The preferred initial id is captured once on first load so that a URL like
  // /c/<id> can drive which conversation is selected. After init, switching is
  // owned by the page-level URL sync effects.
  const preferredInitialIdRef = useRef(preferredInitialId);
  preferredInitialIdRef.current = preferredInitialId;
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
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

  const loadConversations = useCallback(async () => {
    setLoading(true);
    try {
      // Load all conversations for this user (no client_id filter).
      // Client badge + filter dropdown in the sidebar handle per-client views.
      const res = await fetch("/api/conversations");
      if (!res.ok) {
        console.warn("[Conversations] GET /api/conversations failed:", res.status, await res.text().catch(() => ""));
        return;
      }
      const { conversations: convs } = await res.json();
      setConversations(convs ?? []);
      return convs as Conversation[];
    } catch (err) {
      console.warn("[Conversations] loadConversations error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Initial load ───────────────────────────────────────────────────────

  const initInFlight = useRef(false);

  useEffect(() => {
    if (!enabled || !clientId) return;
    // Allow retry: only skip if already initialized OR currently in-flight
    if (initialized.current || initInFlight.current) return;
    initInFlight.current = true;

    console.log("[Conversations] Initializing for clientId:", clientId);

    (async () => {
      try {
        const convs = await loadConversations();
        console.log("[Conversations] Loaded:", convs?.length ?? 0, "conversations");
        if (!convs) {
          // Load failed (auth not ready, network error) — do NOT create a default
          console.warn("[Conversations] Load returned undefined, skipping init");
          return;
        }
        if (convs.length === 0) {
          // No existing conversations — start in "fresh chat" mode (welcome
          // screen). The conv is created lazily on first message send via
          // ensureConversation, so users with no history don't end up with
          // an empty "New conversation" placeholder in the DB.
          console.log("[Conversations] No conversations — entering fresh-chat mode");
          setActiveConversationId(null);
          initialized.current = true;
        } else {
          // Prefer the conversation requested by the URL (/chat/<id>) when it
          // matches one of the user's conversations. Otherwise fall back to the
          // most recently active conv for this client, then the first conv.
          const preferred = preferredInitialIdRef.current;
          const fromUrl = preferred ? convs.find((c: Conversation) => c.id === preferred) : null;
          const active = convs.find(
            (c: Conversation) => c.is_active && c.client_id === clientId,
          );
          const selectedId = fromUrl?.id ?? active?.id ?? convs[0]?.id ?? null;
          console.log(
            "[Conversations] Selected active:",
            selectedId,
            fromUrl ? "(from URL)" : "(from is_active flag)",
          );
          setActiveConversationId(selectedId);
          initialized.current = true;
        }
      } catch (err) {
        console.warn("[Conversations] Initialization failed, will retry:", err);
      } finally {
        initInFlight.current = false;
      }
    })();
  }, [enabled, clientId, loadConversations]);

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
          setConversations((prev) => [conversation, ...prev]);
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
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeConversationId === id) {
        // Switch to the next available conversation
        setConversations((prev) => {
          const remaining = prev.filter((c) => c.id !== id);
          setActiveConversationId(remaining[0]?.id ?? null);
          return remaining;
        });
      }
    },
    [activeConversationId],
  );

  const updateTitle = useCallback(async (id: string, title: string) => {
    await fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }).catch(() => {});
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title } : c)),
    );
  }, []);

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
