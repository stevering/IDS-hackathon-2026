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
- `app/hooks/useChatWorkflow.ts` - Browser hook replacing useChat

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
| `text_complete` | `{ requestId, content, modelId, usage }` | Streaming finished |

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

The start route builds the system prompt as `GUARDIAN_SYSTEM_PROMPT + dynamicContext`, matching the legacy `/api/chat` route. The client (`useChatWorkflow`) sends the following context with each request:

| Context | Source | Injected when |
|---|---|---|
| Selected Figma node (URL + properties) | `selectedNode` from plugin | A node is selected in Figma |
| Figma plugin context (file, pages, user) | `figmaPluginContext` from plugin | Plugin is connected |
| Connected agents list + orchestration rules | `connectedAgents` from presence | Other clients are online |
| Model identity (modelId, BYOK/free tier) | `model`, `source`, `keyId` from settings | Always |

The `buildDynamicContext()` function in the start route constructs these sections identically to the legacy chat route (lines 1088-1214 of `/api/chat/route.ts`).

Note: Dynamic context is captured at workflow start time. If the Figma selection changes mid-conversation, the system prompt is NOT updated (same behavior as legacy).
