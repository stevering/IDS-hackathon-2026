/**
 * Agent runtime abstraction.
 *
 * Encapsulates LLM calls so that the orchestration logic
 * doesn't depend on a specific AI SDK or provider.
 */

import type { LLMCallParams, LLMCallResult } from "../types/agents.js";

export interface IAgentRuntime {
  /** Call an LLM with messages and optional tool definitions */
  callLLM(params: LLMCallParams): Promise<LLMCallResult>;
}
