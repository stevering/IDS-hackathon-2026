"use client";

/**
 * GuardianSendButton — round send/stop button with the animated Guardian
 * mascot inside. Reuses <GuardianMascot /> for the character.
 *
 * Behaviour:
 *   - Not generating: static mascot (paused), works as a submit button.
 *   - Generating: mascot is animated; on hover the mascot cross-fades to a
 *     red square "stop" icon to indicate the button would cancel generation.
 *
 * Note: the actual "stop generation" action is NOT wired up here — the
 * workflow hook does not yet expose a stop function. Parent can handle
 * onClick during generation once that's available. For now the form-level
 * onSubmit guard (`if (isLoading) return;`) keeps clicks harmless.
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
  return (
    <button
      {...rest}
      className={`guardian-send-btn ${isGenerating ? "guardian-send-btn-generating" : ""} ${className}`.trim()}
      aria-label={ariaLabel ?? (isGenerating ? "Generating — hover to cancel" : "Send message")}
    >
      <span className="guardian-mascot-wrap">
        <GuardianMascot size={34} paused={!isGenerating} />
      </span>
      {isGenerating && (
        <span className="guardian-stop-wrap" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
          </svg>
        </span>
      )}
    </button>
  );
}
