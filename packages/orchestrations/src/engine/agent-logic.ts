/**
 * Agent workflow logic — engine-agnostic.
 *
 * This module contains the pure business logic for an agent workflow.
 * It operates on state and produces effects that the engine adapter executes.
 */

import type {
  DirectivePayload,
  PeerMessagePayload,
  BroadcastPayload,
  SubConvInvitePayload,
  SubConvMessagePayload,
  SubConvClosePayload,
  SubConvResponsePayload,
  AgentDirectoryPayload,
  AgentReportPayload,
  AgentId,
  AgentActivity,
} from "../types/signals.js";
import type { LLMMessage, LLMToolCall, LLMToolDefinition, SubConversationState } from "../types/agents.js";
import { FIGMA_API_QUICK_REFERENCE } from "../logic/figma-api-reference.js";
import * as acorn from "acorn";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_STEPS = 20;

// ---------------------------------------------------------------------------
// Agent state
// ---------------------------------------------------------------------------

export type AgentWorkflowState = {
  /** Agent identity */
  agent: AgentId;
  /** Orchestrator's workflow ID */
  orchestratorWorkflowId: string;
  /** Agent directory (shortId → AgentId) */
  agentDirectory: Map<string, AgentId>;
  /** LLM conversation history */
  messageHistory: LLMMessage[];
  /** Queued directives from the orchestrator */
  directiveQueue: DirectivePayload[];
  /** Queued peer-to-peer messages */
  peerMessageQueue: PeerMessagePayload[];
  /** Queued broadcast messages */
  broadcastQueue: BroadcastPayload[];
  /** Queued sub-conversation messages */
  subConvMessageQueue: SubConvMessagePayload[];
  /** Active sub-conversation (max 1) */
  subConvActive: SubConversationState | null;
  /** Whether the plugin has disconnected */
  disconnected: boolean;
  /** Whether the agent has completed its task */
  completed: boolean;
  /** Step counter for LLM loop */
  stepCount: number;
  /** Execution success/failure tracking */
  execStats: { success: number; fail: number };
  /** Consecutive file review ISSUE count (for loop detection) */
  consecutiveFileReviewIssues?: number;
  /** Consecutive pipeline failures across all gates (linter, reviewer, exec, file review) */
  consecutivePipelineFailures?: number;
  /** Last 3 error signatures for deduplication (first 100 chars of each error) */
  lastErrorSignatures?: string[];
  /** Total code execution attempts (for budget awareness) */
  codeAttemptCount?: number;
  /** Original task description from the orchestrator directive */
  taskDescription?: string;
};

// ---------------------------------------------------------------------------
// Effects — actions the engine adapter must execute
// ---------------------------------------------------------------------------

export type AgentEffect =
  | { type: "call_llm"; messages: LLMMessage[]; tools: LLMToolDefinition[] }
  | { type: "review_and_execute_figma_code"; pluginClientId: string; userId: string; code: string; toolCallId: string }
  | { type: "fetch_figma_docs"; topic: string; toolCallId: string }
  | { type: "report_to_orchestrator"; report: AgentReportPayload }
  | { type: "send_peer_message"; targetWorkflowId: string; message: PeerMessagePayload }
  | { type: "send_broadcast"; broadcast: BroadcastPayload }
  | { type: "send_sub_conv_invite"; targetWorkflowIds: string[]; invite: SubConvInvitePayload }
  | { type: "send_sub_conv_response"; targetWorkflowId: string; response: SubConvResponsePayload }
  | { type: "send_sub_conv_message"; targetWorkflowIds: string[]; message: SubConvMessagePayload }
  | { type: "send_sub_conv_close"; targetWorkflowIds: string[]; close: SubConvClosePayload }
  | { type: "notify_orchestrator_sub_conv"; event: "opened" | "closed"; subConvId: string; participantIds: string[]; topic?: string; reason?: "completed" | "timeout" | "cancelled" }
  | { type: "emit_activity"; activities: AgentActivity[] }
  | { type: "wait_for_input" }
  | { type: "complete" };

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function createAgentState(agent: AgentId): AgentWorkflowState {
  return {
    agent,
    orchestratorWorkflowId: "",
    agentDirectory: new Map(),
    messageHistory: [],
    directiveQueue: [],
    peerMessageQueue: [],
    broadcastQueue: [],
    subConvMessageQueue: [],
    subConvActive: null,
    disconnected: false,
    completed: false,
    stepCount: 0,
    execStats: { success: 0, fail: 0 },
  };
}

