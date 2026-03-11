"use client";

import { useState, useEffect, useCallback, useRef } from "react";

export type FigmaPluginContext = {
  fileKey: string | null;
  fileName: string;
  fileUrl: string | null;
  currentPage?: { id: string; name: string } | null;
  pages?: { id: string; name: string }[];
  currentUser?: { id: string; name: string } | null;
};

export type ExecuteCodeResult = {
  success: boolean;
  result?: unknown;
  error?: string;
};

type MessageHandler = (data: Record<string, unknown>) => void;

/** Lightweight event log entry for debug diagnostics */
export type PluginEvent = {
  ts: number;
  dir: "in" | "out";
  channel: "postMessage" | "supabase" | "chat";
  type: string;
  summary?: string;
  /** Ordered parts for chat messages (text and tool calls interleaved) */
  parts?: unknown[];
  /** Optional sender/receiver identifiers (clientId or role label) — resolved to shortIds during debug serialization */
  from?: string;
  to?: string;
  /** Optional metadata for enriched events (e.g. execution stats) */
  meta?: Record<string, unknown>;
};

const MAX_PLUGIN_EVENTS = 200;

/** Push an event into a circular buffer (mutates in place) */
export function pushPluginEvent(
  log: PluginEvent[],
  event: Omit<PluginEvent, "ts">,
) {
  log.push({ ...event, ts: Date.now() });
  if (log.length > MAX_PLUGIN_EVENTS) log.splice(0, log.length - MAX_PLUGIN_EVENTS);
}

/** Build a summary string for a postMessage — full content, no truncation */
function summarize(d: Record<string, unknown>): string | undefined {
  // EXECUTE_CODE — full code
  if (d.code && typeof d.code === "string") {
    return `code=${d.code as string}`;
  }
  // EXECUTE_CODE_RESULT — success/error with full result
  if (d.type === "EXECUTE_CODE_RESULT") {
    if (d.success) {
      const r = typeof d.result === "string" ? d.result : JSON.stringify(d.result ?? "");
      return `ok ${r}`;
    }
    return `err ${(d.error as string) ?? "unknown"}`;
  }
  // selection-changed — node count
  if (d.type === "selection-changed" && d.data && typeof d.data === "object") {
    const data = d.data as { nodes?: unknown[] };
    return `${data.nodes?.length ?? 0} nodes`;
  }
  // figma-context — fileName
  if (d.type === "figma-context") {
    return (d.fileName as string) ?? undefined;
  }
  // notify
  if (d.data && typeof d.data === "object" && (d.data as Record<string, unknown>).message) {
    return (d.data as Record<string, unknown>).message as string;
  }
  return undefined;
}

/**
 * Hook to communicate with the Figma plugin from the embedded webapp.
 *
 * Message flow:
 *   webapp → window.parent.postMessage({source:'figpal-webapp',...})
 *         → ui.html bridge → parent.postMessage({pluginMessage:{...}})
 *         → code.js (figma.ui.onmessage)
 *
 *   code.js → figma.ui.postMessage({...})
 *         → ui.html sendToWebview(msg)
 *         → iframe.contentWindow.postMessage(msg)
 *         → webapp (this hook's message listener)
 */
