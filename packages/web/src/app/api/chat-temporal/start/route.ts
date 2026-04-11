/**
 * POST /api/chat-temporal/start
 *
 * Starts a new chatWorkflow for a conversation.
 * Resolves model, system prompt (with dynamic context), MCP connections, and launches the workflow.
 */

import { NextResponse } from "next/server";
import { createClient as createSupabaseUserClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { GUARDIAN_SYSTEM_PROMPT } from "@/lib/system-prompt";
import { createLogger } from "@/lib/log";
import {
  buildDynamicContext,
  type SelectedNode,
  type FigmaPluginContext,
  type ConnectedAgent,
} from "@/lib/chat-dynamic-context";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

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
  console.log("[chat-temporal/start] RAW body keys:", Object.keys(body), "designInstanceId:", body.designInstanceId, "codeInstanceId:", body.codeInstanceId);
  const {
    conversationId, message, model, mcpServerIds, figmaPluginClientId, images,
    selectedNode, figmaPluginContext, connectedAgents, isLocalPlugin, source, keyId,
    designInstanceId, codeInstanceId,
  } = body as {
    conversationId: string;
    message: string;
    model?: string;
    mcpServerIds?: string[];
    figmaPluginClientId?: string;
    images?: string[];
    selectedNode?: SelectedNode;
    figmaPluginContext?: FigmaPluginContext;
    connectedAgents?: ConnectedAgent[];
    isLocalPlugin?: boolean;
    source?: string;
    keyId?: string;
    /** V2: focus Design MCP instance ID (from TargetSelector) */
    designInstanceId?: string;
    /** V2: focus Code MCP instance ID (from TargetSelector) */
    codeInstanceId?: string;
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

    // Resolve key label for model identity injection
    let keyLabel: string | undefined;
    if (source === "byok" && keyId) {
      const { data: keyRow } = await supabase
        .from("user_api_keys")
        .select("provider, label")
        .eq("id", keyId)
        .single();
      if (keyRow) keyLabel = `provider=${keyRow.provider}, label=${keyRow.label || keyRow.provider}`;
    }

    // Build dynamic system prompt (parity with legacy /api/chat)
    const dynamicCtx = buildDynamicContext({
      selectedNode,
      figmaPluginContext,
      connectedAgents,
      isLocalPlugin,
      modelId: resolvedModel,
      source,
      keyLabel,
    });
    const systemPrompt = GUARDIAN_SYSTEM_PROMPT + dynamicCtx;

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

    // Resolve instance IDs server-side if frontend didn't provide them.
    // This handles: race conditions (hook not loaded yet), plugin-selected design target, etc.
    let resolvedDesignInstanceId = designInstanceId;
    let resolvedCodeInstanceId = codeInstanceId;
    if (!resolvedDesignInstanceId || !resolvedCodeInstanceId) {
      try {
        const { data: defaults } = await supabase
          .from("user_category_defaults")
          .select("category, instance_id")
          .eq("user_id", userId);
        for (const d of defaults ?? []) {
          if (!resolvedDesignInstanceId && d.category === "design" && d.instance_id) {
            resolvedDesignInstanceId = d.instance_id as string;
          }
          if (!resolvedCodeInstanceId && d.category === "code" && d.instance_id) {
            resolvedCodeInstanceId = d.instance_id as string;
          }
        }
      } catch { /* non-fatal — V1 fallback will handle it */ }

      // Last resort: pick the first enabled instance per category
      if (!resolvedDesignInstanceId || !resolvedCodeInstanceId) {
        try {
          const { data: instances } = await supabase
            .from("user_mcp_instances")
            .select("id, category, scope")
            .eq("enabled", true)
            .order("created_at", { ascending: true });
          for (const inst of instances ?? []) {
            if (!resolvedDesignInstanceId && inst.category === "design") {
              resolvedDesignInstanceId = inst.id as string;
            }
            if (!resolvedCodeInstanceId && inst.category === "code") {
              resolvedCodeInstanceId = inst.id as string;
            }
          }
        } catch { /* non-fatal */ }
      }
    }

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
        systemPrompt,
        mcpServerIds: mcpServerIds ?? [],
        figmaPluginClientId,
        focusDesignInstanceId: resolvedDesignInstanceId,
        focusCodeInstanceId: resolvedCodeInstanceId,
      }],
    });

    // Store workflowId in conversation metadata for F5 recovery.
    // Belt-and-suspenders: scope the update to the authenticated user so a
    // caller cannot hijack another user's conversation metadata even if
    // conversations RLS is misconfigured.
    await supabase
      .from("conversations")
      .update({ metadata: { chatWorkflowId: workflowId } })
      .eq("id", conversationId)
      .eq("user_id", userId);

    log.info("chatWorkflow started", { conv: conversationId, model: resolvedModel, mcpServerIds: mcpServerIds ?? [], figmaPluginClientId: figmaPluginClientId ?? null, hasDynamicCtx: dynamicCtx.length > 0, designInstanceId: designInstanceId ?? null, codeInstanceId: codeInstanceId ?? null });

    return NextResponse.json({ workflowId, conversationId });
  } catch (err) {
    log.error("failed to start chatWorkflow", { error: String(err) });
    return NextResponse.json(
      { error: `Failed to start chat workflow: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