// ---------------------------------------------------------------------------
// Signal handlers (mutate state)
// ---------------------------------------------------------------------------

export function handleDirective(state: AgentWorkflowState, directive: DirectivePayload): void {
  state.directiveQueue.push(directive);
}

export function handlePeerMessage(state: AgentWorkflowState, message: PeerMessagePayload): void {
  state.peerMessageQueue.push(message);
}

export function handleBroadcast(state: AgentWorkflowState, broadcast: BroadcastPayload): void {
  state.broadcastQueue.push(broadcast);
}

export function handleSubConvMessage(state: AgentWorkflowState, message: SubConvMessagePayload): void {
  state.subConvMessageQueue.push(message);
}

export function handleAgentDirectory(state: AgentWorkflowState, directory: AgentDirectoryPayload): void {
  state.agentDirectory = new Map(Object.entries(directory.agents));
  state.orchestratorWorkflowId = directory.orchestratorWorkflowId;
}

export function handlePluginDisconnected(state: AgentWorkflowState): void {
  state.disconnected = true;
}

// ---------------------------------------------------------------------------
// Handle sub-conversation invite
// ---------------------------------------------------------------------------

export function handleSubConvInvite(
  state: AgentWorkflowState,
  invite: SubConvInvitePayload
): AgentEffect | null {
  if (state.subConvActive !== null) {
    // Already in a sub-conversation, decline
    const initiator = state.agentDirectory.get(invite.initiatorId);
    if (initiator?.workflowId) {
      return {
        type: "send_sub_conv_response",
        targetWorkflowId: initiator.workflowId,
        response: {
          subConvId: invite.subConvId,
          agentId: state.agent.shortId,
          accepted: false,
        },
      };
    }
    return null;
  }

  // Accept the invitation
  state.subConvActive = {
    id: invite.subConvId,
    initiatorId: invite.initiatorId,
    participantIds: invite.participantIds,
    topic: invite.topic,
    durationMs: invite.durationMs,
    startedAt: new Date().toISOString(),
  };

  const initiator = state.agentDirectory.get(invite.initiatorId);
  if (initiator?.workflowId) {
    return {
      type: "send_sub_conv_response",
      targetWorkflowId: initiator.workflowId,
      response: {
        subConvId: invite.subConvId,
        agentId: state.agent.shortId,
        accepted: true,
      },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Handle sub-conversation close
// ---------------------------------------------------------------------------

export function handleSubConvClose(state: AgentWorkflowState, close: SubConvClosePayload): void {
  if (state.subConvActive?.id === close.subConvId) {
    state.subConvActive = null;
  }
}

// ---------------------------------------------------------------------------
// Process all queued inputs and generate LLM call
// ---------------------------------------------------------------------------

export function processQueues(state: AgentWorkflowState): AgentEffect[] {
  const effects: AgentEffect[] = [];
  let hasNewInput = false;

  // Process directives
  while (state.directiveQueue.length > 0) {
    const directive = state.directiveQueue.shift()!;
    state.messageHistory.push({
      role: "user",
      content: `[Orchestrator task] ${directive.content}${directive.expectedResult ? `\n\nExpected result: ${directive.expectedResult}` : ""}`,
    });
    hasNewInput = true;
  }

  // Process peer messages
  while (state.peerMessageQueue.length > 0) {
    const msg = state.peerMessageQueue.shift()!;
    state.messageHistory.push({
      role: "user",
      content: `[Message from #${msg.fromAgentId}] ${msg.content}`,
    });
    hasNewInput = true;
  }

  // Process broadcast messages
  while (state.broadcastQueue.length > 0) {
    const msg = state.broadcastQueue.shift()!;
    state.messageHistory.push({
      role: "user",
      content: `[Broadcast from #${msg.fromAgentId}] ${msg.content}`,
    });
    hasNewInput = true;
  }

  // Process sub-conversation messages
  while (state.subConvMessageQueue.length > 0) {
    const msg = state.subConvMessageQueue.shift()!;
    state.messageHistory.push({
      role: "user",
      content: `[Sub-conversation with #${msg.fromAgentId}] ${msg.content}`,
    });
    hasNewInput = true;
  }

  // Plugin disconnect
  if (state.disconnected && !state.completed) {
    state.completed = true;
    effects.push({
      type: "report_to_orchestrator",
      report: {
        agentShortId: state.agent.shortId,
        status: "interrupted",
        summary: "Plugin disconnected during execution.",
      },
    });
    effects.push({ type: "complete" });
    return effects;
  }

  if (!hasNewInput) {
    effects.push({ type: "wait_for_input" });
    return effects;
  }

  // Generate LLM call with agent tools
  effects.push({
    type: "call_llm",
    messages: [...state.messageHistory],
    tools: getAgentTools(state),
  });

  return effects;
}

// ---------------------------------------------------------------------------
// Process LLM response (may trigger tool calls)
// ---------------------------------------------------------------------------

export function processLLMResponse(
  state: AgentWorkflowState,
  content: string,
  toolCalls?: LLMToolCall[],
  reasoning?: string,
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
): AgentEffect[] {
  state.messageHistory.push({
    role: "assistant",
    content,
    toolCalls,
  });
  state.stepCount++;

  const effects: AgentEffect[] = [];
  const activities: AgentActivity[] = [];

  // Attach usage to the first activity that gets emitted (reasoning > thinking > first tool_call)
  let usageAttached = false;

  // Emit reasoning activity (model internal thinking, e.g. kimi-k2.5)
  if (reasoning?.trim()) {
    activities.push({ action: "reasoning", content: reasoning, usage });
    usageAttached = !!usage;
  }

  // Emit thinking activity if there's content
  if (content.trim()) {
    activities.push({ action: "thinking", content, usage: !usageAttached ? usage : undefined });
    if (!usageAttached && usage) usageAttached = true;
  }

  if (!toolCalls || toolCalls.length === 0) {
    // Detect LLMs that write tool calls as text instead of invoking them.
    // kimi-k2.5 commonly outputs '{ "tool": "signal_task_complete", ... }'
    // as plain text. Parse it and treat it as a real tool call.
    if (/signal_task_complete/i.test(content) && !state.completed) {
      let summary = "Task completed.";
      try {
        const parsed = JSON.parse(content);
        if (parsed.summary) summary = parsed.summary;
      } catch {
        const match = content.match(/["']summary["']\s*:\s*["']([^"']+)["']/);
        if (match) summary = match[1];
      }
      activities.push({ action: "tool_call", toolName: "signal_task_complete", summary: `(auto-detected from text) ${summary}` });
      if (activities.length > 0) {
        effects.push({ type: "emit_activity", activities });
      }
      state.completed = true;
      effects.push({
        type: "report_to_orchestrator",
        report: {
          agentShortId: state.agent.shortId,
          status: "completed",
          summary,
        },
      });
      effects.push({ type: "complete" });
      return effects;
    }

    // No tool calls — report in-progress and wait
    if (activities.length > 0) {
      effects.push({ type: "emit_activity", activities });
    }
    effects.push({
      type: "report_to_orchestrator",
      report: {
        agentShortId: state.agent.shortId,
        status: "in_progress",
        summary: content,
      },
    });
    effects.push({ type: "wait_for_input" });
    return effects;
  }

  for (const tc of toolCalls) {
    const { effects: toolEffects, activities: toolActivities } = processToolCall(state, tc);
    effects.push(...toolEffects);
    // Attach usage to first tool_call activity if not yet attached to reasoning/thinking
    if (!usageAttached && usage) {
      const firstToolCall = toolActivities.find(a => a.action === "tool_call");
      if (firstToolCall && firstToolCall.action === "tool_call") {
        firstToolCall.usage = usage;
        usageAttached = true;
      }
    }
    activities.push(...toolActivities);
  }

  // Emit all collected activities as a single batch
  if (activities.length > 0) {
    effects.push({ type: "emit_activity", activities });
  }

  // If not completed and under step limit, continue LLM loop
  if (!state.completed && state.stepCount < MAX_STEPS) {
    effects.push({
      type: "call_llm",
      messages: [...state.messageHistory],
      tools: getAgentTools(state),
    });
  } else if (state.stepCount >= MAX_STEPS && !state.completed) {
    state.completed = true;
    effects.push({
      type: "report_to_orchestrator",
      report: {
        agentShortId: state.agent.shortId,
        status: "failed",
        summary: `Agent could not complete the task within ${MAX_STEPS} steps. It may have been stuck retrying a failing operation.`,
      },
    });
    effects.push({ type: "complete" });
  }

  return effects;
}

// ---------------------------------------------------------------------------
// Inject tool result into history
// ---------------------------------------------------------------------------

export function injectToolResult(
  state: AgentWorkflowState,
  toolCallId: string,
  result: string,
  images?: string[]
): void {
  state.messageHistory.push({
    role: "tool",
    content: result,
    toolCallId,
    images,
  });
}

// ---------------------------------------------------------------------------
// Execution stats tracking
// ---------------------------------------------------------------------------

export function recordExecResult(state: AgentWorkflowState, success: boolean): void {
  if (success) {
    state.execStats.success++;
  } else {
    state.execStats.fail++;
  }
}

// ---------------------------------------------------------------------------
// Pre-execution code review (Figma API linter)
// ---------------------------------------------------------------------------

/** Globals available in the Figma Plugin sandbox. */
const FIGMA_GLOBALS = new Set([
  "figma", "console", "Math", "JSON", "Date", "Array", "Object",
  "String", "Number", "Boolean", "Promise", "parseInt", "parseFloat",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "Infinity", "NaN", "Error", "RegExp", "Map", "Set", "undefined",
  "Symbol", "BigInt", "Proxy", "Reflect", "globalThis",
  "__html__", "__uiFiles__",
]);

// ---- Minimal AST walker (no external dependency) ----

type AnyNode = acorn.Node & { [key: string]: unknown };

/**
 * Walk an acorn AST, tracking lexical scopes, and return identifiers that are
 * used as the *object* of a MemberExpression (foo.bar) but never declared in
 * any enclosing scope and are not known globals.
 */
export function findUndeclaredMemberAccess(ast: acorn.Node): Set<string> {
  const undeclared = new Set<string>();

  // Scope chain: each entry is a Set of names declared in that scope.
  const scopes: Set<string>[] = [new Set()];

  const pushScope = () => scopes.push(new Set<string>());
  const popScope = () => scopes.pop();
  const declare = (name: string) => scopes[scopes.length - 1].add(name);
  const isDeclared = (name: string): boolean => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].has(name)) return true;
    }
    return FIGMA_GLOBALS.has(name);
  };

  function collectPatternNames(node: AnyNode): string[] {
    if (!node) return [];
    switch (node.type) {
      case "Identifier":
        return [node.name as string];
      case "ObjectPattern":
        return (node.properties as AnyNode[]).flatMap((p) =>
          collectPatternNames((p.value ?? p.argument) as AnyNode)
        );
      case "ArrayPattern":
        return (node.elements as (AnyNode | null)[]).flatMap((e) =>
          e ? collectPatternNames(e) : []
        );
      case "RestElement":
        return collectPatternNames(node.argument as AnyNode);
      case "AssignmentPattern":
        return collectPatternNames(node.left as AnyNode);
      default:
        return [];
    }
  }

  function declareParams(params: AnyNode[]) {
    for (const p of params) {
      for (const name of collectPatternNames(p)) declare(name);
    }
  }

  function walk(node: AnyNode) {
    if (!node || typeof node !== "object" || !node.type) return;

    // --- scope-creating nodes ---

    if (node.type === "FunctionDeclaration") {
      if (node.id) declare((node.id as AnyNode).name as string);
      pushScope();
      declareParams(node.params as AnyNode[]);
      walk(node.body as AnyNode);
      popScope();
      return;
    }

    if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      pushScope();
      if (node.type === "FunctionExpression" && node.id) {
        declare((node.id as AnyNode).name as string);
      }
      declareParams(node.params as AnyNode[]);
      walk(node.body as AnyNode);
      popScope();
      return;
    }

    if (node.type === "BlockStatement" || node.type === "ForStatement" ||
        node.type === "ForInStatement" || node.type === "ForOfStatement") {
      pushScope();
      walkChildren(node);
      popScope();
      return;
    }

    if (node.type === "CatchClause") {
      pushScope();
      if (node.param) {
        for (const name of collectPatternNames(node.param as AnyNode)) declare(name);
      }
      walk(node.body as AnyNode);
      popScope();
      return;
    }

    // --- declarations ---

    if (node.type === "VariableDeclaration") {
      for (const decl of node.declarations as AnyNode[]) {
        // Walk init first (it's in the outer scope for let/const, but fine for our check)
        if (decl.init) walk(decl.init as AnyNode);
        for (const name of collectPatternNames(decl.id as AnyNode)) declare(name);
      }
      return;
    }

    // --- member access check ---

    if (node.type === "MemberExpression" && !node.computed) {
      const obj = node.object as AnyNode;
      if (obj.type === "Identifier") {
        const name = obj.name as string;
        if (!isDeclared(name)) undeclared.add(name);
      }
      // Still walk the object (could be chained) and property is just a name
      walk(obj);
      return;
    }

    // --- default: recurse children ---
    walkChildren(node);
  }

  function walkChildren(node: AnyNode) {
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc" ||
          key === "range" || key === "sourceType") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === "object" && (item as AnyNode).type) {
            walk(item as AnyNode);
          }
        }
      } else if (child && typeof child === "object" && (child as AnyNode).type) {
        walk(child as AnyNode);
      }
    }
  }

  walk(ast as AnyNode);
  return undeclared;
}

