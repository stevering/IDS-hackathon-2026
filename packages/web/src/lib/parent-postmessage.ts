/**
 * Helpers to send postMessage to window.parent with a restricted targetOrigin.
 *
 * Why this exists:
 *   The webapp is loaded inside the Figma plugin's `ui.html` iframe at a parent
 *   origin we don't know at build time (sandboxed null-origin in some Figma
 *   versions, "https://www.figma.com" in others). Posting with `targetOrigin: "*"`
 *   means any malicious page that embeds the webapp could intercept auth state,
 *   relay codes, and EXECUTE_CODE payloads.
 *
 * Strategy:
 *   1. Record the parent's `event.origin` from the first inbound message we
 *      accept from `window.parent`.
 *   2. All subsequent outbound posts target that learned origin.
 *   3. Bootstrap messages sent before the parent has spoken still fall back to
 *      `"*"` — required because Figma's sandboxed null origin only matches `"*"`,
 *      and we have no other way to address it on first contact.
 */

let learnedParentOrigin: string | null = null;

/**
 * Record the parent's origin from an inbound MessageEvent. Call this once we
 * have validated the message is genuinely from `window.parent`.
 *
 * Sandboxed iframes report `event.origin === "null"` — we accept and store it
 * verbatim, since `postMessage(msg, "null")` is a valid (if narrow) target.
 */
export function recordParentOrigin(origin: string | undefined | null): void {
  if (typeof origin !== "string" || origin.length === 0) return;
  learnedParentOrigin = origin;
}

/**
 * Post a message to `window.parent` using the learned parent origin.
 *
 * Returns silently when there is no parent (top-level window) so callers can
 * use it unconditionally.
 */
export function postMessageToParent(message: unknown): void {
  if (typeof window === "undefined") return;
  if (window.parent === window) return;
  const targetOrigin = learnedParentOrigin ?? "*";
  try {
    window.parent.postMessage(message, targetOrigin);
  } catch {
    // Parent may have been closed or unreachable — non-fatal.
  }
}

/** Test-only: reset the cached origin between unit tests. */
export function __resetParentOriginForTests(): void {
  learnedParentOrigin = null;
}
