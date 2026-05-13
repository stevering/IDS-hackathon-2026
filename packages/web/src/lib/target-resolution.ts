/**
 * Target resolution for the chat workflow's TargetSelector.
 *
 * Replaces the silent cascade fallback in page.tsx (`targetPluginClientId ??
 * isFigmaPlugin ? myClientId : undefined ?? presencePluginClientId`) which
 * picked a plugin without telling the user when multiple were running.
 *
 * The resolver outputs a structured pairing state per category:
 *   - "explicit": user picked a specific target in the selector
 *   - "auto-resolved": user picked "Auto" and exactly one candidate is active
 *   - "ambiguous": user picked "Auto" and >=2 plugins are active — UI must
 *     surface to the LLM via system-prompt disambiguation block, LLM asks
 *     via QCM_FORMAT, click sets the selector to a specific plugin
 *   - "no-plugin": user picked "Auto" and no plugin is connected (only
 *     read-only REST endpoints can serve)
 *
 * REST endpoints (figma_console MCP, figma_mcp official) are always exposed
 * separately — they don't depend on a paired plugin and work via fileUrl.
 *
 * Per-message switching (the LLM-driven QCM flow) is supported by recomputing
 * the resolution on every send; the resulting `pairedPluginClientId` is sent
 * with each chat message so the worker can re-pair Southleft's cloud relay
 * if the target plugin changed (see `lastPairedPluginByUser` cache in
 * packages/temporal/src/activities/mcp.ts).
 */

import type { PresenceClient } from "@/types/presence";
import type { MCPInstance } from "@/app/hooks/useUserMCPInstances";

// ---------------------------------------------------------------------------
// Selection state
// ---------------------------------------------------------------------------

export type TargetSelection =
  | "auto"
  | `plugin:${string}`
  | `instance:${string}`
  | null;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type PluginCandidate = {
  clientId: string;
  shortId: string;
  label: string;
  fileName?: string;
  fileKey?: string;
  fileUrl?: string;
  connectedAt: number;
};

export type RestEndpoint = {
  instanceId: string;
  presetType: string; // "figma_console" | "figma_mcp" | future
  label: string;
  capabilities: ("read" | "screenshot")[];
};

export type DesignPairing =
  | { kind: "explicit"; plugin: PluginCandidate }
  | { kind: "auto-resolved"; plugin: PluginCandidate }
  | { kind: "ambiguous"; candidates: PluginCandidate[]; suggestion: PluginCandidate }
  | { kind: "no-plugin" };

export type DesignResolution = {
  /** Plugin paired for plugin-bound tools — undefined if ambig or no-plugin. */
  pairedPluginClientId: string | undefined;
  pairing: DesignPairing;
  /**
   * All currently-active plugins (independent of `pairing.kind`). Lets the
   * worker construct a "switch" QCM when the user wants to retarget mid-conv
   * (e.g. asks "et sur file A ?" after we already paired with file B).
   * `pairing.candidates` only exists for `kind: "ambiguous"`; this field is
   * the always-on superset.
   */
  availablePlugins: PluginCandidate[];
  /** Always-available REST endpoints (work with fileUrl, no pairing needed). */
  restEndpoints: RestEndpoint[];
};

export type CodePairing =
  | { kind: "explicit"; instance: { instanceId: string; label: string; presetType: string } }
  | { kind: "auto-resolved"; instance: { instanceId: string; label: string; presetType: string } }
  | { kind: "ambiguous"; candidates: { instanceId: string; label: string; presetType: string }[]; suggestion: { instanceId: string; label: string; presetType: string } }
  | { kind: "none" };

