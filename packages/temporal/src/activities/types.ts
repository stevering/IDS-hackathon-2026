/**
 * Activity interface types.
 *
 * These define the contracts for Temporal activities that workflows
 * call via proxyActivities. Implementations are in separate files.
 */

import type {
  LLMCallParams,
  LLMCallResult,
  LLMToolDefinition,
  ExecuteCodeParams,
  ExecuteCodeResult,
  FetchFigmaDocsParams,
  FetchFigmaDocsResult,
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

  persistDurableEvents(params: {
    workflowId: string;
    events: Array<Record<string, unknown>>;
    userId: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Docs Activities
// ---------------------------------------------------------------------------

export interface DocsActivities {
  fetchFigmaDocs(params: FetchFigmaDocsParams): Promise<FetchFigmaDocsResult>;
}

// ---------------------------------------------------------------------------
// MCP Activities
// ---------------------------------------------------------------------------

export interface MCPActivities {
  discoverMCPTools(params: {
    userId: string;
    mcpServerIds: string[];
    agentId?: string;
    pluginClientId?: string;
  }): Promise<LLMToolDefinition[]>;

  executeMCPTool(params: {
    userId: string;
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    agentId?: string;
  }): Promise<{ success: boolean; result?: unknown; error?: string }>;

  pairFCCloudRelay(params: {
    userId: string;
    pluginClientId?: string;
  }): Promise<{ success: boolean; code?: string; error?: string }>;

  closeStdioPool(params: {
    agentId?: string;
  }): Promise<void>;
}
