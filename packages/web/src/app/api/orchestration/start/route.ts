/**
 * POST /api/orchestration/start
 *
 * Starts a new Temporal orchestration workflow.
 */

import { NextResponse } from "next/server";
import { createClient as createSupabaseUserClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { StartOrchestrationParams, AgentId } from "@guardian/orchestrations";
import { createLogger } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Check feature flag
  if (process.env.TEMPORAL_ENABLED !== "true") {
    return NextResponse.json(
      { error: "Temporal orchestration is not enabled" },
      { status: 503 }
    );
  }

  // Resolve user identity: MCP service-key (internal) OR Supabase session (browser)
  let userId: string;

  const mcpServiceKey = request.headers.get("x-mcp-service-key");
  const mcpUserId = request.headers.get("x-mcp-user-id");
  const expectedKey = process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;

  if (mcpServiceKey && mcpUserId && expectedKey && mcpServiceKey === expectedKey) {
    userId = mcpUserId;
  } else {
    const supabase = await createSupabaseUserClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    userId = user.id;
  }

  const body = await request.json();
  const { task, targetAgents, model, agentModel, maxDurationMs, context, conversationId, mcpServerIds } = body as {
    task: string;
    targetAgents: AgentId[];
    model?: string;
    agentModel?: string;
    maxDurationMs?: number;
    context?: Record<string, unknown>;
    conversationId?: string;
    mcpServerIds?: string[];
  };

  if (!task || !targetAgents?.length) {
    return NextResponse.json(
      { error: "Missing required fields: task, targetAgents" },
      { status: 400 }
    );
  }

  const workflowId = `orch-${userId.slice(0, 8)}-${Date.now()}`;
  const log = createLogger("orch/start", { u: userId.slice(0, 8), wf: workflowId });

  try {
    // Dynamic import to avoid loading Temporal client when feature is disabled
    const { getTemporalClient, getTaskQueue } = await import("@guardian/temporal/client");

    const client = await getTemporalClient();
    const taskQueue = getTaskQueue();

    // Fetch user settings to pass dev flags to the workflow
    const sb = createServiceClient();
    let userSettings: Record<string, unknown> = {};
    try {
      const { data: settingsRows } = await sb.from("user_settings").select("*").eq("user_id", userId).limit(1);
      if (settingsRows?.[0]) {
        userSettings = {
          developerMode: settingsRows[0].developer_mode ?? false,
          devLLMDelegation: settingsRows[0].dev_llm_delegation ?? false,
          devSlowDelegation: settingsRows[0].dev_slow_delegation ?? false,
        };
      }
    } catch { /* best-effort */ }

    // Slow delegation mode: extend orchestration duration to 4 hours
    const effectiveMaxDuration = userSettings.devSlowDelegation
      ? 4 * 60 * 60_000  // 4 hours
      : maxDurationMs;

    const params: StartOrchestrationParams = {
      userId,
      task,
      targetAgents,
      model,
      agentModel,
      maxDurationMs: effectiveMaxDuration,
      context: {
        ...context,
        userSettings,
      },
      mcpServerIds,
    };

    log.info("starting orchestration", {
      agents: targetAgents.map((a: AgentId) => a.shortId).join(","),
      model: model ?? "default",
      task: task.slice(0, 80),
    });

    // Use string workflow name — do NOT import the workflow function directly
    // as it depends on @temporalio/workflow which only works inside the sandbox.
    const handle = await client.workflow.start("orchestratorWorkflow", {
      workflowId,
      taskQueue,
      args: [params],
    });

    log.info("workflow started");

    // ── Ensure conversation exists for UI visibility ─────────────────────
    // If no conversationId was provided (e.g. MCP caller), create a parent
    // conversation + sub-conversation automatically so the orchestration
    // appears in the webapp sidebar.
    let parentConversationId = conversationId ?? null;
    let orchConversationId: string | null = null;

    // sb already created above for settings fetch
    const agentNames = targetAgents.map((a: AgentId) => a.shortId).join(", ");

    try {
      if (!parentConversationId) {
        // Create a parent conversation with the task as title
        const { data: parentId, error: parentErr } = await sb
          .from("conversations")
          .insert({
            user_id: userId,
            title: task.slice(0, 100),
            metadata: {},
          })
          .select("id")
          .single();

        if (parentErr) throw parentErr;
        parentConversationId = parentId.id;
        log.info("created parent conversation", { convId: parentConversationId });
      }

      // Add user message (the task) to the parent conversation
      await sb.from("messages").insert({
        conversation_id: parentConversationId,
        role: "user",
        content: task,
        parts: [{ type: "text", text: task }],
        metadata: { source: "mcp" },
      });

      // Add assistant message with the orchestrate button marker
      const orchestrateMarker = `[ORCHESTRATE:${targetAgents.map((a: AgentId) => a.shortId).join(",")}]`;
      const assistantText = `Starting collaborative orchestration with ${agentNames}.\n\n${orchestrateMarker}`;
      await sb.from("messages").insert({
        conversation_id: parentConversationId,
        role: "assistant",
        content: assistantText,
        parts: [{ type: "text", text: assistantText }],
        metadata: { source: "mcp", workflowId },
      });

      // Create the orchestration sub-conversation
      const { data: orchConvId, error: orchErr } = await sb
        .from("conversations")
        .insert({
          user_id: userId,
          title: "Orchestration",
          parent_id: parentConversationId,
          metadata: { workflowId },
        })
        .select("id")
        .single();

      if (orchErr) throw orchErr;
      orchConversationId = orchConvId.id;
      log.info("created orchestration sub-conversation", { convId: orchConversationId });
    } catch (convErr) {
      // Conversation creation is best-effort — workflow already started
      log.warn(`conversation setup failed (non-fatal): ${convErr}`);
    }

    return NextResponse.json({
      workflowId: handle.workflowId,
      orchestrationId: workflowId,
      conversationId: parentConversationId,
      orchestrationConversationId: orchConversationId,
    });
  } catch (error) {
    log.error(`failed to start: ${error}`);
    return NextResponse.json(
      { error: "Failed to start orchestration" },
      { status: 500 }
    );
  }
}