export type CodeResolution = {
  pairing: CodePairing;
  /** All currently-active code MCP instances — same role as `availablePlugins`. */
  availableInstances: { instanceId: string; label: string; presetType: string }[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pluginFromClient(c: PresenceClient): PluginCandidate {
  return {
    clientId: c.clientId,
    shortId: c.shortId,
    label: c.label,
    fileName: c.figmaContext?.fileName,
    fileKey: c.fileKey,
    fileUrl: c.figmaContext?.fileUrl ?? undefined,
    connectedAt: c.connectedAt,
  };
}

function activePlugins(clients: PresenceClient[]): PluginCandidate[] {
  return clients
    .filter((c) => c.type === "figma-plugin")
    .map(pluginFromClient)
    // most recent in presence first — used as `suggestion` when ambig
    .sort((a, b) => b.connectedAt - a.connectedAt);
}

/**
 * Read-only REST endpoints exposed by enabled+ready design-category MCP
 * instances. Convention-based: `figma_console` and `figma_mcp` both have
 * `figma_get_*` tools that work via `fileUrl` without a paired plugin.
 */
function designRestEndpoints(mcpInstances: MCPInstance[]): RestEndpoint[] {
  return mcpInstances
    .filter((i) => i.category === "design" && i.enabled && i.ready)
    .filter((i) => i.preset_type === "figma_console" || i.preset_type === "figma_mcp")
    .map((i) => ({
      instanceId: i.id,
      presetType: i.preset_type,
      label: i.display_name ?? i.preset?.display_name ?? i.label,
      capabilities: ["read", "screenshot"],
    }));
}

// ---------------------------------------------------------------------------
// Design resolver
// ---------------------------------------------------------------------------

export function resolveDesignTarget(
  selection: TargetSelection,
  mcpInstances: MCPInstance[],
  clients: PresenceClient[],
): DesignResolution {
  const restEndpoints = designRestEndpoints(mcpInstances);
  const plugins = activePlugins(clients);

  // Explicit pick — if still active, honor; otherwise fall through to auto.
  if (selection?.startsWith("plugin:")) {
    const clientId = selection.slice("plugin:".length);
    const plugin = plugins.find((p) => p.clientId === clientId);
    if (plugin) {
      return {
        pairedPluginClientId: plugin.clientId,
        pairing: { kind: "explicit", plugin },
        availablePlugins: plugins,
        restEndpoints,
      };
    }
    // Disconnected — let auto take over.
  }
  if (selection?.startsWith("instance:")) {
    const instanceId = selection.slice("instance:".length);
    const inst = mcpInstances.find((i) => i.id === instanceId && i.category === "design" && i.ready);
    if (inst) {
      // Picking an MCP instance directly = REST-only mode (no paired plugin).
      return {
        pairedPluginClientId: undefined,
        pairing: { kind: "no-plugin" },
        availablePlugins: plugins,
        restEndpoints,
      };
    }
    // Disconnected — let auto take over.
  }

  // Auto resolution.
  if (plugins.length === 0) {
    return {
      pairedPluginClientId: undefined,
      pairing: { kind: "no-plugin" },
      availablePlugins: plugins,
      restEndpoints,
    };
  }
  if (plugins.length === 1) {
    return {
      pairedPluginClientId: plugins[0].clientId,
      pairing: { kind: "auto-resolved", plugin: plugins[0] },
      availablePlugins: plugins,
      restEndpoints,
    };
  }
  return {
    pairedPluginClientId: undefined,
    pairing: { kind: "ambiguous", candidates: plugins, suggestion: plugins[0] },
    availablePlugins: plugins,
    restEndpoints,
  };
}

// ---------------------------------------------------------------------------
// Code resolver
// ---------------------------------------------------------------------------

export function resolveCodeTarget(
  selection: TargetSelection,
  mcpInstances: MCPInstance[],
): CodeResolution {
  const candidates = mcpInstances
    .filter((i) => i.category === "code" && i.enabled && i.ready)
    .map((i) => ({
      instanceId: i.id,
      label: i.display_name ?? i.preset?.display_name ?? i.label,
      presetType: i.preset_type,
    }));

  if (selection?.startsWith("instance:")) {
    const instanceId = selection.slice("instance:".length);
    const inst = candidates.find((c) => c.instanceId === instanceId);
    if (inst) {
      return { pairing: { kind: "explicit", instance: inst }, availableInstances: candidates };
    }
  }

  if (candidates.length === 0) {
    return { pairing: { kind: "none" }, availableInstances: candidates };
  }
  if (candidates.length === 1) {
    return { pairing: { kind: "auto-resolved", instance: candidates[0] }, availableInstances: candidates };
  }
  // No reliable "most recent" signal for MCP instances (they're persistent).
  // Suggest the first; future: use last-used timestamp per instance.
  return { pairing: { kind: "ambiguous", candidates, suggestion: candidates[0] }, availableInstances: candidates };
}

// ---------------------------------------------------------------------------
// Display helpers (for the "Auto" entry subtitle in the TargetSelector)
// ---------------------------------------------------------------------------

export function summarizeDesignResolution(r: DesignResolution): string {
  switch (r.pairing.kind) {
    case "explicit":
      return `→ ${r.pairing.plugin.shortId}${r.pairing.plugin.fileName ? ` (${r.pairing.plugin.fileName})` : ""}`;
    case "auto-resolved":
      return `→ ${r.pairing.plugin.shortId}${r.pairing.plugin.fileName ? ` (${r.pairing.plugin.fileName})` : ""}`;
    case "ambiguous":
      return `→ ambiguous (${r.pairing.candidates.length} plugins)`;
    case "no-plugin":
      return r.restEndpoints.length > 0 ? "→ no plugin (REST only)" : "→ no design target";
  }
}

export function summarizeCodeResolution(r: CodeResolution): string {
  switch (r.pairing.kind) {
    case "explicit":
    case "auto-resolved":
      return `→ ${r.pairing.instance.label}`;
    case "ambiguous":
      return `→ ambiguous (${r.pairing.candidates.length} options)`;
    case "none":
      return "→ none";
  }
}
