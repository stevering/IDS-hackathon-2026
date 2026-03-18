/**
 * SSE endpoint for LLM intercept requests (dev-only).
 *
 * Subscribes to the Supabase Realtime channel `guardian:intercept:{userId}`
 * and relays `intercept_request` broadcasts as SSE events to the client.
 *
 * ## For AI agents (Claude Code, Cursor, etc.)
 *
 * This endpoint pushes intercept requests in real-time. Run it as a
 * background task to be notified when orchestration agents need a review.
 *
 * Each `data:` line is a JSON object with:
 * - requestId: unique ID to reference when responding
 * - context.purpose: "code_review" or "file_review"
 * - context.agentShortId: which agent is asking (e.g. "#Figma-Desktop-vopope")
 * - context.currentDirective: what the agent was asked to do
 * - llm.messages: the full prompt that would have been sent to the AI provider
 *
 * After reading a request, call the `respond_to_intercept` MCP tool with:
 * - code_review: "APPROVED" or "REJECTED: <reason>"
 * - file_review: "VERIFIED: <description>" or "ISSUE: <description>"
 *
 * If no response within 120s, the interceptor falls back to the original AI provider.
 *
 * ## Auth
 * MCP service key headers: x-mcp-service-key + x-mcp-user-id
 *
 * ## Usage
 *   export $(grep -v '^#' .env.local | grep STORAGE_SUPABASE_SERVICE_ROLE_KEY | xargs)
 *   curl -s -N \
 *     -H "x-mcp-service-key: $STORAGE_SUPABASE_SERVICE_ROLE_KEY" \
 *     -H "x-mcp-user-id: <USER_ID>" \
 *     http://localhost:3000/api/intercept/stream
 *
 * ## Dev-only
 * Returns 404 in production. The user must also enable "LLM call delegation"
 * in Account > Developers for the interceptor to actually delegate calls.
 */

import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // Dev-only guard
  if (process.env.NODE_ENV === "production") {
    return new Response("Not available in production", { status: 404 });
  }

  // Auth: MCP service key
  const serviceKey = request.headers.get("x-mcp-service-key");
  const userId = request.headers.get("x-mcp-user-id");
  const expectedKey = process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceKey || !userId || serviceKey !== expectedKey) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_STORAGE_SUPABASE_URL;
  if (!supabaseUrl || !expectedKey) {
    return new Response("Supabase not configured", { status: 500 });
  }

  const encoder = new TextEncoder();
  const supabase = createClient(supabaseUrl, expectedKey, {
    auth: { persistSession: false },
  });

  const channelName = `guardian:intercept:${userId}`;
  const channel = supabase.channel(channelName);

  const stream = new ReadableStream({
    start(controller) {
      let alive = true;

      // Keepalive every 15s
      const keepalive = setInterval(() => {
        if (alive) {
          controller.enqueue(encoder.encode(":keepalive\n\n"));
        }
      }, 15_000);

      // Listen for intercept requests
      channel
        .on("broadcast", { event: "intercept_request" }, (payload) => {
          if (!alive) return;
          const data = payload.payload;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
        })
        .subscribe();

      // Cleanup on client disconnect
      request.signal.addEventListener("abort", () => {
        alive = false;
        clearInterval(keepalive);
        channel.unsubscribe();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
