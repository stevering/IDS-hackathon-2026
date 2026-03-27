/**
 * Agent Temporal workflow.
 *
 * Thin adapter that wraps the engine-agnostic agent logic
 * with Temporal-specific APIs.
 */

import {
  condition,
  getExternalWorkflowHandle,
  proxyActivities,
  setHandler,
  CancellationScope,
} from "@temporalio/workflow";

import {
  createAgentState,
  handleDirective,
  handlePeerMessage,
  handleBroadcast,
  handleSubConvMessage,
  handleAgentDirectory,
  handlePluginDisconnected,
  handleTerminate,
  handleSubConvInvite,
  handleSubConvClose,
  processQueues,
  processLLMResponse,
  injectToolResult,
  recordExecResult,
  type AgentWorkflowState,
  type AgentEffect,
  buildAgentSystemPrompt,
  FIGMA_API_QUICK_REFERENCE,
  FIGMA_API_EXECUTE_SUPPLEMENT,
} from "@guardian/orchestrations";

import type { AgentId, LLMMessage, LLMToolDefinition } from "@guardian/orchestrations";
import type { AgentWorkflowInput } from "./types.js";

import {
  directiveSignal,
  peerMessageSignal,
  agentBroadcastSignal,
  subConvInviteSignal,
  subConvMessageSignal,
  subConvCloseSignal,
  subConvResponseSignal,
  agentDirectorySignal,
  pluginDisconnectedSignal,
  terminateAgentSignal,
  agentReportSignal,
  subConvNotifySignal,
  guardrailBlockedSignal,
  agentActivitySignal,
} from "../signals/definitions.js";

import type { LLMActivities, FigmaActivities, DocsActivities, MCPActivities } from "../activities/types.js";

// Proxy activities — normal timeouts
const normalLLM = proxyActivities<LLMActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});
// Proxy activities — slow delegation mode (extended timeouts for interactive use)
const slowLLM = proxyActivities<LLMActivities>({
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 1 },
});

const { executeFigmaCode } = proxyActivities<FigmaActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 2 },
});

const { fetchFigmaDocs } = proxyActivities<DocsActivities>({
  startToCloseTimeout: "20 seconds",
  retry: { maximumAttempts: 2 },
});

const mcpActivities = proxyActivities<MCPActivities>({
  startToCloseTimeout: "60 seconds",
  retry: { maximumAttempts: 2 },
});

// ---------------------------------------------------------------------------
// Guardrail: notify orchestrator when plugin code is blocked
// ---------------------------------------------------------------------------

async function notifyGuardrailIfBlocked(
  execResult: { success: boolean; error?: string },
  state: AgentWorkflowState
): Promise<void> {
  if (execResult.success) return;
  if (!execResult.error?.startsWith("BLOCKED:")) return;
  try {
    const handle = getExternalWorkflowHandle(state.orchestratorWorkflowId);
    await handle.signal(guardrailBlockedSignal, {
      agentShortId: state.agent.shortId,
      blockedAction: execResult.error.replace(/^BLOCKED:\s*/, "").split(" is ")[0],
      reason: execResult.error,
    });
  } catch {
    // Orchestrator may have already completed
  }
}

// ---------------------------------------------------------------------------
// LLM code review (automatic, forced by the system)
// ---------------------------------------------------------------------------

const REVIEW_SYSTEM_PROMPT = `You are a Figma Plugin API code reviewer. Review the code for correctness before it runs.

CRITICAL CONTEXT: Each code execution runs in a **completely fresh JavaScript scope**. Variables from previous executions do NOT exist. The code MUST be self-contained — it must declare every variable it uses.

Check for:
1. **Self-contained code**: Every variable used must be declared (const/let/var) in THIS snippet. If the code references a variable like "ellipse" or "canvas" without declaring it, REJECT it.
2. Correct Figma Plugin API usage — use the API reference below to verify methods, properties, and async patterns
3. Color rules:
   - fills/strokes: use { r, g, b } — NO 'a' key. For opacity use paint-level "opacity" property.
   - effects (DROP_SHADOW, INNER_SHADOW): color MUST use { r, g, b, a } — the 'a' key IS required here.
   - gradientStops: color MUST use { r, g, b, a } — the 'a' key IS required here.
4. No figma.closePlugin() — it kills the bridge
5. No assignment to read-only properties (.children)
6. Must call await figma.loadFontAsync() before setting .characters or .fontName
7. No TypeScript syntax (no "as Type" casts — this runs as plain JavaScript)
8. FrameNode has no .backgroundColor — use .fills instead
9. GroupNode has no .layoutMode — use figma.createFrame() for auto-layout
10. figma.currentPage has NO .width or .height — pages are infinite canvases. Use figma.viewport.center or hardcoded coordinates.
11. Code must execute immediately — do NOT just define an async function without calling it. Either use top-level statements or call the function at the end.

IMPORTANT — Do NOT reject code for these NON-issues (these are valid patterns):
- Font loading at the top: calling loadFontAsync() once at the start of the code for all needed fonts is valid. It does NOT need to be immediately before each .characters or .fontName assignment.
- Frame resize with auto-layout: Frames using layoutMode with primaryAxisSizingMode="AUTO" do NOT need explicit resize(). Auto-layout handles sizing.
- DROP_SHADOW offset format: The correct format IS \`offset: { x: number, y: number }\`, NOT a single number.
- Null checks on getNodeByIdAsync: These are nice-to-have but NOT required. Missing null checks should NOT cause rejection.
- Positioning in auto-layout: Children of auto-layout frames do NOT need .x/.y positioning — the layout engine handles it.
- strokeAlign default: The default "CENTER" is fine if not specified. Missing strokeAlign should NOT cause rejection.

Only reject for ACTUAL errors that WILL cause runtime failures. When in doubt, APPROVE.

${FIGMA_API_QUICK_REFERENCE}

Respond with EXACTLY one of:
- "APPROVED" if the code is correct
- If you find issues, respond with:
  1. "REJECTED: <brief reason>" on its own line
  2. A numbered list of EACH specific issue: what is wrong and what the correct approach is

Do NOT provide corrected code. Only describe the issues and their fixes.
The code author will fix them — your job is to identify problems, not rewrite code.`;

// ---------------------------------------------------------------------------
// File review — verifies execution result against the Figma canvas diff
// ---------------------------------------------------------------------------

