import { createMcpSupabaseClient } from "./supabase.js"

const CHANNEL_BASE = "guardian:execute"

/** Lightweight presence info for a connected Figma plugin client */
export type ConnectedClient = {
  clientId: string
  shortId: string
  label: string
  fileKey?: string
  figmaContext?: {
    fileName?: string
    fileUrl?: string | null
    pages?: { id: string; name: string }[]
    currentPage?: { id: string; name: string } | null
    currentUser?: { id: string; name: string } | null
  }
  connectedAt?: number
}

/**
 * Query connected Figma plugin clients via Supabase Realtime presence.
 * Does NOT execute any code — only reads the presence state.
 */
export async function getConnectedClients(userId?: string): Promise<ConnectedClient[]> {
  const channelName = userId ? `${CHANNEL_BASE}:${userId}` : CHANNEL_BASE
  const supabase = createMcpSupabaseClient()
  const channel = supabase.channel(channelName, {
    config: { presence: { key: "mcp-query" } },
  })

  return new Promise<ConnectedClient[]>((resolve) => {
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        channel.unsubscribe()
        resolve([])
      }
    }, 3000)

    channel
      .on("presence", { event: "sync" }, () => {
        if (settled) return
        settled = true
        clearTimeout(timer)

        const state = channel.presenceState()
        const clients: ConnectedClient[] = []

        for (const presences of Object.values(state)) {
          for (const p of presences as Record<string, unknown>[]) {
            if (p.type !== "figma-plugin") continue
            clients.push({
              clientId: (p.clientId as string) ?? "unknown",
              shortId: (p.serverShortId as string) ?? (p.clientId as string) ?? "unknown",
              label: (p.label as string) ?? "Unknown",
              fileKey: p.fileKey as string | undefined,
              figmaContext: p.figmaContext as ConnectedClient["figmaContext"],
              connectedAt: p.connectedAt as number | undefined,
            })
          }
        }

        channel.unsubscribe()
        resolve(clients)
      })
      .subscribe()
  })
}

/** Result from a single client execution */
export type ClientExecResult = {
  clientId: string
  client?: string // human-readable label from presence (e.g. "Figma-Desktop")
  success: boolean
  result?: unknown
  error?: string
}

/** Aggregated execution result with metadata */
export type ExecResult = {
  success: boolean
  /** Array of all client responses (each with clientId, success, result/error) */
  result?: ClientExecResult[]
  error?: string
  /** Number of figma-plugin clients discovered via presence */
  expectedClients?: number
}

/**
 * Execute code via Supabase Realtime broadcast channel (presence-aware).
 *
 * Flow:
 * 1. Subscribe to channel with presence support
 * 2. Wait for presence sync to discover connected figma-plugin clients
 * 3. Broadcast execute_request
 * 4. Collect ALL results (up to expectedCount or timeout)
 * 5. Return primary result + all results metadata
 */
