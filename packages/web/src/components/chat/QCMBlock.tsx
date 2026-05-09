"use client";

import type { QCMMeta } from "@/lib/content-parsing";

type Props = {
  choices: string[];
  onSelect: (choice: string) => void;
  disabled: boolean;
  meta?: QCMMeta;
  onTargetChoice?: (category: "design" | "code", targetId: string) => void;
};

export function QCMBlock({ choices, onSelect, disabled, meta, onTargetChoice }: Props) {
  return (
    <div className="my-3 flex flex-wrap gap-2">
      {choices.map((choice, i) => (
        <button
          key={i}
          onClick={() => {
            if (disabled) return;
            if (meta && onTargetChoice) {
              const targetId = meta.map[choice];
              if (targetId) onTargetChoice(meta.category, targetId);
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
