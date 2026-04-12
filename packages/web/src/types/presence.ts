import type { AgentRole } from "./orchestration"

export type ClientType = "figma-plugin" | "webapp" | "overlay"

export type PresenceClient = {
  type: ClientType
  clientId: string
  shortId: string
  label: string
  fileKey?: string
  connectedAt: number
  presenceRef?: string
  agentRole?: AgentRole
  orchestrationId?: string
  mcpInfo?: {
    figma?: { connected: boolean; mode: string }
    code?: { connected: boolean; path: string }
  }
  figmaContext?: {
    fileName?: string
    fileUrl?: string | null
    pages?: { id: string; name: string }[]
    currentPage?: { id: string; name: string } | null
    currentUser?: { id: string; name: string } | null
  }
}

export function generateShortId(type: ClientType, presenceRef: string | undefined): string {
  const prefix = type === "figma-plugin" ? "A" : type === "webapp" ? "B" : "C"
  const hex = presenceRef ? presenceRef.slice(-2).toUpperCase() : Math.random().toString(36).slice(-2).toUpperCase()
  return `#${prefix}${hex}`
}

export function parsePresenceState(
  state: Record<string, { presence_ref?: string; [key: string]: unknown }[]>
): PresenceClient[] {
  // Deduplicate by clientId — keep only the most recent entry (highest connectedAt).
  // During reconnection storms, stale presence ghosts accumulate on the server
  // because channel.unsubscribe() can't reach a dead WebSocket.
  const byClientId = new Map<string, PresenceClient>()
  for (const presences of Object.values(state)) {
    for (const p of presences) {
      const type = (p.type as ClientType) ?? "webapp"
      const cid = (p.clientId as string) ?? p.presence_ref ?? ""
      const connectedAt = (p.connectedAt as number) ?? Date.now()
      const existing = byClientId.get(cid)
      if (existing && existing.connectedAt >= connectedAt) continue
      byClientId.set(cid, {
        type,
        clientId: cid,
        shortId: (p.serverShortId as string) ?? generateShortId(type, p.presence_ref),
        label: (p.label as string) ?? "Unknown",
        fileKey: p.fileKey as string | undefined,
        connectedAt,
        presenceRef: p.presence_ref,
        agentRole: (p.agentRole as AgentRole) ?? "idle",
        orchestrationId: p.orchestrationId as string | undefined,
        mcpInfo: p.mcpInfo as PresenceClient["mcpInfo"],
        figmaContext: p.figmaContext as PresenceClient["figmaContext"],
      })
    }
  }
  return Array.from(byClientId.values())
}
