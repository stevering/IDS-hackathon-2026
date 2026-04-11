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

  const sb = createServiceClient();

  // ── Defense-in-depth: verify the workflow actually belongs to this conversation ──
  // Prevents the client from signalling a stale workflow from a previous
  // conversation — which would persist the user message to the wrong conv
  // and split assistant responses across conversations.
  let workflowMatchesConv = false;
  try {
    const { getTemporalClient } = await import("@guardian/temporal/client");
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowId);

    const desc = await handle.describe();
    if (desc.status.name === "RUNNING") {
      // Query the workflow for its bound conversationId (chatConversationIdQuery)
      let workflowConvId: string | null = null;
      try {
        workflowConvId = await handle.query<string>("chatConversationId");
      } catch {
        // Query handler not registered (older workflow) → assume mismatch to be safe
        workflowConvId = null;
      }

      if (workflowConvId && workflowConvId === conversationId) {
        workflowMatchesConv = true;

        // Save user message, then signal the workflow
        await supabase.rpc("save_message", {
          p_conversation_id: conversationId,
          p_role: "user",
          p_content: message,
          p_parts: [{ type: "text", text: message }],
          p_sender_client_id: null,
          p_sender_short_id: null,
          p_metadata: {},
        });

        await handle.signal("chatNewMessage", { content: message, images });
        log.info("signalled existing workflow", { conv: conversationId });
        return NextResponse.json({ workflowId, conversationId, action: "signalled" });
      } else if (workflowConvId && workflowConvId !== conversationId) {
        // Client sent a stale workflowId from a different conversation.
        // Do NOT signal it (would pollute the other conv). Start a new one instead.
        log.warn(
          `Workflow/conversation mismatch — wf=${workflowId.slice(0, 16)} is bound to conv=${workflowConvId.slice(0, 8)} ` +
            `but client requested conv=${conversationId.slice(0, 8)} — starting new workflow`,
        );
      }
    }
  } catch {
    // Workflow not found or not running — fall through to start a new one
  }

  // Workflow not running OR not matching conversationId → save message + start a new workflow
  if (!workflowMatchesConv) {
    await supabase.rpc("save_message", {
      p_conversation_id: conversationId,
      p_role: "user",
      p_content: message,
      p_parts: [{ type: "text", text: message }],
      p_sender_client_id: null,
      p_sender_short_id: null,
      p_metadata: {},
    });
  }

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
