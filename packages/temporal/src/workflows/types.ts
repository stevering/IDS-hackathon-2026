/**
 * Workflow input types.
 *
 * Kept separate from the workflow implementations so that
 * Next.js / API routes can import them without pulling in
 * `@temporalio/workflow` (which only works inside the Temporal sandbox).
 */

import type { AgentId } from "@guardian/orchestrations";

export type AgentWorkflowInput = {
  agent: AgentId;
  task: string;
  context?: Record<string, unknown>;
  userId: string;
};
