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

import type { LLMStreamingParams } from "./llm-streaming.js";

// ---------------------------------------------------------------------------
// LLM Activities
// ---------------------------------------------------------------------------

export interface LLMActivities {
  callLLM(params: LLMCallParams): Promise<LLMCallResult>;
}

export interface StreamingLLMActivities {
  callLLMStreaming(params: LLMStreamingParams): Promise<LLMCallResult>;
}

// ---------------------------------------------------------------------------
// Chat Persistence Activities
// ---------------------------------------------------------------------------

export interface ChatBroadcastActivities {
  broadcastChatEvent(params: {
    conversationId: string;
    event: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

export interface ChatPersistenceActivities {
  persistChatMessage(params: {
    conversationId: string;
    role: "user" | "assistant" | "system";
    content: string;
    parts?: unknown[];
    metadata?: Record<string, unknown>;
    userId: string;
  }): Promise<{ messageId: string }>;

  loadChatHistory(params: {
    conversationId: string;
    userId: string;
    limit?: number;
  }): Promise<Array<{ role: string; content: string; parts?: unknown[]; metadata?: Record<string, unknown> }>>;
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

// ---------------------------------------------------------------------------
// MCP V2 Activities (instance-based routing)
// ---------------------------------------------------------------------------

export type InstanceManifestEntry = {
  instanceId: string;
  label: string;
  presetType: string;
  category: string;
  scope: string;
  displayName: string | null;
  toolPrefix: string;
  toolCount: number;
  toolNames: string[];
  isFocus: boolean;
};

export interface MCPV2Activities {
  discoverMCPToolsV2(params: {
    userId: string;
    focusDesignInstanceId?: string;
    focusCodeInstanceId?: string;
  }): Promise<{
    focusTools: LLMToolDefinition[];
    instanceManifest: InstanceManifestEntry[];
  }>;

  executeMCPToolV2(params: {
    userId: string;
    instanceId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }): Promise<{ success: boolean; result?: unknown; error?: string }>;
}

export interface GuardianMetaActivities {
  executeGuardianMetaTool(params: {
    userId: string;
    manifest: InstanceManifestEntry[];
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<{ success: boolean; result?: unknown; error?: string }>;

  buildInstanceSystemPrompt(manifest: InstanceManifestEntry[]): string;
}
