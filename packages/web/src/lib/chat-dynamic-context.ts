/**
 * Dynamic system-prompt context for the Temporal chat.
 *
 * Shared between:
 *   - POST /api/chat-temporal/start          — first message, brand new workflow
 *   - POST /api/chat-temporal/[id]/message   — follow-up AFTER a workflow has
 *                                              expired (5 min idle) and we
 *                                              need to spin up a fresh one.
 *
 * Without this parity, a user who changes their Figma selection mid-conversation
 * and sends a follow-up after the 5-minute idle timeout would see the new
 * workflow boot with an empty system prompt — no selected node, no plugin
 * context, no connected agents. The assistant would lose all situational
 * awareness and refuse to act on "this node" / "the current file" references.
 */

// ---------------------------------------------------------------------------
// Types sent by the useChatWorkflow hook in the request body
// ---------------------------------------------------------------------------

export type SelectedNode = {
  nodes: unknown[];
  image: string | null;
  nodeUrl: string | null;
};

export type FigmaPluginContext = {
  fileKey: string;
  fileName: string;
  fileUrl: string;
  currentPage?: { id: string; name: string } | null;
  pages?: { id: string; name: string }[];
  currentUser?: { id: string; name: string } | null;
};

export type ConnectedAgent = {
  shortId: string;
  label: string;
  type: string;
  fileName?: string;
};

export type BuildDynamicContextOpts = {
  selectedNode?: SelectedNode;
  figmaPluginContext?: FigmaPluginContext;
  connectedAgents?: ConnectedAgent[];
  isLocalPlugin?: boolean;
  modelId?: string;
  source?: string;
  keyLabel?: string;
};

// ---------------------------------------------------------------------------
// Build dynamic system prompt sections (parity with /api/chat legacy route)
// ---------------------------------------------------------------------------

export function buildDynamicContext(opts: BuildDynamicContextOpts): string {
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
