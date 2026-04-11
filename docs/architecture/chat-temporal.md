# Chat via Temporal Workflow

Durable chat conversations backed by Temporal workflows, with token-by-token streaming via Supabase Realtime.

## Motivation

Regular chat conversations (`POST /api/chat`) run entirely in a Next.js API route. If the browser tab is closed, the response is lost. Moving chat to Temporal makes conversations durable: the LLM response continues even if the user disconnects.

## Architecture

```
Browser (webapp)                    Temporal Worker
-----------------                   ------------------
POST /api/chat-temporal/start ----> chatWorkflow starts
  |                                   |
  | Subscribe to Realtime             | callLLMStreaming activity
  | channel: guardian:chat:{convId}   |   streamText() -> broadcast deltas
  | <- text_delta <---- Realtime <----|
  | <- tool_call_start                |
  | <- tool_call_result               | executeMCPTool / executeFigmaCode
  | <- text_complete                  |
  |                                   |
  | POST .../message  -------------> signal: chatNewMessage
  |                                   | -> next loop iteration
  | <- text_delta <---- Realtime <----|
  |                                   |
  | (user closes tab)                 | workflow continues!
  | (user reopens)                    |
  | Fetch messages from DB            | (already persisted)
  | Re-subscribe to Realtime          | (still streaming)
```

## Key Files

### Temporal (packages/temporal/)
- `workflows/chat.ts` - chatWorkflow state machine
- `activities/llm-streaming.ts` - callLLMStreaming with Realtime broadcast
- `activities/chat-persistence.ts` - persistChatMessage, loadChatHistory
- `signals/definitions.ts` - chatNewMessageSignal, chatCancelSignal, chatStatusQuery

### Web (packages/web/)
- `app/api/chat-temporal/start/route.ts` - Start a chatWorkflow
- `app/api/chat-temporal/[id]/stream/route.ts` - SSE relay (Realtime -> browser)
- `app/api/chat-temporal/[id]/message/route.ts` - Send follow-up message (signal or new workflow)
- `app/api/chat-temporal/[id]/cancel/route.ts` - Stop in-flight generation
- `app/hooks/useChatWorkflow.ts` - Browser hook replacing useChat
- `lib/chat-dynamic-context.ts` - Shared `buildDynamicContext()` used by the
  start route AND the message route so a follow-up that spawns a fresh
  workflow (previous one expired after 5 min idle) inherits the same Figma
  selection / plugin context / connected agents / model identity sections as
  the first message.

### Shared types (packages/orchestrations/)
- `types/events.ts` - Streaming event types (text_delta, text_complete, figma_execute_ack, etc.)

## Feature Flag

Controlled by `NEXT_PUBLIC_TEMPORAL_CHAT_ENABLED=true` (env var).

When enabled, `page.tsx` uses `useChatWorkflow` instead of `useChat` from `@ai-sdk/react`.

## Streaming Protocol

The `callLLMStreaming` activity broadcasts on Supabase Realtime channel `guardian:chat:{conversationId}`:

| Event | Payload | When |
|---|---|---|
| `text_delta` | `{ requestId, content }` | Each text chunk (~50ms intervals) |
| `reasoning_delta` | `{ requestId, content }` | Each reasoning chunk |
| `tool_call_start` | `{ requestId, toolName, toolCallId, args }` | LLM emits a tool call |
| `tool_call_result` | `{ toolCallId, result, isError }` | Tool execution completes |
| `text_complete` | `{ requestId, content, modelId, reasoning?, usage?, finishReason?, hasToolCalls }` | Streaming finished |

`finishReason` mirrors the AI SDK enum — `"stop"`, `"length"`, `"tool-calls"`,
`"content-filter"`, `"error"`, `"other"`, or `"unknown"`. It is also persisted
in `messages.metadata.finishReason` so the UI can render truncation hints
(`length` → "Response was cut off") or distinguish intentional stops from
errors on reload.