export function useFigmaPlugin() {
  const [isFigmaPlugin, setIsFigmaPlugin] = useState(false);
  const isFigmaPluginRef = useRef(false);
  const [figmaContext, setFigmaContext] = useState<FigmaPluginContext | null>(null);
  const pendingExecutions = useRef<Map<string, (r: ExecuteCodeResult) => void>>(new Map());
  const messageHandlers = useRef<Map<string, MessageHandler[]>>(new Map());
  const eventLog = useRef<PluginEvent[]>([]);

  // ─── Send a message to the plugin sandbox (code.js) ────────────────
  const sendToPlugin = useCallback((type: string, data?: Record<string, unknown>) => {
    if (typeof window === "undefined") return;
    const msg: Record<string, unknown> = { source: "figpal-webapp", type };
    if (data !== undefined) msg.data = data;
    pushPluginEvent(eventLog.current, { dir: "out", channel: "postMessage", type, summary: summarize(msg) });
    window.parent.postMessage(msg, "*");
  }, []);

  // ─── Execute arbitrary JS inside the Figma sandbox ─────────────────
  const executeCode = useCallback(
    (code: string, timeout = 5000): Promise<ExecuteCodeResult> => {
      // Skip postMessage when not inside a Figma plugin — no recipient to handle it
      if (!isFigmaPluginRef.current) {
        return Promise.resolve({ success: false, error: "Not inside Figma plugin" });
      }
      return new Promise((resolve) => {
        const id = `exec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        pendingExecutions.current.set(id, resolve);
        pushPluginEvent(eventLog.current, { dir: "out", channel: "postMessage", type: "EXECUTE_CODE", summary: `code=${code}` });
        if (typeof window !== "undefined") {
          // Note: code and timeout are sent at the top level (not inside data)
          // because code.js reads msg.code and msg.timeout directly.
          window.parent.postMessage(
            { source: "figpal-webapp", type: "EXECUTE_CODE", id, code, timeout },
            "*"
          );
        }
      });
    },
    []
  );

  // ─── Subscribe to a specific message type from the plugin ──────────
  const onPluginMessage = useCallback(
    (type: string, handler: MessageHandler): (() => void) => {
      const handlers = messageHandlers.current.get(type) ?? [];
      handlers.push(handler);
      messageHandlers.current.set(type, handlers);
      return () => {
        const h = messageHandlers.current.get(type) ?? [];
        messageHandlers.current.set(type, h.filter((fn) => fn !== handler));
      };
    },
    []
  );

  // ─── Incoming message listener ──────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Request figma context on mount if running inside an iframe
    if (window.parent !== window) {
      sendToPlugin("request-figma-context");
    }

    const handleMessage = (event: MessageEvent) => {
      const d = event.data;
      if (!d || typeof d !== "object") return;

      // Skip React DevTools, webpack HMR, and other internal messages
      const msgType = d.type as string | undefined;
      if (!msgType || msgType.startsWith("webpack") || msgType.startsWith("react-")) return;

      // Log incoming postMessage
      pushPluginEvent(eventLog.current, { dir: "in", channel: "postMessage", type: msgType, summary: summarize(d as Record<string, unknown>) });

      // ── Handshake: plugin confirms we're inside Figma ──────────────
      if (d.type === "figpal-init") {
        isFigmaPluginRef.current = true;
        setIsFigmaPlugin(true);
        return;
      }

      // ── Figma file context (fileName, fileKey, pages…) ─────────────
      if (d.type === "figma-context") {
        isFigmaPluginRef.current = true;
        setIsFigmaPlugin(true);
        sendToPlugin("notify", { message: "Guardian connected!" });
        setFigmaContext({
          fileKey: (d.fileKey as string) ?? null,
          fileName: (d.fileName as string) ?? "",
          fileUrl: (d.fileUrl as string) ?? null,
          currentPage: (d.currentPage as FigmaPluginContext["currentPage"]) ?? null,
          pages: (d.pages as FigmaPluginContext["pages"]) ?? [],
          currentUser: (d.currentUser as FigmaPluginContext["currentUser"]) ?? null,
        });
        return;
      }

      // ── EXECUTE_CODE result: resolve pending promise ───────────────
      if (d.type === "EXECUTE_CODE_RESULT" && d.id) {
        const resolve = pendingExecutions.current.get(d.id as string);
        if (resolve) {
          pendingExecutions.current.delete(d.id as string);
          resolve({
            success: d.success as boolean,
            result: d.result,
            error: d.error as string | undefined,
          });
        }
        return;
      }

      // ── Generic dispatch for other message types ───────────────────
      const handlers = messageHandlers.current.get(d.type as string);
      if (handlers?.length) {
        handlers.forEach((fn) => fn(d as Record<string, unknown>));
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [sendToPlugin]);

  return { isFigmaPlugin, figmaContext, sendToPlugin, executeCode, onPluginMessage, eventLog };
}
