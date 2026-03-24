/**
 * Message metadata wrapper for multi-agent orchestrations.
 *
 * Wraps injected messages with structured metadata (XML tags or bracket prefix)
 * so the LLM can distinguish who sent each message and what kind of event it is.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The source/target of a message in the orchestration. */
export type MessageSource =
  | "guardian-engine"
  | "orchestrator"
  | "user"
  | `agent-${string}`;

/** Event type — reuses the existing orchestration event vocabulary. */
export type MessageEvent =
  | "orchestrator_directive"
  | "agent_report"
  | "guardian_feedback"
  | "orchestrator_broadcast"
  | "user_input"
  | "peer_message"
  | "orchestrator_brief";

/** Format for the metadata wrapper. */
export type MetadataFormat = "xml" | "bracket";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Build an agent MessageSource from a shortId, normalizing the # prefix. */
export function agentSource(shortId: string): `agent-${string}` {
  const normalized = shortId.startsWith("#") ? shortId : `#${shortId}`;
  return `agent-${normalized}`;
}

// ---------------------------------------------------------------------------
// Wrapper function
// ---------------------------------------------------------------------------

/**
 * Wrap a message with structured metadata identifying the source, target, and event type.
 *
 * @param content - The message text
 * @param from - Who sent the message
 * @param to - Who the message is for ("all" for broadcasts)
 * @param event - The event type (reuses orchestration event vocabulary)
 * @param format - "xml" (default) or "bracket" (fallback for models that struggle with XML)
 */
export function wrapMessage(
  content: string,
  from: MessageSource,
  to: MessageSource | "all",
  event: MessageEvent,
  format: MetadataFormat = "xml",
): string {
  if (format === "bracket") {
    return `[from: ${from} | to: ${to} | event: ${event}]\n${content}`;
  }

  return `<message from="${from}" to="${to}" event="${event}">\n${content}\n</message>`;
}