export async function executeViaSupabase(
  code: string,
  requestId: string,
  timeoutMs: number,
  userId?: string,
  targetClientId?: string
): Promise<ExecResult> {
  const channelName = userId ? `${CHANNEL_BASE}:${userId}` : CHANNEL_BASE
  const supabase = createMcpSupabaseClient()
  const channel = supabase.channel(channelName, {
    config: { presence: { key: "mcp-server" } },
  })

  return new Promise<ExecResult>((resolve) => {
    let settled = false
    const collectedResults: ClientExecResult[] = []
    let expectedCount = 1 // fallback if presence sync doesn't arrive
    let presenceReady = false
    let broadcastSent = false
    let knownPluginIds: Set<string> | null = null // populated after presence sync
    const pluginLabels = new Map<string, string>() // clientId → human label

    const settle = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(presenceTimer)
      channel.unsubscribe()

      if (collectedResults.length === 0) {
        resolve({
          success: false,
          error: `Timed out after ${timeoutMs}ms waiting for Supabase Realtime result. Make sure the Figma plugin is open with the Guardian webapp loaded.`,
          result: [],
          expectedClients: expectedCount,
        })
        return
      }

      const anySuccess = collectedResults.some((r) => r.success)
      resolve({
        success: anySuccess,
        result: collectedResults,
        expectedClients: expectedCount,
      })
    }

    // Main timeout — settle with whatever we have
    const timer = setTimeout(settle, timeoutMs)

    // Presence sync timeout — if sync doesn't arrive within 2s, proceed with fallback
    let presenceTimer: ReturnType<typeof setTimeout>

    const trySettleIfComplete = () => {
      if (settled) return
      if (collectedResults.length >= expectedCount && broadcastSent) {
        settle()
      }
    }

    const readPresenceAndBroadcast = async () => {
      if (presenceReady) return
      presenceReady = true

      // Read presence state to discover figma-plugin clients
      const state = channel.presenceState()
      const pluginClientIds: string[] = []
      for (const presences of Object.values(state)) {
        for (const p of presences as { type?: string; clientId?: string; serverShortId?: string; label?: string }[]) {
          if (p.type === "figma-plugin") {
            const id = p.clientId ?? "unknown"
            pluginClientIds.push(id)
            pluginLabels.set(id, p.serverShortId ?? p.label ?? id)
          }
        }
      }

      // Resolve targetClientId: the LLM may pass a shortId (e.g. "Figma-Desktop-zivihi")
      // instead of the raw clientId (e.g. "kukftiz0"). Match against presence labels.
      let resolvedTargetClientId = targetClientId
      if (targetClientId && !pluginClientIds.includes(targetClientId)) {
        const normalizedTarget = targetClientId.replace(/^#/, "")
        for (const [id, label] of pluginLabels) {
          if (label.replace(/^#/, "") === normalizedTarget) {
            resolvedTargetClientId = id
            break
          }
        }
      }

      if (resolvedTargetClientId) {
        expectedCount = 1
        knownPluginIds = new Set([resolvedTargetClientId])
      } else if (pluginClientIds.length > 0) {
        expectedCount = pluginClientIds.length
        knownPluginIds = new Set(pluginClientIds)
      } else {
        // No figma-plugin clients found in presence — resolve immediately
        if (!settled) {
          settled = true
          clearTimeout(timer)
          clearTimeout(presenceTimer)
          channel.unsubscribe()
          resolve({
            success: false,
            error: `No Figma plugin clients connected. Make sure the Figma plugin is open with the Guardian webapp loaded. (${Object.values(state).flat().length} total client(s) on channel, 0 figma-plugin)`,
            result: [],
            expectedClients: 0,
          })
          return
        }
      }

      // Broadcast the execute request (use resolved clientId, not the original shortId)
      await channel.send({
        type: "broadcast",
        event: "execute_request",
        payload: { requestId, code, timeout: timeoutMs, targetClientId: resolvedTargetClientId },
      })
      broadcastSent = true

      // Check if we already have enough results (unlikely but possible)
      trySettleIfComplete()
    }

    channel
      .on("presence", { event: "sync" }, () => {
        if (!presenceReady && !settled) {
          clearTimeout(presenceTimer)
          readPresenceAndBroadcast()
        }
      })
      .on("broadcast", { event: "execute_result" }, (payload) => {
        const data = payload.payload as {
          requestId: string
          senderClientId?: string
          success: boolean
          result?: unknown
          error?: string
        }

        if (data.requestId !== requestId) return
        if (settled) return

        // Ignore responses from non-plugin clients (e.g. webapp tabs)
        const senderId = data.senderClientId ?? "unknown"
        if (knownPluginIds && !knownPluginIds.has(senderId)) return

        collectedResults.push({
          clientId: senderId,
          client: pluginLabels.get(senderId),
          success: data.success,
          result: data.result,
          error: data.error,
        })

        trySettleIfComplete()
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          // Start a 2s timer for presence sync — if it doesn't arrive, broadcast anyway
          presenceTimer = setTimeout(() => {
            if (!presenceReady && !settled) {
              // Presence sync didn't arrive — fallback: broadcast with expectedCount=1
              readPresenceAndBroadcast()
            }
          }, 2000)
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          if (settled) return
          settled = true
          clearTimeout(timer)
          clearTimeout(presenceTimer)
          resolve({
            success: false,
            error: `Supabase Realtime channel error: ${status}. Check NEXT_PUBLIC_STORAGE_SUPABASE_URL and STORAGE_SUPABASE_SERVICE_ROLE_KEY.`,
          })
        }
      })
  })
}
