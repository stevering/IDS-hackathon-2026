/**
 * Message routing logic for peer-to-peer and broadcast communication.
 */

import type { AgentId } from "../types/signals.js";

// ---------------------------------------------------------------------------
// Resolve target workflow IDs from agent directory
// ---------------------------------------------------------------------------

export function resolveTargetWorkflowId(
  directory: Map<string, AgentId>,
  targetShortId: string
): string | null {
  const agent = directory.get(targetShortId);
  return agent?.workflowId ?? null;
}

// ---------------------------------------------------------------------------
// Resolve all workflow IDs except excluded ones
// ---------------------------------------------------------------------------

export function resolveBroadcastTargets(
  directory: Map<string, AgentId>,
  excludeShortIds: string[]
): string[] {
  const excludeSet = new Set(excludeShortIds);
  const targets: string[] = [];

  for (const [shortId, agent] of directory) {
    if (!excludeSet.has(shortId) && agent.workflowId) {
      targets.push(agent.workflowId);
    }
  }

  return targets;
}

// ---------------------------------------------------------------------------
// Validate message routing
// ---------------------------------------------------------------------------

export function validatePeerTarget(
  directory: Map<string, AgentId>,
  targetShortId: string
): { valid: boolean; reason?: string } {
  const agent = directory.get(targetShortId);

  if (!agent) {
    return { valid: false, reason: `Agent #${targetShortId} not found in directory` };
  }

  if (!agent.workflowId) {
    return { valid: false, reason: `Agent #${targetShortId} has no workflow ID` };
  }

  return { valid: true };
}
