"use client";

export function QCMBlock({ choices, onSelect, disabled }: { choices: string[]; onSelect: (choice: string) => void; disabled: boolean }) {
  return (
    <div className="my-3 flex flex-wrap gap-2">
      {choices.map((choice, i) => (
        <button
          key={i}
          onClick={() => !disabled && onSelect(choice)}
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
