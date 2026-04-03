/**
 * POST /api/chat-temporal/[id]/message
 *
 * Sends a follow-up message to an active chatWorkflow via signal.
 * If the workflow has completed, starts a new one.
 */

import { NextResponse } from "next/server";
import { createClient as createSupabaseUserClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { GUARDIAN_SYSTEM_PROMPT } from "@/lib/system-prompt";
import { createLogger } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workflowId } = await params;

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

  if (!message) {
    return NextResponse.json({ error: "Missing message" }, { status: 400 });
  }

  const log = createLogger("chat-temporal/message", { u: userId.slice(0, 8), wf: workflowId });

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
  const sb = createServiceClient();

  try {
    const { getTemporalClient } = await import("@guardian/temporal/client");
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowId);

    // Check if workflow is still running
    const desc = await handle.describe();
    if (desc.status.name === "RUNNING") {
      // Signal the running workflow with the new message
      await handle.signal("chatNewMessage", {
        content: message,
        images,
      });
      log.info("signalled existing workflow", { conv: conversationId });
      return NextResponse.json({ workflowId, conversationId, action: "signalled" });
    }
  } catch {
    // Workflow not found or not running — start a new one
  }

  // Workflow completed/not found — start a new one
  log.info("starting new workflow for follow-up", { conv: conversationId });

  try {
    const { getTemporalClient, getTaskQueue } = await import("@guardian/temporal/client");
    const client = await getTemporalClient();
    const taskQueue = getTaskQueue();

    // Resolve model
    let resolvedModel = model;
    if (!resolvedModel) {
      const { data: settings } = await sb
        .from("user_settings")
        .select("default_model, usage_source")
        .eq("user_id", userId)
        .single();
      if (settings?.usage_source === "byok" && settings?.default_model) {
        resolvedModel = settings.default_model;
      }
    }

    const newWorkflowId = `chat-${userId.slice(0, 8)}-${Date.now()}`;
    await client.workflow.start("chatWorkflow", {
      workflowId: newWorkflowId,
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

    log.info("new chatWorkflow started", { newWf: newWorkflowId, conv: conversationId });
    return NextResponse.json({ workflowId: newWorkflowId, conversationId, action: "started" });
  } catch (err) {
    log.error("failed to start new chatWorkflow", { error: String(err) });
    return NextResponse.json(
      { error: `Failed to start chat workflow: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