## Figma Execute ACK Protocol

Three-phase protocol to handle user approval delays:

```
Server                Plugin
  |                     |
  |-- execute_request ->|
  |                     |-- shows ApprovalOverlay
  |<-- execute_ack -----|  (status: "awaiting_approval")
  |                     |
  | (extends timeout    |  User reads code...
  |  to 120s)           |  User clicks "Allow"
  |                     |
  |<-- execute_result --|  (success/failure)
```

- ACK timeout: 10s (no ack = plugin offline)
- Approval timeout: 120s (after ack received)
- Files: `temporal/activities/figma-execute.ts`, `mcp/lib/figma-bridge.ts`, `web/hooks/useFigmaExecuteChannel.ts`

## chatWorkflow State Machine

```
INIT -> LOAD_HISTORY -> [LLM_CALL -> TOOL_EXECUTION]* -> PERSIST -> IDLE
                                                                     |
                                                       (chatNewMessageSignal)
                                                                     |
                                                            LLM_CALL -> ...
                                                                     |
                                                       (5min timeout) -> COMPLETED
```

- Each "turn" is a LLM call + optional tool execution loop (max 20 steps)
- Workflow stays alive in IDLE state for 5 minutes between messages
- Follow-up messages arrive via signal; if workflow expired, a new one starts
- Messages persist to DB after each completed turn

## Dynamic System Prompt Context

Both the start route and the message route build the system prompt as
`GUARDIAN_SYSTEM_PROMPT + dynamicContext` via the shared
`buildDynamicContext()` helper in `packages/web/src/lib/chat-dynamic-context.ts`.
The client (`useChatWorkflow`) sends the following context with **every**
request (start and follow-up) so whichever route ends up spawning a workflow
has the full picture:

| Context | Source | Injected when |
|---|---|---|
| Selected Figma node (URL + properties) | `selectedNode` from plugin | A node is selected in Figma |
| Figma plugin context (file, pages, user) | `figmaPluginContext` from plugin | Plugin is connected |
| Connected agents list + orchestration rules | `connectedAgents` from presence | Other clients are online |
| Model identity (modelId, BYOK/free tier) | `model`, `source`, `keyId` from settings | Always |

**Parity rule:** the message route MUST pass the same dynamic context to
`buildDynamicContext()` when it spins up a new workflow (previous one
expired after the 5 min idle timeout). Prior to the April 2026 audit pass,
this code path injected only the raw `GUARDIAN_SYSTEM_PROMPT` and the new
workflow booted with zero Figma awareness — the assistant could no longer
act on "this node" / "the current file" references mid-conversation.

**In-workflow freshness:** dynamic context is only rebuilt on workflow
start. If the Figma selection changes while a workflow is still in IDLE
state and the user sends a follow-up within 5 minutes, that follow-up
still uses the prompt from workflow start. Changing selection mid-workflow
does NOT update the running prompt (this matches the legacy `/api/chat`
behaviour). A fresh selection is only picked up once the idle timeout
expires and the message route has to boot a new workflow.

## Cancellation (Stop button)

Because Temporal workflows run in the cloud, **closing the browser tab does
not stop the generation** — the worker keeps streaming tokens to the Realtime
channel and persisting the assistant message. The only way to actually stop
an in-flight generation is the explicit **Stop button**.

### Flow

```
Browser                              Worker
  |                                    |
  |-- [Stop button click]              |
  |-- POST /api/chat-temporal/{wf}/cancel ->
  |                                    | handle.signal("chatCancel")
  |                                    |
  |                                    | setHandler(chatCancelSignal, () => {
  |                                    |   currentTurnScope.cancel();
  |                                    | })
  |                                    |
  |                                    | CancellationScope.cancellable(
  |                                    |   async () => await callLLMStreaming(...)
  |                                    | )
  |                                    |
  |                                    | Activity side:
  |                                    |   streamText({ abortSignal: ctx.cancellationSignal })
  |                                    |   fullStream for-await throws on abort
  |                                    |   → partial text finalized in DB
  |                                    |     with finishReason: "cancelled"
  |                                    |
  |<- text_complete (finishReason=cancelled) <-
  |                                    |
  |                                    | Workflow catches CancelledFailure via
  |                                    |   isCancellation(err), resets status
  |                                    |   to "idle", stays alive waiting for
  |                                    |   the next message signal.
```

