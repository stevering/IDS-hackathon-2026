# Orchestration + MCP Integration — Issue List

> From E2E test on 2026-03-22, orchestration `orch-6285962c-1774206826658` (internal: `orch-1774206827111-4uojn4`), agent `#Figma-Desktop-pomipo` on file A, model `moonshotai/kimi-k2.5` via Vercel AI Gateway, with `figma_console_local` (stdio) MCP server.

---

## #1 — Subprocess npx latency at startup

**Context:** Event sequence 19:13:47 → 19:13:55 (MCP discovery phase)
**Bug:** `npx figma-console-mcp@latest` takes ~8 seconds to start (npm cache resolution + Node.js boot + WebSocket port binding + port file discovery). This adds to the already ~12s LLM latency for the first orchestrator + agent calls.
**Impact:** Medium — 20s total before the first Figma operation.
**First thought:** Pre-warm the subprocess pool when the Temporal worker starts (not per-orchestration). Or cache the npm package locally to skip the npx resolution.

---

## #2 — No LLM call logging in server logs

**Context:** Gaps 19:14:09 → 19:14:26 (17s) and 19:14:27 → 19:15:36 (69s) with zero temporal logs.
**Bug:** `callLLMDirect` in `llm.ts` does not log the start/end of LLM calls, the model used, token counts, or errors. The debug context (UI-side) has this info via activity events, but server-side logs are a black box.
**Impact:** Medium — debugging requires the UI debug context export; server logs alone are insufficient.
**First thought:** Add `log.info` before and after `generateText()` in `callLLMDirect` with model ID, purpose, prompt/completion token counts, and duration.

> Note: the UI debug context does capture usage per activity (promptTokens, completionTokens), so the data exists — it's just not in server logs.

---

## #3 — Orphan nodes from previous orchestrations

