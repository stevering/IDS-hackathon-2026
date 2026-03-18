/**
 * LLM Intercept tools — dev-only tools for intercepting and responding to
 * delegated LLM calls from the orchestration pipeline.
 *
 * ## Context for AI agents (Claude Code, Cursor, etc.)
 *
 * When the user enables "LLM call delegation" in Account > Developers,
 * code_review and file_review LLM calls are delegated to YOU instead of
 * the AI provider. You become the reviewer.
 *
 * ### Workflow
 * 1. Start listening: call `watch_intercepts` (or use the SSE endpoint in background)
 * 2. Receive a request with: requestId, purpose (code_review/file_review),
 *    agent context (which agent, what directive, step count), and the full LLM prompt
 * 3. Review the content and respond via `respond_to_intercept`
 *
 * ### How to respond
 * - code_review: "APPROVED" if the Figma Plugin API code is correct.
 *   "REJECTED: <reason>" with numbered issues if it will cause runtime errors.
 *   Only reject for REAL errors (syntax, wrong API, undeclared vars). Not for style.
 * - file_review: "VERIFIED: <what was created>" if the canvas diff matches the code intent.
 *   "ISSUE: <problem>" only if nothing changed or the result is clearly wrong.
 *
 * ### SSE alternative (recommended for continuous listening)
 * Instead of calling watch_intercepts repeatedly, start a background SSE stream:
 *   curl -s -N -H "x-mcp-service-key: $KEY" -H "x-mcp-user-id: $UID" \
 *     http://localhost:3000/api/intercept/stream
 * Each `data:` line is a JSON intercept request. Use respond_to_intercept to reply.
 *
 * ### Timeout
 * If no response is received within 120s, the interceptor falls back to the
 * original AI provider. Respond promptly.
 *
 * ### Dev-only
 * These tools are NOT registered in production (NODE_ENV=production).
 * The user setting is also hidden in the UI in production.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { createMcpSupabaseClient } from "../lib/supabase.js"
import { formatToolResponse } from "../lib/format-response.js"

export function registerLLMInterceptTools(server: McpServer, userId?: string): void {
  // Dev-only: these tools are disabled in production.
  // The user must also enable "LLM call delegation" in Account > Developers.
  if (process.env.NODE_ENV === "production") return

  server.tool(
    "watch_intercepts",
    "Listen for delegated LLM calls from the orchestration pipeline (dev-only). " +
    "Returns when an intercept request arrives or after timeout. " +
    "The response includes the full LLM prompt, the purpose (code_review or file_review), " +
    "and tracing context (which orchestration, which agent, what directive, step count, exec stats). " +
    "After receiving a request, review the code/result and call respond_to_intercept with your verdict. " +
    "For code_review: respond 'APPROVED' or 'REJECTED: <reason>'. " +
    "For file_review: respond 'VERIFIED: <description>' or 'ISSUE: <description>'. " +
    "Tip: for continuous listening, use the SSE endpoint /api/intercept/stream as a background task instead.",
    {
      timeoutMs: z.number().optional().describe(
        "How long to wait for a request in ms (default: 60000). " +
        "The interceptor waits up to 120s for your response, so keep this under 120000."
      ),
    },
    async ({ timeoutMs }) => {
      if (!userId) {
        return formatToolResponse("No user ID available — cannot listen for intercepts.")
      }

      const supabase = createMcpSupabaseClient()
      const channelName = `guardian:intercept:${userId}`
      const channel = supabase.channel(channelName)
      const timeout = timeoutMs ?? 60_000

      return new Promise((resolve) => {
        let settled = false

        const timer = setTimeout(() => {
          if (!settled) {
            settled = true
            channel.unsubscribe()
            resolve(formatToolResponse(
              "No intercept requests received within timeout.",
              { timeout, channel: channelName }
            ))
          }
        }, timeout)

        channel
          .on("broadcast", { event: "intercept_request" }, (payload) => {
            if (!settled) {
              settled = true
              clearTimeout(timer)
              channel.unsubscribe()

              const data = payload.payload
              const ctx = data?.context ?? {}
              const llm = data?.llm ?? {}

              // Summarize messages for display (truncate long content)
              const messagesSummary = (llm.messages ?? []).map((m: { role: string; content: string }) => ({
                role: m.role,
                content: typeof m.content === "string"
                  ? m.content.slice(0, 500) + (m.content.length > 500 ? "..." : "")
                  : "[multimodal]",
              }))

              resolve(formatToolResponse(
                `Intercept request received! Purpose: ${ctx.purpose}, Agent: ${ctx.agentShortId ?? "N/A"}, Model: ${llm.model ?? "unknown"}. ` +
                `Use respond_to_intercept with requestId "${data.requestId}" to submit your response.`,
                {
                  requestId: data.requestId,
                  timestamp: data.timestamp,
                  context: ctx,
                  llm: {
                    model: llm.model,
                    maxTokens: llm.maxTokens,
                    messages: messagesSummary,
                    toolCount: llm.tools?.length ?? 0,
                  },
                }
              ))
            }
          })
          .subscribe()
      })
    }
  )

  server.tool(
    "respond_to_intercept",
    "Submit a response to a delegated LLM call (dev-only). " +
    "The requestId must match a pending intercept_request from watch_intercepts or the SSE stream. " +
    "For code_review purpose: respond 'APPROVED' if the code is correct, or 'REJECTED: <reason>' with issues. " +
    "For file_review purpose: respond 'VERIFIED: <description>' if the result is correct, or 'ISSUE: <description>'. " +
    "The response is broadcast on Supabase Realtime and picked up by the Temporal interceptor. " +
    "If not received within 120s, the interceptor falls back to the original AI provider.",
    {
      requestId: z.string().describe("The requestId from the intercept request (e.g. 'intercept-1773852526863-fwwn')"),
      content: z.string().describe(
        "The LLM response content. " +
        "For code_review: 'APPROVED' or 'REJECTED: <reason>\\n1. issue...'. " +
        "For file_review: 'VERIFIED: <what was created>' or 'ISSUE: <what went wrong>'."
      ),
    },
    async ({ requestId, content }) => {
      if (!userId) {
        return formatToolResponse("No user ID available — cannot respond to intercepts.")
      }

      const supabase = createMcpSupabaseClient()
      const channelName = `guardian:intercept:${userId}`
      const channel = supabase.channel(channelName)

      return new Promise((resolve) => {
        channel.subscribe((status) => {
          if (status === "SUBSCRIBED") {
            channel.send({
              type: "broadcast",
              event: "intercept_response",
              payload: { requestId, content },
            })

            // Give broadcast a moment to propagate, then cleanup
            setTimeout(() => {
              channel.unsubscribe()
              resolve(formatToolResponse(
                `Response sent for intercept ${requestId}.`,
                { requestId, contentLength: content.length, channel: channelName }
              ))
            }, 500)
          }
        })
      })
    }
  )
}
