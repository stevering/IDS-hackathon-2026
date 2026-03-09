"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
export function useConversations(clientId: string, enabled = true) {
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

  const parallelConversations = conversations.filter(
    (c) => c.orchestration_id !== null && c.id !== activeConversationId,
  );

  // ── Load conversations ─────────────────────────────────────────────────

  const loadConversations = useCallback(async () => {
    setLoading(true);
    try {
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
        if (!convs || convs.length === 0) {
          // Create a default conversation
          console.log("[Conversations] Creating default conversation...");
          const newConv = await createConversationInternal();
          console.log("[Conversations] Created:", newConv?.id ?? "FAILED");
          if (newConv) {
            setActiveConversationId(newConv.id);
            initialized.current = true;
          }
        } else {
          // Find an active conversation for this client, or use the most recent
          const active = convs.find(
            (c: Conversation) => c.is_active && c.client_id === clientId,
          );
          const selectedId = active?.id ?? convs[0]?.id ?? null;
          console.log("[Conversations] Selected active:", selectedId);
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
      const conv = await createConversationInternal(opts);
      if (conv && !opts?.orchestrationId) {
        // Auto-switch to new standalone conversations
        setActiveConversationId(conv.id);
      }
      return conv;
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
    conversations,
    activeConversation,
    activeConversationId,
    parallelConversations,
    loading,
    loadConversations,
    createConversation,
    switchConversation,
    deleteConversation,
    updateTitle,
    setActiveConversation: setActiveConversationById,
    ensureConversation,
  };
}
