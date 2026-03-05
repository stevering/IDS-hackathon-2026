"use client";

import { useEffect, useRef } from "react";
import type { ExecuteCodeResult } from "./useFigmaPlugin";

/**
 * Polls the webapp API for pending MCP code-execution requests
 * and forwards them to the Figma plugin via executeCode (postMessage).
 */
export function useFigmaExecutePoller(
  executeCode: (code: string, timeout?: number) => Promise<ExecuteCodeResult>,
  enabled: boolean
) {
  const busy = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const poll = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const resp = await fetch("/api/figma-execute?action=pending");
        const req = await resp.json();
        if (!req) return;

        const result = await executeCode(req.code, req.timeout);

        await fetch("/api/figma-execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "result",
            requestId: req.requestId,
            success: result.success,
            result: result.result,
            error: result.error,
          }),
        });
      } catch {
        // Silently ignore polling errors
      } finally {
        busy.current = false;
      }
    };

    const interval = setInterval(poll, 500);
    return () => clearInterval(interval);
  }, [executeCode, enabled]);
}
