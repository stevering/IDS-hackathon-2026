/**
 * Engine-agnostic orchestration interface.
 *
 * This abstraction allows swapping Temporal for another engine
 * (e.g. Inngest, Hatchet) without touching the business logic.
 */

import type { StartOrchestrationParams, OrchestrationResult } from "../types/agents.js";
import type { OrchestrationStatusResponse } from "../types/events.js";

// ---------------------------------------------------------------------------
// Orchestration handle (returned after starting a workflow)
// ---------------------------------------------------------------------------

export interface OrchestrationHandle {
  /** Workflow ID */
  readonly workflowId: string;

  /** Send a named signal with a payload to this workflow */
  signal<T>(name: string, payload: T): Promise<void>;

  /** Query the workflow for its current state */
  query<T>(name: string): Promise<T>;

  /** Cancel the workflow */
  cancel(): Promise<void>;

  /** Wait for the workflow to complete and return the result */
  result(): Promise<OrchestrationResult>;
}

// ---------------------------------------------------------------------------
// Orchestration engine interface
// ---------------------------------------------------------------------------

export interface IOrchestrationEngine {
  /** Start a new orchestration workflow */
  startOrchestration(params: StartOrchestrationParams): Promise<OrchestrationHandle>;

  /** Get a handle to an existing orchestration by workflow ID */
  getOrchestration(workflowId: string): OrchestrationHandle;

  /** List active orchestrations for a user */
  listActiveOrchestrations(userId: string): Promise<OrchestrationSummary[]>;
}

// ---------------------------------------------------------------------------
// Summary type for listing
// ---------------------------------------------------------------------------

export type OrchestrationSummary = {
  workflowId: string;
  userId: string;
  task: string;
  status: OrchestrationStatusResponse["status"];
  agentCount: number;
  startedAt: string;
  timerRemainingMs: number | null;
};
