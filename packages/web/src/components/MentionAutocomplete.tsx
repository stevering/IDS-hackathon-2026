"use client";

import { useState, useEffect, useRef, useCallback } from "react";

export type MentionSuggestion = {
  id: string;
  label: string;
  shortId: string;
  type: "orchestrator" | "collaborator" | "agent";
};

type Props = {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  suggestions: MentionSuggestion[];
  onSelect: (suggestion: MentionSuggestion) => void;
};

/**
 * Autocomplete popup for @mentions in the chat input.
 * Triggered when the user types '@' followed by text.
 * Shows a filtered list of mentionable agents in the current orchestration.
 */
export function MentionAutocomplete({ inputRef, suggestions, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [position, setPosition] = useState<{ bottom: number; left: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const filtered = suggestions.filter(
    (s) =>
      s.label.toLowerCase().includes(filter.toLowerCase()) ||
      s.shortId.toLowerCase().includes(filter.toLowerCase()),
  );

  // Listen to input changes to detect @ trigger
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    const handleInput = () => {
      const value = input.value;
      const cursorPos = input.selectionStart ?? 0;

      // Find the last '@' before cursor
      const textBefore = value.slice(0, cursorPos);
      const atIndex = textBefore.lastIndexOf("@");

      if (atIndex === -1 || (atIndex > 0 && textBefore[atIndex - 1] !== " " && textBefore[atIndex - 1] !== "\n")) {
        setOpen(false);
        return;
      }

      // Check there's no space between @ and cursor (meaning user is still typing the mention)
      const mentionText = textBefore.slice(atIndex + 1);
      if (mentionText.includes(" ") || mentionText.includes("\n")) {
        setOpen(false);
        return;
      }

      setFilter(mentionText);
      setSelectedIndex(0);
      setOpen(true);

      // Position the popup above the input
      const rect = input.getBoundingClientRect();
      setPosition({
        bottom: window.innerHeight - rect.top + 4,
        left: rect.left,
      });
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!open) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && filtered.length > 0) {
        e.preventDefault();
        handleSelect(filtered[selectedIndex]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };

    input.addEventListener("input", handleInput);
    input.addEventListener("keydown", handleKeyDown);
    return () => {
      input.removeEventListener("input", handleInput);
      input.removeEventListener("keydown", handleKeyDown);
    };
  }, [inputRef, open, filtered, selectedIndex]);

  const handleSelect = useCallback(
    (suggestion: MentionSuggestion) => {
      const input = inputRef.current;
      if (!input) return;

      const cursorPos = input.selectionStart ?? 0;
      const textBefore = input.value.slice(0, cursorPos);
      const atIndex = textBefore.lastIndexOf("@");

      if (atIndex === -1) return;

      // Replace @mention text with the selected suggestion
      const before = input.value.slice(0, atIndex);
      const after = input.value.slice(cursorPos);
      const mentionTag = `@${suggestion.shortId} `;

      // We need to update the input value via a native setter to trigger React's onChange
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(input, before + mentionTag + after);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }

      // Move cursor after the mention
      const newPos = before.length + mentionTag.length;
      input.setSelectionRange(newPos, newPos);
      input.focus();

      setOpen(false);
      onSelect(suggestion);
    },
    [inputRef, onSelect],
  );

  if (!open || !position || filtered.length === 0) return null;

  return (
    <div
      ref={panelRef}
      className="fixed z-[9999] rounded-lg border border-white/15 overflow-hidden py-1"
      style={{
        bottom: position.bottom,
        left: position.left,
        minWidth: 200,
        maxWidth: 280,
        background: "rgba(10,10,10,0.85)",
        backdropFilter: "blur(20px) saturate(1.5)",
        WebkitBackdropFilter: "blur(20px) saturate(1.5)",
        boxShadow:
          "0 8px 32px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)",
      }}
    >
      {filtered.map((s, i) => (
        <button
          key={s.id}
          onClick={() => handleSelect(s)}
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors cursor-pointer ${
            i === selectedIndex
              ? "bg-white/10 text-white/90"
              : "text-white/60 hover:bg-white/5"
          }`}
        >
          {/* Type indicator */}
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              s.type === "orchestrator"
                ? "bg-amber-400"
                : "bg-violet-400"
            }`}
          />
          <span className="font-medium">{s.shortId}</span>
          <span className="text-white/30 truncate">{s.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Parse @mentions from message text and return their shortIds.
 * Matches patterns like @#Chrome-kobita or @orchestrator.
 */
export function parseMentions(text: string): string[] {
  const matches = text.match(/@(#[\w-]+|orchestrator)/g);
  return matches ? matches.map((m) => m.slice(1)) : [];
}

/**
 * Render mention tags in text content.
 * Replaces @#shortId with a styled span.
 */
export function renderMentions(
  text: string,
  resolve?: (shortId: string) => string | undefined,
): string {
  return text.replace(/@(#[\w-]+|orchestrator)/g, (match, id) => {
    const display = resolve ? resolve(id) ?? match : match;
    return `**${display}**`;
  });
}
