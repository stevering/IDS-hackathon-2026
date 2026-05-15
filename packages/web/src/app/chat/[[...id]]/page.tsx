"use client";

// Optional catch-all route — matches /chat (no id) and /chat/<uuid>.
// A single segment means /chat ↔ /chat/<uuid> transitions keep the React
// tree mounted, so the chat hooks don't reset state when the URL flips
// (which would otherwise yank the user back into the previous conv via
// the is_active flag reload).
export { default } from "../../page";
