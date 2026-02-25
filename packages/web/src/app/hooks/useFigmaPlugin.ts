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
  const [figmaContext, setFigmaContext] = useState<FigmaPluginContext | null>(null);
  const pendingExecutions = useRef<Map<string, (r: ExecuteCodeResult) => void>>(new Map());
  const messageHandlers = useRef<Map<string, MessageHandler[]>>(new Map());

  // ─── Send a message to the plugin sandbox (code.js) ────────────────
  const sendToPlugin = useCallback((type: string, data?: Record<string, unknown>) => {
    if (typeof window === "undefined") return;
    const msg: Record<string, unknown> = { source: "figpal-webapp", type };
    if (data !== undefined) msg.data = data;
    window.parent.postMessage(msg, "*");
  }, []);

  // ─── Execute arbitrary JS inside the Figma sandbox ─────────────────
  const executeCode = useCallback(
    (code: string, timeout = 5000): Promise<ExecuteCodeResult> => {
      return new Promise((resolve) => {
        const id = `exec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        pendingExecutions.current.set(id, resolve);
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

      // ── Handshake: plugin confirms we're inside Figma ──────────────
      if (d.type === "figpal-init") {
        setIsFigmaPlugin(true);
        return;
      }

      // ── Figma file context (fileName, fileKey, pages…) ─────────────
      if (d.type === "figma-context") {
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

  return { isFigmaPlugin, figmaContext, sendToPlugin, executeCode, onPluginMessage };
}