const FILE_REVIEW_SYSTEM_PROMPT = `You are a Figma file reviewer. After code was executed in a Figma plugin, you verify whether the execution produced the expected result on the canvas.

You receive:
1. The code that was executed
2. A JSON diff showing what changed on the Figma page (nodes added, removed, total children count, with properties like type, name, position, size, fills)
3. The AGENT DIRECTIVE (if available) — what THIS specific agent was asked to do. Use this to check semantic alignment. NOTE: In multi-agent orchestrations, each agent has its OWN directive. Do NOT judge an agent's work against the full orchestration task — only against its specific directive.

IMPORTANT about the diff:
- The diff shows TOP-LEVEL page children only. Nested children (inside frames) are NOT listed individually.
- If a node has descendantCount > 0, it means it contains nested children — this is expected for complex components.
- Do NOT report ISSUE just because you only see one frame added. Check the descendantCount to see if it contains the expected content.
- A frame with descendantCount: 50 that the code intended to fill with sections, colors, text etc. is likely correct.
- If the code ends with \`return node.id;\` or \`return frame.id;\`, this is a STEP 1 (container creation). An empty container with childCount:0 is EXPECTED — do NOT report ISSUE for this.
- The "modified" array tracks property changes on existing nodes: name, size, fills, and child count. If the code modifies properties on a node and the modified array shows the changes, that confirms the code worked.
- If the code modifies NESTED nodes (inside a frame), the top-level diff may show no changes. This is NORMAL — trust the execution success status. Do NOT report ISSUE just because the diff shows no top-level changes when the code operates on nested nodes.

Your job:
1. Assess whether the execution result looks correct based on what the code intended to do.
2. If an agent directive is provided, check that the result is semantically aligned with what THIS agent was asked to do. Only judge against the agent's specific directive, not the full orchestration task. If the code ran successfully but produces something different from the directive, report it as an issue.

Respond with EXACTLY one of:
- "VERIFIED: <brief description of what was created/modified>" if the result matches what the code intended AND the user's task
- "ISSUE: <brief description of the problem>" if something looks wrong (e.g. wrong color, missing node, semantic mismatch with user intent)

Be concise (1 sentence max).`;

function parseFileReviewResponse(content: string): { status: "verified" | "issue"; verdict: string } {
  const lines = content.trim().split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const verifiedMatch = trimmed.match(/^VERIFIED:\s*(.+)$/i);
    if (verifiedMatch) return { status: "verified", verdict: verifiedMatch[1] };
    const issueMatch = trimmed.match(/^ISSUE:\s*(.+)$/i);
    if (issueMatch) return { status: "issue", verdict: issueMatch[1] };
  }
  // Default to verified if the model didn't follow format
  return { status: "verified", verdict: content.trim().slice(0, 200) };
}

function parseReviewResponse(content: string): { approved: boolean; reason?: string } {
  const lines = content.trim().split("\n");
  let reason: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^APPROVED$/i.test(trimmed)) return { approved: true };
    const match = trimmed.match(/^REJECTED:\s*(.+)$/i);
    if (match) {
      reason = match[1];
      break;
    }
  }
  if (!reason) {
    // Default to approved if the model didn't follow format (fail-open)
    return { approved: true };
  }

  // Include all remaining content as the detailed reason (issue list from the reviewer)
  const rejectedIdx = content.indexOf(reason);
  const fullReason = rejectedIdx >= 0
    ? content.slice(rejectedIdx).trim()
    : reason;

  return { approved: false, reason: fullReason };
}

// ---------------------------------------------------------------------------
// Circuit breaker helpers
// ---------------------------------------------------------------------------

/** Record a pipeline failure and return an optional escalation message to inject. */
function recordPipelineFailure(state: AgentWorkflowState, errorMsg: string): string | undefined {
  state.consecutivePipelineFailures = (state.consecutivePipelineFailures ?? 0) + 1;
  const count = state.consecutivePipelineFailures;

  // Track error signature for deduplication
  const sig = errorMsg.slice(0, 100);
  if (!state.lastErrorSignatures) state.lastErrorSignatures = [];
  state.lastErrorSignatures.push(sig);
  if (state.lastErrorSignatures.length > 3) state.lastErrorSignatures.shift();

  // Check for repeated identical error (2 is enough to detect a loop)
  const sigs = state.lastErrorSignatures;
  if (sigs.length >= 2 && sigs[sigs.length - 1] === sigs[sigs.length - 2]) {
    return (
      `You are repeating the SAME error: "${sig}". ` +
      `This approach does not work. You MUST choose ONE of these options:\n` +
      `1. Try a SIMPLER version (fewer nodes, basic structure only) — use this if the current sub-task is needed for the rest of your work\n` +
      `2. Skip this sub-task entirely and move on — use this if it's optional\n` +
      `3. Call signal_task_complete — only if nothing else can be done`
    );
  }

  // Hard stop at 3 consecutive failures — force a decision
  if (count >= 3) {
    return (
      `HARD STOP: ${count} consecutive failures. You MUST choose ONE:\n` +
      `1. Create a MINIMAL placeholder (e.g. empty frame with correct name/position) so dependent sub-tasks can reference it, then move on\n` +
      `2. Skip and move on to the next part of your assignment\n` +
      `3. Call signal_task_complete with a summary of what succeeded and what failed\n` +
      `Do NOT retry the same approach again.`
    );
  }

  return undefined;
}

/** Reset pipeline failure tracking on a successful verified execution. */
function resetPipelineFailures(state: AgentWorkflowState): void {
  state.consecutivePipelineFailures = 0;
  state.lastErrorSignatures = [];
}


// ---------------------------------------------------------------------------
// Shared canvas capture helpers (used by both handleReviewAndExecute and handleExecuteExternalTool)
// ---------------------------------------------------------------------------

const SNAPSHOT_CODE = `return JSON.stringify(figma.currentPage.children.map(n => ({
  id: n.id, name: n.name,
  childCount: 'children' in n ? n.children.length : 0,
  width: Math.round(n.width), height: Math.round(n.height),
  fillHash: 'fills' in n ? JSON.stringify(n.fills).slice(0, 100) : '',
})));`;

function buildScreenshotCode(targetExpr: string): string {
  return `const target = ${targetExpr};
if (!target) return null;
const bytes = await target.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 0.25 } });
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
let r = '';
for (let i = 0; i < bytes.length; i += 3) {
  const a = bytes[i], b = bytes[i+1] || 0, c = bytes[i+2] || 0;
  r += chars[a >> 2] + chars[((a & 3) << 4) | (b >> 4)] + (i+1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : '=') + (i+2 < bytes.length ? chars[c & 63] : '=');
}
return r;`;
}

function buildDiffCode(beforeIds: string[], beforeNodeProps: Record<string, unknown>): string {
  const beforeSet = JSON.stringify(beforeIds);
  const prevProps = JSON.stringify(beforeNodeProps);
  return `const before = new Set(${beforeSet});
const prevProps = ${prevProps};
const children = figma.currentPage.children;
const added = children.filter(n => !before.has(n.id));
const countDescendants = n => { if (!('children' in n)) return 0; let count = n.children.length; for (const c of n.children) count += countDescendants(c); return count; };
const describe = n => ({ id: n.id, name: n.name, type: n.type, x: Math.round(n.x), y: Math.round(n.y), width: Math.round(n.width), height: Math.round(n.height), fills: 'fills' in n ? n.fills : undefined, childCount: 'children' in n ? n.children.length : undefined, descendantCount: countDescendants(n) });
const modified = [];
for (const n of children) { if (!before.has(n.id)) continue; const prev = prevProps[n.id]; if (!prev) continue; const changes = []; const cc = 'children' in n ? n.children.length : 0; if (cc !== prev.childCount) changes.push('children: '+prev.childCount+'→'+cc); if (n.name !== prev.name) changes.push('name: '+prev.name+'→'+n.name); if (Math.round(n.width) !== prev.width || Math.round(n.height) !== prev.height) changes.push('size: '+prev.width+'x'+prev.height+'→'+Math.round(n.width)+'x'+Math.round(n.height)); const currFillHash = 'fills' in n ? JSON.stringify(n.fills).slice(0,100) : ''; if (currFillHash !== prev.fillHash) changes.push('fills changed'); if (changes.length > 0) modified.push({ id: n.id, name: n.name, changes }); }
const removed = ${beforeSet}.filter(id => !children.find(n => n.id === id));
return JSON.stringify({ added: added.map(describe), modified, removedCount: removed.length, totalChildren: children.length });`;
}

