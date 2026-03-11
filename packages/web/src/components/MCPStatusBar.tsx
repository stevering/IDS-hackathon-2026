"use client";

import { useEffect, useRef, useState } from "react";

type MCPStatus = "idle" | "connecting" | "connected" | "error";

type Props = {
  status: MCPStatus;
};

/**
 * Compact header bar showing MCP connection status.
 * Follows the OrchestrationStatusBar design pattern.
 * - connecting: blue spinner
 * - connected: green checkmark, auto-dismiss after 1.5s
 * - error: red warning, stays visible
 * - idle: returns null
 */
export function MCPStatusBar({ status }: Props) {
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);
  const fadeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    clearTimeout(fadeTimer.current);
    clearTimeout(hideTimer.current);

    if (status === "idle") {
      setFading(true);
      hideTimer.current = setTimeout(() => {
        setVisible(false);
        setFading(false);
      }, 300);
      return;
    }

    setVisible(true);
    setFading(false);

    if (status === "connected") {
      fadeTimer.current = setTimeout(() => {
        setFading(true);
        hideTimer.current = setTimeout(() => {
          setVisible(false);
          setFading(false);
        }, 300);
      }, 1500);
    }

    return () => {
      clearTimeout(fadeTimer.current);
      clearTimeout(hideTimer.current);
    };
  }, [status]);

  if (!visible) return null;

  const isConnecting = status === "connecting";
  const isError = status === "error";
  const isConnected = status === "connected";

  return (
    <div
      className={`flex items-center gap-2 px-3 py-1.5 text-xs border-b border-white/10 transition-opacity duration-300 ${
        fading ? "opacity-0" : "opacity-100"
      } ${
        isError
          ? "bg-red-500/5 text-red-300/80"
          : isConnecting
          ? "bg-blue-500/5 text-blue-300/80"
          : "bg-emerald-500/5 text-emerald-300/80"
      }`}
    >
      {/* Icon */}
      {isConnecting && (
        <svg
          className="animate-spin h-3 w-3 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      )}
      {isConnected && (
        <svg
          className="h-3 w-3 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {isError && (
        <svg
          className="h-3 w-3 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      )}

      {/* Label */}
      <span className="truncate">
        {isConnecting
          ? "Connecting to MCP servers\u2026"
          : isError
          ? "MCP connection failed"
          : "MCP connected"}
      </span>
    </div>
  );
}
