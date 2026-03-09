"use client";

import { useState, useRef, useEffect } from "react";

type Props = {
  shortId: string;
  onRenamed: (newShortId: string) => Promise<boolean>;
};

export function EditableClientId({ shortId, onRenamed }: Props) {
  const [mounted, setMounted] = useState(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(shortId);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!editing) setValue(shortId);
  }, [shortId, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length < 2 || trimmed === shortId) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const ok = await onRenamed(trimmed);
    setSaving(false);
    if (ok) {
      setEditing(false);
    } else {
      setValue(shortId);
      setEditing(false);
    }
  };

  // Render a static placeholder during SSR to avoid hydration mismatch
  // (shortId is client-only, derived from sessionStorage)
  if (!mounted) {
    return <span className="text-xs font-mono text-white/50">...</span>;
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") { setValue(shortId); setEditing(false); }
        }}
        onBlur={save}
        disabled={saving}
        maxLength={30}
        className="text-xs font-mono text-white/70 bg-white/[0.08] border border-white/20 rounded px-1.5 py-0.5 outline-none focus:border-violet-500/50 w-36"
        suppressHydrationWarning
      />
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="group flex items-center gap-1 text-xs font-mono text-white/50 hover:text-white/70 transition-colors cursor-pointer"
      title="Click to rename this client"
      suppressHydrationWarning
    >
      {shortId}
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="opacity-0 group-hover:opacity-60 transition-opacity"
      >
        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      </svg>
    </button>
  );
}