### Immediate-stop semantics

The cancel signal targets the **current turn's** `CancellationScope`, not
the whole workflow. That matters because:

- **The partial text is preserved.** Whatever tokens streamed up to the
  Stop click are persisted to `messages` with `metadata.finishReason =
  "cancelled"` and `metadata.streaming = false`. The UI renders it as a
  normal (truncated) assistant turn. Users still see what they stopped.
- **The workflow stays alive.** After catching the `CancelledFailure`,
  `runLLMLoop` resets `status = "idle"` and returns to the outer
  `while (true)` loop. The next `chatNewMessage` signal starts a fresh
  turn in the SAME workflow (no new systemPrompt rebuild, no history
  reload) — cheaper and preserves all in-memory state.
- **Latency is bounded by the heartbeat interval.** The activity's
  `HEARTBEAT_INTERVAL_MS` is 1 s, so Temporal delivers the cancellation
  notice to the activity within ~1 s of the signal. The underlying
  fetch aborts immediately once `ctx.cancellationSignal.aborted` flips.
  In practice Stop feels instant.

Prior to the April 2026 audit pass, the cancel signal only set a
`cancelled` boolean flag that was checked at loop iteration boundaries —
meaning an in-flight LLM call could run for the full 5-minute
`startToCloseTimeout` before the cancel took effect. With BYOK, that was
up to 5 minutes of tokens burned after the user thought they had stopped.

### Client behaviour

- **Input stays active at all times** — the composer textarea is NOT set to
  `readOnly` during `isLoading`. This lets the user draft the next message
  while the current one is still generating, then hit Stop and submit.
- **GuardianSendButton morphs into Stop** when `isGenerating === true`:
  the mascot animates, on hover it cross-fades to a red square icon. Clicking
  in generating mode uses `type="button" onClick={cancelMessage}` so the form
  is NOT submitted — it only signals the workflow.
- **F5 recovery** — when the user closes the tab and comes back (possibly
  after logging in on another device), `useChatWorkflow.loadAndRecover()`
  pulls `conversation.metadata.chatWorkflowId` (stored by the start route)
  and rehydrates `workflowIdRef.current`. This is what makes Stop work after
  a reload — without it the hook has no workflowId to POST to.

### Routes

- `POST /api/chat-temporal/[id]/cancel` — authenticates, fetches the workflow
  handle, verifies `status === "RUNNING"`, signals `chatCancel`. No-op if
  the workflow is already `COMPLETED` / `FAILED` / `CANCELLED`.

## Follow-up Model Resolution

Every call to `POST /api/chat-temporal/[id]/message` re-reads
`user_settings.usage_source` + `user_settings.default_model` and passes the
resolved model to the workflow via `modelOverride` on the `chatNewMessage`
signal payload. This is necessary because workflows are long-lived (5 min
idle), and a user who changes their BYOK key or toggles `usage_source` in
Account > Settings between two messages would otherwise keep hitting the
model that was baked in at workflow start.

The workflow tracks a mutable `currentModel` variable that is updated by each
signal handler and passed to `callLLMStreaming` on every turn. The Temporal
worker's `resolveModelForActivity` still re-validates this value against
current `user_settings` + `user_api_keys` on every LLM call as a final safety
net (see `packages/temporal/src/activities/llm-resolver.ts`).

## Free Tier Usage Tracking

When `resolved.isFreeTier === true` (user is on the platform's included AI
Gateway key, not BYOK), `callLLMStreaming` fire-and-forgets an
`increment_usage` RPC after the streaming finishes:

