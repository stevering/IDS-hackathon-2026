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

/**
 * The Figma plugin the user has explicitly selected as the routing target for
 * this conversation (TargetSelector pick, or the inferred fallback when the
 * webapp runs inside a plugin iframe). All `figmaconsole_*` and
 * `figma_plugin_execute` calls are server-side routed to this plugin —
 * Southleft's cloud relay supports exactly one paired plugin per OAuth token,
 * so other entries in `connectedAgents` are visible but NOT reachable through
 * those tools without re-pairing first.
 */
export type ActiveTarget = {
  shortId: string;
  label?: string;
  fileName?: string;
  fileKey?: string;
  fileUrl?: string;
};

/**
 * Emitted when the user picked "Auto" but the resolver finds multiple
 * candidates (e.g. 2+ Figma plugins running). The LLM must ask the user to
 * disambiguate via QCM_FORMAT before invoking any plugin-bound tool. The
 * worker also enforces this at the activity level (AMBIGUOUS_TARGET error).
 */
export type DisambiguationCandidate = {
  /** TargetSelector id, e.g. "plugin:abc123" or "instance:uuid". */
  targetId: string;
  shortId: string;
  label: string;
  fileName?: string;
  fileKey?: string;
};

export type PendingDisambiguation = {
  category: "design" | "code";
  candidates: DisambiguationCandidate[];
  /** TargetSelector id of the most-recent / suggested candidate. */
  suggestionTargetId: string;
};

/**
 * Read-only REST endpoints (e.g. figma_console figma_get_*, figma_mcp tools)
 * that work via fileUrl without a paired plugin. Listed in the system prompt
 * so the LLM knows it can serve read-only requests even when no plugin is
 * paired (or while disambiguation is pending).
 */
export type RestEndpointInfo = {
  presetType: string;
  label: string;
};

export type BuildDynamicContextOpts = {
  selectedNode?: SelectedNode;
  figmaPluginContext?: FigmaPluginContext;
  connectedAgents?: ConnectedAgent[];
  isLocalPlugin?: boolean;
  modelId?: string;
  source?: string;
  keyLabel?: string;
  activeTarget?: ActiveTarget;
  pendingDisambiguation?: PendingDisambiguation;
  restEndpoints?: RestEndpointInfo[];
};

// ---------------------------------------------------------------------------
// Build dynamic system prompt sections (parity with /api/chat legacy route)
// ---------------------------------------------------------------------------

