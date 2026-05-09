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
  type ActiveTarget,
  type PendingDisambiguation,
  type RestEndpointInfo,
} from "@/lib/chat-dynamic-context";
import { enforceFreeTierQuota } from "@/lib/chat-quota";

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
    activeTarget,
    designInstanceId, codeInstanceId,
    pendingDisambiguation, restEndpoints,
    designPairingKind, codePairingKind,
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
    activeTarget?: ActiveTarget;
    /** V2: focus Design MCP instance ID (from TargetSelector) */
    designInstanceId?: string;
    /** V2: focus Code MCP instance ID (from TargetSelector) */
    codeInstanceId?: string;
    pendingDisambiguation?: PendingDisambiguation;
    restEndpoints?: RestEndpointInfo[];
    designPairingKind?: "explicit" | "auto-resolved" | "ambiguous" | "no-plugin";
    codePairingKind?: "explicit" | "auto-resolved" | "ambiguous" | "none";
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
    const sb = createServiceClient();
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
      // Otherwise callLLMStreaming will resolve to free tier
    }

    // ── Free-tier quota + model restriction pre-flight ────────────────────
    // Enforces the rolling 24h token limit and tier-allowed model list
    // BEFORE starting the workflow. Legacy parity: the old /api/chat route
    // rejected over-quota calls with 429 up front; the Temporal migration
    // dropped this and only incremented usage after the stream, allowing
    // free-tier users to burn unlimited tokens in a single session.
    // BYOK users bypass this check (they bring their own key).
    const quotaResult = await enforceFreeTierQuota({
      userId,
      requestedModel: resolvedModel,
      serviceClient: sb,
    });
    if (quotaResult.kind === "error") {
      log.warn("quota pre-flight rejected", { status: quotaResult.status, error: String(quotaResult.body.error ?? "unknown") });
      return NextResponse.json(quotaResult.body, { status: quotaResult.status });
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
      activeTarget,
      pendingDisambiguation,
      restEndpoints,
      designPairingKind,
      codePairingKind,
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
    //
    // ⚠️ IMPORTANT: skip the fallback when the resolver explicitly says
    // "ambiguous" for that category. The frontend has 2+ candidates and
    // wants the user to pick — auto-falling-back to first-enabled here
    // would silently expose tools from the wrong instance and the LLM
    // would never reach the disambig flow. Leaving the focus undefined
    // forces V2 discovery to either expose nothing or all-via-meta-tools,
    // and the LLM has to call request_target_disambiguation to proceed.
    let resolvedDesignInstanceId = designInstanceId;
    let resolvedCodeInstanceId = codeInstanceId;
    const allowDesignFallback = designPairingKind !== "ambiguous";
    const allowCodeFallback = codePairingKind !== "ambiguous";
    if (
      (allowDesignFallback && !resolvedDesignInstanceId) ||
      (allowCodeFallback && !resolvedCodeInstanceId)
    ) {
      try {
        const { data: defaults } = await supabase
          .from("user_category_defaults")
          .select("category, instance_id")
          .eq("user_id", userId);
        for (const d of defaults ?? []) {
          if (allowDesignFallback && !resolvedDesignInstanceId && d.category === "design" && d.instance_id) {
            resolvedDesignInstanceId = d.instance_id as string;
          }
          if (allowCodeFallback && !resolvedCodeInstanceId && d.category === "code" && d.instance_id) {
            resolvedCodeInstanceId = d.instance_id as string;
          }
        }
      } catch { /* non-fatal — V1 fallback will handle it */ }

      // Last resort: pick the first enabled instance per category
      if (
        (allowDesignFallback && !resolvedDesignInstanceId) ||
        (allowCodeFallback && !resolvedCodeInstanceId)
      ) {
        try {
          const { data: instances } = await supabase
            .from("user_mcp_instances")
            .select("id, category, scope")
            .eq("enabled", true)
            .order("created_at", { ascending: true });
          for (const inst of instances ?? []) {
            if (allowDesignFallback && !resolvedDesignInstanceId && inst.category === "design") {
              resolvedDesignInstanceId = inst.id as string;
            }
            if (allowCodeFallback && !resolvedCodeInstanceId && inst.category === "code") {
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
        // Forward the resolver's "ambiguous" output so the worker's
        // `request_target_disambiguation` tool can synthesize an up-to-date
        // QCM block when the LLM signals it needs the user to pick.
        pendingDisambiguation: pendingDisambiguation
          ? {
              category: pendingDisambiguation.category,
              candidates: pendingDisambiguation.candidates.map((c) => ({
                targetId: c.targetId,
                shortId: c.shortId,
                label: c.label,
                fileName: c.fileName,
                fileKey: c.fileKey,
              })),
              suggestionTargetId: pendingDisambiguation.suggestionTargetId,
            }
          : undefined,
        designPairingKind,
        codePairingKind,
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

    log.info("chatWorkflow started", {
      conv: conversationId,
      model: resolvedModel,
      mcpServerIds: (mcpServerIds ?? []).join(",") || null,
      mcpServerCount: mcpServerIds?.length ?? 0,
      figmaPluginClientId: figmaPluginClientId ?? null,
      hasDynamicCtx: dynamicCtx.length > 0,
      designInstanceId: designInstanceId ?? null,
      codeInstanceId: codeInstanceId ?? null,
      // Auto-target diagnostics — true when the frontend resolver said
      // "ambiguous" and forwarded the candidate list. If figmaPluginClientId
      // is null AND this is false, either the resolver returned "no-plugin"
      // (0 plugins) or the wire-up dropped the disambiguation payload.
      hasDisambig: !!pendingDisambiguation,
      disambigCandidateCount: pendingDisambiguation?.candidates.length ?? 0,
      restEndpointCount: restEndpoints?.length ?? 0,
    });

    return NextResponse.json({ workflowId, conversationId });
  } catch (err) {
    // Generate a short error ID that the user can surface in a bug report.
    // Logged on the server side with the full stack trace and returned to
    // the client as a grep-able correlation token. Legacy parity: the old
    // `/api/chat` route did the same with `err-${timestamp}-${random}` so
    // operators could find the matching server log line instantly.
    const errId = `err-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error("failed to start chatWorkflow", { errId, error: errMsg });
    return NextResponse.json(
      { error: `Failed to start chat workflow: ${errMsg}`, errId },
      { status: 500 }
    );
  }
}
