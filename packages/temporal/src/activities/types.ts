/**
 * Activity interface types.
 *
 * These define the contracts for Temporal activities that workflows
 * call via proxyActivities. Implementations are in separate files.
 */

import type {
  LLMCallParams,
  LLMCallResult,
  ExecuteCodeParams,
  ExecuteCodeResult,
} from "@guardian/orchestrations";

// ---------------------------------------------------------------------------
// LLM Activities
// ---------------------------------------------------------------------------

export interface LLMActivities {
  callLLM(params: LLMCallParams): Promise<LLMCallResult>;
}

// ---------------------------------------------------------------------------
// Figma Activities
// ---------------------------------------------------------------------------

export interface FigmaActivities {
  executeFigmaCode(params: ExecuteCodeParams): Promise<ExecuteCodeResult>;
}

// ---------------------------------------------------------------------------
// Presence Activities
// ---------------------------------------------------------------------------

export interface PresenceActivities {
  checkPresence(params: {
    userId: string;
    pluginClientId: string;
  }): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Persistence Activities
// ---------------------------------------------------------------------------

export interface PersistenceActivities {
  saveOrchestrationState(params: {
    orchestrationId: string;
    status: string;
    agentResults: Record<string, unknown>;
    durationMs: number;
    userId: string;
  }): Promise<void>;
}
