/**
 * Guardian meta-tools — injectable into every LLM call alongside the focus tools.
 *
 * These 3 tools let the LLM discover and invoke MCP instances that are NOT
 * in the current conversation's focus selection.
 *
 * - guardian_list_instances       → returns all online instances with metadata
 * - guardian_get_instance_tools   → returns the tool spec for a non-focus instance
 * - guardian_call_instance_tool   → proxy-executes a tool on a non-focus instance
 */

import type { LLMToolDefinition } from "@guardian/orchestrations";
import { type InstanceManifestEntry, discoverMCPToolsV2, executeMCPToolV2 } from "./mcp-v2.js";
import { callBridgedMCP } from "./mcp-bridge-client.js";
import { createClient } from "@supabase/supabase-js";
import { createMCPClient } from "@ai-sdk/mcp";
import { BUILTIN_PRESETS, buildToolPrefix } from "@guardian/orchestrations";
import { createLogger } from "../lib/log.js";

const log = createLogger("guardian-meta");

// ---------------------------------------------------------------------------
// Tool specifications (injected into the LLM tool catalog)
// ---------------------------------------------------------------------------

export const GUARDIAN_META_TOOL_SPECS: LLMToolDefinition[] = [
  {
    name: "guardian_list_instances",
    description:
      "List all MCP instances the user has configured and that are currently online. " +
      "Returns instances grouped by category (design, code) with labels, tool counts, and focus status. " +
      "Use this to discover which instances are available before calling guardian_call_instance_tool.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "guardian_get_instance_tools",
    description:
      "Get the list of tools exposed by a specific MCP instance, identified by its label. " +
      "Use this to inspect what a non-focus instance can do before invoking it.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "The instance label, e.g. 'work', 'cursor_mac'." },
      },
      required: ["label"],
    },
  },
  {
    name: "guardian_call_instance_tool",
    description:
      "Execute a tool on a non-focus MCP instance. Use this when the user refers to another " +
      "account, device, or editor than the current focus. The tool_name is the raw name " +
      "(without the prefix), e.g. 'get_selection' not 'figma_work_get_selection'.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "The instance label." },
        tool_name: { type: "string", description: "The raw tool name, without prefix." },
        arguments: { type: "object", description: "Tool arguments.", additionalProperties: true },
      },
      required: ["label", "tool_name", "arguments"],
    },
  },
  {
    name: "guardian_load_tool_group",
    description:
      "Load additional tools from a functional group into the current session. " +
      "Use this when you need capabilities not in the current tool set. " +
      "Call guardian_list_tool_groups first to see available groups.",
    parameters: {
      type: "object",
      properties: {
        group_id: {
          type: "string",
          description: "The group ID to load (e.g., 'figma_variables', 'code_editing').",
        },
      },
      required: ["group_id"],
    },
  },
  {
    name: "guardian_list_tool_groups",
    description:
      "List all available tool groups with their descriptions. " +
      "Use this to discover which group to load via guardian_load_tool_group.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

// ---------------------------------------------------------------------------
// Execution context — set once per workflow turn, consumed by meta-tool handlers
// ---------------------------------------------------------------------------

export type MetaToolContext = {
  userId: string;
  manifest: InstanceManifestEntry[];
};

// ---------------------------------------------------------------------------
// Meta-tool handler
// ---------------------------------------------------------------------------

export async function executeGuardianMetaTool(params: {
  userId: string;
  manifest: InstanceManifestEntry[];
  toolName: string;
  args: Record<string, unknown>;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const ctx: MetaToolContext = { userId: params.userId, manifest: params.manifest };
  const { toolName, args } = params;
  switch (toolName) {
    case "guardian_list_instances":
      return handleListInstances(ctx);

    case "guardian_get_instance_tools":
      return handleGetInstanceTools(ctx, args.label as string);

    case "guardian_call_instance_tool":
      return handleCallInstanceTool(
        ctx,
        args.label as string,
        args.tool_name as string,
        (args.arguments as Record<string, unknown>) ?? {},
      );

    default:
      return { success: false, error: `Unknown guardian meta-tool: ${toolName}` };
  }
}

// ---------------------------------------------------------------------------
// guardian_list_instances
// ---------------------------------------------------------------------------

function handleListInstances(ctx: MetaToolContext): { success: boolean; result: unknown } {
  const grouped: Record<string, Array<{
    label: string;
    preset: string;
    display_name: string | null;
    scope: string;
    tool_count: number;
    tool_prefix: string;
    is_focus: boolean;
  }>> = { design: [], code: [] };

  for (const entry of ctx.manifest) {
    const cat = entry.category === "design" || entry.category === "code" ? entry.category : "design";
    grouped[cat].push({
      label: entry.label,
      preset: entry.presetType,
      display_name: entry.displayName,
      scope: entry.scope,
      tool_count: entry.toolCount,
      tool_prefix: entry.toolPrefix,
      is_focus: entry.isFocus,
    });
  }

  return { success: true, result: grouped };
}

// ---------------------------------------------------------------------------
// guardian_get_instance_tools
// ---------------------------------------------------------------------------

async function handleGetInstanceTools(
  ctx: MetaToolContext,
  label: string,
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const entry = ctx.manifest.find((e) => e.label === label);
  if (!entry) {
    return { success: false, error: `No instance with label "${label}". Use guardian_list_instances to see available labels.` };
  }

  // For bridged instances, ask the overlay for tools/list
  if (entry.scope === "local") {
    const supabase = createServiceClient();
    const { data: rows } = await supabase.rpc("list_mcp_instances_service", { p_user_id: ctx.userId });
    const inst = ((rows ?? []) as Array<{ id: string; device_id: string | null }>).find((r) => r.id === entry.instanceId);

    if (!inst?.device_id) {
      return { success: false, error: `Instance "${label}" has no device — bridge offline?` };
    }

    const result = await callBridgedMCP({
      userId: ctx.userId,
      deviceId: inst.device_id,
      instanceId: entry.instanceId,
      method: "tools/list",
    });

    if (!result.ok) return { success: false, error: result.error };

    return { success: true, result: result.result };
  }

  // For cloud instances, connect and list
  const preset = BUILTIN_PRESETS[entry.presetType];
  const url = preset?.cloud_url;
  if (!url) return { success: false, error: `No URL for ${label}` };

  const supabase = createServiceClient();
  const { data: tokensJson } = await supabase.rpc("get_mcp_connection_service", {
    p_user_id: ctx.userId,
    p_server_id: entry.presetType,
  });

  if (!tokensJson) return { success: false, error: `No token for ${label}` };
  const tokens = JSON.parse(tokensJson as string);
  if (!tokens.access_token) return { success: false, error: `Token expired for ${label}` };

  const client = await createMCPClient({
    transport: { type: "http", url, headers: { Authorization: `Bearer ${tokens.access_token}` } },
  });
  const mcpTools = await client.tools();
  await client.close();

  const toolList = Object.entries(mcpTools).map(([name, tool]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = tool as any;
    return { name, description: t.description ?? "" };
  });

  return { success: true, result: toolList };
}

// ---------------------------------------------------------------------------
// guardian_call_instance_tool
// ---------------------------------------------------------------------------

async function handleCallInstanceTool(
  ctx: MetaToolContext,
  label: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const entry = ctx.manifest.find((e) => e.label === label);
  if (!entry) {
    return { success: false, error: `No instance with label "${label}". Available labels: ${ctx.manifest.map(e => e.label).join(", ")}` };
  }

  // Auto-strip the prefix if the LLM passed a prefixed tool name
  // e.g. "figmaconsole_list_components" → "list_components"
  let rawToolName = toolName;
  if (toolName.startsWith(entry.toolPrefix)) {
    rawToolName = toolName.slice(entry.toolPrefix.length);
  }

  log.info(`Meta-tool call: ${label}/${rawToolName}`, { args: JSON.stringify(args).slice(0, 200) });

  return executeMCPToolV2({
    userId: ctx.userId,
    instanceId: entry.instanceId,
    toolName: rawToolName,
    arguments: args,
  });
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function createServiceClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.STORAGE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase credentials not configured");
  return createClient(supabaseUrl, serviceKey);
}

// ---------------------------------------------------------------------------
// System prompt builder — generates the "Tool instances and labels" block
// ---------------------------------------------------------------------------

export function buildInstanceSystemPrompt(manifest: InstanceManifestEntry[]): string {
  if (manifest.length === 0) return "";

  const lines: string[] = [
    "## Tool instances and labels",
    "",
    "The user has configured these MCP instances (label in parentheses):",
    "",
  ];

  const byCategory: Record<string, InstanceManifestEntry[]> = { design: [], code: [] };
  for (const e of manifest) {
    (byCategory[e.category] ?? []).push(e);
  }

  for (const [cat, entries] of Object.entries(byCategory)) {
    if (entries.length === 0) continue;
    lines.push(`${cat.charAt(0).toUpperCase() + cat.slice(1)}:`);
    for (const e of entries) {
      const focusTag = e.isFocus ? " ← FOCUS" : "";
      const scopeTag = e.scope === "local" ? " [local bridged]" : "";
      const name = e.displayName ?? BUILTIN_PRESETS[e.presetType]?.display_name ?? e.presetType;

      // Instance line
      if (e.error) {
        // Instance failed discovery — mark UNAVAILABLE and show reason
        const shortError = e.error.length > 120 ? e.error.slice(0, 120) + "…" : e.error;
        lines.push(`- ${name} (${e.label})${scopeTag} ⚠️ UNAVAILABLE`);
        lines.push(`  Reason: ${shortError}`);
        lines.push(`  DO NOT call tools on this instance. DO NOT call guardian_call_instance_tool with label="${e.label}".`);
        lines.push(`  If user asks about ${name}, tell them: "${name} is not reachable (reason: ${shortError}). Please reconnect it in Account page or check your credentials."`);
      } else {
        lines.push(`- ${name} (${e.label})${scopeTag}${focusTag}`);
        if (e.toolNames && e.toolNames.length > 0 && !e.isFocus) {
          lines.push(`  Tools: ${e.toolNames.join(", ")}`);
        }
      }
    }
    lines.push("");
  }

  lines.push(
    "## Rules",
    "",
    "Tool naming: `<preset>_<label>_<action>` (e.g. `github_github_list_repos`).",
    "Default: use focus tools directly.",
    "When the user mentions another instance label, use `guardian_call_instance_tool(label, raw_tool_name, args)`.",
    "  - `tool_name` must be the RAW name without prefix (e.g. `list_repos`, NOT `github_github_list_repos`).",
    "Use `guardian_list_instances` to see available labels.",
    "",
    "## UNAVAILABLE instances — CRITICAL",
    "",
    "Any instance marked ⚠️ UNAVAILABLE above has failed discovery and CANNOT be called.",
    "- DO NOT call `guardian_call_instance_tool` with its label.",
    "- DO NOT call any tool with its prefix.",
    "- DO NOT try to use it as a fallback.",
    "- If the user asks for something involving an UNAVAILABLE instance:",
    "  1. Check if another instance (same category, different label) can serve the request → use it directly.",
    "  2. Check if a Figma plugin is connected (presence) → use `figma_plugin_execute` as alternative.",
    "  3. Otherwise, respond with the canned message from the instance entry above.",
    "- DO NOT attempt to call the UNAVAILABLE instance 'just in case' — the error will propagate and waste a turn.",
    "",
    "IMPORTANT: Figma plugins (from presence, e.g. 'Figma-Desktop-catevi') are NOT MCP instances.",
    "Do NOT call `guardian_call_instance_tool` with a plugin short ID.",
    "To execute code on a Figma plugin, use the `figma_plugin_execute` tool directly.",
    "MCP instances listed above have labels like 'figma', 'figmaconsole', 'github' — use only these labels.",
  );

  return lines.join("\n");
}
