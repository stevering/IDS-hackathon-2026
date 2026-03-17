"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { UIMessage } from "@ai-sdk/react";
import type { ConversationMessage } from "./useConversations";

// ---------------------------------------------------------------------------
// Helper: convert DB messages to UIMessage format
// ---------------------------------------------------------------------------

function dbToUIMessage(msg: ConversationMessage): UIMessage {
  return {
    id: msg.id,
    // 'agent' role maps to 'assistant' for useChat compatibility
    role: msg.role === "agent" ? "assistant" : msg.role as UIMessage["role"],
    parts: msg.parts
      ? (msg.parts as UIMessage["parts"])
      : [{ type: "text" as const, text: msg.content }],
  };
}

// ---------------------------------------------------------------------------
// Helper: extract text content from UIMessage parts
// ---------------------------------------------------------------------------

function extractTextContent(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Synchronizes `@ai-sdk/react` `useChat` messages with the database.
 * - On mount: loads persisted messages and hydrates useChat via setMessages()
 * - On message completion: saves new messages to the DB
 */
export function useMessagePersistence(
  conversationId: string | null,
  messages: UIMessage[],
  setMessages: (messages: UIMessage[]) => void,
  status: string,
  clientId: string,
  shortId: string | null,
) {
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  // Track which messages have been persisted to avoid double-saves
  const persistedIds = useRef(new Set<string>());
  // Track previous status to detect streaming → ready transition
  const prevStatus = useRef(status);
  // Track previous conversationId for resets
  const prevConvId = useRef(conversationId);
  // Track messages count to detect new user messages
  const prevMessagesCount = useRef(0);
  // Synchronous flag to block saves during conversation switch
  // (React state updates are batched, so `loaded` state may lag behind)
  const readyForSaves = useRef(false);
  // AbortController for in-flight loads — prevents stale responses from polluting state
  const abortRef = useRef<AbortController | null>(null);

  // ── Load messages on conversation switch ────────────────────────────────

  const loadMessages = useCallback(async () => {
    if (!conversationId) return;

    // Abort any in-flight load (e.g. from a previous conversation)
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    readyForSaves.current = false;
    setLoaded(false);
    persistedIds.current.clear();

    try {
      const res = await fetch(`/api/conversations/${conversationId}`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        setLoaded(true);
        readyForSaves.current = true;
        return;
      }
      const { messages: dbMessages } = await res.json();
      if (controller.signal.aborted) return;
      if (dbMessages && dbMessages.length > 0) {
        const uiMessages = (dbMessages as ConversationMessage[]).map(dbToUIMessage);
        // Mark all loaded messages as persisted
        for (const msg of dbMessages as ConversationMessage[]) {
          persistedIds.current.add(msg.id);
        }
        setMessages(uiMessages);
        prevMessagesCount.current = uiMessages.length;
      } else {
        setMessages([]);
        prevMessagesCount.current = 0;
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      // Silently fail — messages will be ephemeral
    } finally {
      if (!controller.signal.aborted) {
        setLoaded(true);
        readyForSaves.current = true;
      }
    }
  }, [conversationId, setMessages]);

  // Reset and reload when conversationId changes
  useEffect(() => {
    if (conversationId !== prevConvId.current) {
      prevConvId.current = conversationId;
      // Block saves synchronously BEFORE any state update
      readyForSaves.current = false;
      persistedIds.current.clear();
      prevMessagesCount.current = 0;
      // Clear stale messages immediately to avoid mixing
      setMessages([]);
      loadMessages();
    }
  }, [conversationId, loadMessages, setMessages]);

  // Initial load
  useEffect(() => {
    if (conversationId && !loaded && !abortRef.current) {
      loadMessages();
    }
  }, [conversationId, loaded, loadMessages]);

  // ── Save messages ───────────────────────────────────────────────────────

  const saveMessage = useCallback(
    async (message: UIMessage) => {
      if (!conversationId || persistedIds.current.has(message.id)) return;

      // Mark as persisted optimistically
      persistedIds.current.add(message.id);
      setSaving(true);

      try {
        const content = extractTextContent(message);
        if (!content.trim()) return;

        await fetch(`/api/conversations/${conversationId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role: message.role,
            content,
            parts: message.parts,
            senderClientId: message.role === "user" ? clientId : null,
            senderShortId: message.role === "user" ? shortId : null,
          }),
        });
      } catch {
        // Remove from persisted so it can be retried
        persistedIds.current.delete(message.id);
      } finally {
        setSaving(false);
      }
    },
    [conversationId, clientId, shortId],
  );

  // ── Save user messages immediately ──────────────────────────────────────

  useEffect(() => {
    // Block saves until loadMessages() has completed for this conversation
    if (!conversationId || !loaded || !readyForSaves.current) return;

    // Detect new messages (user messages appear immediately)
    if (messages.length > prevMessagesCount.current) {
      const newMessages = messages.slice(prevMessagesCount.current);
      for (const msg of newMessages) {
        if (msg.role === "user" && !persistedIds.current.has(msg.id)) {
          saveMessage(msg);
        }
      }
    }
    prevMessagesCount.current = messages.length;
  }, [messages.length, conversationId, loaded, messages, saveMessage]);

  // ── Save assistant messages on stream completion ────────────────────────

  useEffect(() => {
    const wasStreaming =
      prevStatus.current === "streaming" || prevStatus.current === "submitted";
    const isReady = status === "ready";

    prevStatus.current = status;

    if (!wasStreaming || !isReady || !conversationId || !loaded || !readyForSaves.current) return;

    // Find assistant messages that haven't been persisted
    for (const msg of messages) {
      if (msg.role === "assistant" && !persistedIds.current.has(msg.id)) {
        saveMessage(msg);
      }
    }
  }, [status, conversationId, loaded, messages, saveMessage]);

  return { loaded, saving, loadMessages };
}
