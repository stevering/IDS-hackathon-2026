/**
 * MCP Server Registry
 *
 * Centralised catalog of known MCP servers that Guardian can connect to.
 * Used by the Connected Services UI, OAuth callbacks (dual-write), and
 * Temporal workers (tool discovery + execution).
 */

export type MCPServerDef = {
  /** Unique stable identifier stored in user_mcp_connections.server_id */
  id: string;
  /** Human-readable name shown in the UI */
  name: string;
  /** MCP endpoint URL (Streamable HTTP or SSE) */
  serverUrl: string;
  /** OAuth scopes requested during authorization */
  scopes: string;
  /** Prefix prepended to every tool name ("figmaconsole_", "github_", etc.) */
  toolPrefix: string;
  /** MCP transport type */
  transport: "sse" | "http";
  /** Webapp route that initiates the OAuth flow */
  authPath: string;
  /** Short description for the Connected Services UI */
  description: string;
};

export const MCP_SERVERS: MCPServerDef[] = [
  {
    id: "figma_console",
    name: "Figma Console",
    serverUrl: "https://figma-console-mcp.southleft.com/mcp",
    scopes: "file_content:read,library_content:read,file_variables:read",
    toolPrefix: "figmaconsole_",
    transport: "http",
    authPath: "/api/auth/southleft-mcp",
    description:
      "Structured Figma tools (create, read, modify nodes) via Southleft Console MCP",
  },
  {
    id: "github",
    name: "GitHub",
    serverUrl: "https://api.githubcopilot.com/mcp",
    scopes: "repo",
    toolPrefix: "github_",
    transport: "http",
    authPath: "/api/auth/github-mcp",
    description: "GitHub repository access, code search, and PR management",
  },
  {
    id: "figma_mcp",
    name: "Figma (Official MCP)",
    serverUrl: "https://mcp.figma.com/mcp",
    scopes: "mcp:connect",
    toolPrefix: "figma_",
    transport: "http",
    authPath: "/api/auth/figma-mcp",
    description: "Official Figma MCP — design context, metadata, screenshots",
  },
];

/** Lookup a server definition by its id */
export function getMCPServer(serverId: string): MCPServerDef | undefined {
  return MCP_SERVERS.find((s) => s.id === serverId);
}

/**
 * Given a prefixed tool name (e.g. "figmaconsole_create_child"),
 * return the server id and the raw tool name.
 */
export function resolveServerIdFromToolName(
  prefixedName: string,
): { serverId: string; rawName: string } | undefined {
  for (const server of MCP_SERVERS) {
    if (prefixedName.startsWith(server.toolPrefix)) {
      return {
        serverId: server.id,
        rawName: prefixedName.slice(server.toolPrefix.length),
      };
    }
  }
  return undefined;
}
