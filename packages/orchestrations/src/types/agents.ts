/**
 * Agent state types used within the orchestration engine logic.
 */

import type { AgentId, AgentReportStatus, AgentChange } from "./signals.js";

// ---------------------------------------------------------------------------
// Agent runtime state (inside workflow)
// ---------------------------------------------------------------------------

export type AgentState = {
  /** Agent identity */
  agent: AgentId;
  /** Current status */
  status: "pending" | "active" | "completed" | "failed" | "interrupted";
  /** Whether the agent itself confirmed completion (via report, not just orchestrator marking) */
  confirmedByAgent: boolean;
  /** Temporal child workflow handle (opaque, set by the engine adapter) */
  workflowHandle?: unknown;
  /** Last report received */
  lastReport?: {
    status: AgentReportStatus;
    summary?: string;
    result?: Record<string, unknown>;
    screenshot?: string;
    changes?: AgentChange[];
    timestamp: string;
  };
};

// ---------------------------------------------------------------------------
// Sub-conversation state
// ---------------------------------------------------------------------------

export type SubConversationState = {
  id: string;
  initiatorId: string;
  participantIds: string[];
  topic: string;
  durationMs: number;
  startedAt: string;
};

// ---------------------------------------------------------------------------
// Orchestration params
// ---------------------------------------------------------------------------

export type StartOrchestrationParams = {
  /** User ID who initiated the orchestration */
  userId: string;
  /** Human-readable task description */
  task: string;
  /** Target agents to invite */
  targetAgents: AgentId[];
  /** AI model identifier (e.g. "moonshotai/kimi-k2.5") — from the user's UI selection */
  model?: string;
  /** Maximum duration in ms (default 600_000 = 10 min) */
  maxDurationMs?: number;
  /** Optional context data */
  context?: Record<string, unknown>;
};

export type OrchestrationResult = {
  status: "completed" | "cancelled" | "timed_out";
  agentResults: Record<string, {
    status: AgentReportStatus;
    summary?: string;
    changes?: AgentChange[];
  }>;
  /** Total wall-clock duration in ms */
  durationMs: number;
};

// ---------------------------------------------------------------------------
// LLM call types
// ---------------------------------------------------------------------------

export type LLMMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Optional base64-encoded images (PNG) to include in the message (multimodal) */
  images?: string[];
  toolCallId?: string;
  toolCalls?: LLMToolCall[];
};

export type LLMToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type LLMToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** Purpose of the LLM call — used by the interceptor to decide overrides. */
export type LLMCallPurpose = "agent" | "orchestrator" | "code_review" | "file_review";

/** Tracing context for delegate intercepts — tells the responder where the request comes from. */
export type LLMCallTracing = {
  /** "classic" (single conversation) or "orchestration" (multi-agent) */
  conversationType?: "classic" | "orchestration";
  conversationId?: string;
  orchestrationId?: string;
  /** Which agent is making the request (e.g. "#Figma-Desktop-vopope") */
  agentShortId?: string;
  /** Current directive the agent is working on */
  currentDirective?: string;
  /** Agent step count */
  stepCount?: number;
  /** Execution stats */
  execStats?: { success: number; fail: number };
  /** User setting: enable LLM call delegation (dev-only) */
  devLLMDelegation?: boolean;
};

export type LLMCallParams = {
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  /** Model identifier (e.g. "google/gemini-2.5-flash") */
  model?: string;
  /** User ID for BYOK resolution */
  userId: string;
  /** Max tokens for the response */
  maxTokens?: number;
  /** Call purpose — enables the interceptor to apply per-purpose logic */
  purpose?: LLMCallPurpose;
  /** Tracing context for delegate intercepts (dev-only) */
  tracing?: LLMCallTracing;
};

export type LLMCallResult = {
  content: string;
  /** Model reasoning/thinking (if supported, e.g. kimi-k2.5) */
  reasoning?: string;
  toolCalls?: LLMToolCall[];
  /** Token usage */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Set when the interceptor modified the call (e.g. changed model, auto-approved) */
  intercepted?: {
    action: string;
    reason: string;
    originalModel?: string;
  };
};

// ---------------------------------------------------------------------------
// Figma execution types
// ---------------------------------------------------------------------------

export type ExecuteCodeParams = {
  /** Target plugin client ID */
  pluginClientId: string;
  /** User ID (for Supabase channel) */
  userId: string;
  /** JavaScript code to execute in the plugin */
  code: string;
  /** Timeout in ms */
  timeoutMs?: number;
  /** Orchestrator workflow ID — forwarded to plugin for SSE stream */
  workflowId?: string;
};

export type ExecuteCodeResult = {
  success: boolean;
  result?: unknown;
  error?: string;
};

// ---------------------------------------------------------------------------
// Figma docs fetch types
// ---------------------------------------------------------------------------

export type FetchFigmaDocsParams = {
  /** Topic to look up (e.g. "FrameNode", "TextNode", "figma") */
  topic: string;
  /** Timeout in ms (default 15000) */
  timeoutMs?: number;
};

export type FetchFigmaDocsResult = {
  success: boolean;
  content?: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// Presence types
// ---------------------------------------------------------------------------

export type ConnectedClient = {
  clientId: string;
  shortId?: string;
  label?: string;
  fileName?: string;
  joinedAt: string;
};