type CanvasSnapshot = {
  ids: string[];
  nodeProps: Record<string, { name: string; childCount: number; width: number; height: number; fillHash: string }>;
  screenshot?: string;
};

async function captureCanvasSnapshot(clientId: string, userId: string, workflowId: string, screenshotTargetExpr?: string): Promise<CanvasSnapshot> {
  const snap: CanvasSnapshot = { ids: [], nodeProps: {} };
  try {
    const result = await executeFigmaCode({ pluginClientId: clientId, userId, code: SNAPSHOT_CODE, workflowId });
    if (result.success && result.result) {
      const parsed = JSON.parse(String(result.result));
      snap.ids = parsed.map((n: { id: string }) => n.id);
      snap.nodeProps = Object.fromEntries(parsed.map((n: { id: string; name: string; childCount: number; width: number; height: number; fillHash: string }) =>
        [n.id, { name: n.name, childCount: n.childCount, width: n.width, height: n.height, fillHash: n.fillHash }]));
    }
    const ssCode = buildScreenshotCode(screenshotTargetExpr ?? "figma.currentPage");
    const ssResult = await executeFigmaCode({ pluginClientId: clientId, userId, code: ssCode, workflowId });
    if (ssResult.success && ssResult.result) snap.screenshot = String(ssResult.result).slice(0, 500_000);
  } catch { /* best-effort */ }
  return snap;
}

async function captureCanvasDiff(clientId: string, userId: string, workflowId: string, before: CanvasSnapshot, screenshotTargetExpr?: string): Promise<{ diff?: string; screenshot?: string }> {
  const result: { diff?: string; screenshot?: string } = {};
  try {
    const diffCode = buildDiffCode(before.ids, before.nodeProps);
    const diffResult = await executeFigmaCode({ pluginClientId: clientId, userId, code: diffCode, workflowId });
    if (diffResult.success && diffResult.result) result.diff = String(diffResult.result).slice(0, 2000);
    const ssCode = buildScreenshotCode(screenshotTargetExpr ?? "figma.currentPage");
    const ssResult = await executeFigmaCode({ pluginClientId: clientId, userId, code: ssCode, workflowId });
    if (ssResult.success && ssResult.result) result.screenshot = String(ssResult.result).slice(0, 500_000);
  } catch { /* best-effort */ }
  return result;
}


