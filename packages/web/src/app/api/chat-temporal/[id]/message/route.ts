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
  const {
    conversationId,
    message,
    model,
    mcpServerIds,
    figmaPluginClientId,
    images,
    // Dynamic context — forwarded by useChatWorkflow on every send so that if
    // this route has to spin up a NEW workflow (previous one expired after
    // 5 min idle), the fresh system prompt captures the user's latest Figma
    // selection, plugin context, agent presence, and model identity. Without
    // this, every follow-up after an idle timeout would reboot with an empty
    // system prompt and the assistant would lose all situational awareness.
    selectedNode,
    figmaPluginContext,
    connectedAgents,
    isLocalPlugin,
    source,
    keyId,
    activeTarget,
    // V2 focus instance IDs from the TargetSelector. When this route has to
    // spin up a new chatWorkflow (idle timeout, first follow-up after reload,
    // etc.), these drive the V2 discovery path — without them the workflow
    // falls back to V1 legacy MCP discovery and the LLM only sees the
    // hardcoded cloud servers (figma_console, github, guardian), never the
    // user's selected local instance (e.g. figmadesktop).
    designInstanceId,
    codeInstanceId,
    pendingDisambiguation,
    restEndpoints,
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
    designInstanceId?: string;
    codeInstanceId?: string;
    pendingDisambiguation?: PendingDisambiguation;
    restEndpoints?: RestEndpointInfo[];
  };

  if (!message) {
    return NextResponse.json({ error: "Missing message" }, { status: 400 });
  }

  const log = createLogger("chat-temporal/message", { u: userId.slice(0, 8), wf: workflowId });

  const sb = createServiceClient();

  // ── Resolve the user's current preferred model ─────────────────────────
  // Re-read user_settings on every follow-up so changes to `usage_source` or
  // `default_model` between turns take effect. Without this, a workflow
  // started in BYOK mode would keep using the old BYOK model even after the
  // user switched back to the included free tier in Account > Settings.
  //
  // The resolved model is sent to the workflow in two places:
  //   - in the signal payload (`modelOverride`) for an existing workflow
  //   - in the workflow start args (`model`) when a new workflow is started
  //
  // The Temporal worker's `resolveModelForActivity` will still re-validate
  // this value against `user_settings` + `user_api_keys` for every LLM call,
  // so this is a "best-effort hint" rather than an authoritative override.
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

  // ── Free-tier quota + model restriction pre-flight ──────────────────────
  // Must run BEFORE either the signal-existing-workflow branch or the
  // start-new-workflow branch. Legacy parity: the old /api/chat route
  // rejected over-quota calls with 429 up front. Without this, a follow-up
  // message on an existing workflow would queue against a user who has
  // already exhausted their rolling 24h quota. BYOK users bypass.
  const quotaResult = await enforceFreeTierQuota({
    userId,
    requestedModel: resolvedModel,
    serviceClient: sb,
  });
  if (quotaResult.kind === "error") {
    log.warn("quota pre-flight rejected", { status: quotaResult.status, error: String(quotaResult.body.error ?? "unknown") });
    return NextResponse.json(quotaResult.body, { status: quotaResult.status });
  }

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

        await handle.signal("chatNewMessage", {
          content: message,
          images,
          modelOverride: resolvedModel,
          // null = "unpair this turn" (REST-only); undefined = "no change".
          // The frontend sends `figmaPluginClientId: undefined` when the
          // resolver returns `ambiguous` or `no-plugin`, so we map that
          // explicitly to null to clear the worker's currentPluginClientId.
          pluginClientIdOverride: figmaPluginClientId ?? null,
          // null = "no longer ambiguous" (user picked or one plugin closed);
          // object = "new candidates" (a plugin opened/closed mid-conv).
          // The worker's `request_target_disambiguation` tool reads this to
          // build the QCM block at call time.
          pendingDisambiguationOverride: pendingDisambiguation
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
            : null,
        });
        log.info("signalled existing workflow", { conv: conversationId, model: resolvedModel });
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

    // `resolvedModel` was already computed at the top of the handler — reuse it.

    // Resolve the BYOK key label for the model-identity section. Same logic as
    // /api/chat-temporal/start so that the system prompt reports the correct
    // provider/label when the user is on BYOK.
    let keyLabel: string | undefined;
    if (source === "byok" && keyId) {
      const { data: keyRow } = await supabase
        .from("user_api_keys")
        .select("provider, label")
        .eq("id", keyId)
        .single();
      if (keyRow) keyLabel = `provider=${keyRow.provider}, label=${keyRow.label || keyRow.provider}`;
    }

    // Rebuild the dynamic system prompt with the caller's latest context.
    // Parity with /api/chat-temporal/start: this is the only code path that
    // has ever captured Figma selection + plugin context + agents for a
    // follow-up after an idle timeout — previously the new workflow booted
    // with just GUARDIAN_SYSTEM_PROMPT and lost all situational awareness.
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
    });
    const systemPrompt = GUARDIAN_SYSTEM_PROMPT + dynamicCtx;

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
        systemPrompt,
        mcpServerIds: mcpServerIds ?? [],
        figmaPluginClientId,
        focusDesignInstanceId: designInstanceId,
        focusCodeInstanceId: codeInstanceId,
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
      }],
    });

    // Persist the new workflowId on the conversation so F5 recovery can find
    // it. Ownership scoped to the authenticated user (defence-in-depth vs
    // conversations RLS misconfiguration).
    await supabase
      .from("conversations")
      .update({ metadata: { chatWorkflowId: newWorkflowId } })
      .eq("id", conversationId)
      .eq("user_id", userId);

    log.info("new chatWorkflow started", { newWf: newWorkflowId, conv: conversationId, hasDynamicCtx: dynamicCtx.length > 0 });
    return NextResponse.json({ workflowId: newWorkflowId, conversationId, action: "started" });
  } catch (err) {
    // Correlatable error ID — see start/route.ts for rationale.
    const errId = `err-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error("failed to start new chatWorkflow", { errId, error: errMsg });
    return NextResponse.json(
      { error: `Failed to start chat workflow: ${errMsg}`, errId },
      { status: 500 }
    );
  }
}
