"use client";

/**
 * GuardianSendButton — dual-mode send/stop button.
 *
 * Behaviour:
 *   - Not generating: classic arrow-up send button (standard AI chat style).
 *   - Generating: round button with animated Guardian mascot; on hover the
 *     mascot cross-fades to a red square "stop" icon.
 */

import type { ButtonHTMLAttributes } from "react";
import { GuardianMascot } from "./GuardianMascot";

type GuardianSendButtonProps = {
  /** True while the chat workflow is streaming/tool_executing. */
  isGenerating: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export function GuardianSendButton({
  isGenerating,
  className = "",
  "aria-label": ariaLabel,
  ...rest
}: GuardianSendButtonProps) {
  if (!isGenerating) {
    return (
      <button
        {...rest}
        className={`guardian-send-btn-idle ${className}`.trim()}
        aria-label={ariaLabel ?? "Send message"}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 19V5" />
          <path d="M5 12l7-7 7 7" />
        </svg>
      </button>
    );
  }

  return (
    <button
      {...rest}
      className={`guardian-send-btn guardian-send-btn-generating ${className}`.trim()}
      aria-label={ariaLabel ?? "Generating — hover to cancel"}
    >
      <span className="guardian-mascot-wrap">
        <GuardianMascot size={34} paused={false} />
      </span>
      <span className="guardian-stop-wrap" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
        </svg>
      </span>
    </button>
  );
}