/**
 * Validates generated Figma Plugin API code BEFORE execution.
 * Returns an array of issues. Empty = code is OK to execute.
 *
 * This is a structural gate — it catches known LLM mistakes early so
 * the agent doesn't waste steps on code that will always fail.
 */
/** Maximum lines per figma_plugin_execute call. Enforced by the linter. */
export const MAX_CODE_LINES = 150;

/** Known-invalid Figma properties that LLMs commonly hallucinate, with the correct alternative. */
export const INVALID_PROPERTY_FIXES: Record<string, string> = {
  counterAxisFixedSize: 'Set counterAxisSizingMode = "FIXED" then use .resize(width, height)',
  mainAxisFixedSize: 'Set primaryAxisSizingMode = "FIXED" then use .resize(width, height)',
  backgroundColor: 'Use .fills = [{ type: "SOLID", color: { r, g, b } }] instead',
  paddingAll: "Use .paddingTop, .paddingRight, .paddingBottom, .paddingLeft individually",
  horizontalPadding: "Use .paddingLeft and .paddingRight individually",
  verticalPadding: "Use .paddingTop and .paddingBottom individually",
  gap: "Use .itemSpacing for auto-layout gap",
  flexGrow: "Use .layoutGrow instead",
  flexDirection: 'Use .layoutMode = "VERTICAL" or "HORIZONTAL"',
  alignItems: "Use .primaryAxisAlignItems or .counterAxisAlignItems",
  justifyContent: "Use .primaryAxisAlignItems",
  backgrounds: "Use .fills instead (FrameNode has no .backgrounds property)",
};

