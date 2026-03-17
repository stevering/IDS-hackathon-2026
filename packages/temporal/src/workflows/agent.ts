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
} from "@guardian/orchestrations";

import type { AgentId, LLMMessage } from "@guardian/orchestrations";
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
  agentReportSignal,
  subConvNotifySignal,
  guardrailBlockedSignal,
  agentActivitySignal,
} from "../signals/definitions.js";

import type { LLMActivities, FigmaActivities, DocsActivities } from "../activities/types.js";

// Proxy activities
const { callLLM } = proxyActivities<LLMActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

const { executeFigmaCode } = proxyActivities<FigmaActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 2 },
});

const { fetchFigmaDocs } = proxyActivities<DocsActivities>({
  startToCloseTimeout: "20 seconds",
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
3. The ORIGINAL USER TASK (if available) — use this to check semantic alignment

IMPORTANT about the diff:
- The diff shows TOP-LEVEL page children only. Nested children (inside frames) are NOT listed individually.
- If a node has descendantCount > 0, it means it contains nested children — this is expected for complex components.
- Do NOT report ISSUE just because you only see one frame added. Check the descendantCount to see if it contains the expected content.
- A frame with descendantCount: 50 that the code intended to fill with sections, colors, text etc. is likely correct.

Your job:
1. Assess whether the execution result looks correct based on what the code intended to do.
2. If the original user task is provided, check that the result is semantically aligned with what the user asked for (correct theme, correct components, correct style). If the code ran successfully but produces something the user didn't ask for (e.g., wrong theme, missing required elements), report it as an issue.

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


async function handleReviewAndExecute(
  state: AgentWorkflowState,
  effect: Extract<AgentEffect, { type: "review_and_execute_figma_code" }>,
  userId: string,
  model?: string
): Promise<void> {
  // Step 1: Review LLM call (same model, dedicated prompt, no tools)
  const reviewResult = await callLLM({
    messages: [
      { role: "system", content: REVIEW_SYSTEM_PROMPT },
      { role: "user", content: `Review this Figma Plugin API code:\n\n\`\`\`js\n${effect.code}\n\`\`\`` },
    ],
    userId,
    model,
    maxTokens: 4096,
  });

  // Emit the raw review response with usage inline
  await executeEffect(state, {
    type: "emit_activity",
    activities: [{
      action: "code_review_llm_response" as const,
      response: reviewResult.content,
      reasoning: reviewResult.reasoning,
      usage: reviewResult.usage,
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
  const snapshotCode = `return JSON.stringify(figma.currentPage.children.map(n => ({ id: n.id, childCount: 'children' in n ? n.children.length : 0 })));`;
  let beforeIds: string[] = [];
  let beforeChildCounts: Record<string, number> = {};
  let beforeScreenshot: string | undefined;
  try {
    const beforeResult = await executeFigmaCode({
      pluginClientId: clientId, userId, code: snapshotCode,
      workflowId: state.orchestratorWorkflowId,
    });
    if (beforeResult.success && beforeResult.result) {
      const parsed = JSON.parse(String(beforeResult.result));
      beforeIds = parsed.map((n: { id: string }) => n.id);
      beforeChildCounts = Object.fromEntries(
        parsed.map((n: { id: string; childCount: number }) => [n.id, n.childCount])
      );
    }
    // Capture screenshot only if page has content (avoid empty export)
    if (beforeIds.length > 0) {
      const screenshotCode = `const bytes = await figma.currentPage.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 0.25 } });
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
let r = '';
for (let i = 0; i < bytes.length; i += 3) {
  const a = bytes[i], b = bytes[i+1] || 0, c = bytes[i+2] || 0;
  r += chars[a >> 2] + chars[((a & 3) << 4) | (b >> 4)] + (i+1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : '=') + (i+2 < bytes.length ? chars[c & 63] : '=');
}
return r;`;
      const ssResult = await executeFigmaCode({
        pluginClientId: clientId, userId, code: screenshotCode,
        workflowId: state.orchestratorWorkflowId,
      });
      if (ssResult.success && ssResult.result) {
        beforeScreenshot = String(ssResult.result).slice(0, 500_000); // cap at ~375KB
      }
    }
  } catch { /* best-effort */ }

  // Step 3: Execute the actual code in Figma
  const execResult = await executeFigmaCode({
    pluginClientId: clientId,
    userId,
    code: effect.code,
    workflowId: state.orchestratorWorkflowId,
  });

  let verificationSummary: string | undefined;

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
    try {
      const beforeSet = JSON.stringify(beforeIds);
      const beforeCounts = JSON.stringify(beforeChildCounts);
      const diffCode = `const before = new Set(${beforeSet});
const prevCounts = ${beforeCounts};
const children = figma.currentPage.children;
const added = children.filter(n => !before.has(n.id));
const removed = ${beforeSet}.filter(id => !children.find(n => n.id === id));
const countDescendants = n => {
  if (!('children' in n)) return 0;
  let count = n.children.length;
  for (const c of n.children) count += countDescendants(c);
  return count;
};
const describe = n => ({
  id: n.id, name: n.name, type: n.type,
  x: Math.round(n.x), y: Math.round(n.y),
  width: Math.round(n.width), height: Math.round(n.height),
  fills: 'fills' in n ? n.fills : undefined,
  childCount: 'children' in n ? n.children.length : undefined,
  descendantCount: countDescendants(n),
});
const modified = [];
for (const n of children) {
  if (before.has(n.id) && 'children' in n) {
    const prev = prevCounts[n.id] || 0;
    const curr = n.children.length;
    if (curr !== prev) {
      modified.push({ id: n.id, name: n.name, childrenBefore: prev, childrenAfter: curr });
    }
  }
}
return JSON.stringify({
  added: added.map(describe),
  modified: modified,
  removedCount: removed.length,
  totalChildren: children.length,
});`;
      const afterResult = await executeFigmaCode({
        pluginClientId: clientId, userId, code: diffCode,
        workflowId: state.orchestratorWorkflowId,
      });
      if (afterResult.success && afterResult.result) {
        verificationSummary = String(afterResult.result).slice(0, 2000);
        await executeEffect(state, {
          type: "emit_activity",
          activities: [{
            action: "code_verified" as const,
            selection: verificationSummary,
          }],
        }, userId);
      }
    } catch {
      // Verification is best-effort — don't block the agent if it fails
    }
  }

  await notifyGuardrailIfBlocked(execResult, state);

  // Step 5: Capture AFTER screenshot (best-effort)
  let afterScreenshot: string | undefined;
  if (execResult.success) {
    try {
      const screenshotCode = `const bytes = await figma.currentPage.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 0.25 } });
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
let r = '';
for (let i = 0; i < bytes.length; i += 3) {
  const a = bytes[i], b = bytes[i+1] || 0, c = bytes[i+2] || 0;
  r += chars[a >> 2] + chars[((a & 3) << 4) | (b >> 4)] + (i+1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : '=') + (i+2 < bytes.length ? chars[c & 63] : '=');
}
return r;`;
      const ssResult = await executeFigmaCode({
        pluginClientId: clientId, userId, code: screenshotCode,
        workflowId: state.orchestratorWorkflowId,
      });
      if (ssResult.success && ssResult.result) {
        afterScreenshot = String(ssResult.result).slice(0, 500_000);
      }
    } catch { /* best-effort */ }
  }

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
            content: `Code executed:\n\`\`\`js\n${effect.code}\n\`\`\`\n\nFigma canvas diff:\n${verificationSummary}${imageContext}${state.taskDescription ? `\n\nOriginal user task: ${state.taskDescription}` : ""}`,
            images: images.length > 0 ? images : undefined,
          },
        ],
        userId,
        model,
        maxTokens: 256,
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
        }],
      }, userId);
    } catch {
      // File review is best-effort
    }
  }

  // Inject result as tool result — include file review verdict so the agent understands what happened
  let execResultJson: string;
  if (execResult.success) {
    const parts = [
      "Execution succeeded.",
    ];

    parts.push("\nCode review: APPROVED");

    if (verificationSummary) {
      parts.push(`\nCanvas diff:\n${verificationSummary}`);

      // Phase 6 (C3): Extract and expose created node IDs for inter-step references
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
        parts.push("If your task is complete, call signal_task_complete now.");
        // Reset ALL failure tracking on verified success
        state.consecutiveFileReviewIssues = 0;
        resetPipelineFailures(state);
      } else {
        // Track consecutive issues to detect loops
        const consecutiveIssues = (state.consecutiveFileReviewIssues ?? 0) + 1;
        state.consecutiveFileReviewIssues = consecutiveIssues;

        parts.push(`\nFile review: ISSUE — ${fileReviewVerdict}`);

        // Circuit breaker for file review issues
        const escalation = recordPipelineFailure(state, fileReviewVerdict);
        if (escalation) {
          parts.push(escalation);
        } else if (consecutiveIssues >= 3) {
          parts.push(
            "WARNING: You have received the same ISSUE feedback multiple times. " +
            "Do NOT retry the same code. Try a DIFFERENT approach, or if you believe " +
            "the task is actually done, call signal_task_complete."
          );
        } else {
          parts.push("Look at the before/after screenshots to understand what went wrong. Fix the issue and retry with different code.");
        }
      }
    } else {
      // No file review — still a success, reset pipeline failures
      resetPipelineFailures(state);
      parts.push("If your task is complete, call signal_task_complete now.");
    }

    // Intent reminder — keep the original task visible after a few executions
    if (state.taskDescription && state.stepCount >= 5) {
      parts.push(`\n[Reminder] Your assigned task: "${state.taskDescription}". Ensure your code aligns with this.`);
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

  injectToolResult(state, effect.toolCallId, execResultJson, toolImages.length > 0 ? toolImages : undefined);
  recordExecResult(state, execResult.success ?? false);
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

// Re-export for convenience within the workflow sandbox
export type { AgentWorkflowInput } from "./types.js";

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export async function agentWorkflow(input: AgentWorkflowInput): Promise<void> {
  const state = createAgentState(input.agent);
  // Store original task for intent pinning (Phase 5 B2 + D1)
  state.taskDescription = input.task;
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

  // ── Wait for directory ───────────────────────────────────────────────────
  await condition(() => directoryReceived);

  // ── Inject system prompt (includes task context) ────────────────────────
  const peerAgents = Array.from(state.agentDirectory.values());
  const systemPrompt = buildAgentSystemPrompt(
    input.agent,
    "orchestrator",
    peerAgents,
    input.task
  );
  state.messageHistory.push({
    role: "system",
    content: systemPrompt,
  });

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
        });
        const responseEffects = processLLMResponse(
          state,
          llmResult.content,
          llmResult.toolCalls,
          llmResult.reasoning,
          llmResult.usage
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
            await handleReviewAndExecute(state, rEffect, input.userId, input.model);
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
          await executeLLMLoop(state, msgs, pendingLLM.tools, input.userId, input.model);
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
  tools: Parameters<typeof callLLM>[0]["tools"],
  userId: string,
  model?: string
): Promise<void> {
  let maxIterations = 200;

  while (maxIterations-- > 0 && !state.completed) {
    const llmResult = await callLLM({ messages, tools, userId, model });
    const effects = processLLMResponse(state, llmResult.content, llmResult.toolCalls, llmResult.reasoning, llmResult.usage);

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
        await handleReviewAndExecute(state, effect, userId, model);
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