```ts
snapshotSupabase.rpc("increment_usage", {
  p_user_id: params.userId,
  p_input_tokens: usage.inputTokens ?? 0,
  p_output_tokens: usage.outputTokens ?? 0,
  p_model: resolved.modelId,
});
```

This writes into `user_usage_log` so that:
- The Account > Usage page (`GET /api/user/usage` → `get_current_usage` RPC)
  stays in sync with what users actually consumed.
- Future quota enforcement can rely on the rolling 24h window already
  aggregated by `increment_usage`.
- BYOK users are NOT tracked here — their provider bills them directly.

This parity with the legacy `/api/chat` route was missing during the initial
Temporal migration and was restored in April 2026.

## Defence-in-depth: Conversation/Workflow Binding

To prevent cross-conversation message contamination (an earlier bug where
signalling a stale workflow would persist user messages to the wrong
conversation), the `POST /api/chat-temporal/[id]/message` route queries
`chatConversationIdQuery` on the target workflow before signalling. If the
workflow is bound to a different `conversationId` than what the client
claims, the route falls through to start a fresh workflow for the correct
conversation instead of cross-contaminating.

This is layered on top of the client-side reset in
`useChatWorkflow.ts` that clears `workflowIdRef.current` when the user
switches conversations — both layers must fail for contamination to recur.

## Conversation ownership checks

All chat-temporal routes authenticate the caller via `supabase.auth.getUser()`,
but auth alone is not enough — a caller could still pass a `conversationId`
belonging to another user. Each route therefore scopes its DB writes and
Realtime subscriptions to the authenticated user:

| Route | Check | Why |
|---|---|---|
| `POST /api/chat-temporal/start` | `conversations.update(...).eq("id", convId).eq("user_id", userId)` on the `metadata.chatWorkflowId` write | Prevent hijacking another user's workflow tracking |
| `POST /api/chat-temporal/[id]/message` | Same `.eq("user_id", userId)` when the route has to persist a new workflowId after spawning a fresh workflow | Same concern, follow-up path |
| `GET /api/chat-temporal/[id]/stream` | Explicit `SELECT user_id FROM conversations WHERE id = $1` and compare to `auth.uid()` before subscribing to the Realtime channel | RLS does **not** protect Supabase Realtime broadcast channels — the stream relays token-level deltas that would otherwise be readable by any authenticated user that knows the `conversationId` |
| `POST /api/chat-temporal/[id]/cancel` | Auth check only (workflow IDs are namespaced `chat-<userIdPrefix>-<ts>` and Temporal signals on foreign workflows are no-ops) | Minimal surface — attacker gains nothing by signalling an arbitrary workflow |

The stream check in particular is load-bearing: without it, a hostile
authenticated user who learned a `conversationId` could subscribe to the
SSE relay and watch another user's tokens, reasoning, and tool calls
stream live. Supabase RLS gates table reads but does not gate Realtime
broadcasts, so the check has to happen in the route itself.

## Figma Execute — subscribe-status handling

The `executeFigmaCode` activity uses a three-phase protocol (request → ack →
result) over a per-user Supabase Realtime channel. The activity must handle
the case where the **channel subscription itself** fails (not the plugin):

- The ACK and result timers only start AFTER the subscribe callback returns
  `SUBSCRIBED`. Prior to April 2026 they started synchronously, which meant
  a failed subscription still surfaced as "no ack received — plugin offline"
  at the 10 s mark, misleading operators who were actually dealing with a
  Realtime transport issue.
- `CHANNEL_ERROR`, `TIMED_OUT`, and `CLOSED` statuses are now settled with
  a distinct error that identifies transport failure explicitly.
- A 10 s `subscribeGuardTimer` covers the case where the subscribe callback
  never fires at all (silent network blackhole) — without this guard the
  activity would hang for the full 3-minute `startToCloseTimeout`.