export function reviewFigmaCode(code: string): string[] {
  const issues: string[] = [];

  // Rule 0a: Code length enforcement — prevent monolithic code blocks
  {
    const lineCount = code.split("\n").length;
    if (lineCount > MAX_CODE_LINES) {
      issues.push(
        `Code is ${lineCount} lines (max ${MAX_CODE_LINES}). ` +
        `Break this into multiple smaller figma_plugin_execute calls. ` +
        `Create the container first, then populate sections in separate calls ` +
        `using await figma.getNodeByIdAsync("node-id") to reference previously created nodes.`
      );
    }
  }

  // Rule 0b: Known-invalid Figma properties blacklist
  for (const [prop, fix] of Object.entries(INVALID_PROPERTY_FIXES)) {
    const regex = new RegExp(`\\.${prop}\\s*=`, "g");
    if (regex.test(code)) {
      issues.push(`.${prop} is NOT a valid Figma property. ${fix}.`);
    }
  }

  // Rule 1: 'a' (alpha) in color objects — Figma SOLID fills/strokes use { r, g, b }, not { r, g, b, a }.
  // BUT effects (DROP_SHADOW, INNER_SHADOW) and gradientStops DO use { r, g, b, a }.
  // Strategy: find all color: { ... a: } patterns, then walk backwards to find the enclosing
  // paint/effect object's `type:` field. Only flag if type is 'SOLID'.
  {
    const colorAlphaPattern = /color\s*:\s*\{[^}]*\ba\s*:/gi;
    let match;
    let hasIllegalAlpha = false;
    while ((match = colorAlphaPattern.exec(code)) !== null) {
      // Walk backwards from match to find the enclosing object's `type:` value.
      // We look for the nearest `type: '...'` or `type: "..."` before this color.
      const before = code.slice(Math.max(0, match.index - 500), match.index);
      // Find the LAST type: '...' before this color (nearest enclosing object)
      const typeMatches = [...before.matchAll(/type\s*:\s*['"](\w+)['"]/gi)];
      if (typeMatches.length > 0) {
        const nearestType = typeMatches[typeMatches.length - 1][1];
        // SOLID fills/strokes must NOT have alpha. Everything else (effects, gradients) is OK.
        if (nearestType === "SOLID") {
          hasIllegalAlpha = true;
          break;
        }
      }
      // If no type found (e.g. standalone color object), flag it conservatively
      // but only if it's clearly in a fills/strokes context
      else if (/\.(fills|strokes)\s*=/.test(before.slice(-100))) {
        hasIllegalAlpha = true;
        break;
      }
    }
    if (hasIllegalAlpha) {
      issues.push(
        'Color objects in SOLID fills/strokes must use { r, g, b } — NOT { r, g, b, a }. ' +
        'Remove the "a" key. Use paint-level "opacity" instead if needed. ' +
        'Note: effects (DROP_SHADOW, INNER_SHADOW) and gradientStops DO use { r, g, b, a } — that is correct.'
      );
    }
  }

  // Rule 2: figma.closePlugin() — kills the bridge
  if (/figma\s*\.\s*closePlugin\s*\(/.test(code)) {
    issues.push(
      'figma.closePlugin() is forbidden — it kills the plugin bridge. Remove this call.'
    );
  }

  // Rule 3: figma.currentPage = ... (sync setter removed in newer API)
  if (/figma\s*\.\s*currentPage\s*=\s*/.test(code)) {
    issues.push(
      'figma.currentPage = ... is not allowed with dynamic-page access. ' +
      'Use await figma.setCurrentPageAsync(page) instead.'
    );
  }

  // Rule 4: .children = [...] (read-only property)
  if (/\.children\s*=\s*\[/.test(code)) {
    issues.push(
      'node.children is read-only. You cannot assign to it. ' +
      'Use node.appendChild(child) or node.insertChild(index, child) instead.'
    );
  }

  // Rule 5: parse JS with acorn — catches syntax errors AND undeclared variables.
  // Each figma_plugin_execute runs in a fresh scope — variables don't persist.
  {
    // Wrap in async function to allow top-level await
    const wrapped = `(async () => {\n${code}\n})()`;
    let ast: acorn.Node | null = null;
    try {
      ast = acorn.parse(wrapped, {
        ecmaVersion: "latest",
        sourceType: "script",
      } as acorn.Options);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      issues.push(`Syntax error: ${msg}. Send valid JavaScript (not TypeScript).`);
    }

    // If parsing succeeded, walk the AST for scope-aware undeclared variable detection
    if (ast) {
      const undeclared = findUndeclaredMemberAccess(ast);
      if (undeclared.size > 0) {
        issues.push(
          `Undeclared variable(s): ${Array.from(undeclared).join(", ")}. ` +
          "Each figma_plugin_execute call runs in a FRESH JavaScript scope — " +
          "variables from previous calls do NOT persist. Send complete, self-contained code that declares all variables."
        );
      }
    }
  }

  // Rule 6: figma.currentPage.width/height (pages have no dimensions)
  if (/figma\s*\.\s*currentPage\s*\.\s*(?:width|height)\b/.test(code) ||
      /\bpage\s*\.\s*(?:width|height)\b/.test(code)) {
    issues.push(
      "Figma pages do not have width/height (they are infinite canvases). " +
      "Use figma.viewport.center for positioning, or hardcode coordinates."
    );
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Process individual tool call
// ---------------------------------------------------------------------------

function processToolCall(
  state: AgentWorkflowState,
  tc: LLMToolCall
): { effects: AgentEffect[]; activities: AgentActivity[] } {
  const effects: AgentEffect[] = [];
  const activities: AgentActivity[] = [];

  switch (tc.name) {
    case "signal_task_complete": {
      const args = tc.arguments as { summary?: string };

      // Guard: block completion if more failures than successes
      if (state.execStats.fail > 0 && state.execStats.fail > state.execStats.success) {
        const warning =
          `WARNING: You have ${state.execStats.fail} failed executions vs ${state.execStats.success} successful. ` +
          `Are you sure the task is complete? Verify your work before signaling completion.`;
        activities.push({ action: "tool_call", toolName: tc.name, summary: args.summary ?? "Task completed." });
        activities.push({
          action: "guardian_message",
          recipient: `agent ${state.agent.shortId}`,
          message: warning,
        });
        injectToolResult(state, tc.id, JSON.stringify({
          success: false,
          error: warning,
        }));
        break;
      }

      state.completed = true;
      activities.push({ action: "tool_call", toolName: tc.name, summary: args.summary ?? "Task completed." });
      effects.push({
        type: "report_to_orchestrator",
        report: {
          agentShortId: state.agent.shortId,
          status: "completed",
          summary: args.summary ?? "Task completed.",
        },
      });
      effects.push({ type: "complete" });
      break;
    }

    case "send_peer_message": {
      const args = tc.arguments as { targetAgentId: string; content: string };
      activities.push({ action: "tool_call", toolName: tc.name, summary: `→ ${args.targetAgentId}: ${args.content}` });
      const target = state.agentDirectory.get(args.targetAgentId);
      if (target?.workflowId) {
        effects.push({
          type: "send_peer_message",
          targetWorkflowId: target.workflowId,
          message: {
            fromAgentId: state.agent.shortId,
            content: args.content,
          },
        });
      }
      break;
    }

    case "broadcast_message": {
      const args = tc.arguments as { content: string };
      activities.push({ action: "tool_call", toolName: tc.name, summary: args.content });
      effects.push({
        type: "send_broadcast",
        broadcast: {
          fromAgentId: state.agent.shortId,
          content: args.content,
        },
      });
      break;
    }

    case "start_sub_conversation": {
      const args = tc.arguments as { participantIds: string[]; topic: string; durationMs?: number };
      activities.push({ action: "tool_call", toolName: tc.name, summary: `topic: ${args.topic}` });
      if (state.subConvActive === null) {
        const subConvId = `subconv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const durationMs = args.durationMs ?? 120_000;

        state.subConvActive = {
          id: subConvId,
          initiatorId: state.agent.shortId,
          participantIds: args.participantIds,
          topic: args.topic,
          durationMs,
          startedAt: new Date().toISOString(),
        };

        const targetWorkflowIds = args.participantIds
          .map((id) => state.agentDirectory.get(id)?.workflowId)
          .filter((wid): wid is string => !!wid);

        effects.push({
          type: "send_sub_conv_invite",
          targetWorkflowIds,
          invite: {
            subConvId,
            initiatorId: state.agent.shortId,
            participantIds: args.participantIds,
            topic: args.topic,
            durationMs,
          },
        });

        effects.push({
          type: "notify_orchestrator_sub_conv",
          event: "opened",
          subConvId,
          participantIds: [state.agent.shortId, ...args.participantIds],
          topic: args.topic,
        });
      }
      break;
    }

    case "close_sub_conversation": {
      activities.push({ action: "tool_call", toolName: tc.name, summary: "Closing sub-conversation" });
      if (state.subConvActive) {
        const subConv = state.subConvActive;
        state.subConvActive = null;

        const targetWorkflowIds = subConv.participantIds
          .map((id) => state.agentDirectory.get(id)?.workflowId)
          .filter((wid): wid is string => !!wid);

        effects.push({
          type: "send_sub_conv_close",
          targetWorkflowIds,
          close: {
            subConvId: subConv.id,
            reason: "completed",
          },
        });

        effects.push({
          type: "notify_orchestrator_sub_conv",
          event: "closed",
          subConvId: subConv.id,
          participantIds: [state.agent.shortId, ...subConv.participantIds],
          reason: "completed",
        });
      }
      break;
    }

    case "figma_plugin_execute": {
      const args = tc.arguments as { code: string };
      activities.push({ action: "tool_call", toolName: tc.name, summary: args.code });

      // Phase 1: programmatic linter — instant, free
      const codeIssues = reviewFigmaCode(args.code);
      if (codeIssues.length > 0) {
        const issueList = codeIssues.map((issue, i) => `${i + 1}. ${issue}`).join("\n");
        const linterFeedback = `Code review rejected (${codeIssues.length} issue${codeIssues.length > 1 ? "s" : ""}):\n${issueList}\n\nFix these issues and retry with corrected code.\n---\n${JSON.stringify({ success: false, codeReview: codeIssues })}`;
        activities.push({ action: "code_review_rejected", issues: codeIssues, feedback: linterFeedback });
        activities.push({
          action: "guardian_message",
          recipient: `agent ${state.agent.shortId}`,
          message: linterFeedback,
        });
        injectToolResult(state, tc.id, linterFeedback);
        break;
      }

      // Phase 2: linter passed — push effect for LLM review + execution
      // The tool result is NOT injected here — the workflow adapter handles it
      // after performing the review LLM call and optional execution.
      activities.push({ action: "code_review_passed", codeSnippet: args.code });
      effects.push({
        type: "review_and_execute_figma_code",
        pluginClientId: state.agent.pluginClientId ?? "",
        userId: "",
        code: args.code,
        toolCallId: tc.id,
      });
      break;
    }

    case "lookup_figma_docs": {
      const args = tc.arguments as { topic?: string; mode?: string };
      const mode = args.mode ?? "quick";
      const topic = args.topic ?? "all";
      activities.push({ action: "tool_call", toolName: tc.name, summary: `${mode}: ${topic}` });

      if (mode === "quick") {
        // Immediate — no effect needed, inject static reference directly
        injectToolResult(state, tc.id, FIGMA_API_QUICK_REFERENCE);
      } else {
        // Delegate to Temporal activity for live fetch
        effects.push({ type: "fetch_figma_docs", topic, toolCallId: tc.id });
      }
      break;
    }
  }

  return { effects, activities };
}

// ---------------------------------------------------------------------------
// Agent tool definitions
// ---------------------------------------------------------------------------

function getAgentTools(state: AgentWorkflowState): LLMToolDefinition[] {
  const tools: LLMToolDefinition[] = [
    {
      name: "signal_task_complete",
      description: "Signal that you have completed your assigned task. Call this when your work is done.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Summary of the work completed" },
        },
      },
    },
    {
      name: "send_peer_message",
      description: "Send a message to a specific agent in the orchestration.",
      parameters: {
        type: "object",
        properties: {
          targetAgentId: { type: "string", description: "Short ID of the target agent (e.g. '#figma-1')" },
          content: { type: "string", description: "Message content" },
        },
        required: ["targetAgentId", "content"],
      },
    },
    {
      name: "broadcast_message",
      description: "Send a message to all agents in the orchestration.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Message content" },
        },
        required: ["content"],
      },
    },
    {
      name: "start_sub_conversation",
      description: "Start a scoped sub-conversation with one or more agents. You can only have one active sub-conversation at a time.",
      parameters: {
        type: "object",
        properties: {
          participantIds: {
            type: "array",
            items: { type: "string" },
            description: "Short IDs of agents to invite",
          },
          topic: { type: "string", description: "Topic of the sub-conversation" },
          durationMs: { type: "number", description: "Duration in milliseconds (default: 120000)" },
        },
        required: ["participantIds", "topic"],
      },
    },
  ];

  // Only add close_sub_conversation if one is active
  if (state.subConvActive) {
    tools.push({
      name: "close_sub_conversation",
      description: "Close the active sub-conversation.",
      parameters: {
        type: "object",
        properties: {},
      },
    });
  }

  // Add figma tool if agent has a plugin client — always static
  if (state.agent.pluginClientId) {
    tools.push({
      name: "figma_plugin_execute",
      description:
        "Execute JavaScript code in the Figma plugin. " +
        "CRITICAL: Each call runs in a FRESH scope — variables do NOT persist between calls. " +
        "Every call must be fully self-contained (declare all variables). " +
        "Create parent containers AND their children in the SAME call — do not split across calls. " +
        "Code can be up to ~100 lines if needed — prioritize completeness over brevity. " +
        "After execution you receive: success/error + canvas diff + before/after screenshots + expert review. " +
        "Fills/strokes use { r, g, b } — NO 'a' (alpha) key in color objects. " +
        "Pages have no width/height — use figma.viewport.center for positioning.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript code to execute in the Figma Plugin API" },
        },
        required: ["code"],
      },
    });

    tools.push({
      name: "lookup_figma_docs",
      description:
        "Look up Figma Plugin API documentation. " +
        "Use mode 'quick' for a condensed reference of common APIs (instant), " +
        "or 'full' to fetch complete documentation for a specific node type from the official Figma docs (slower, uses network).",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "API topic: 'all' for quick overview, or a node type like 'FrameNode', 'TextNode', 'EllipseNode', 'figma' (global object), etc.",
          },
          mode: {
            type: "string",
            enum: ["quick", "full"],
            description: "quick = static condensed ref (~4KB, instant). full = fetch complete docs from developers.figma.com (slower). Default: quick.",
          },
        },
        required: ["topic"],
      },
    });
  }

  return tools;
}
