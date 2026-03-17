import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { getConnectedClients } from "../lib/figma-bridge.js"
import { formatToolResponse } from "../lib/format-response.js"

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
    },
    async ({ task, agents, model }) => {
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

      const cloudUrl = process.env.GUARDIAN_CLOUD_URL || "http://localhost:3000"
      const serviceKey = process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY || ""

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
        }

        const agentList = targetAgents.map((a) => `${a.shortId} (${a.fileName ?? "n/a"})`).join(", ")

        const data = {
          success: true,
          workflowId: result.workflowId,
          orchestrationId: result.orchestrationId,
          task,
          agents: targetAgents.map((a) => ({
            shortId: a.shortId,
            label: a.label,
            fileName: a.fileName,
          })),
        }

        return formatToolResponse(
          `Orchestration started (workflow: ${result.workflowId}). Task: "${task}". ` +
          `Agents (${targetAgents.length}): ${agentList}. ` +
          `The AI orchestrator will now brief all agents and assign directives.`,
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
