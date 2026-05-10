"use client";

import type { QCMMeta } from "@/lib/content-parsing";

type Props = {
  choices: string[];
  /**
   * Fallback for non-target QCMs (project pickers, etc.). When `meta` is
   * present (target disambiguation), `onQCMResolve` is preferred — see
   * the click handler. `onSelect` remains for the legacy generic-QCM path.
   */
  onSelect: (choice: string) => void;
  disabled: boolean;
  meta?: QCMMeta;
  /**
   * Updates the local TargetSelector state when a target QCM choice is
   * picked. Always called (synchronously) before the resolution flow
   * fires, so the selector reflects the user's pick immediately.
   */
  onTargetChoice?: (category: "design" | "code", targetId: string) => void;
  /**
   * Sends the click as a TOOL RESPONSE to the worker (option C) instead
   * of as a free-form user message. When provided AND `meta` is present,
   * `onSelect` is NOT called — the click is fully resolved via this
   * dedicated path. The worker replaces the prior
   * `request_target_disambiguation` tool result with the resolution and
   * resumes the LLM loop without polluting the LLM history with a
   * redundant user message.
   */
  onQCMResolve?: (
    category: "design" | "code",
    targetId: string,
    choiceLabel: string,
  ) => void;
};

export function QCMBlock({ choices, onSelect, disabled, meta, onTargetChoice, onQCMResolve }: Props) {
  return (
    <div className="my-3 flex flex-wrap gap-2">
      {choices.map((choice, i) => (
        <button
          key={i}
          onClick={() => {
            if (disabled) return;
            if (meta) {
              const targetId = meta.map[choice];
              if (targetId) {
                onTargetChoice?.(meta.category, targetId);
                if (onQCMResolve) {
                  onQCMResolve(meta.category, targetId, choice);
                  return; // option C path — do NOT also call onSelect
                }
              }
            }
            onSelect(choice);
          }}
          disabled={disabled}
          className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
            disabled
              ? "bg-white/5 border-white/10 text-white/30 cursor-not-allowed"
              : "bg-blue-600/20 border-blue-500/30 text-blue-300 hover:bg-blue-600/30 hover:border-blue-500/50 cursor-pointer"
          }`}
        >
          {choice}
        </button>
      ))}
    </div>
  );
}
