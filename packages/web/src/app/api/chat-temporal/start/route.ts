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

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Types for dynamic context (sent by useChatWorkflow)
// ---------------------------------------------------------------------------

type SelectedNode = {
  nodes: unknown[];
  image: string | null;
  nodeUrl: string | null;
};

type FigmaPluginContext = {
  fileKey: string;
  fileName: string;
  fileUrl: string;
  currentPage?: { id: string; name: string } | null;
  pages?: { id: string; name: string }[];
  currentUser?: { id: string; name: string } | null;
};

type ConnectedAgent = {
  shortId: string;
  label: string;
  type: string;
  fileName?: string;
};

// ---------------------------------------------------------------------------
// Build dynamic system prompt sections (parity with /api/chat legacy route)
// ---------------------------------------------------------------------------

function buildDynamicContext(opts: {
  selectedNode?: SelectedNode;
  figmaPluginContext?: FigmaPluginContext;
  connectedAgents?: ConnectedAgent[];
  isLocalPlugin?: boolean;
  modelId?: string;
  source?: string;
  keyLabel?: string;
}): string {
  let ctx = "";

  // Selected Figma node
  if (opts.selectedNode) {
    const { nodeUrl, nodes } = opts.selectedNode;
    ctx += `\n\n### SELECTED FIGMA NODE (from host application — HIGHEST PRIORITY)`;
    if (nodeUrl) ctx += `\nThe currently selected node URL: ${nodeUrl}`;
    if (nodes && Array.isArray(nodes) && nodes.length > 0) {
      ctx += `\nSelected node properties (from Figma plugin):\n\`\`\`json\n${JSON.stringify(nodes, null, 2)}\n\`\`\``;
    }
    ctx += `
CRITICAL RULES:
- The selection is already known from the data above. Do NOT call any Figma MCP tool to get or find the current selection.
- When the user refers to "this node", "the selection", "the selected element", or similar, they mean the node above.
- You may use other Figma MCP tools to inspect further properties using the node URL above.
- Always start from this data when the user asks about the current selection.`;
  }

  // Figma plugin context (currently open file)
  if (opts.figmaPluginContext?.fileName) {
    const fpc = opts.figmaPluginContext;
    ctx += `\n\n### FIGMA PLUGIN CONTEXT (currently open file — HIGH PRIORITY)
The user is working in the following Figma file:
- **File Name:** "${fpc.fileName}"
- **File Key:** "${fpc.fileKey}"
- **File URL:** "${fpc.fileUrl}"`;
    if (fpc.currentPage) ctx += `\n- **Current Page:** "${fpc.currentPage.name}" (id: ${fpc.currentPage.id})`;
    if (fpc.pages && fpc.pages.length > 0) {
      ctx += `\n- **All Pages:** ${fpc.pages.map(p => `"${p.name}" (${p.id})`).join(", ")}`;
    }
    if (fpc.currentUser) ctx += `\n- **User:** ${fpc.currentUser.name}`;
    if (fpc.fileKey) {
      ctx += `
RULES:
- Use this URL as the default Figma file for any tool call that requires a file key or URL when none is explicitly provided.
- When the user refers to "the current file", "this file", "my file", or similar, they mean this Figma file.
- When the user refers to "the current page" or "this page", they mean the page named above.
- Do NOT ask the user for the Figma file URL if this context is present — you already have it.`;
    }
  }

  // Connected agents
  if (opts.connectedAgents && opts.connectedAgents.length > 0) {
    const agentList = opts.connectedAgents.map(a =>
      `${a.shortId} (${a.label}${a.type === "figma-plugin" ? `, file: "${a.fileName || "?"}"` : ""})`
    ).join(", ");
    const shortIds = opts.connectedAgents.map(a => a.shortId).join(",");
    const execTool = opts.isLocalPlugin ? "figma_plugin_execute" : "guardian_figma_execute";

    ctx += `\n\n## Connected Agents: ${agentList}

${opts.isLocalPlugin ? "You run inside a Figma plugin (own file). Other agents have separate files." : "You are a webapp. Plugin agents below own their files."}

**Collaborative Mode:** You MUST propose orchestration when ANY of these conditions is met:
- The task involves 2+ files (multi-agent)
- The user says "collab" / "collaborative"
- The task targets a single collaborator's file and is better executed on their side

You may orchestrate with **one or more** agents — there is no minimum. Pick only the agents relevant to the task.
Output a SHORT plan (agent/file/task table) then on the NEXT line:
\`[ORCHESTRATE:${shortIds}]\`
(include only the shortIds of the agents you actually need)

**CRITICAL — When you output [ORCHESTRATE], you are DELEGATING work to agents. You MUST NOT:**
- Call any figma_execute or guardian_figma_execute tools in this response
- Do the work yourself — the agents will do it autonomously after accepting

For simple tasks you can handle yourself without delegation, execute directly via ${execTool}.
`;
  }

  // Model identity
  if (opts.modelId) {
    let keyInfo = "";
    if (opts.source === "byok" && opts.keyLabel) {
      keyInfo = ` (user's own API key: ${opts.keyLabel})`;
    } else if (opts.source === "included") {
      keyInfo = " (platform included free tier)";
    }
    ctx += `\n\n## Current Model
You are running as: \`${opts.modelId}\`${keyInfo}.
If the user asks what model you are, answer with this model identifier.`;
  }

  return ctx;
}

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
  const {
    conversationId, message, model, mcpServerIds, figmaPluginClientId, images,
    selectedNode, figmaPluginContext, connectedAgents, isLocalPlugin, source, keyId,
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
      }],
    });

    // Store workflowId in conversation metadata for F5 recovery
    await supabase
      .from("conversations")
      .update({ metadata: { chatWorkflowId: workflowId } })
      .eq("id", conversationId);

    log.info("chatWorkflow started", { conv: conversationId, model: resolvedModel, mcpServerIds: mcpServerIds ?? [], figmaPluginClientId: figmaPluginClientId ?? null, hasDynamicCtx: dynamicCtx.length > 0 });

    return NextResponse.json({ workflowId, conversationId });
  } catch (err) {
    log.error("failed to start chatWorkflow", { error: String(err) });
    return NextResponse.json(
      { error: `Failed to start chat workflow: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
