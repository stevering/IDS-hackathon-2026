"use client";

/**
 * ComposerAurora — wraps the chat composer with a rotating multicolor
 * "aurora" border and a pulsing blurred halo. Enabled only when the chat
 * workflow is actively generating (streaming or running a tool); otherwise
 * the wrapper is invisible and just adds a 2px padding ring to avoid any
 * layout shift when the state toggles.
 *
 * All animations live in globals.css (see ".composer-aurora" section).
 */

import type { ReactNode } from "react";

type ComposerAuroraProps = {
  /** When true, the rotating aurora border + pulse halo are visible. */
  active: boolean;
  children: ReactNode;
};

export function ComposerAurora({ active, children }: ComposerAuroraProps) {
  return (
    <div
      className={`composer-aurora ${active ? "composer-aurora-active" : ""}`.trim()}
    >
      {children}
    </div>
  );
}
