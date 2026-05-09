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
import type { PendingDisambiguation, RestEndpointInfo } from "@/lib/chat-dynamic-context";

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

/** One entry per MCP instance that failed discovery at workflow start. */
export type MCPDiscoveryFailure = {
  label: string;
  displayName: string;
  presetType: string;
  scope: string;
  error: string;
};

export type UseChatWorkflowReturn = {
  messages: ChatMessage[];
  sendMessage: (msg: { text: string; forceConversationId?: string }) => void;
  /**
   * Abort the current generation by signalling `chatCancel` to the running
   * Temporal workflow. No-op if no workflow is attached (status === "idle" or
   * no workflow id known). Because Temporal runs in the cloud, this is the
   * ONLY way to stop generation — closing the tab doesn't help.
   */
  cancelMessage: () => void;
  status: ChatWorkflowStatus;
  error: string | undefined;
  /**
   * `true` once the initial `loadAndRecover` pass for the current
   * `conversationId` has completed (success or failure). UI code gates the
   * empty-state splash on this so it doesn't flash before persisted
   * messages arrive. Resets to `false` on every conversation switch.
   */
  loaded: boolean;
  /**
   * The conversationId that the current `messages` array was loaded for.
   * `null` between a conv switch and the moment loadAndRecover finishes
   * populating messages. Consumers comparing `messages` against the active
   * conv (e.g. auto-rename) MUST gate on `messagesConvId === activeConvId`
   * to avoid acting on stale messages from the previous conv (React closure
   * semantics make a setMessages([]) inside this hook's effect invisible to
   * effects in the same render at the call site).
   */
  messagesConvId: string | null;
  setMessages: (msgs: ChatMessage[]) => void;
  /** Discovery failures surfaced from the Temporal worker (MCP instances that couldn't be reached). */
  mcpDiscoveryFailures: MCPDiscoveryFailure[];
  clearMCPDiscoveryFailures: () => void;
  /** Current workflow phase broadcast by the Temporal workflow (e.g. "discovering_tools", "waiting_for_model"). */
  workflowPhase: string | null;
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

type ActiveTarget = {
  shortId: string;
  label?: string;
  fileName?: string;
  fileKey?: string;
  fileUrl?: string;
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
  /** Resolved Figma plugin target for this conversation (for the system prompt). */
  activeTarget?: ActiveTarget;
  // V2: focus instance IDs from TargetSelector
  designInstanceId?: string;
  codeInstanceId?: string;
  /**
   * When the design or code resolver returns `kind: "ambiguous"`, the
   * frontend forwards this to the worker so the system prompt can request
   * a QCM disambiguation from the LLM. `figmaPluginClientId` will be
   * undefined in this case (intentional — plugin-bound tools must wait
   * for the user's pick).
   */
  pendingDisambiguation?: PendingDisambiguation;
  /**
   * Read-only design REST endpoints (figma_console / figma_mcp) that work
   * with an explicit fileUrl regardless of plugin pairing. Listed in the
   * system prompt so the LLM knows it can serve read queries even when
   * no plugin is paired.
   */
  restEndpoints?: RestEndpointInfo[];
  /**
   * Resolver-output kinds. Forwarded so the worker's system prompt can
   * render the right "no plugin / unavailable" section AND the worker's
   * AMBIGUOUS_TARGET error can differentiate "ambig" vs "no plugin".
   */
  designPairingKind?: "explicit" | "auto-resolved" | "ambiguous" | "no-plugin";
  codePairingKind?: "explicit" | "auto-resolved" | "ambiguous" | "none";
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
  activeTarget,
  designInstanceId,
  codeInstanceId,
  pendingDisambiguation,
  restEndpoints,
  designPairingKind,
  codePairingKind,
}: UseChatWorkflowParams): UseChatWorkflowReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatWorkflowStatus>("idle");
  const [error, setError] = useState<string | undefined>();
  const [workflowPhase, setWorkflowPhase] = useState<string | null>(null);
  // `loaded` flips true once `loadAndRecover` has completed its first pass
  // (success or failure) for the current conversation. UI code gates the
  // empty-state "New conversation" splash on this so it doesn't flash
  // before persisted messages arrive. Replaces the old `messagesLoaded`
  // flag from `useMessagePersistence` which was decommissioned along with
  // the legacy `useChat` path.
  const [loaded, setLoaded] = useState(false);
  // The convId that the current `messages` array was loaded for. Lets
  // consumers detect "messages are stale relative to the active conv"
  // (during the brief window between activeConversationId changing and the
  // useEffect below repopulating messages). Without this, code in page.tsx
  // that depends on `messages` for the active conv (e.g. auto-rename) can
  // race against the conv switch.
  const [messagesConvId, setMessagesConvId] = useState<string | null>(null);
  // When sendMessage is called with forceConversationId (deferred-persistence
  // lazy creation flow from page.tsx), the parent will setActiveConversation
  // to that id on the next render. The conversationId-change effect below
  // would then wipe the optimistic user message we just added. This ref tells
  // the effect "I know about this transition, skip the reset" — refs update
  // synchronously so the effect sees the updated value the same render.
  const expectedNextConvIdRef = useRef<string | null>(null);
  const [mcpDiscoveryFailures, setMcpDiscoveryFailures] = useState<MCPDiscoveryFailure[]>([]);
  const clearMCPDiscoveryFailures = useCallback(() => setMcpDiscoveryFailures([]), []);
  const workflowIdRef = useRef<string | null>(null);
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>["channel"]> | null>(null);
  const streamingMsgRef = useRef<{ id: string; text: string; reasoning: string } | null>(null);
  const benchmarkRef = useRef<{ sendAt: number; firstDeltaAt: number; completeAt: number } | null>(null);

  // ── Streaming smoothing buffer ─────────────────────────────────────────────
  // Raw deltas from Supabase Realtime arrive in unpredictable bursts (one
  // token, then 50 chars at once, then silence). Rendering each burst
  // immediately produces a visible jerk. This buffer holds a "displayed
  // cursor" that advances at an adaptive rate across animation frames so
  // the text appears like a smooth typewriter.
  //
  // Model:
  //   streamingMsgRef.current.{text,reasoning}  = TARGET (all received chars)
  //   smoothingRef.current.{textCursor,...}     = DISPLAYED position
  //
  // A rAF tick moves the cursors forward; commitDisplayed() pushes the
  // sliced view into React state. On text_complete, flushSmoothing() jumps
  // the cursors to target so the final full content is rendered atomically.
  const smoothingRef = useRef<{
    textCursor: number;
    reasoningCursor: number;
    rafId: number | null;
    lastTick: number;
    /** Wall-clock time of the first received char for the current stream. */
    streamStartAt: number;
  }>({ textCursor: 0, reasoningCursor: 0, rafId: null, lastTick: 0, streamStartAt: 0 });

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
  const activeTargetRef = useRef(activeTarget);
  activeTargetRef.current = activeTarget;
  const pendingDisambiguationRef = useRef(pendingDisambiguation);
  pendingDisambiguationRef.current = pendingDisambiguation;
  const restEndpointsRef = useRef(restEndpoints);
  restEndpointsRef.current = restEndpoints;
  const designPairingKindRef = useRef(designPairingKind);
  designPairingKindRef.current = designPairingKind;
  const codePairingKindRef = useRef(codePairingKind);
  codePairingKindRef.current = codePairingKind;

  // ── Reset workflow state when conversation changes ──────────────────────
  // CRITICAL: workflowIdRef persists across renders as a mutable ref. When the
  // user switches conversations (or creates a new one), the ref must be cleared
  // so the next sendMessage starts a fresh workflow for the new conversation
  // instead of signalling the old one — which would route the message to the
  // wrong conversation and split assistant responses across conversations.
  useEffect(() => {
    workflowIdRef.current = null;
    streamingMsgRef.current = null;
    setMcpDiscoveryFailures([]);
    // Kill any in-flight smoothing frame from the previous conversation.
    if (smoothingRef.current.rafId !== null) {
      cancelAnimationFrame(smoothingRef.current.rafId);
      smoothingRef.current.rafId = null;
    }
    // Unsubscribe from the previous conversation's streaming channel
    if (channelRef.current) {
      try { channelRef.current.unsubscribe(); } catch { /* ignore */ }
      channelRef.current = null;
    }
  }, [conversationId]);

  // ── Load persisted messages + detect active workflow on mount/F5 ─────────
  useEffect(() => {
    // Lazy-creation skip: sendMessage(forceConversationId=Y) was just called,
    // and the parent has now set conversationId=Y on this render. The
    // optimistic user message + messagesConvId + loaded state are already
    // in place. A reset here would wipe the optimistic message; a load here
    // would race against the in-flight chat-temporal/start save_message.
    // Skip both — the streaming subscription set up inside sendMessage will
    // populate the assistant response.
    if (conversationId && conversationId === expectedNextConvIdRef.current) {
      expectedNextConvIdRef.current = null;
      return;
    }

    // Always reset on conversationId change — including the transition to
    // null (deferred-persistence "fresh chat" mode after a "+ New" click).
    // Without clearing here, the previous conv's messages remain visible in
    // the UI because the load branch below short-circuits when convId is null.
    setLoaded(false);
    setMessagesConvId(null);
    setMessages([]);
    workflowIdRef.current = null;

    if (!conversationId || !enabled) return;

    // The reset above also covers the conv-switch case: by the time
    // loadAndRecover finishes, messagesConvId is repopulated for the new
    // conv. The auto-rename effect in page.tsx gates on this so it does not
    // trigger with stale messages from the previous conv (closure semantics).

    async function loadAndRecover() {
      try {
        // Load persisted messages
        const res = await fetch(`/api/conversations/${conversationId}/messages`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.messages) {
          const loadedMessages: ChatMessage[] = data.messages.map((m: { id: string; role: string; content: string; parts?: unknown[]; metadata?: Record<string, unknown> }) => ({
            id: m.id,
            role: m.role as ChatMessage["role"],
            content: m.content ?? "",
            parts: m.parts ?? [{ type: "text", text: m.content ?? "" }],
          }));
          setMessages(loadedMessages);
          setMessagesConvId(conversationId);

          // Recover the running workflow id from conversation.metadata.chatWorkflowId.
          // This is set by /api/chat-temporal/start so that — after an F5 or tab revisit —
          // the client can send a cancel signal to the workflow it no longer holds a
          // handle to in memory. Without this, the Stop button would be dead on F5.
          try {
            const supabase = createClient();
            const { data: convRow } = await supabase
              .from("conversations")
              .select("metadata")
              .eq("id", conversationId!)
              .single();
            const wfId = (convRow?.metadata as { chatWorkflowId?: string } | null)?.chatWorkflowId;
            if (wfId) {
              workflowIdRef.current = wfId;
              console.log("[ChatWorkflow] F5 recovered workflowId from conversation.metadata", { wfId });
            }
          } catch {
            // Non-fatal — cancel will simply be a no-op if the id can't be recovered
          }

          // Check if the last message is still streaming (metadata.streaming === true)
          const lastAssistant = [...loadedMessages].reverse().find(m => m.role === "assistant");
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
      } finally {
        // Flip regardless of outcome — consumers just need to know that the
        // first load attempt is done so they can render (or not render) the
        // empty-state splash. A failed load leaves `messages` as whatever it
        // was before, which is the right UX fallback.
        setLoaded(true);
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

    // Cancel any leftover smoothing frame from a previous stream and reset
    // the cursors so the new stream starts from position 0.
    if (smoothingRef.current.rafId !== null) {
      cancelAnimationFrame(smoothingRef.current.rafId);
    }
    smoothingRef.current = { textCursor: 0, reasoningCursor: 0, rafId: null, lastTick: 0, streamStartAt: 0 };

    // ── Smoothing tuning ─────────────────────────────────────────────────
    // Drain strategy: instead of deriving rate from the current backlog
    // (which stalls whenever the buffer empties between provider bursts),
    // we drain at the **running-average incoming rate** with a gentle
    // correction toward a target lag. This decouples the output rate from
    // the instantaneous arrival pattern — even if 50 chars arrive then
    // silence for 500ms, the cursor keeps advancing at the average rate
    // until the next burst. Result: constant visible typewriter speed.
    //
    // Target lag = how far the cursor trails the target. Smaller = more
    // responsive feel, less smoothing headroom. Larger = stable but laggy.
    const SMOOTHING_ENABLED = true;
    const TARGET_LAG_MS = 1200;       // cursor trails ~1.2s behind target in steady state
    const CORRECTION_GAIN = 0.4;      // chars/sec of correction per char of lag error (soft PID P-term)
    const MIN_CHARS_PER_SEC = 40;     // floor so short messages don't feel frozen
    const MAX_CHARS_PER_SEC = 300;    // hard cap protecting against runaway catch-up
    const DEFAULT_INCOMING_RATE = 140;// used before enough elapsed time to measure

    // ── Debug instrumentation (toggle via localStorage.smoothDebug = "1") ─
    // When enabled, logs incoming bursts (size + inter-arrival) and emits
    // a drain sample every ~250ms showing pending/rate/cursor progress.
    // Use window.__smoothingLog in devtools to inspect the last samples.
    const DEBUG = typeof window !== "undefined" && window.localStorage?.getItem("smoothDebug") === "1";
    const SLOW_MODE = typeof window !== "undefined" && window.localStorage?.getItem("smoothSlow") === "1";
    const SLOW_FIXED_CPS = 25; // fixed rate for slow-mode diagnostic runs
    let lastDrainLogAt = 0;
    let lastBurstAt = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wnd = (typeof window !== "undefined" ? (window as any) : null);
    if (DEBUG && wnd) {
      wnd.__smoothingLog = { bursts: [], drains: [] };
    }
    // Minimum interval between React state commits. rAF fires at 60fps but
    // each commit re-wraps ALL chars in every markdown element of the bubble
    // through react-markdown + wrapCharsInSpans — O(N) where N is total
    // message length. For a 2000-char response committing 60 times/sec
    // bogs down the main thread. Committing at ~20fps (50ms) gives React
    // room to breathe without making the typewriter feel stuttered: at
    // ~120 chars/sec typewriter speed that's ~6 chars per commit, which
    // combined with the per-char mount animation still reads as "one char
    // at a time" since the char spans arrive slightly staggered in render.
    // Drain rate accumulates between commits, so total throughput is
    // unchanged — we just bundle more chars per React update.
    const MIN_COMMIT_INTERVAL_MS = 50;

    // Commit the currently-displayed slice to React state. Reads the target
    // from streamingMsgRef and the cursors from smoothingRef, then rebuilds
    // the visible parts. No-op if there's no active streaming message.
    const commitDisplayed = () => {
      const snap = streamingMsgRef.current;
      if (!snap) return;
      const buf = smoothingRef.current;
      const displayedText = snap.text.slice(0, buf.textCursor);
      const displayedReasoning = snap.reasoning.slice(0, buf.reasoningCursor);
      const msgId = snap.id;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? {
                ...m,
                content: displayedText,
                parts: buildParts({ text: displayedText, reasoning: displayedReasoning }),
              }
            : m
        )
      );
    };

    // One animation frame of drain. rAF fires at ~60fps but we only COMMIT
    // to React state at ~30fps (MIN_COMMIT_INTERVAL_MS). On skipped frames
    // the cursors stay in place and we re-queue another rAF — that means
    // the ADVANCE calculation uses the full elapsed time since the last
    // commit, so characters still arrive at the correct rate overall.
    const smoothTick = () => {
      const buf = smoothingRef.current;
      buf.rafId = null;
      const snap = streamingMsgRef.current;
      if (!snap) return;

      const now = performance.now();

      // Throttle gate: if we committed recently, skip advancing and
      // re-queue another frame. Keeps the loop alive without spending
      // React reconciliation cycles on every rAF.
      if (now - buf.lastTick < MIN_COMMIT_INTERVAL_MS) {
        if (snap.text.length > buf.textCursor || snap.reasoning.length > buf.reasoningCursor) {
          buf.rafId = requestAnimationFrame(smoothTick);
        }
        return;
      }

      const dt = Math.max(1, now - buf.lastTick);
      buf.lastTick = now;

      const pendingText = snap.text.length - buf.textCursor;
      const pendingReasoning = snap.reasoning.length - buf.reasoningCursor;
      if (pendingText <= 0 && pendingReasoning <= 0) return;

      // Running-average incoming rate: total chars received since stream
      // start divided by elapsed time. Smooths over provider bursts better
      // than a short EMA because char arrivals are very bursty at the
      // sub-second scale. Uses DEFAULT_INCOMING_RATE before 500ms of data
      // exists so early frames don't drain at a noisy measurement.
      const elapsedMs = buf.streamStartAt > 0 ? now - buf.streamStartAt : 0;
      const avgIncoming = elapsedMs > 500
        ? Math.max(MIN_CHARS_PER_SEC, (snap.text.length * 1000) / elapsedMs)
        : DEFAULT_INCOMING_RATE;

      // Drain at avgIncoming, with a correction proportional to the
      // error between current lag and target lag. If we're behind target
      // (too much backlog) → speed up. If we're ahead → slow down. Kept
      // gentle (small gain) so the output rate stays near constant.
      const rateFor = (pending: number) => {
        if (pending <= 0) return 0;
        if (SLOW_MODE) return SLOW_FIXED_CPS;
        const targetBacklog = (avgIncoming * TARGET_LAG_MS) / 1000;
        const error = pending - targetBacklog;
        const target = avgIncoming + error * CORRECTION_GAIN;
        return Math.max(MIN_CHARS_PER_SEC, Math.min(MAX_CHARS_PER_SEC, target));
      };

      const textRate = rateFor(pendingText);
      const advanceText = Math.ceil((textRate * dt) / 1000);
      const advanceReasoning = Math.ceil((rateFor(pendingReasoning) * dt) / 1000);

      if (DEBUG && now - lastDrainLogAt > 250) {
        lastDrainLogAt = now;
        const sample = {
          t: Math.round(now - buf.streamStartAt),
          elapsedMs: Math.round(elapsedMs),
          target: snap.text.length,
          cursor: buf.textCursor,
          pending: pendingText,
          avgIncoming: Math.round(avgIncoming),
          rate: Math.round(textRate),
          dt: Math.round(dt),
          advance: advanceText,
        };
        console.log("[smooth]", sample);
        if (wnd?.__smoothingLog) wnd.__smoothingLog.drains.push(sample);
      }

      let changed = false;
      if (pendingText > 0 && advanceText > 0) {
        buf.textCursor = Math.min(snap.text.length, buf.textCursor + advanceText);
        changed = true;
      }
      if (pendingReasoning > 0 && advanceReasoning > 0) {
        buf.reasoningCursor = Math.min(snap.reasoning.length, buf.reasoningCursor + advanceReasoning);
        changed = true;
      }

      if (changed) commitDisplayed();

      // Keep the animation alive while any cursor is behind its target.
      if (snap.text.length > buf.textCursor || snap.reasoning.length > buf.reasoningCursor) {
        buf.rafId = requestAnimationFrame(smoothTick);
      }
    };

    // Request a drain frame if one isn't already queued. When smoothing
    // is disabled (debug flag), falls back to an immediate synchronous
    // commit so we can compare before/after without code changes.
    const scheduleSmoothTick = () => {
      if (!SMOOTHING_ENABLED) {
        const snap = streamingMsgRef.current;
        if (snap) {
          smoothingRef.current.textCursor = snap.text.length;
          smoothingRef.current.reasoningCursor = snap.reasoning.length;
        }
        commitDisplayed();
        return;
      }
      const buf = smoothingRef.current;
      if (buf.rafId !== null) return; // already scheduled
      if (buf.lastTick === 0) buf.lastTick = performance.now();
      buf.rafId = requestAnimationFrame(smoothTick);
    };

    // Jump the cursors to the end of the target. Used at text_complete and
    // on errors so the final render has no leftover unshown chars and any
    // queued rAF is cancelled.
    const flushSmoothing = () => {
      const buf = smoothingRef.current;
      if (buf.rafId !== null) {
        cancelAnimationFrame(buf.rafId);
        buf.rafId = null;
      }
      const snap = streamingMsgRef.current;
      if (snap) {
        buf.textCursor = snap.text.length;
        buf.reasoningCursor = snap.reasoning.length;
      }
    };

    // Reset cursors to 0 when starting a fresh streaming message mid-stream
    // (e.g., after a tool call returns and the LLM resumes talking).
    const resetSmoothingCursors = () => {
      const buf = smoothingRef.current;
      if (buf.rafId !== null) {
        cancelAnimationFrame(buf.rafId);
        buf.rafId = null;
      }
      buf.textCursor = 0;
      buf.reasoningCursor = 0;
      buf.lastTick = 0;
      buf.streamStartAt = 0;
    };

    const supabase = createClient();
    const channel = supabase.channel(`guardian:chat:${convId}`);
    channelRef.current = channel;

    // Initialize streaming message
    const streamMsgId = `assistant-${Date.now()}`;
    streamingMsgRef.current = { id: streamMsgId, text: "", reasoning: "" };
    resetSmoothingCursors();

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
          // New streaming message → restart the typewriter from 0.
          resetSmoothingCursors();
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

        // Mark stream start on first char — used by rateFor() to compute
        // the running-average incoming rate.
        if (smoothingRef.current.streamStartAt === 0) {
          smoothingRef.current.streamStartAt = performance.now();
        }

        if (DEBUG) {
          const now = performance.now();
          const gap = lastBurstAt === 0 ? 0 : now - lastBurstAt;
          lastBurstAt = now;
          const burst = {
            t: Math.round(now - smoothingRef.current.streamStartAt),
            size: content.length,
            gapMs: Math.round(gap),
            totalReceived: streamingMsgRef.current.text.length + content.length,
          };
          console.log("[burst]", burst);
          if (wnd?.__smoothingLog) wnd.__smoothingLog.bursts.push(burst);
        }

        // Append to the TARGET. The rAF drain will progressively reveal
        // the new chars via commitDisplayed().
        streamingMsgRef.current.text += content;
        scheduleSmoothTick();
      })
      .on("broadcast", { event: "reasoning_delta" }, (payload) => {
        const { content } = payload.payload as { content: string };
        if (!streamingMsgRef.current) return;

        // Append to the TARGET; let the smoothing drain reveal it.
        streamingMsgRef.current.reasoning += content;
        scheduleSmoothTick();
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
      .on("broadcast", { event: "mcp_discovery_error" }, (payload) => {
        const { failures } = payload.payload as { failures: MCPDiscoveryFailure[] };
        if (Array.isArray(failures) && failures.length > 0) {
          console.warn("[ChatWorkflow] MCP discovery failures:", failures);
          setMcpDiscoveryFailures(failures);
        }
      })
      .on("broadcast", { event: "text_complete" }, (payload) => {
        const { content, reasoning, hasToolCalls, finishReason } = payload.payload as {
          content: string;
          modelId?: string;
          reasoning?: string;
          hasToolCalls?: boolean;
          finishReason?: string;
        };
        console.log("[ChatWorkflow] text_complete received", { hasToolCalls, contentLen: content?.length, finishReason, msgId: streamingMsgRef.current?.id });
        if (!streamingMsgRef.current) return;

        const msgId = streamingMsgRef.current.id;

        if (hasToolCalls) {
          // LLM emitted tool calls. If the intermediate text is meaningful
          // (real reasoning like "Je vais vérifier ta sélection…"), KEEP it
          // as its own message so the tool-call bubbles appear below it.
          // If it's trivial (empty or a short preamble like "Tool: xxx" or "✅"),
          // drop it — the ToolCallBlock carries the semantics.
          // Must match the backend rule in llm-streaming.ts (threshold > 4 chars).
          const meaningful = (content ?? "").trim().length > 4;
          flushSmoothing();
          if (meaningful) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msgId
                  ? { ...m, content: content ?? "", parts: buildFinalParts(content ?? "", reasoning) }
                  : m,
              ),
            );
          } else {
            setMessages((prev) => prev.filter((m) => m.id !== msgId));
          }
          setStatus("tool_executing");

          // Switch streamingMsgRef — tool_call_start/result events will create
          // new messages. The next text_delta will create a fresh placeholder.
          streamingMsgRef.current = null;
          return;
        }

        // ── finishReason handling ─────────────────────────────────────────
        // Distinct user-visible treatment for "non-normal" stop reasons:
        //   - "content-filter" → provider blocked some/all of the response.
        //     Surface via PeekBanner so the user knows their answer may be
        //     incomplete AND why.
        //   - "length"         → truncation at max_output_tokens. Same banner
        //     treatment, different message ("ask me to continue").
        //   - "cancelled"      → user clicked Stop (emitted by the activity's
        //     cancellation branch). Silent — the truncated message speaks for
        //     itself, no banner needed.
        // "stop", "tool-calls", "error", "other", "unknown" use the default
        // text rendering path without a banner.
        if (finishReason === "content-filter") {
          setError("Response was blocked by the model's content filter. Part of the answer may be missing.");
        } else if (finishReason === "length") {
          setError("Response was cut off at the maximum output length. Ask the model to continue if you need more.");
        }

        // No tool calls — final response. Flush the smoothing buffer so any
        // pending rAF is cancelled; the setMessages below renders the full
        // final content atomically (no fight between typewriter and final).
        flushSmoothing();
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
      .on("broadcast", { event: "stream_error" }, (payload) => {
        const { error: errMsg } = payload.payload as { requestId: string; error: string };
        console.error("[ChatWorkflow] stream_error received:", errMsg);

        // Cancel any queued typewriter frame — the message is going away.
        flushSmoothing();
        // Remove the empty streaming placeholder if present
        if (streamingMsgRef.current) {
          const emptyId = streamingMsgRef.current.id;
          setMessages((prev) => prev.filter((m) => m.id !== emptyId));
          streamingMsgRef.current = null;
        }

        // Error shown via PeekBanner (page.tsx syncs chatWorkflow.error → chatErrorMsg)
        // No chat message added — banner is sufficient.
        setError(errMsg);
        setStatus("idle");
      })
      .on("broadcast", { event: "phase_update" }, (payload) => {
        const { phase } = payload.payload as { phase: string };
        setWorkflowPhase(phase);
      })
      .on("broadcast", { event: "workflow_error" }, (payload) => {
        // Broadcast from chat.ts top-level catch for any error NOT already
        // surfaced as a stream_error (e.g. loadChatHistory crashed, an MCP
        // tool execution threw, persistChatMessage failed). Previously the
        // workflow would die silently and the client would hang forever
        // waiting for text_complete — now we flip to error state immediately.
        const { error: errMsg } = payload.payload as { error: string; status?: string };
        console.error("[ChatWorkflow] workflow_error received:", errMsg);

        // Cancel any queued typewriter frame — the message is going away.
        flushSmoothing();
        if (streamingMsgRef.current) {
          const emptyId = streamingMsgRef.current.id;
          setMessages((prev) => prev.filter((m) => m.id !== emptyId));
          streamingMsgRef.current = null;
        }

        setError(errMsg || "Chat workflow failed unexpectedly. Please try again.");
        setStatus("idle");
      })
      .subscribe();
  }, []);

  // ── Send message ────────────────────────────────────────────────────────
  const sendMessage = useCallback(async ({ text: content, forceConversationId }: { text: string; forceConversationId?: string }) => {
    // forceConversationId lets callers send into a conv that was just created
    // (lazy-create flow) without waiting for the conversationId prop to
    // propagate through React state. In the normal case, fall back to the prop.
    const effectiveConvId = forceConversationId ?? conversationId;
    if (!effectiveConvId || !enabled) return;

    setError(undefined);
    setWorkflowPhase(null);
    benchmarkRef.current = { sendAt: Date.now(), firstDeltaAt: 0, completeAt: 0 };

    if (forceConversationId) {
      // Mark that the next conversationId-prop transition (caller will call
      // setActiveConversation right after) is a lazy-creation, not a real
      // conv switch. The conv-switch effect will short-circuit and preserve
      // the optimistic user message added below + the streaming subscription.
      // Also pre-set messagesConvId so consumers (auto-rename, etc.) see the
      // messages as belonging to the new conv from the start.
      expectedNextConvIdRef.current = forceConversationId;
      setMessagesConvId(forceConversationId);
      setLoaded(true);
    }

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
        activeTarget: activeTargetRef.current,
        pendingDisambiguation: pendingDisambiguationRef.current,
        restEndpoints: restEndpointsRef.current,
        designPairingKind: designPairingKindRef.current,
        codePairingKind: codePairingKindRef.current,
      };

      if (workflowIdRef.current) {
        // Try signalling existing workflow
        const res = await fetch(`/api/chat-temporal/${workflowIdRef.current}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: effectiveConvId,
            message: content,
            model,
            mcpServerIds,
            figmaPluginClientId,
            // Forwarded so /message can reapply V2 focus selection when it
            // has to spin up a new chatWorkflow after idle timeout.
            designInstanceId,
            codeInstanceId,
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
            conversationId: effectiveConvId,
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
      subscribeToStream(effectiveConvId, result.workflowId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, [conversationId, enabled, model, mcpServerIds, figmaPluginClientId, subscribeToStream]);

  // ── Cancel in-flight generation ─────────────────────────────────────────
  // Sends POST /api/chat-temporal/{wf}/cancel which in turn signals the
  // `chatCancel` signal on the workflow. Temporal runs in the cloud, so
  // closing the tab does NOT stop generation — this is the only way to
  // actually halt the current LLM call.
  const cancelMessage = useCallback(() => {
    const wfId = workflowIdRef.current;
    if (!wfId) {
      console.warn("[ChatWorkflow] cancelMessage called but no workflowId — ignoring");
      return;
    }
    // Fire-and-forget — we don't wait for the signal to round-trip before
    // updating the UI. The user gets immediate feedback that the stop happened.
    fetch(`/api/chat-temporal/${wfId}/cancel`, { method: "POST" }).catch((err) => {
      console.warn("[ChatWorkflow] cancel request failed", err);
    });
    // Optimistically flip status — the actual state will re-sync when the
    // workflow completes (via text_complete) or errors (via stream_error).
    setStatus("idle");
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Kill any pending typewriter frame before unmount, otherwise it
      // would fire against a torn-down component.
      if (smoothingRef.current.rafId !== null) {
        cancelAnimationFrame(smoothingRef.current.rafId);
        smoothingRef.current.rafId = null;
      }
      if (channelRef.current) {
        channelRef.current.unsubscribe();
        channelRef.current = null;
      }
    };
  }, []);

  return { messages, messagesConvId, sendMessage, cancelMessage, status, error, loaded, setMessages, mcpDiscoveryFailures, clearMCPDiscoveryFailures, workflowPhase };
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
