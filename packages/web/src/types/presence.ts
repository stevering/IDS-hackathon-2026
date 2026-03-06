export type ClientType = "figma-plugin" | "webapp" | "overlay"

export type PresenceClient = {
  type: ClientType
  shortId: string
  label: string
  fileKey?: string
  connectedAt: number
  presenceRef: string
  mcpInfo?: {
    figma?: { connected: boolean; mode: string }
    code?: { connected: boolean; path: string }
  }
}

export function generateShortId(type: ClientType, presenceRef: string): string {
  const prefix = type === "figma-plugin" ? "A" : type === "webapp" ? "B" : "C"
  const hex = presenceRef.slice(-2).toUpperCase()
  return `#${prefix}${hex}`
}

export function parsePresenceState(
  state: Record<string, { presence_ref: string; [key: string]: unknown }[]>
): PresenceClient[] {
  const clients: PresenceClient[] = []
  for (const presences of Object.values(state)) {
    for (const p of presences) {
      const type = (p.type as ClientType) ?? "webapp"
      clients.push({
        type,
        shortId: generateShortId(type, p.presence_ref),
        label: (p.label as string) ?? "Unknown",
        fileKey: p.fileKey as string | undefined,
        connectedAt: (p.connectedAt as number) ?? Date.now(),
        presenceRef: p.presence_ref,
        mcpInfo: p.mcpInfo as PresenceClient["mcpInfo"],
      })
    }
  }
  return clients
}
