"use client";

type Props = {
  enabled: boolean;
  onChange: (value: boolean) => void;
  compact?: boolean;
};

/**
 * Toggle switch for the auto-accept collaboration setting.
 * Compact mode is used in the chat header; full mode in the account page.
 */
export function AutoAcceptToggle({ enabled, onChange, compact }: Props) {
  if (compact) {
    return (
      <button
        onClick={() => onChange(!enabled)}
        className="flex items-center gap-1.5 text-[10px] text-white/40 hover:text-white/60 transition-colors cursor-pointer"
        title={
          enabled
            ? "Auto-accept: ON — collaboration requests are accepted automatically"
            : "Auto-accept: OFF — you'll be asked before accepting collaboration requests"
        }
      >
        <span
          className={`relative w-6 h-3.5 rounded-full transition-colors ${
            enabled ? "bg-emerald-500/40" : "bg-white/15"
          }`}
        >
          <span
            className={`absolute top-0.5 w-2.5 h-2.5 rounded-full transition-all ${
              enabled
                ? "left-3 bg-emerald-400"
                : "left-0.5 bg-white/40"
            }`}
          />
        </span>
        <span className="hidden sm:inline">Auto-accept</span>
      </button>
    );
  }

  return (
    <div className="flex items-center justify-between py-3">
      <div>
        <p className="text-sm text-white/80">Auto-accept collaboration requests</p>
        <p className="text-xs text-white/40 mt-0.5">
          When enabled, incoming orchestration requests from other agents are
          accepted automatically without requiring your approval.
        </p>
      </div>
      <button
        onClick={() => onChange(!enabled)}
        className="cursor-pointer shrink-0 ml-4"
      >
        <span
          className={`relative inline-block w-10 h-6 rounded-full transition-colors ${
            enabled ? "bg-emerald-500/40" : "bg-white/15"
          }`}
        >
          <span
            className={`absolute top-1 w-4 h-4 rounded-full transition-all ${
              enabled
                ? "left-5 bg-emerald-400"
                : "left-1 bg-white/40"
            }`}
          />
        </span>
      </button>
    </div>
  );
}
