import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { getConnectedClients } from "../lib/figma-bridge.js"
import { formatToolResponse } from "../lib/format-response.js"
import { createClient } from "@supabase/supabase-js"

/**
 * MCP tool: start_collab
 *
 * Starts a multi-agent collaborative orchestration via Temporal.
 * The LLM should call get_connected_clients first to discover available agents,
 * then call this tool with the chosen agents and a task description.
 */
export function registerStartCollabTool(server: McpServer, userId?: string): void {
  server.tool(
    "start_collab",
    `Start a multi-agent collaborative orchestration.

Launches a Temporal workflow where an AI orchestrator coordinates multiple Figma plugin agents to accomplish a task together.

## Prerequisites
- Temporal must be enabled on Guardian Cloud (TEMPORAL_ENABLED=true)
- At least one Figma plugin must be connected
- Call get_connected_clients first to discover available agents and their shortIds

## How it works
1. You call get_connected_clients → see available Figma plugins and their files
2. You choose agents relevant to the task
3. You call start_collab with the task description + selected agent shortIds
4. A Temporal orchestrator workflow starts, briefs all agents on the task, and assigns directives automatically

## Example
After discovering agents #Figma-Desktop-abc (file: Homepage) and #Figma-Desktop-xyz (file: Components):

  start_collab({
    task: "Create a green circle on Homepage and a red circle on Components",
    agents: ["#Figma-Desktop-abc", "#Figma-Desktop-xyz"]
  })`,
    {
      task: z.string().min(1).describe(
        "The collaborative task to accomplish. Be specific about what each file/agent should do."
      ),
      agents: z.array(z.string()).min(1).describe(
        "Array of agent shortIds to include in the collaboration " +
        "(e.g. ['#Figma-Desktop-vopope', '#Figma-Desktop-sudode']). " +
        "Use get_connected_clients to discover available agents first."
      ),
      model: z.string().optional().describe(
        "Optional AI model ID for the orchestrator LLM (defaults to platform default)"
      ),
      conversationId: z.string().optional().describe(
        "Optional parent conversation ID to attach this orchestration to. " +
        "If omitted, a new conversation is created automatically."
      ),
    },
    async ({ task, agents, model, conversationId }) => {
      const connectedClients = await getConnectedClients(userId)

      if (connectedClients.length === 0) {
        return formatToolResponse(
          `Cannot start collaboration: no Figma plugin clients connected. Make sure the Figma plugin is open with the Guardian webapp loaded.`,
          { success: false, error: "No Figma plugin clients connected." },
        )
      }

      const targetAgents: {
        shortId: string
        workflowId: string
        label: string
        type: "figma-plugin" | "web" | "cloud"
        fileName?: string
        pluginClientId?: string
      }[] = []
      const missingAgents: string[] = []

      for (const shortId of agents) {
        const normalized = shortId.replace(/^#/, "")
        const client = connectedClients.find(
          (c) =>
            c.shortId.replace(/^#/, "") === normalized ||
            c.clientId === shortId
        )

        if (!client) {
          missingAgents.push(shortId)
          continue
        }

        targetAgents.push({
          shortId: client.shortId,
          workflowId: "",
          label: client.label,
          type: "figma-plugin",
          fileName: client.figmaContext?.fileName,
          pluginClientId: client.clientId,
        })
      }

      if (missingAgents.length > 0) {
        const available = connectedClients.map(
          (c) => `${c.shortId} (${c.figmaContext?.fileName ?? "unknown file"})`
        )
        return formatToolResponse(
          `Cannot start collaboration: agent(s) not found: ${missingAgents.join(", ")}. Available: ${available.join(", ")}.`,
          { success: false, error: `Agent(s) not found: ${missingAgents.join(", ")}`, availableAgents: available },
        )
      }

      const cloudUrl = process.env.GUARDIAN_CLOUD_URL
        || process.env.NEXT_PUBLIC_BASE_URL
        || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")
      const serviceKey = process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY || ""

      // Discover user's connected MCP servers for tool injection
      let mcpServerIds: string[] = []
      if (userId && serviceKey) {
        try {
          const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.STORAGE_SUPABASE_URL || ""
          if (supabaseUrl) {
            const supabase = createClient(supabaseUrl, serviceKey)
            const { data } = await supabase.rpc("list_mcp_connections_service", { p_user_id: userId })
            mcpServerIds = (data as Array<{ server_id: string }> | null)?.map((c) => c.server_id) ?? []
          }
        } catch {
          // Non-fatal: proceed without MCP tools
        }
      }

      // Include figma_console_local (stdio) only in local dev — in prod/cloud
      // there's no Figma Desktop to connect to, and npx would fail.
      const isLocal = process.env.NODE_ENV !== "production" || process.env.ENABLE_LOCAL_MCP === "true"
      if (isLocal && !mcpServerIds.includes("figma_console_local")) {
        mcpServerIds.push("figma_console_local")
      }

      try {
        const response = await fetch(`${cloudUrl}/api/orchestration/start`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-mcp-service-key": serviceKey,
            "x-mcp-user-id": userId || "",
          },
          body: JSON.stringify({
            task,
            targetAgents,
            model,
            conversationId,
            mcpServerIds,
          }),
        })

        if (!response.ok) {
          const errorBody = await response.text()
          return formatToolResponse(
            `Orchestration start failed (HTTP ${response.status}): ${errorBody}.`,
            { success: false, error: `Orchestration start failed (${response.status}): ${errorBody}` },
          )
        }

        const result = await response.json() as {
          workflowId: string
          orchestrationId: string
          conversationId?: string
          orchestrationConversationId?: string
        }

        const agentList = targetAgents.map((a) => `${a.shortId} (${a.fileName ?? "n/a"})`).join(", ")

        const streamUrl = `${cloudUrl}/api/orchestration/${result.workflowId}/stream`
        const signalUrl = `${cloudUrl}/api/orchestration/${result.workflowId}/signal`

        const data = {
          success: true,
          workflowId: result.workflowId,
          orchestrationId: result.orchestrationId,
          conversationId: result.conversationId,
          orchestrationConversationId: result.orchestrationConversationId,
          task,
          agents: targetAgents.map((a) => ({
            shortId: a.shortId,
            label: a.label,
            fileName: a.fileName,
          })),
          monitoring: {
            streamUrl,
            signalUrl,
            serviceKeyHeader: "x-mcp-service-key",
            userIdHeader: "x-mcp-user-id",
          },
        }

        const envLoad = `export $(grep -v '^#' .env.local | grep STORAGE_SUPABASE_SERVICE_ROLE_KEY | xargs)`
        const authHeaders = `-H "x-mcp-service-key: $STORAGE_SUPABASE_SERVICE_ROLE_KEY" -H "x-mcp-user-id: ${userId || "$USER_ID"}"`
        const logFile = `/tmp/guardian-stream-${result.workflowId}.log`

        return formatToolResponse(
          `Orchestration started (workflow: ${result.workflowId}). Task: "${task}". ` +
          `Agents (${targetAgents.length}): ${agentList}. ` +
          `The AI orchestrator will now brief all agents and assign directives.\n\n` +
          `## IMPORTANT: Follow the orchestration in real-time\n` +
          `You MUST start the background stream immediately after receiving this response.\n\n` +
          `### Step 1: Start background stream (run_in_background=true)\n` +
          `\`\`\`bash\n` +
          `${envLoad} && curl -s -N ${authHeaders} "${streamUrl}" > ${logFile} 2>&1\n` +
          `\`\`\`\n\n` +
          `### Step 2: Check progress (run anytime)\n` +
          `\`\`\`bash\n` +
          `tail -50 ${logFile}\n` +
          `\`\`\`\n\n` +
          `### Step 3: Search for specific events\n` +
          `\`\`\`bash\n` +
          `grep -E "agent_report|orchestration_completed|code_executed|VERIFIED|ISSUE" ${logFile}\n` +
          `\`\`\`\n\n` +
          `### Send a message to the orchestrator\n` +
          `\`\`\`bash\n` +
          `${envLoad} && curl -s -X POST -H "Content-Type: application/json" ${authHeaders} ` +
          `-d '{"signal":"userInput","payload":{"content":"your message here"}}' "${signalUrl}"\n` +
          `\`\`\`\n\n` +
          `### Stop the orchestration\n` +
          `\`\`\`bash\n` +
          `${envLoad} && curl -s -X POST -H "Content-Type: application/json" ${authHeaders} ` +
          `-d '{"signal":"stop"}' "${signalUrl}"\n` +
          `\`\`\``,
          data,
        )
      } catch (err) {
        return formatToolResponse(
          `Cannot reach Guardian Cloud at ${cloudUrl}: ${err instanceof Error ? err.message : String(err)}.`,
          { success: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}`, hint: `Make sure Guardian Cloud is running at ${cloudUrl}` },
        )
      }
    }
  )
}
