"use client";

/**
 * useChatWorkflow — replaces useChat when TEMPORAL_CHAT_ENABLED is true.
 *
 * Manages a chat conversation backed by a Temporal chatWorkflow:
 *   - Starts a workflow via POST /api/chat-temporal/start
 *   - Subscribes to Supabase Realtime for token-by-token streaming
 *   - Sends follow-up messages via POST /api/chat-temporal/{id}/message
 *   - Loads persisted messages on mount and reconnect
 *
 * Returns a shape compatible with the existing message rendering in page.tsx.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

// ---------------------------------------------------------------------------
// Types (compatible with AI SDK UIMessage shape)
// ---------------------------------------------------------------------------

export type ChatPart =
  | { type: "text"; text: string; state?: "streaming" | "done" | "recovering" }
  | { type: "reasoning"; text: string; state?: "streaming" | "done" }
  | { type: "step-start" }
  | { type: "recovering-skeleton" }
  | { type: "dynamic-tool"; toolName: string; toolCallId: string; input: Record<string, unknown>; state: string; output?: unknown };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: ChatPart[];
  createdAt?: Date;
};

export type ChatWorkflowStatus = "idle" | "streaming" | "tool_executing" | "error";

export type UseChatWorkflowReturn = {
  messages: ChatMessage[];
  sendMessage: (msg: { text: string }) => void;
  status: ChatWorkflowStatus;
  error: string | undefined;
  setMessages: (msgs: ChatMessage[]) => void;
};

// ---------------------------------------------------------------------------
// Hook params
// ---------------------------------------------------------------------------

type FigmaPluginContext = {
  fileKey: string;
  fileName: string;
  fileUrl: string;
  currentPage?: { id: string; name: string } | null;
  pages?: { id: string; name: string }[];
  currentUser?: { id: string; name: string } | null;
};

type SelectedNode = {
  nodes: unknown[];
  image: string | null;
  nodeUrl: string | null;
};

type ConnectedAgent = {
  shortId: string;
  label: string;
  type: string;
  fileName?: string;
};

type UseChatWorkflowParams = {
  conversationId: string | null;
  model?: string;
  mcpServerIds?: string[];
  figmaPluginClientId?: string;
  enabled?: boolean;
  // Dynamic context (parity with legacy /api/chat)
  selectedNode?: SelectedNode | null;
  figmaPluginContext?: FigmaPluginContext | null;
  connectedAgents?: ConnectedAgent[];
  isLocalPlugin?: boolean;
  source?: string;
  keyId?: string;
  // V2: focus instance IDs from TargetSelector
  designInstanceId?: string;
  codeInstanceId?: string;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChatWorkflow({
  conversationId,
  model,
  mcpServerIds,
  figmaPluginClientId,
  enabled = true,
  selectedNode,
  figmaPluginContext,
  connectedAgents,
  isLocalPlugin,
  source,
  keyId,
  designInstanceId,
  codeInstanceId,
}: UseChatWorkflowParams): UseChatWorkflowReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatWorkflowStatus>("idle");
  const [error, setError] = useState<string | undefined>();
  const workflowIdRef = useRef<string | null>(null);
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>["channel"]> | null>(null);
  const streamingMsgRef = useRef<{ id: string; text: string; reasoning: string } | null>(null);
  const benchmarkRef = useRef<{ sendAt: number; firstDeltaAt: number; completeAt: number } | null>(null);

  // Refs for dynamic context (captured at send time, not stale from closure)
  const selectedNodeRef = useRef(selectedNode);
  selectedNodeRef.current = selectedNode;
  const figmaPluginContextRef = useRef(figmaPluginContext);
  figmaPluginContextRef.current = figmaPluginContext;
  const connectedAgentsRef = useRef(connectedAgents);
  connectedAgentsRef.current = connectedAgents;
  const isLocalPluginRef = useRef(isLocalPlugin);
  isLocalPluginRef.current = isLocalPlugin;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const keyIdRef = useRef(keyId);
  keyIdRef.current = keyId;

  // ── Load persisted messages + detect active workflow on mount/F5 ─────────
  useEffect(() => {
    if (!conversationId || !enabled) return;

    async function loadAndRecover() {
      try {
        // Load persisted messages
        const res = await fetch(`/api/conversations/${conversationId}/messages`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.messages) {
          const loaded: ChatMessage[] = data.messages.map((m: { id: string; role: string; content: string; parts?: unknown[]; metadata?: Record<string, unknown> }) => ({
            id: m.id,
            role: m.role as ChatMessage["role"],
            content: m.content ?? "",
            parts: m.parts ?? [{ type: "text", text: m.content ?? "" }],
          }));
          setMessages(loaded);

          // Check if the last message is still streaming (metadata.streaming === true)
          const lastAssistant = [...loaded].reverse().find(m => m.role === "assistant");
          const rawLastAssistant = data.messages.find((m: { id: string }) => m.id === lastAssistant?.id);
          const lastMeta = rawLastAssistant?.metadata as Record<string, unknown> | undefined;
          console.log("[ChatWorkflow] F5 recovery check:", {
            lastAssistantId: lastAssistant?.id,
            lastAssistantContentLen: lastAssistant?.content?.length,
            streaming: lastMeta?.streaming,
            metadata: lastMeta,
          });
          if (lastMeta?.streaming === true) {
            console.log("[ChatWorkflow] Detected streaming message on reload — re-subscribing to Realtime");
            // Re-subscribe to get remaining deltas
            const recoveringId = lastAssistant!.id;
            streamingMsgRef.current = {
              id: recoveringId,
              text: lastAssistant!.content,
              reasoning: "",
            };
            setStatus("streaming");

            // Show partial text + skeleton to indicate recovery gap
            setMessages((prev) =>
              prev.map((m) =>
                m.id === recoveringId
                  ? {
                      ...m,
                      parts: [
                        { type: "text" as const, text: m.content, state: "recovering" as const },
                        { type: "recovering-skeleton" as const },
                      ],
                    }
                  : m
              )
            );

            // Subscribe to Realtime channel for remaining tokens.
            // In recovery mode, IGNORE text_delta (they create gaps) — only
            // text_snapshot can synchronize. After first snapshot, switch to
            // normal delta mode.
            let recovering = true;
            const supabase = createClient();
            const channel = supabase.channel(`guardian:chat:${conversationId}`);
            channelRef.current = channel;

            channel
              .on("broadcast", { event: "text_delta" }, (payload) => {
                if (recovering) return; // Skip deltas until first snapshot syncs us
                const { content } = payload.payload as { content: string };
                if (!streamingMsgRef.current) return;
                streamingMsgRef.current.text += content;
                const currentText = streamingMsgRef.current.text;
                const msgId = streamingMsgRef.current.id;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === msgId
                      ? { ...m, content: currentText, parts: buildParts(streamingMsgRef.current!) }
                      : m
                  )
                );
              })
              .on("broadcast", { event: "text_snapshot" }, (payload) => {
                // Full accumulated text — replaces partial to close any gap from F5
                const { content } = payload.payload as { content: string };
                if (!streamingMsgRef.current) return;
                if (recovering) {
                  recovering = false;
                  console.log("[ChatWorkflow] Recovery synced via text_snapshot — switching to delta mode");
                }
                streamingMsgRef.current.text = content;
                const msgId = streamingMsgRef.current.id;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === msgId
                      ? { ...m, content, parts: buildParts(streamingMsgRef.current!) }
                      : m
                  )
                );
              })
              .on("broadcast", { event: "text_complete" }, (payload) => {
                const { content, reasoning } = payload.payload as { content: string; reasoning?: string };
                if (!streamingMsgRef.current) return;
                const msgId = streamingMsgRef.current.id;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === msgId
                      ? { ...m, content, parts: buildFinalParts(content, reasoning) }
                      : m
                  )
                );
                streamingMsgRef.current = null;
                setStatus("idle");
                channel.unsubscribe();
                channelRef.current = null;
              })
              .subscribe();
          }
        }
      } catch {
        // Non-fatal
      }
    }

    loadAndRecover();
  }, [conversationId, enabled]);

  // ── Subscribe to Realtime channel for streaming ─────────────────────────
  const subscribeToStream = useCallback((convId: string, wfId: string) => {
    // Unsubscribe from previous channel
    if (channelRef.current) {
      channelRef.current.unsubscribe();
      channelRef.current = null;
    }

    const supabase = createClient();
    const channel = supabase.channel(`guardian:chat:${convId}`);
    channelRef.current = channel;

    // Initialize streaming message
    const streamMsgId = `assistant-${Date.now()}`;
    streamingMsgRef.current = { id: streamMsgId, text: "", reasoning: "" };

    // Add a placeholder assistant message
    setMessages((prev) => [
      ...prev,
      {
        id: streamMsgId,
        role: "assistant",
        content: "",
        parts: [{ type: "text", text: "", state: "streaming" }],
      },
    ]);
    setStatus("streaming");

    channel
      .on("broadcast", { event: "text_delta" }, (payload) => {
        const { content } = payload.payload as { content: string };

        // If no active streaming message (e.g., after tool execution),
        // create a new placeholder for the next LLM response
        if (!streamingMsgRef.current) {
          const nextMsgId = `assistant-${Date.now()}`;
          streamingMsgRef.current = { id: nextMsgId, text: "", reasoning: "" };
          setMessages((prev) => [
            ...prev,
            {
              id: nextMsgId,
              role: "assistant" as const,
              content: "",
              parts: [{ type: "text" as const, text: "", state: "streaming" as const }],
            },
          ]);
          setStatus("streaming");
        }

        // Benchmark: first delta
        if (benchmarkRef.current && !benchmarkRef.current.firstDeltaAt) {
          benchmarkRef.current.firstDeltaAt = Date.now();
          const ttfd = benchmarkRef.current.firstDeltaAt - benchmarkRef.current.sendAt;
          console.log(`[ChatWorkflow] BENCHMARK first_delta: ${ttfd}ms (time from send to first visible token)`);
        }

        streamingMsgRef.current.text += content;
        const snapshot = { ...streamingMsgRef.current };
        const msgId = snapshot.id;

        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? { ...m, content: snapshot.text, parts: buildParts(snapshot) }
              : m
          )
        );
      })
      .on("broadcast", { event: "reasoning_delta" }, (payload) => {
        const { content } = payload.payload as { content: string };
        if (!streamingMsgRef.current) return;

        streamingMsgRef.current.reasoning += content;
        const snapshot = { ...streamingMsgRef.current };

        setMessages((prev) =>
          prev.map((m) =>
            m.id === snapshot.id
              ? { ...m, parts: buildParts(snapshot) }
              : m
          )
        );
      })
      .on("broadcast", { event: "tool_call_start" }, (payload) => {
        const { toolName, toolCallId, args } = payload.payload as {
          toolName: string;
          toolCallId: string;
          args: Record<string, unknown>;
        };
        setStatus("tool_executing");

        // Add tool call as a new assistant message with dynamic-tool part
        const toolMsgId = `tool-${toolCallId}`;
        setMessages((prev) => [
          ...prev,
          {
            id: toolMsgId,
            role: "assistant" as const,
            content: `Calling ${toolName}...`,
            parts: [
              {
                type: "dynamic-tool" as const,
                toolName,
                toolCallId,
                input: args,
                state: "running",
              },
            ],
          },
        ]);
      })
      .on("broadcast", { event: "tool_call_result" }, (payload) => {
        const { toolCallId, result, isError } = payload.payload as {
          toolCallId: string;
          result: string;
          isError: boolean;
        };

        // Find the tool message by toolCallId and update its state
        const toolMsgId = `tool-${toolCallId}`;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === toolMsgId
              ? {
                  ...m,
                  content: isError ? `Error: ${result}` : result,
                  parts: m.parts.map((p) =>
                    p.type === "dynamic-tool" && p.toolCallId === toolCallId
                      ? { ...p, state: isError ? "error" : "output-available", output: { content: [{ type: "text", text: result }], isError } }
                      : p
                  ),
                }
              : m
          )
        );
      })
      .on("broadcast", { event: "text_complete" }, (payload) => {
        const { content, reasoning, hasToolCalls } = payload.payload as {
          content: string;
          modelId?: string;
          reasoning?: string;
          hasToolCalls?: boolean;
        };
        console.log("[ChatWorkflow] text_complete received", { hasToolCalls, contentLen: content?.length, msgId: streamingMsgRef.current?.id });
        if (!streamingMsgRef.current) return;

        const msgId = streamingMsgRef.current.id;

        if (hasToolCalls) {
          // LLM emitted tool calls — remove the intermediate text message.
          // The LLM often writes tool names in its text output (e.g. "Tool: xxx")
          // alongside the structured tool call. The tool call will be shown
          // as a ToolCallBlock, and the final LLM response will have the real content.
          setMessages((prev) => prev.filter((m) => m.id !== msgId));
          setStatus("tool_executing");

          // Switch streamingMsgRef — tool_call_start/result events will create
          // new messages. The next text_delta will create a fresh placeholder.
          streamingMsgRef.current = null;
          return;
        }

        // No tool calls — final response, finalize
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? {
                  ...m,
                  content,
                  parts: buildFinalParts(content, reasoning),
                }
              : m
          )
        );

        streamingMsgRef.current = null;
        setStatus("idle");

        // Benchmark: completion
        if (benchmarkRef.current) {
          benchmarkRef.current.completeAt = Date.now();
          const total = benchmarkRef.current.completeAt - benchmarkRef.current.sendAt;
          const streaming = benchmarkRef.current.firstDeltaAt
            ? benchmarkRef.current.completeAt - benchmarkRef.current.firstDeltaAt
            : 0;
          console.log(`[ChatWorkflow] BENCHMARK complete: total=${total}ms, streaming=${streaming}ms, contentLen=${content.length}`);
          benchmarkRef.current = null;
        }

        // Cleanup channel
        channel.unsubscribe();
        channelRef.current = null;
      })
      .subscribe();
  }, []);

  // ── Send message ────────────────────────────────────────────────────────
  const sendMessage = useCallback(async ({ text: content }: { text: string }) => {
    if (!conversationId || !enabled) return;

    setError(undefined);
    benchmarkRef.current = { sendAt: Date.now(), firstDeltaAt: 0, completeAt: 0 };

    // Add user message to UI immediately
    const userMsgId = `user-${Date.now()}`;
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: "user",
      content,
      parts: [{ type: "text", text: content }],
      createdAt: new Date(),
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      let result: { workflowId: string; conversationId: string };

      // Dynamic context captured at send time
      const dynamicContext = {
        selectedNode: selectedNodeRef.current ?? undefined,
        figmaPluginContext: figmaPluginContextRef.current ?? undefined,
        connectedAgents: connectedAgentsRef.current,
        isLocalPlugin: isLocalPluginRef.current,
        source: sourceRef.current,
        keyId: keyIdRef.current,
      };

      if (workflowIdRef.current) {
        // Try signalling existing workflow
        const res = await fetch(`/api/chat-temporal/${workflowIdRef.current}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            message: content,
            model,
            mcpServerIds,
            figmaPluginClientId,
            ...dynamicContext,
          }),
        });
        if (!res.ok) throw new Error(`Message failed: ${res.status}`);
        result = await res.json();
        workflowIdRef.current = result.workflowId;
      } else {
        // Start new workflow
        const res = await fetch("/api/chat-temporal/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            message: content,
            model,
            mcpServerIds,
            figmaPluginClientId,
            designInstanceId,
            codeInstanceId,
            ...dynamicContext,
          }),
        });
        if (!res.ok) throw new Error(`Start failed: ${res.status}`);
        result = await res.json();
        workflowIdRef.current = result.workflowId;
      }

      // Subscribe to streaming channel
      subscribeToStream(conversationId, result.workflowId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, [conversationId, enabled, model, mcpServerIds, figmaPluginClientId, subscribeToStream]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (channelRef.current) {
        channelRef.current.unsubscribe();
        channelRef.current = null;
      }
    };
  }, []);

  return { messages, sendMessage, status, error, setMessages };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildParts(streaming: { text: string; reasoning: string }): ChatPart[] {
  const parts: ChatPart[] = [];
  if (streaming.reasoning) {
    parts.push({ type: "reasoning", text: streaming.reasoning, state: "streaming" });
  }
  parts.push({ type: "text", text: streaming.text, state: "streaming" });
  return parts;
}

function buildFinalParts(content: string, reasoning?: string): ChatPart[] {
  const parts: ChatPart[] = [];
  if (reasoning) {
    parts.push({ type: "reasoning", text: reasoning, state: "done" });
  }
  parts.push({ type: "text", text: content, state: "done" });
  return parts;
}