**Context:** Canvas snapshot BEFORE (event #9) shows node `582:36` "Design System" from a previous orchestration.
**Bug:** Failed or completed orchestrations leave Figma nodes on the page. No cleanup mechanism.
**Impact:** Low — visual clutter, doesn't break anything.
**First thought:** Add a cleanup step at orchestration start (remove nodes from previous failed orchestrations), or provide a "clean canvas" tool.

---

## #4 — `figmaconsole_figma_execute` skips code review

**Context:** Events #6-#7 — agent calls `figmaconsole_figma_execute` which goes straight to execution without code review.
**Bug:** `figma_plugin_execute` goes through a 2-phase pipeline: programmatic linter → LLM code review → execute. But `figmaconsole_figma_execute` (an MCP tool that also takes arbitrary code) bypasses both. The code `frame.name = "Design System"` was fine, but the title code (event #19) had a font loading bug that a code reviewer would have caught.
**Impact:** Medium — `figmaconsole_figma_execute` is essentially `figma_plugin_execute` routed through MCP, but without the safety net.
**First thought:** In `handleExecuteExternalTool`, detect when the tool name is `figma_execute` (any prefix) and run the code through `reviewFigmaCode` (linter) before execution. Optionally add LLM code review too.

---

## #5 — `mcp-exec` log says "Execution succeeded" when Figma returns `success:false`

**Context:** Event #21 — `mcp-exec` log: `result={"success":false,"error":"in set_characters: Cannot write..."}` → log message: `Execution succeeded`.
**Bug:** The `mcp-exec` logger reports "Execution succeeded" because the MCP HTTP call succeeded (200 OK). But the Figma operation inside failed. The log is misleading.
**Impact:** Medium — confusing when debugging from server logs.
**First thought:** Check `result.content[0].text` for `success:false` and log as `Execution returned error` instead of `Execution succeeded`.

---

## #6 — Canvas diff runs even when MCP returns `success:false`

**Context:** Events #22-#23 — after the font error, the pipeline still runs canvas snapshot AFTER + screenshot AFTER + file review LLM.
**Bug:** `handleExecuteExternalTool` runs the canvas diff unconditionally for write tools, even when the MCP result indicates failure. This wastes 4 Figma roundtrips + 1 LLM call for a known failure.
**Impact:** Low — wastes resources but doesn't break anything. The file review does correctly identify the issue ("ISSUE: Text node created but text is empty").
**First thought:** Skip canvas diff + file review when the MCP result contains `success:false`. Inject the error directly as the tool result.

---

## #7 — Non-atomic Figma execution creates orphan nodes

**Context:** Event #21 — `createText()` succeeds but `set_characters()` fails → empty TEXT node `585:56` (width=0, height=15) left on canvas.
**Bug:** Figma Plugin API operations are not transactional. `createText` + `appendChild` succeed, then `set_characters` fails, leaving a broken node.
**Impact:** Medium — orphan nodes accumulate and pollute the canvas.
**First thought:** This is a Figma API limitation, not easily fixable. The MCP server (Southleft) could wrap operations in try/catch and remove created nodes on failure. Or the agent prompt could instruct cleanup of failed nodes.

---

## #8 — Kimi-k2.5 alternates between structured tool calls and text-based tool calls

**Context:** Events #6→#83 — kimi starts with real tool calls (events #6, #19, #45, #54) but progressively switches to writing `[Called tool: figmaconsole_figma_execute({...})]` in text (events #32, #37, #55, #60, #69, #74, #82, #83). Pattern correlates with context size: real tool calls up to ~26k tokens, text-based after.
**Bug:** Kimi-k2.5 inconsistently uses structured tool_use vs text-based tool invocation. At higher context sizes (>26k tokens), it increasingly writes tool calls as plain text in `content` instead of structured `toolCalls`.
**Impact:** Critical — the agent's tool calls don't execute, the orchestration stalls.
**First thought:** This is a model behavior issue. Mitigations: (1) reduce context size (summarize history), (2) use a model with more reliable tool calling, (3) detect and nudge (implemented — see fix below). The nudge fix detects `[Called tool:` patterns in text and asks the LLM to retry with a real tool call.

---

## #9 — `extractTextToolCalls` whitelist doesn't include MCP tool names

**Context:** Event #32 — `[Called tool: figmaconsole_figma_execute({...})]` written in text → `extractTextToolCalls` regex matches it → but `TOOL_NAMES` whitelist (`agent-logic.ts:321`) only contains `figma_plugin_execute`, `signal_task_complete`, etc. → `figmaconsole_figma_execute` is skipped.
**Bug:** `TOOL_NAMES` is a hardcoded whitelist of engine tools. External MCP tools (`figmaconsole_*`, `github_*`) are never detected by `extractTextToolCalls`.
**Impact:** High — text-based MCP tool calls are silently ignored, contributing to idle loops.
**First thought:** Instead of adding all MCP tools to the whitelist (which is dynamic), the nudge approach (issue #8 fix) is better — detect the pattern and ask the LLM to retry properly. For simple tools like `signal_task_complete`, the existing extraction is fine.

> **Fix implemented:** Added pattern detection in `processLLMResponse` that detects `[Called tool:` in text and nudges the LLM to use structured tool_use instead. Does not increment idle counter.

---

## #10 — Idle loop counter doesn't distinguish "useful text" from "empty text"

**Context:** Events #24, #32, #37, #55, #60, #69 — agent writes detailed plans + code but without tool calls → each counts as +1 idle → at 5 → FAILED.
**Bug:** `consecutiveTextOnlyResponses` increments for any text response without tool calls, regardless of whether the text contains useful content (plans, code) or is truly idle.
**Impact:** High — agent with a font error writes the fix code in text (useful!) but gets killed after 5 attempts.
**First thought:** With the nudge fix (issue #8), most of these would be caught before counting as idle. But the counter could also differentiate: reset it when the LLM shows intent to work (code blocks, tool name references) vs truly empty/repetitive text.

> **Fix implemented:** The nudge for `[Called tool:` and ````js` + `figma.` patterns returns early before the idle counter, so these no longer count toward the 5-text limit.

---

## #11 — Orchestration status "completed" when agent failed

**Context:** Final state: agent `status: "failed"` with summary "Agent FAILED: 5 consecutive text responses", but orchestration `completedStatus: "completed"`.
**Bug:** When the agent reports `status: "failed"`, the orchestrator receives it and processes it. But `checkCompletion` in `orchestrator-logic.ts` marks the orchestration as "completed" (all agents done = completed), not distinguishing between successful completion and failure.
**Impact:** Critical — the UI shows "completed" (green) for a failed orchestration.
**First thought:** `checkCompletion` should check if any agent has `status: "failed"` and set the orchestration result to `"completed_with_errors"` or `"failed"` accordingly.

> **Fix implemented:** `checkCompletion` now computes the orchestration status based on agent outcomes: all agents failed → `"failed"`, mix of failed and completed → `"completed_with_errors"`, all completed → `"completed"`. New status values added to `OrchestratorState`, `OrchestrationResult`, `OrchestrationStatusResponse`, and `orchestration_completed` SSE event types. UI updated (banner + event log) with red styling for failed/completed_with_errors. SSE replay route now extracts the real status from persisted events instead of hardcoding `"completed"`. 3 new unit tests added.

---

## #12 — Plugin UI orchestration rendering regression

**Context:** User reported that orchestration display in the Figma plugin is no longer formatted like in the webapp.
**Bug:** Not investigated in depth during this session.
**Impact:** Medium — reduced usability for users following orchestrations from the plugin.
**First thought:** Compare the rendering code in `ui.html` (plugin) vs the webapp orchestration view. May be a CSS or event parsing regression.

---

## #13 — Action name "thinking" is confusing

**Context:** Throughout the trace — every `content` text from the LLM is emitted as `action: "thinking"`.
**Bug:** The action name `"thinking"` in `processLLMResponse` (line 426) is used for the LLM's `content` text response. This is confusing because: (1) it's not the LLM's internal reasoning (which would be `action: "reasoning"`), (2) the UI displays it under a "thinking" label suggesting internal reflection, (3) it's actually the LLM's public response that happens to contain plans/code.
**Impact:** Low — cosmetic/naming confusion, but makes debug traces harder to interpret.
**First thought:** Rename to `"assistant_text"` or `"response"` in the engine. Or keep `"thinking"` but only emit it when the response also has tool calls (i.e., the text is a preamble to action). When the text IS the response (no tool calls), emit as `"assistant_message"`.

> **Fix implemented:** Renamed across the entire pipeline:
> - Agent activity: `"thinking"` → `"assistant_text"` (signals.ts, agent-logic.ts, event-meta.ts, OrchestrationEventLog.tsx)
> - Orchestrator event: `"orchestrator_thinking"` split into `"orchestrator_text"` (content) + `"orchestrator_reasoning"` (reasoning) — events.ts, orchestrator-logic.ts, event-meta.ts, OrchestrationEventLog.tsx
> - UI labels updated: "response" / "reasoning" instead of "thinking"
> - `"reasoning"` (agent) unchanged — it was already correct
> - All tests updated (151 pass). Build OK across orchestrations, temporal, web.

---

## #14 — No reasoning/thinking middleware in Temporal worker

**Context:** Zero `"reasoning"` events in the entire trace despite kimi-k2.5 supporting thinking mode.
**Bug:** The chat route (`route.ts`) configures `extractReasoningMiddleware({ tagName: 'thinking' })` and adds `<thinking>` instructions to the system prompt. The Temporal worker's `callLLMDirect` does neither. Result: kimi puts its reasoning in `content` (mixed with useful output), not in a separate `reasoning` field.
**Impact:** High — the agent's "thinking" pollutes its conversation history (30k+ tokens of plans/code that should have been reasoning), contributes to context bloat, and confuses the orchestrator which receives these text dumps as "reports".
**First thought:** Add `extractReasoningMiddleware` to `generateText()` in `callLLMDirect`. Add `<thinking>` instruction to the agent system prompt. This would separate internal reasoning from actionable output.

> **Root cause found:** The Vercel AI Gateway DOES transform kimi-k2.5's `reasoning_content` into LMS v3 `{ type: "reasoning" }` parts correctly. `result.reasoning` contains valid reasoning parts. The bug was in `callLLMDirect` line 362: `.filter((p) => p.type === "text")` — but AI SDK v6 reasoning parts have `type: "reasoning"`, not `type: "text"`. This filter silently discarded ALL reasoning parts.
>
> **Fix implemented (2 parts):**
> 1. **Reasoning extraction bug:** Replaced `.filter((p) => p.type === "text")` with `result.reasoningText` (AI SDK v6 built-in accessor). The filter was discarding all reasoning parts because they have `type: "reasoning"` in LMS v3 format.
> 2. **Fallback for non-reasoning models:** Added Gateway capabilities cache (in-memory, 24h TTL) that fetches the model catalog from `ai-gateway.vercel.sh/v1/models`. Models without the `"reasoning"` tag get `extractReasoningMiddleware({ tagName: "thinking" })` + a `<thinking>` system prompt instruction — same approach as the chat route. Models with native reasoning (kimi-k2.5, gemini-2.5-flash, Claude, etc.) are used as-is.
>
> Verified with test script against live kimi-k2.5 via Gateway: reasoning arrives natively as `{ type: "reasoning" }` parts. Build + 151 tests pass.

---

## #15 — Same tool call emitted twice (events #6 and #7)

**Context:** Events #6 and #7 both contain `tool_call figmaconsole_figma_execute` with the same code, but different `promptTokens` (24,077 vs 24,324 = 247 token difference).
**Bug:** Two separate LLM calls produce the same tool call. The first (event #6) has the tool call as part of a batch with `thinking`. The second (event #7) is a standalone tool call with its own usage. This suggests the tool call may execute twice, or there's a re-emission in the activity pipeline.
**Impact:** Medium — potential double execution of Figma code. Needs deeper investigation in `executeLLMLoop` to understand why two LLM calls happen for the same step.
**First thought:** Investigate whether `executeLLMLoop` re-calls the LLM after an `execute_external_tool` effect is queued but before it completes. The 247-token difference could be the tool result being injected between calls.

---

## #16 — MCP tool result is triple-wrapped JSON

**Context:** Event #8 — `external_tool_result` summary contains `{"content":[{"type":"text","text":"{\"success\":true,\"result\":\"585:55\"}"}],"isError":false}`.
**Bug:** The result injected into the agent's conversation history has 3 levels of JSON wrapping: (1) Figma result `{success, result}`, (2) MCP content wrapper `{content: [{type, text}]}`, (3) activity summary string. The agent has to parse through all this to find the node ID `585:55`.
**Impact:** Medium — wastes tokens in the agent's context, makes it harder for the LLM to extract useful data (node IDs), may contribute to the model getting confused and switching to text-based tool calls.
**First thought:** In `handleExecuteExternalTool`, unwrap the MCP content format before injecting. Extract `content[0].text` and parse the inner JSON. Inject a clean result like `{"success":true,"result":"585:55"}` instead of the full MCP wrapper.

---

## #17 — Canvas diff and file review displayed as two separate blocks

**Context:** After event #8 — UI shows `code_verified` (canvas diff) then `file_review_llm_response` (LLM verdict) as two separate blocks.
**Bug:** The `code_verified` event and the `file_review_llm_response` event are rendered as two distinct UI blocks, but they concern the same operation. The file review already includes the diff in its "Figma diff" section, making the first block redundant.
**Impact:** Low — visual noise in the UI, no functional impact.
**First thought:** In the UI renderer, suppress `code_verified` when a `file_review_llm_response` follows immediately for the same agent. Or merge them into a single expandable block.

---

## #18 — Agent report displayed twice (orchestrator_input + agent_report)

**Context:** Events #25-#26, #33-#34, #56-#57, etc. — every agent report appears as both `orchestrator_input` and `agent_report` in the UI.
**Bug:** Two events are emitted for the same report: `orchestrator_input` (what the orchestrator receives) and `agent_report` (what the agent sent). The UI displays both, showing the same content twice.
**Impact:** Low — visual clutter, confusing for users who see the same message twice.
**First thought:** In the UI renderer, deduplicate — show only the `agent_report` view, or merge both into one block with "Agent → Orchestrator" label.

---

## #19 — "Thinking" text shown alongside its tool call

**Context:** Event #6 — `thinking` (plan + code block) immediately followed by `tool_call figmaconsole_figma_execute` (same code) in the same activity batch.
**Bug:** When the LLM returns both `content` text and structured `toolCalls`, both are displayed. The text contains the same code that the tool call will execute, creating visual duplication. However — this relates to issue #14: the text should have been in `reasoning` (hidden from UI by default), not in `content`.
**Impact:** Low if #14 is fixed (reasoning would be hidden). Medium if not fixed.
**First thought:** Fixing #14 (add reasoning middleware) would naturally solve this — the plan/code would go into reasoning (collapsed by default in UI), and only the tool call would be prominently displayed.

---

## #20 — Agent text content sent as report to orchestrator

**Context:** Events #24→#25→#26 — agent writes code in text (no tool call) → engine sends `content` as `report_to_orchestrator(status: "in_progress", summary: <the code>)` → orchestrator receives JS code as a "progress report" and thinks the agent progressed.
**Bug:** Two coupled issues:
1. **Agent-side:** In `processLLMResponse`, when the LLM responds with text but no tool calls, the entire `content` was sent as `summary` in a `report_to_orchestrator` effect + `wait_for_input`. This forwarded raw code/plans to the orchestrator as fake progress, then the agent stopped and waited.
2. **Orchestrator-side:** `send_agent_directive` had no guard against sending a new directive to an agent still working on one (`status: "active"` without a `completed` lastReport). The orchestrator LLM could pile up directives.
**Impact:** Critical — the orchestrator was misled (receives code as "progress"), sends the next directive, agent moves on without executing the first task. Directive pileup and desynchronization.

> **Fix implemented (2 parts):**
> 1. **Agent:** Text-only responses no longer report to orchestrator. Instead, a nudge is injected ("You MUST call a tool") and the LLM is retried. The idle counter (5) remains as guard. Consistent with existing nudges for `[Called tool:]` and code block patterns.
> 2. **Orchestrator:** `send_agent_directive` now rejects sending to an agent with `status: "active"` unless `lastReport.status === "completed"` (standby mode). Error message tells the LLM to wait for the agent's completion report.
> 4 new tests added (2 agent-logic, 2 orchestrator-logic). 151 tests pass.

---

## #21 — Same content displayed 3 times (thinking + orchestrator_input + agent_report)

**Context:** Events #24, #25, #26 — the agent's text response appears as: (1) `thinking` block, (2) `Guardian → Orchestrator` message, (3) `Agent → Guardian` report.
**Bug:** A single LLM text response traverses 3 layers (engine activity → orchestrator signal → event log) and each layer emits a visible UI event. The same JS code appears 3 times in the orchestration timeline.
**Impact:** Medium — makes the UI very noisy and hard to follow. 93 events in total for an orchestration that only executed 2 Figma operations.
**First thought:** (1) Fix #14 to move plans/code into reasoning (hidden). (2) Deduplicate `orchestrator_input` and `agent_report` in the UI (issue #18). (3) Don't emit `thinking` when it's followed by a `report_to_orchestrator` with the same content.

---

## Summary by priority

### Critical (blocks successful orchestrations)
- **#8** — Kimi alternates between structured and text-based tool calls
- **#11** — Orchestration "completed" when agent failed *(fix implemented)*
- **#20** — Agent text sent as report misleads orchestrator *(fix implemented: agent nudge + orchestrator directive guard)*

### High (significantly degrades quality)
- **#9** — `extractTextToolCalls` whitelist missing MCP tools *(fix implemented: nudge)*
- **#10** — Idle loop counter kills agents with useful text *(fix implemented: nudge)*
- **#14** — No reasoning middleware in Temporal worker *(fix implemented: type filter bug)*
- **#16** — Triple-wrapped JSON in tool results

### Medium (should fix)
- **#1** — 8s npx subprocess latency
- **#2** — No LLM call logging in server logs
- **#4** — `figmaconsole_figma_execute` skips code review
- **#5** — Misleading "Execution succeeded" log
- **#7** — Non-atomic Figma execution
- **#12** — Plugin UI orchestration rendering regression
- **#15** — Same tool call emitted twice
- **#21** — Same content displayed 3 times in UI

### Low (cosmetic/minor)
- **#3** — Orphan nodes from previous orchestrations
- **#6** — Canvas diff runs on known failures
- **#13** — Action name "thinking" is confusing *(fix implemented: renamed to assistant_text/orchestrator_text/orchestrator_reasoning)*
- **#17** — Canvas diff + file review shown as two blocks
- **#18** — Agent report displayed twice
- **#19** — Thinking text alongside tool call (solved by #14)
- **#22** — Orchestration without explicit model uses free tier instead of user's BYOK default
- **#23** — Multi-agent message source identification (XML metadata tags)

---

## #22 — Orchestration without explicit model should use user's BYOK default

**Context:** When `start_collab` is called without a `model` parameter (e.g. from MCP), the resolver falls back to the free tier (XAI `grok-4-1-fast-non-reasoning`) even if the user has a BYOK Gateway key configured in their account.
**Bug:** `resolveModelForActivity` requires a `provider/model-id` format string to attempt BYOK lookup. When `model` is undefined or has no `/`, it skips BYOK entirely and goes straight to free tier. There is no mechanism to resolve the user's default BYOK key + a sensible default model.
**Impact:** High — users with a paid Gateway key get the free tier model in orchestrations unless they explicitly pass `model` every time. The MCP `start_collab` tool makes model optional, so most MCP-initiated orchestrations use the wrong model.
**First thought:** In `resolveModelForActivity`, when `requestedModel` is undefined/empty:
1. Check if the user has a default BYOK key (gateway or direct provider) via `get_api_key_for_user`
2. If gateway key exists → use it with a sensible default model (e.g. the user's last selected model from `user_settings`, or a hardcoded default like `google/gemini-2.5-flash`)
3. If no BYOK key → free tier with usage limit enforcement
This also requires storing the user's preferred default model in `user_settings` so the resolver can pick it up without the frontend passing it explicitly.

---

## #23 — Multi-agent message source identification (XML metadata tags)

**Context:** In orchestrations, all messages injected into LLM conversation histories use `role: "user"` regardless of the actual source (guardian engine, orchestrator, other agents, real user). The LLM cannot distinguish who sent what.
**Bug:** Nudges, directives, agent reports, broadcasts, and user messages all look identical to the LLM. This causes confusion (e.g. agent replies to a guardian nudge as if it were a user message) and makes debugging harder.
**Impact:** Medium — contributes to model confusion and text-based tool call fallbacks. Also affects UI readability.

### Design

**Two metadata formats** depending on the model:

1. **XML tags** (default) — for models that handle XML well (kimi, Claude, Gemini, GPT):
```xml
<message from="guardian-engine" to="agent-#Figma-Desktop-pomipo" event="guardian_feedback">
You must call a tool to make progress.
</message>
```

```xml
<message from="orchestrator" to="agent-#Figma-Desktop-pomipo" event="orchestrator_directive">
Create the color palette in container 601:81
</message>
```

```xml
<message from="agent-#Figma-Desktop-pomipo" to="orchestrator" event="agent_report">
Task done, node 601:81
</message>
```

2. **Bracket prefix** (fallback) — for models that struggle with XML tags:
```
[from: guardian-engine | to: agent-#Figma-Desktop-pomipo | event: guardian_feedback]
You must call a tool to make progress.
```

### Notes on format
- **`event`** (not `type`) to avoid confusion with XML/HTML `type` attributes
- Event names reuse the existing orchestration event vocabulary (same names as SSE events)
- The LLM sees the event name and understands the context (a `guardian_feedback` is system feedback, an `orchestrator_directive` is a task assignment)

### Model config table

New Supabase table `guardian_model_config`:
| Column | Type | Description |
|---|---|---|
| `model_id` | text PK | e.g. `"moonshotai/kimi-k2.5"` |
| `message_metadata_format` | text | `"xml-message"` (default) or `"prefix"` |
| `notes` | text | Why this model needs a specific format |

Fallback: if model not in table → `"xml-message"`.

### Event names (reuse existing vocabulary)

| `event` value | Source → Target | When |
|---|---|---|
| `orchestrator_directive` | orchestrator → agent | `send_agent_directive` |
| `agent_report` | agent → orchestrator | `report_to_orchestrator` |
| `guardian_feedback` | guardian-engine → agent/orchestrator | Text-only response nudges, tool result injections |
| `orchestrator_broadcast` | orchestrator → all | Text broadcast to active agents |
| `user_input` | user → orchestrator | Human message via signal |
| `peer_message` | agent → agent | Direct peer communication |
| `orchestrator_brief` | guardian-engine → orchestrator | Initial task briefing |

### Scope of changes

- **Utility function** `wrapMessage(content, from, to, event, modelId)` → returns wrapped string based on model config
- **All message injections** in `agent-logic.ts`, `orchestrator-logic.ts`, and workflow files
- **System prompts** — explain the metadata format so the LLM knows what the tags mean
- **UI** — display metadata as-is initially (don't hide), later parse for structured rendering
- **DB** — metadata stored in `orchestration_events.payload` (already JSONB, no schema change)
- **Gateway capabilities cache** — extend to also cache model config from `guardian_model_config`