export function buildDynamicContext(opts: BuildDynamicContextOpts): string {
  let ctx = "";

  // ── PRIORITY 0: target disambiguation ────────────────────────────────────
  // When the resolver is "ambiguous", this MUST appear before anything else
  // — the LLM cannot make any plugin-bound tool call until the user picks.
  // Putting it at the top forces the model to read the rule before it sees
  // the SELECTED NODE / PLUGIN CONTEXT blocks (which would otherwise prime it
  // toward "let me just inspect the selection" via figmaconsole_figma_execute).
  if (opts.pendingDisambiguation) {
    const pd = opts.pendingDisambiguation;
    const categoryLabel = pd.category === "design" ? "DESIGN" : "CODE";
    const targetWord = pd.category === "design" ? "Figma plugin" : "code MCP";
    const map: Record<string, string> = {};
    for (const c of pd.candidates) {
      const display = c.fileName ? `${c.shortId} (${c.fileName})` : c.shortId;
      map[display] = c.targetId;
    }
    const choices = Object.keys(map);
    const suggestion = pd.candidates.find((c) => c.targetId === pd.suggestionTargetId);
    const suggestionDisplay = suggestion
      ? (suggestion.fileName ? `${suggestion.shortId} (${suggestion.fileName})` : suggestion.shortId)
      : choices[0];
    ctx += `## ${categoryLabel} TARGET — DISAMBIGUATION REQUIRED (READ FIRST)
**${pd.candidates.length} ${targetWord}s are connected** and the user picked "Auto". You CANNOT call any plugin-bound tool until the user picks one. There is NO need to call \`guardian_list_instances\` — the candidates are listed below.

Candidates:`;
    for (const c of pd.candidates) {
      const isSuggested = c.targetId === pd.suggestionTargetId ? " [SUGGESTED — most recent]" : "";
      const fileBit = c.fileName ? ` — file "${c.fileName}"` : "";
      ctx += `\n- ${c.shortId}${fileBit}${isSuggested}`;
    }
    ctx += `

REQUIRED ACTION (verbatim):
Emit this QCM block as your response. Copy it EXACTLY — the QCM_META JSON drives the UI's Target selector update on click.

<!-- QCM_START -->
<!-- QCM_META: ${JSON.stringify({ category: pd.category, map })} -->
${choices.map((c) => `- [CHOICE] ${c}`).join("\n")}
<!-- QCM_END -->

You MAY add a one-line text question before the \`<!-- QCM_START -->\` line (e.g. "Quel plugin cibler ?"). Suggest "${suggestionDisplay}" — but do NOT pick silently.

EXCEPTIONS — these tools work WITHOUT picking a plugin:
- ${pd.category === "design" ? "READ-ONLY \`figmaconsole_figma_get_*\` and \`figma_*\` tools called with an explicit fileUrl in arguments — they hit the REST API, no pairing needed." : ""}
- DO NOT call \`figmaconsole_figma_execute\`, \`figmaconsole_figma_set_*\`, \`figmaconsole_figma_create_child\`, \`figma_plugin_execute\` or any write tool until the user picks. The worker will reject these with \`AMBIGUOUS_TARGET\` and you will have wasted a turn.`;
  }

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

  // Active Figma target (the plugin this conversation routes to)
  if (opts.activeTarget?.shortId) {
    const t = opts.activeTarget;
    ctx += `\n\n## ACTIVE FIGMA TARGET (this conversation)
- **shortId:** ${t.shortId}`;
    if (t.label) ctx += `\n- **label:** ${t.label}`;
    if (t.fileName) ctx += `\n- **file:** "${t.fileName}"`;
    if (t.fileKey) ctx += ` (fileKey: ${t.fileKey})`;
    if (t.fileUrl) ctx += `\n- **fileUrl:** ${t.fileUrl}`;
    ctx += `

RULES:
- All \`figmaconsole_*\` and \`figma_plugin_execute\` tool calls in this conversation are routed to **this** plugin instance. Other plugins listed under "Connected Agents" below are visible but NOT reachable through these tools — Southleft's cloud relay binds to one plugin per user at a time.
- When the user references "the current file", "this Figma", "my plugin", or similar without naming a specific agent, they mean this target.
- If the user asks to switch to a different plugin/file, instruct them to change the selection in the Target selector — Guardian will re-pair automatically. Do NOT attempt to drive other plugins from \`figmaconsole_*\` calls.`;
  }

  // (DISAMBIGUATION REQUIRED block was rendered at the top of this function.)

  // REST endpoints (always available, take fileUrl). Listed even when
  // ACTIVE FIGMA TARGET is resolved — useful when the user asks about a
  // DIFFERENT file than the one in the current plugin (e.g. "show me
  // file https://www.figma.com/design/XYZ"). These tools don't need a
  // paired plugin, just the fileUrl in args.
  if (opts.restEndpoints && opts.restEndpoints.length > 0) {
    ctx += `\n\n## READ-ONLY REST ENDPOINTS (work without a paired plugin)`;
    for (const r of opts.restEndpoints) {
      ctx += `\n- **${r.label}** (${r.presetType}) — use \`${r.presetType === "figma_console" ? "figmaconsole_figma_get_*" : "figma_*"}\` tools with an explicit fileUrl in arguments.`;
    }
    ctx += `\n\nRULES:
- These endpoints DO NOT require a paired plugin. They work for ANY Figma file the user has read access to, given a fileUrl.
- Use them when the user references a file by URL, when no plugin is paired, or when the disambiguation is pending and the action is read-only.`;
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