async function handleReviewAndExecute(
  state: AgentWorkflowState,
  effect: Extract<AgentEffect, { type: "review_and_execute_figma_code" }>,
  userId: string,
  callLLM: LLMActivities["callLLM"],
  model?: string
): Promise<void> {
  // Track execution attempts for progress awareness
  state.codeAttemptCount = (state.codeAttemptCount ?? 0) + 1;

  // Build tracing context for delegate intercepts
  const tracing = {
    conversationType: "orchestration" as const,
    orchestrationId: state.orchestratorWorkflowId,
    agentShortId: state.agent.shortId,
    currentDirective: state.lastDirectiveContent,
    stepCount: state.stepCount,
    execStats: state.execStats,
    devLLMDelegation: state.devLLMDelegation,
    devSlowDelegation: state.devSlowDelegation,
  };

  // Step 1: Review LLM call (same model, dedicated prompt, no tools)
  const reviewResult = await callLLM({
    messages: [
      { role: "system", content: REVIEW_SYSTEM_PROMPT },
      { role: "user", content: `Review this Figma Plugin API code:\n\n\`\`\`js\n${effect.code}\n\`\`\`` },
    ],
    userId,
    model,
    maxTokens: 4096,
    purpose: "code_review",
    tracing,
  });

  // Emit the raw review response with usage inline
  await executeEffect(state, {
    type: "emit_activity",
    activities: [{
      action: "code_review_llm_response" as const,
      response: reviewResult.content,
      reasoning: reviewResult.reasoning,
      usage: reviewResult.usage,
      intercepted: reviewResult.intercepted,
    }],
  }, userId);

  const review = parseReviewResponse(reviewResult.content);

  if (!review.approved) {
    const reason = review.reason ?? "Unspecified issues";

    // Emit rejected activity
    await executeEffect(state, {
      type: "emit_activity",
      activities: [{
        action: "code_review_llm_rejected" as const,
        issues: reason,
        codeSnippet: effect.code,
      }],
    }, userId);

    // Build tool result — issues only, no corrected code (the agent must fix its own code)
    const parts = [
      `Code review rejected: ${reason}`,
      "\nFix the issues listed above and retry with corrected code.",
    ];

    // Circuit breaker: escalate on consecutive failures
    const escalation = recordPipelineFailure(state, reason);
    if (escalation) parts.push(`\n${escalation}`);

    parts.push(`---\n${JSON.stringify({ success: false, error: reason })}`);
    const rejectionResult = parts.join("\n");

    await executeEffect(state, {
      type: "emit_activity",
      activities: [{
        action: "guardian_message" as const,
        recipient: `agent ${state.agent.shortId}`,
        message: rejectionResult,
      }],
    }, userId);

    injectToolResult(state, effect.toolCallId, rejectionResult);
    recordExecResult(state, false);
    return;
  }

  // Emit approved activity
  await executeEffect(state, {
    type: "emit_activity",
    activities: [{
      action: "code_review_llm_approved" as const,
      codeSnippet: effect.code,
    }],
  }, userId);

  // Step 2: Snapshot BEFORE — list all node IDs + their child counts + capture screenshot
  const clientId = effect.pluginClientId || state.agent.pluginClientId || "";

  // Determine screenshot target: parent node if code references one, otherwise full page
  const parentIdMatch = effect.code.match(/getNodeByIdAsync\s*\(\s*["'](\d+:\d+)["']\s*\)/);
  const screenshotTargetId = parentIdMatch?.[1];
  const screenshotTargetExpr = screenshotTargetId ? `await figma.getNodeByIdAsync("${screenshotTargetId}")` : "figma.currentPage";

  // Detect if agent code uses scrollAndZoomIntoView (affects viewport, not node exports)
  const codeHasScroll = /scrollAndZoomIntoView|scrollIntoView/.test(effect.code);

  const before = await captureCanvasSnapshot(clientId, userId, state.orchestratorWorkflowId, screenshotTargetExpr);
  const beforeScreenshot = before.screenshot;

  // Step 3: Execute the actual code in Figma
  const execResult = await executeFigmaCode({
    pluginClientId: clientId,
    userId,
    code: effect.code,
    workflowId: state.orchestratorWorkflowId,
  });

  let verificationSummary: string | undefined;
  let afterScreenshot: string | undefined;

  // Emit code_executed activity
  await executeEffect(state, {
    type: "emit_activity",
    activities: [{
      action: "code_executed" as const,
      success: execResult.success ?? false,
      summary: execResult.success
        ? `OK${execResult.result ? `: ${String(execResult.result).slice(0, 200)}` : ""}`
        : (execResult.error?.slice(0, 200) ?? "Execution failed"),
    }],
  }, userId);

  // Step 4: Snapshot AFTER — diff to find new/changed nodes
  if (execResult.success) {
    const after = await captureCanvasDiff(clientId, userId, state.orchestratorWorkflowId, before, screenshotTargetExpr);
    verificationSummary = after.diff;
    afterScreenshot = after.screenshot;
    if (verificationSummary) {
      await executeEffect(state, {
        type: "emit_activity",
        activities: [{ action: "code_verified" as const, selection: verificationSummary }],
      }, userId);
    }
  }

  await notifyGuardrailIfBlocked(execResult, state);

  // Step 6: File review LLM — ask an LLM to interpret the diff in natural language
  let fileReviewVerdict: string | undefined;
  let fileReviewStatus: "verified" | "issue" = "verified";
  if (execResult.success && verificationSummary) {
    try {
      // Build images array for multimodal review (before + after screenshots)
      const images: string[] = [];
      if (beforeScreenshot) images.push(beforeScreenshot);
      if (afterScreenshot) images.push(afterScreenshot);

      const imageContext = images.length === 2
        ? "\n\nTwo screenshots are attached: the FIRST is BEFORE execution, the SECOND is AFTER execution."
        : images.length === 1
          ? "\n\nOne screenshot is attached showing the canvas AFTER execution."
          : "";

      const fileReviewResult = await callLLM({
        messages: [
          { role: "system", content: FILE_REVIEW_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Code executed:\n\`\`\`js\n${effect.code}\n\`\`\`\n\nFigma canvas diff:\n${verificationSummary}${imageContext}${state.lastDirectiveContent ? `\n\nAgent directive (what THIS agent was asked to do): ${state.lastDirectiveContent}` : state.taskDescription ? `\n\nOriginal user task: ${state.taskDescription}` : ""}`,
            images: images.length > 0 ? images : undefined,
          },
        ],
        userId,
        model,
        maxTokens: 256,
        purpose: "file_review",
        tracing,
      });

      const review = parseFileReviewResponse(fileReviewResult.content);
      fileReviewVerdict = review.verdict;
      fileReviewStatus = review.status;

      await executeEffect(state, {
        type: "emit_activity",
        activities: [{
          action: "file_review_llm_response" as const,
          verdict: review.verdict,
          status: review.status,
          code: effect.code,
          diff: verificationSummary ?? "",
          hasScreenshots: images.length > 0,
          beforeScreenshot: beforeScreenshot,
          afterScreenshot: afterScreenshot,
          rawResponse: fileReviewResult.content,
          usage: fileReviewResult.usage,
          intercepted: fileReviewResult.intercepted,
        }],
      }, userId);
    } catch {
      // File review is best-effort
    }
  }

  // ---------------------------------------------------------------------------
  // Programmatic gate: detect "nothing happened" using diff + binary screenshot comparison
  // This runs BEFORE trusting the LLM file review verdict.
  // ---------------------------------------------------------------------------

  let diffEmpty = false;
  if (verificationSummary) {
    try {
      const diff = JSON.parse(verificationSummary);
      diffEmpty = (!diff.added || diff.added.length === 0)
        && (!diff.modified || diff.modified.length === 0)
        && (diff.removedCount ?? 0) === 0;
    } catch { /* best-effort */ }
  } else {
    diffEmpty = true;
  }

  const hasScreenshots = !!(beforeScreenshot && afterScreenshot);
  // Binary comparison is reliable when: same target node AND no scrollAndZoomIntoView in code
  const canBinaryCompare = hasScreenshots && !codeHasScroll;
  const screenshotsIdentical = canBinaryCompare && beforeScreenshot === afterScreenshot;
  const screenshotsDifferent = canBinaryCompare && beforeScreenshot !== afterScreenshot;

  // Decision matrix (programmatic, no LLM involved):
  // | Diff   | Screenshots         | Action                                    |
  // |--------|---------------------|-------------------------------------------|
  // | empty  | identical or N/A    | REJECT — nothing happened (pipeline fail) |
  // | empty  | different           | Trust file review (nested changes likely)  |
  // | filled | any                 | Trust file review                         |
  const nothingHappened = execResult.success && diffEmpty && !screenshotsDifferent;

  // Inject result as tool result
  let execResultJson: string;
  if (nothingHappened) {
    // REJECT: code ran without error but produced no visible change on canvas
    const rejectParts = [
      "Execution completed but NOTHING CHANGED on the canvas.",
      "The diff is empty and the before/after screenshots are identical.",
      "This usually means your code did an early return (e.g. a node was not found).",
      "Check that all node IDs are correct and that you are creating/modifying nodes, not just looking them up.",
    ];
    if (verificationSummary) rejectParts.push(`\nCanvas diff:\n${verificationSummary}`);
    if (fileReviewVerdict) rejectParts.push(`\nFile review said: ${fileReviewVerdict}`);

    const escalation = recordPipelineFailure(state, "Nothing changed on canvas (empty diff + identical screenshots)");
    if (escalation) rejectParts.push(`\n${escalation}`);

    rejectParts.push(`---\n${JSON.stringify({ success: false, error: "No visible changes on canvas" })}`);
    execResultJson = rejectParts.join("\n");

    // Collect screenshots for the tool result
    const toolImages: string[] = [];
    if (beforeScreenshot) toolImages.push(beforeScreenshot);
    if (afterScreenshot) toolImages.push(afterScreenshot);

    await executeEffect(state, {
      type: "emit_activity",
      activities: [{
        action: "guardian_message" as const,
        recipient: `agent ${state.agent.shortId}`,
        message: execResultJson,
      }],
    }, userId);

    injectToolResult(state, effect.toolCallId, execResultJson, toolImages.length > 0 ? toolImages : undefined);
    recordExecResult(state, false); // count as failure
    return;
  }

  // ---------------------------------------------------------------------------
  // Programmatic gate 2: detect "empty frames" — frames created with no children
  // Skip this check on the FIRST successful execution (step 1 = container creation)
  // ---------------------------------------------------------------------------
  let emptyFramesCreated = false;
  if (execResult.success && verificationSummary && state.execStats.success > 0) {
    try {
      const diff = JSON.parse(verificationSummary);
      const emptyFrames = (diff.added || []).filter(
        (n: { type?: string; childCount?: number; descendantCount?: number }) =>
          n.type === "FRAME" && (n.childCount ?? 0) === 0 && (n.descendantCount ?? 0) === 0
      );
      if (emptyFrames.length > 0 && diff.added.length === emptyFrames.length) {
        // ALL added nodes are empty frames — likely a failed population step
        emptyFramesCreated = true;
      }
    } catch { /* best-effort */ }
  }

  if (emptyFramesCreated) {
    const rejectParts = [
      "Execution completed but ALL created frames are EMPTY (childCount=0).",
      "You created frame containers but did not add any content inside them.",
      "This usually means your code created the outer frame but the inner content (text nodes, rectangles, child frames) was not appended.",
      "Re-check your code: make sure you call parent.appendChild(child) for every element.",
    ];
    if (verificationSummary) rejectParts.push(`\nCanvas diff:\n${verificationSummary}`);
    if (fileReviewVerdict) rejectParts.push(`\nFile review said: ${fileReviewVerdict}`);

    const escalation = recordPipelineFailure(state, "All created frames are empty (childCount=0)");
    if (escalation) rejectParts.push(`\n${escalation}`);

    rejectParts.push(`---\n${JSON.stringify({ success: false, error: "Created frames are empty — no children" })}`);
    const rejectJson = rejectParts.join("\n");

    await executeEffect(state, {
      type: "emit_activity",
      activities: [{
        action: "guardian_message" as const,
        recipient: `agent ${state.agent.shortId}`,
        message: rejectJson,
      }],
    }, userId);

    injectToolResult(state, effect.toolCallId, rejectJson);
    recordExecResult(state, false);
    return;
  } else if (execResult.success) {
    const successCount = state.execStats.success + 1; // +1 because recordExecResult hasn't been called yet
    const parts = [
      `Execution succeeded. (${successCount} successful execution${successCount > 1 ? "s" : ""} so far)`,
    ];

    parts.push("\nCode review: APPROVED");

    if (verificationSummary) {
      parts.push(`\nCanvas diff:\n${verificationSummary}`);

      // Extract and expose created node IDs for inter-step references
      try {
        const diff = JSON.parse(verificationSummary);
        if (diff.added?.length > 0) {
          const ids = diff.added.map((n: { id: string }) => n.id);
          parts.push(`\nCreated node IDs: ${JSON.stringify(ids)}`);
          parts.push(`To reference in your next call: const node = await figma.getNodeByIdAsync("${ids[0]}");`);
        }
      } catch { /* best-effort ID extraction */ }
    }

    if (fileReviewVerdict) {
      if (fileReviewStatus === "verified") {
        parts.push(`\nFile review: VERIFIED — ${fileReviewVerdict}`);
        parts.push("If this step completes your current directive, call signal_task_complete. The orchestrator may send you more work.");
        state.consecutiveFileReviewIssues = 0;
        resetPipelineFailures(state);
      } else {
        // File review ISSUE but content exists on canvas → warning only
        const consecutiveIssues = (state.consecutiveFileReviewIssues ?? 0) + 1;
        state.consecutiveFileReviewIssues = consecutiveIssues;

        parts.push(`\nFile review: WARNING — ${fileReviewVerdict}`);

        if (consecutiveIssues >= 3) {
          parts.push(
            "The file reviewer has flagged your last 3 executions. " +
            "Your code ran successfully each time, but the results may not match your directive. " +
            "Re-read your directive carefully, or call signal_task_complete if you believe the work is done."
          );
        } else {
          parts.push("Note: the code executed successfully. The reviewer flagged a possible mismatch with your directive. Check if this is expected, then continue with your plan.");
        }

        // Execution succeeded with visible changes — reset pipeline failures
        resetPipelineFailures(state);
      }
    } else {
      // No file review — still a success, reset pipeline failures
      resetPipelineFailures(state);
      parts.push("If this step completes your current directive, call signal_task_complete. The orchestrator may send you more work.");
    }

    // Intent reminder — keep the directive visible after a few executions
    const intentReminder = state.lastDirectiveContent ?? state.taskDescription;
    if (intentReminder && state.stepCount >= 5) {
      parts.push(`\n[Reminder] Your assigned directive: "${intentReminder}". Ensure your code aligns with this.`);
    }

    parts.push(`---\n${JSON.stringify(execResult)}`);
    execResultJson = parts.join("\n");
  } else {
    // Execution failed — circuit breaker
    const failParts = ["Execution failed. Diagnose the error and retry with corrected code."];
    const escalation = recordPipelineFailure(state, execResult.error ?? "unknown error");
    if (escalation) failParts.push(escalation);
    failParts.push(`---\n${JSON.stringify(execResult)}`);
    execResultJson = failParts.join("\n");
  }

  // Collect before/after screenshots to attach to the tool result
  const toolImages: string[] = [];
  if (beforeScreenshot) toolImages.push(beforeScreenshot);
  if (afterScreenshot) toolImages.push(afterScreenshot);

  if (toolImages.length === 2) {
    execResultJson += "\n\n[Two screenshots attached: FIRST = BEFORE execution, SECOND = AFTER execution. Compare them visually.]";
  } else if (toolImages.length === 1) {
    execResultJson += "\n\n[One screenshot attached showing the canvas AFTER execution.]";
  }

  await executeEffect(state, {
    type: "emit_activity",
    activities: [{
      action: "guardian_message" as const,
      recipient: `agent ${state.agent.shortId}`,
      message: execResultJson,
    }],
  }, userId);

  // Append Figma API supplement on first raw code execution (lazy injection for slim prompt)
  const supplement = getFigmaApiSupplement(state);
  injectToolResult(state, effect.toolCallId, execResultJson + supplement, toolImages.length > 0 ? toolImages : undefined);
  recordExecResult(state, execResult.success ?? false);
}

// ---------------------------------------------------------------------------
// Lazy Figma API supplement injection
// ---------------------------------------------------------------------------

/**
 * Get the Figma Plugin API supplement to append to the first figma_execute tool result.
 *
 * Returns the supplement text on first call (when slim prompt is active),
 * or empty string on subsequent calls. Appended to the tool result content
 * to avoid a separate role:"user" message that some providers reject.
 */
function getFigmaApiSupplement(state: AgentWorkflowState): string {
  if (state.figmaApiDocsInjected || !state.externalTools?.length) return "";
  state.figmaApiDocsInjected = true;
  return `\n\n---\n\n[Figma API Reference — automatically provided on first code execution]\n\n${FIGMA_API_EXECUTE_SUPPLEMENT}`;
}

// ---------------------------------------------------------------------------
// Fetch Figma docs (mode "full" — network call via activity)
// ---------------------------------------------------------------------------

async function handleFetchFigmaDocs(
  state: AgentWorkflowState,
  effect: Extract<AgentEffect, { type: "fetch_figma_docs" }>
): Promise<void> {
  const result = await fetchFigmaDocs({ topic: effect.topic });
  if (result.success && result.content) {
    injectToolResult(state, effect.toolCallId, result.content);
  } else {
    injectToolResult(
      state,
      effect.toolCallId,
      `Could not fetch docs for "${effect.topic}": ${result.error ?? "unknown error"}. Use mode "quick" instead.`
    );
  }
}

// ---------------------------------------------------------------------------
// External tool execution (MCP)
// ---------------------------------------------------------------------------

// Read-only FC tools that don't modify the Figma canvas (no diff/screenshot needed)
const FC_READ_ONLY_TOOLS = new Set([
  "figma_get_status", "figma_get_selection", "figma_get_variables", "figma_get_file_data",
  "figma_get_styles", "figma_get_component", "figma_get_component_details",
  "figma_get_component_image", "figma_get_component_for_development",
  "figma_get_console_logs", "figma_get_design_system_summary", "figma_get_design_system_kit",
  "figma_get_design_changes", "figma_get_comments", "figma_get_file_for_plugin",
  "figma_get_library_components", "figma_get_token_values", "figma_get_variables",
  "figma_list_open_files", "figma_navigate", "figma_reconnect", "figma_watch_console",
  "figma_browse_tokens", "figma_search_components", "figma_clear_console",
  "figma_check_design_parity", "figma_lint_design", "figma_audit_design_system",
]);

function isFigmaWriteTool(rawToolName: string): boolean {
  return rawToolName.startsWith("figma_") && !FC_READ_ONLY_TOOLS.has(rawToolName);
}

async function handleExecuteExternalTool(
  state: AgentWorkflowState,
  effect: Extract<AgentEffect, { type: "execute_external_tool" }>,
  userId: string,
  mcpServerIds?: string[],
  callLLM?: LLMActivities["callLLM"],
  model?: string,
): Promise<void> {
  // Resolve server ID from the prefixed tool name
  const resolved = resolveServerIdFromPrefixedName(effect.toolName, mcpServerIds);
  if (!resolved) {
    injectToolResult(state, effect.toolCallId, `Error: Cannot resolve MCP server for tool "${effect.toolName}"`);
    await executeEffect(state, {
      type: "emit_activity",
      activities: [{
        action: "external_tool_result",
        success: false,
        summary: `${effect.toolName}: Cannot resolve MCP server`,
      }],
    }, userId);
    return;
  }

  const clientId = state.agent.pluginClientId || "";
  const shouldCaptureDiff = isFigmaWriteTool(resolved.rawName) && clientId;

  // ── Before snapshot (for Figma write tools) ────────────────────────────
  const before = shouldCaptureDiff
    ? await captureCanvasSnapshot(clientId, userId, state.orchestratorWorkflowId)
    : { ids: [], nodeProps: {} } as CanvasSnapshot;

  // ── Execute the MCP tool ───────────────────────────────────────────────
  const result = await mcpActivities.executeMCPTool({
    userId,
    serverId: resolved.serverId,
    toolName: resolved.rawName,
    arguments: effect.arguments,
    agentId: state.agent.shortId,
  });

  // For figma_execute tools, the MCP transport may succeed (result.success = true)
  // while the Figma code itself fails (result.result contains { success: false }).
  // Detect this and treat it as a partial failure so the agent knows the code errored.
  let figmaCodeFailed = false;
  if (result.success && resolved.rawName === "figma_execute") {
    try {
      const payload = typeof result.result === "string" ? JSON.parse(result.result)
        : Array.isArray(result.result) ? JSON.parse(result.result.find((c: { type?: string; text?: string }) => c.type === "text")?.text ?? "{}")
        : result.result;
      if (payload && typeof payload === "object" && payload.success === false) {
        figmaCodeFailed = true;
      }
    } catch { /* best-effort parsing */ }
  }

  if (result.success && !figmaCodeFailed) {
    recordExecResult(state, true);
    state.directiveExecCount = (state.directiveExecCount ?? 0) + 1;
  } else if (result.success && figmaCodeFailed) {
    recordExecResult(state, false);
  }

  // Emit tool result activity
  await executeEffect(state, {
    type: "emit_activity",
    activities: [{
      action: "external_tool_result",
      success: result.success ? !figmaCodeFailed : false,
      summary: !result.success
        ? `${effect.toolName}: FAILED — ${result.error?.slice(0, 200) ?? "Unknown error"}`
        : figmaCodeFailed
          ? `${effect.toolName}: CODE ERROR — ${JSON.stringify(result.result).slice(0, 200)}`
          : `${effect.toolName}: OK${result.result ? ` — ${JSON.stringify(result.result).slice(0, 200)}` : ""}`,
    }],
  }, userId);

  // ── After snapshot + diff + file review (for Figma write tools) ────────
  let verificationSummary: string | undefined;
  let afterScreenshot: string | undefined;

  // Skip diff/review when the Figma code itself reported failure — partial canvas
  // changes may exist but the intent was not fulfilled, so "verified" would be misleading.
  if (shouldCaptureDiff && result.success && !figmaCodeFailed) {
    try {
      const after = await captureCanvasDiff(clientId, userId, state.orchestratorWorkflowId, before);
      verificationSummary = after.diff;
      afterScreenshot = after.screenshot;

      if (verificationSummary) {
        await executeEffect(state, {
          type: "emit_activity",
          activities: [{ action: "code_verified" as const, selection: verificationSummary }],
        }, userId);
      }

      // File review LLM
      if (verificationSummary && callLLM) {
        const images: string[] = [];
        if (before.screenshot) images.push(before.screenshot);
        if (afterScreenshot) images.push(afterScreenshot);
        const imageContext = images.length === 2 ? "\n\nTwo screenshots attached: FIRST = BEFORE, SECOND = AFTER." : images.length === 1 ? "\n\nOne screenshot attached (AFTER)." : "";
        const tracing = { conversationType: "orchestration" as const, orchestrationId: state.orchestratorWorkflowId, agentShortId: state.agent.shortId, currentDirective: state.lastDirectiveContent, stepCount: state.stepCount, execStats: state.execStats, devLLMDelegation: state.devLLMDelegation, devSlowDelegation: state.devSlowDelegation };
        const fileReviewResult = await callLLM({
          messages: [
            { role: "system", content: FILE_REVIEW_SYSTEM_PROMPT },
            { role: "user", content: `External MCP tool executed: ${effect.toolName}\nArguments: ${JSON.stringify(effect.arguments).slice(0, 500)}\nResult: ${JSON.stringify(result.result).slice(0, 500)}\n\nFigma canvas diff:\n${verificationSummary}${imageContext}${state.lastDirectiveContent ? `\n\nAgent directive: ${state.lastDirectiveContent}` : ""}`, images: images.length > 0 ? images : undefined },
          ],
          userId, model, maxTokens: 256, purpose: "file_review", tracing,
        });
        const review = parseFileReviewResponse(fileReviewResult.content);
        await executeEffect(state, { type: "emit_activity", activities: [{ action: "file_review_llm_response" as const, verdict: review.verdict, status: review.status, code: `[MCP Tool] ${effect.toolName}(${JSON.stringify(effect.arguments).slice(0, 200)})`, diff: verificationSummary ?? "", hasScreenshots: images.length > 0, beforeScreenshot: before.screenshot, afterScreenshot, rawResponse: fileReviewResult.content, usage: fileReviewResult.usage, intercepted: fileReviewResult.intercepted }] }, userId);
      }
    } catch { /* canvas diff/review is best-effort */ }
  }

  // Build enriched result for the agent
  const parts: string[] = [];
  if (verificationSummary) parts.push(`Canvas diff:\n${verificationSummary}`);
  if (state.lastDirectiveContent) parts.push(`[Reminder] Your assigned directive: "${state.lastDirectiveContent}".`);
  parts.push(`---\n${JSON.stringify(result)}`);

  const toolImages: string[] = [];
  if (before.screenshot) toolImages.push(before.screenshot);
  if (afterScreenshot) toolImages.push(afterScreenshot);

  // Append Figma API supplement on first figmaconsole_figma_execute call (lazy injection for slim prompt)
  const supplement = effect.toolName === "figmaconsole_figma_execute" ? getFigmaApiSupplement(state) : "";
  injectToolResult(state, effect.toolCallId, parts.join("\n\n") + supplement, toolImages.length > 0 ? toolImages : undefined);
}

/** Resolve server ID from prefixed tool name (e.g. "figmaconsole_create_child" → figma_console / create_child) */
function resolveServerIdFromPrefixedName(prefixedName: string, mcpServerIds?: string[]): { serverId: string; rawName: string } | undefined {
  const prefixes: Array<[string, string]> = [
    // If figma_console_local is connected, prefer it over remote for figmaconsole_ tools
    ...(mcpServerIds?.includes("figma_console_local")
      ? [["figmaconsole_", "figma_console_local"] as [string, string]]
      : [["figmaconsole_", "figma_console"] as [string, string]]),
    ["github_", "github"],
    ["figma_", "figma_mcp"],
  ];
  for (const [prefix, serverId] of prefixes) {
    if (prefixedName.startsWith(prefix)) {
      return { serverId, rawName: prefixedName.slice(prefix.length) };
    }
  }
  return undefined;
}

// Re-export for convenience within the workflow sandbox
export type { AgentWorkflowInput } from "./types.js";

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export async function agentWorkflow(input: AgentWorkflowInput): Promise<void> {
  const state = createAgentState(input.agent);
  // Store original task for intent pinning (Phase 5 B2 + D1)
  state.taskDescription = input.task;
  // Dev-only: delegate LLM calls to external responder (from user settings)
  const userSettings = (input.context as Record<string, unknown>)?.userSettings as Record<string, unknown> | undefined;
  state.devLLMDelegation = !!(userSettings?.devLLMDelegation);
  state.devSlowDelegation = !!(userSettings?.devSlowDelegation);
  state.model = input.model;

  // Choose activity proxy based on slow delegation mode
  const { callLLM } = state.devSlowDelegation ? slowLLM : normalLLM;

  let directoryReceived = false;

  // ── Signal handlers (fill the mailboxes) ─────────────────────────────────
  setHandler(directiveSignal, (directive) => {
    handleDirective(state, directive);
  });

  setHandler(peerMessageSignal, (message) => {
    handlePeerMessage(state, message);
  });

  setHandler(agentBroadcastSignal, (broadcast) => {
    handleBroadcast(state, broadcast);
  });

  setHandler(subConvMessageSignal, (message) => {
    handleSubConvMessage(state, message);
  });

  setHandler(agentDirectorySignal, (directory) => {
    handleAgentDirectory(state, directory);
    directoryReceived = true;
  });

  setHandler(pluginDisconnectedSignal, () => {
    handlePluginDisconnected(state);
  });

  setHandler(subConvInviteSignal, async (invite) => {
    const effect = handleSubConvInvite(state, invite);
    if (effect) {
      await executeEffect(state, effect, input.userId);
    }
  });

  setHandler(subConvCloseSignal, (close) => {
    handleSubConvClose(state, close);
  });

  setHandler(terminateAgentSignal, () => {
    handleTerminate(state);
  });

  // ── Wait for directory ───────────────────────────────────────────────────
  await condition(() => directoryReceived);

  // ── Discover MCP tools (if user has connected MCP servers) ──────────────
  if (input.mcpServerIds?.length) {
    try {
      state.externalTools = await mcpActivities.discoverMCPTools({
        userId: input.userId,
        mcpServerIds: input.mcpServerIds,
        agentId: input.agent.shortId,
        pluginClientId: input.agent.pluginClientId,
      });

      // Auto-pair cloud relay for Southleft Figma Console (production/preview)
      // This allows figmaconsole_* write tools to reach the plugin via Southleft's cloud relay
      const needsCloudRelay =
        input.mcpServerIds.includes("figma_console") &&
        !input.mcpServerIds.includes("figma_console_local");
      if (needsCloudRelay && input.agent.pluginClientId) {
        try {
          await mcpActivities.pairFCCloudRelay({
            userId: input.userId,
            pluginClientId: input.agent.pluginClientId,
          });
        } catch {
          // Non-fatal: write tools may fail but read tools still work
        }
      }
    } catch {
      // Non-fatal: agent continues with static tools only
      state.externalTools = [];
    }
  }

  // ── Inject system prompt (includes task context) ────────────────────────
  const peerAgents = Array.from(state.agentDirectory.values());
  const hasExternalFigmaTools = input.mcpServerIds?.includes("figma_console_local") || input.mcpServerIds?.includes("figma_console");
  const systemPrompt = buildAgentSystemPrompt(
    input.agent,
    "orchestrator",
    peerAgents,
    input.task,
    { hasExternalFigmaTools },
    state.metadataFormat
  );
  state.messageHistory.push({
    role: "system",
    content: systemPrompt,
  });

  // Emit system prompt as activity so it appears in SSE stream + DB
  try {
    const handle = getExternalWorkflowHandle(state.orchestratorWorkflowId);
    await handle.signal(agentActivitySignal, {
      agentShortId: state.agent.shortId,
      activities: [{ action: "guardian_message" as const, recipient: `agent ${state.agent.shortId}`, message: `[system_prompt]\n${systemPrompt}` }],
    });
  } catch { /* orchestrator may not be ready yet */ }

  // ── Main loop ────────────────────────────────────────────────────────────
  while (!state.completed && !state.disconnected) {
    // Wait for any input
    const hasInput = () =>
      state.directiveQueue.length > 0 ||
      state.peerMessageQueue.length > 0 ||
      state.broadcastQueue.length > 0 ||
      state.subConvMessageQueue.length > 0 ||
      state.disconnected;

    await condition(hasInput);

    // Process queued inputs
    const effects = processQueues(state);

    for (const effect of effects) {
      if (effect.type === "call_llm") {
        // LLM loop
        const llmResult = await callLLM({
          messages: effect.messages,
          tools: effect.tools,
          userId: input.userId,
          model: input.model,
          purpose: "agent",
          tracing: {
            conversationType: "orchestration",
            orchestrationId: state.orchestratorWorkflowId,
            agentShortId: state.agent.shortId,
            currentDirective: state.lastDirectiveContent,
            stepCount: state.stepCount,
            execStats: state.execStats,
            devLLMDelegation: state.devLLMDelegation,
          },
        });
        // Update metadata format from LLM result (resolved per model config)
        if (llmResult.metadataFormat) state.metadataFormat = llmResult.metadataFormat;
        if (llmResult.modelId) state.model = llmResult.modelId;

        const responseEffects = processLLMResponse(
          state,
          llmResult.content,
          llmResult.toolCalls,
          llmResult.reasoning,
          llmResult.usage,
          llmResult.intercepted,
          llmResult.reasoningSimulated,
          llmResult.modelId
        );

        // Emit activities first so tool_call events arrive before their pipeline children
        let didExecTool = false;
        let pendingLLM: { messages: typeof effect.messages; tools: typeof effect.tools } | null = null;

        for (const rEffect of responseEffects) {
          if (rEffect.type === "emit_activity") {
            await executeEffect(state, rEffect, input.userId);
          }
        }
        for (const rEffect of responseEffects) {
          if (rEffect.type === "emit_activity") continue;
          if (rEffect.type === "review_and_execute_figma_code") {
            await handleReviewAndExecute(state, rEffect, input.userId, callLLM, input.model);
            didExecTool = true;
          } else if (rEffect.type === "fetch_figma_docs") {
            await handleFetchFigmaDocs(state, rEffect);
            didExecTool = true;
          } else if (rEffect.type === "call_llm") {
            pendingLLM = { messages: rEffect.messages, tools: rEffect.tools };
          } else {
            await executeEffect(state, rEffect, input.userId);
          }
        }

        // Continue LLM loop with correct messages (including tool results)
        if (pendingLLM) {
          const msgs = didExecTool ? [...state.messageHistory] : pendingLLM.messages;
          await executeLLMLoop(state, msgs, pendingLLM.tools, input.userId, callLLM, input.model, input.mcpServerIds);
        }
      } else if (effect.type === "wait_for_input") {
        // Continue to next loop iteration
        continue;
      } else {
        await executeEffect(state, effect, input.userId);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// LLM tool-call loop
// ---------------------------------------------------------------------------

async function executeLLMLoop(
  state: AgentWorkflowState,
  messages: LLMMessage[],
  tools: LLMToolDefinition[] | undefined,
  userId: string,
  callLLM: LLMActivities["callLLM"],
  model?: string,
  mcpServerIds?: string[],
): Promise<void> {
  let maxIterations = 200;

  while (maxIterations-- > 0 && !state.completed) {
    const llmResult = await callLLM({
      messages, tools, userId, model,
      purpose: "agent",
      tracing: {
        conversationType: "orchestration",
        orchestrationId: state.orchestratorWorkflowId,
        agentShortId: state.agent.shortId,
        currentDirective: state.lastDirectiveContent,
        stepCount: state.stepCount,
        execStats: state.execStats,
        devLLMDelegation: state.devLLMDelegation,
      },
    });
    if (llmResult.metadataFormat) state.metadataFormat = llmResult.metadataFormat;
    if (llmResult.modelId) state.model = llmResult.modelId;
    const effects = processLLMResponse(state, llmResult.content, llmResult.toolCalls, llmResult.reasoning, llmResult.usage, llmResult.intercepted, llmResult.reasoningSimulated, llmResult.modelId);

    let needsContinue = false;
    let didExecuteTool = false;

    // First pass: emit activities so tool_call events arrive before their pipeline children
    for (const effect of effects) {
      if (effect.type === "emit_activity") {
        await executeEffect(state, effect, userId);
      }
    }
    // Second pass: process tool executions and other effects
    for (const effect of effects) {
      if (effect.type === "emit_activity") continue;
      if (effect.type === "review_and_execute_figma_code") {
        await handleReviewAndExecute(state, effect, userId, callLLM, model);
        didExecuteTool = true;
        needsContinue = true;
      } else if (effect.type === "execute_external_tool") {
        await handleExecuteExternalTool(state, effect, userId, mcpServerIds, callLLM, model);
        didExecuteTool = true;
        needsContinue = true;
      } else if (effect.type === "fetch_figma_docs") {
        await handleFetchFigmaDocs(state, effect);
        didExecuteTool = true;
        needsContinue = true;
      } else if (effect.type === "call_llm") {
        if (!didExecuteTool) {
          messages = effect.messages;
        } else {
          messages = [...state.messageHistory];
        }
        tools = effect.tools;
        needsContinue = true;
      } else {
        await executeEffect(state, effect, userId);
      }
    }

    // If tools were executed but no call_llm effect, still continue
    if (didExecuteTool && !needsContinue) {
      messages = [...state.messageHistory];
      needsContinue = true;
    }

    if (!needsContinue) break;
  }
}

// ---------------------------------------------------------------------------
// Effect executor
// ---------------------------------------------------------------------------

async function executeEffect(
  state: AgentWorkflowState,
  effect: AgentEffect,
  userId: string
): Promise<void> {
  switch (effect.type) {
    case "report_to_orchestrator": {
      try {
        const handle = getExternalWorkflowHandle(state.orchestratorWorkflowId);
        await handle.signal(agentReportSignal, effect.report);
      } catch {
        // Orchestrator may have already completed
      }
      break;
    }

    case "send_peer_message": {
      try {
        const handle = getExternalWorkflowHandle(effect.targetWorkflowId);
        await handle.signal(peerMessageSignal, effect.message);
      } catch {
        // Peer workflow may have already completed
      }
      break;
    }

    case "send_broadcast": {
      try {
        const handle = getExternalWorkflowHandle(state.orchestratorWorkflowId);
        await handle.signal(agentReportSignal, {
          agentShortId: state.agent.shortId,
          status: "in_progress",
          summary: `[Broadcast] ${effect.broadcast.content}`,
        });
      } catch {
        // Orchestrator may have already completed
      }
      break;
    }

    case "send_sub_conv_invite": {
      for (const wid of effect.targetWorkflowIds) {
        try {
          const handle = getExternalWorkflowHandle(wid);
          await handle.signal(subConvInviteSignal, effect.invite);
        } catch {
          // Target may have already completed
        }
      }
      break;
    }

    case "send_sub_conv_response": {
      try {
        const handle = getExternalWorkflowHandle(effect.targetWorkflowId);
        await handle.signal(subConvResponseSignal, effect.response);
      } catch {
        // Target may have already completed
      }
      break;
    }

    case "send_sub_conv_message": {
      for (const wid of effect.targetWorkflowIds) {
        try {
          const handle = getExternalWorkflowHandle(wid);
          await handle.signal(subConvMessageSignal, effect.message);
        } catch {
          // Target may have already completed
        }
      }
      break;
    }

    case "send_sub_conv_close": {
      for (const wid of effect.targetWorkflowIds) {
        try {
          const handle = getExternalWorkflowHandle(wid);
          await handle.signal(subConvCloseSignal, effect.close);
        } catch {
          // Target may have already completed
        }
      }
      break;
    }

    case "notify_orchestrator_sub_conv": {
      try {
        const handle = getExternalWorkflowHandle(state.orchestratorWorkflowId);
        await handle.signal(subConvNotifySignal, {
          subConvId: effect.subConvId,
          event: effect.event,
          participantIds: effect.participantIds,
          topic: effect.topic,
          reason: effect.reason,
        });
      } catch {
        // Orchestrator may have already completed
      }
      break;
    }

    case "emit_activity": {
      try {
        const handle = getExternalWorkflowHandle(state.orchestratorWorkflowId);
        await handle.signal(agentActivitySignal, {
          agentShortId: state.agent.shortId,
          activities: effect.activities,
        });
      } catch {
        // Orchestrator may have already completed
      }
      break;
    }

    case "complete":
      // Workflow will naturally exit the loop
      break;

    case "wait_for_input":
      // No-op, handled by the main loop
      break;

    default:
      break;
  }
}
