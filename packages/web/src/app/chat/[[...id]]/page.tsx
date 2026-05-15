"use client";

// Optional catch-all route — matches /chat (no id) and /chat/<uuid>.
// The actual Home component lives in _home.tsx (segment-private, "_" prefix
// keeps it out of the Next.js routing surface).
import Home from "./_home";

export default function ChatPage() {
  return <Home />;
}
