"use client";

type MiniToggleProps = {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  title?: string;
};

export function MiniToggle({ checked, onChange, disabled, title }: MiniToggleProps) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      title={title}
      className={`relative shrink-0 w-10 h-5 rounded-full transition-colors cursor-pointer disabled:opacity-40 ${
        checked ? "bg-emerald-600" : "bg-white/20"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
          checked ? "translate-x-5" : ""
        }`}
      />
    </button>
  );
}
