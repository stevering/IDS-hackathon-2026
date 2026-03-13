/**
 * Legacy orchestration utilities.
 *
 * The full useOrchestration hook has been removed — orchestration now runs
 * on Temporal (backend workflows + SSE). Only shared helpers remain.
 */

/** Match shortId with suffix support — LLM may abbreviate "#Figma-Desktop-zivihi" to "#zivihi" */
export function matchesShortId(fullShortId: string | undefined, abbreviated: string): boolean {
  if (!fullShortId) return false;
  if (fullShortId === abbreviated) return true;
  const full = fullShortId.replace(/^#/, "");
  const abbr = abbreviated.replace(/^#/, "");
  return full.endsWith(`-${abbr}`);
}

export type CollaboratorInfo = {
  clientId: string;
  shortId: string;
  label: string;
  status: "invited" | "active" | "completed" | "standby";
  conversationId?: string;
  task?: string;
};
