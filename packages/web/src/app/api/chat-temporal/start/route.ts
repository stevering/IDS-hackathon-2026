/**
 * POST /api/chat-temporal/start
 *
 * Starts a new chatWorkflow for a conversation.
 * Resolves model, system prompt, MCP connections, and launches the workflow.
 */

import { NextResponse } from "next/server";
import { createClient as createSupabaseUserClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { GUARDIAN_SYSTEM_PROMPT } from "@/lib/system-prompt";
import { createLogger } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (process.env.TEMPORAL_ENABLED !== "true") {
    return NextResponse.json({ error: "Temporal chat is not enabled" }, { status: 503 });
  }

  // Auth
  const supabase = await createSupabaseUserClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = user.id;

  const body = await request.json();
  const { conversationId, message, model, mcpServerIds, figmaPluginClientId, images } = body as {
    conversationId: string;
    message: string;
    model?: string;
    mcpServerIds?: string[];
    figmaPluginClientId?: string;
    images?: string[];
  };

  if (!conversationId || !message) {
    return NextResponse.json({ error: "Missing conversationId or message" }, { status: 400 });
  }

  const workflowId = `chat-${userId.slice(0, 8)}-${Date.now()}`;
  const log = createLogger("chat-temporal/start", { u: userId.slice(0, 8), wf: workflowId });

  try {
    const { getTemporalClient, getTaskQueue } = await import("@guardian/temporal/client");
    const client = await getTemporalClient();
    const taskQueue = getTaskQueue();

    // Resolve model from user settings if not specified
    let resolvedModel = model;
    if (!resolvedModel) {
      const sb = createServiceClient();
      const { data: settings } = await sb
        .from("user_settings")
        .select("default_model, usage_source")
        .eq("user_id", userId)
        .single();

      if (settings?.usage_source === "byok" && settings?.default_model) {
        resolvedModel = settings.default_model;
      }
      // Otherwise callLLMStreaming will resolve to free tier
    }

    // Persist user message via authenticated client (save_message RPC uses auth.uid())
    await supabase.rpc("save_message", {
      p_conversation_id: conversationId,
      p_role: "user",
      p_content: message,
      p_parts: [{ type: "text", text: message }],
      p_sender_client_id: null,
      p_sender_short_id: null,
      p_metadata: {},
    });

    // Start the workflow
    await client.workflow.start("chatWorkflow", {
      workflowId,
      taskQueue,
      args: [{
        conversationId,
        userId,
        userMessage: message,
        userImages: images,
        model: resolvedModel,
        systemPrompt: GUARDIAN_SYSTEM_PROMPT,
        mcpServerIds: mcpServerIds ?? [],
        figmaPluginClientId,
      }],
    });

    // Store workflowId in conversation metadata for F5 recovery
    await supabase
      .from("conversations")
      .update({ metadata: { chatWorkflowId: workflowId } })
      .eq("id", conversationId);

    log.info("chatWorkflow started", { conv: conversationId, model: resolvedModel, mcpServerIds: mcpServerIds ?? [], figmaPluginClientId: figmaPluginClientId ?? null });

    return NextResponse.json({ workflowId, conversationId });
  } catch (err) {
    log.error("failed to start chatWorkflow", { error: String(err) });
    return NextResponse.json(
      { error: `Failed to start chat workflow: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
