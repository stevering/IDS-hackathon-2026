/**
 * MCP built-in preset registry.
 *
 * Single source of truth for the 6 MCP presets that Guardian supports in v1.
 * Pure constants + helpers, no runtime dependencies. Consumed by:
 *   - packages/web (Account page UI, API routes, chat body)
 *   - packages/temporal (worker activities that discover and execute tools)
 *   - packages/electron-overlay (bridge: reads user instances, maps to presets)
 *
 * User-defined custom MCPs are NOT in this registry — they are a v2 feature
 * that will add rows to user_mcp_instances with preset_type='custom'.
 */

export type Category = "design" | "code";
export type Scope = "cloud" | "local";
export type Transport = "http" | "sse" | "stdio";

export type BuiltinPreset = {
  /** Stable key stored in user_mcp_instances.preset_type. */
  preset_type: string;
  /** Short slug used as the first segment of the tool name prefix. */
  preset_slug: string;
  category: Category;
  scope: Scope;
  transport: Transport;
  display_name: string;
  description: string;
  /** Cloud only: HTTPS endpoint of the MCP server. */
  cloud_url?: string;
  /** Cloud only: OAuth scopes requested during authorization. */
  oauth_scopes?: string;
  /** Cloud only: webapp route that initiates the OAuth flow. */
  oauth_auth_path?: string;
  /** Local http/sse only: default URL if the user does not override. */
  default_local_url?: string;
  /** Local stdio only: command to spawn the subprocess. */
  stdio_command?: string;
  /** Local stdio only: arguments passed to the command. */
  stdio_args?: string[];
  /**
   * Template presets can produce multiple instances on the same device
   * (e.g. code_editor: Cursor + VS Code + IntelliJ in parallel).
   * Non-template presets are singletons per (user, device) for locals
   * and admit multiple instances for cloud (multi-account).
   */
  is_template: boolean;
};

/**
 * The 6 v1 built-in presets.
 *
 * Adding a new preset here requires:
 *   1. Update this map
 *   2. Implement the OAuth flow (cloud) OR the transport config (local)
 *   3. Teach the overlay how to create a client for the new preset (for local)
 */
export const BUILTIN_PRESETS: Record<string, BuiltinPreset> = {
  figma_mcp: {
    preset_type: "figma_mcp",
    preset_slug: "figma",
    category: "design",
    scope: "cloud",
    transport: "http",
    display_name: "Figma (official)",
    description:
      "Official Figma MCP — design context, metadata, screenshots, code generation hints",
    cloud_url: "https://mcp.figma.com/mcp",
    oauth_scopes: "mcp:connect",
    oauth_auth_path: "/api/auth/figma-mcp",
    is_template: false,
  },
  figma_console: {
    preset_type: "figma_console",
    preset_slug: "figmaconsole",
    category: "design",
    scope: "cloud",
    transport: "http",
    display_name: "Figma Console (cloud)",
    description:
      "Structured Figma tools via the Southleft Console MCP — create, read, modify nodes",
    cloud_url: "https://figma-console-mcp.southleft.com/mcp",
    oauth_scopes: "file_content:read,library_content:read,file_variables:read",
    oauth_auth_path: "/api/auth/southleft-mcp",
    is_template: false,
  },
  github: {
    preset_type: "github",
    preset_slug: "github",
    category: "code",
    scope: "cloud",
    transport: "http",
    display_name: "GitHub",
    description:
      "GitHub repositories, code search, issues, and pull request management",
    cloud_url: "https://api.githubcopilot.com/mcp",
    oauth_scopes: "repo",
    oauth_auth_path: "/api/auth/github-mcp",
    is_template: false,
  },
  figma_desktop: {
    preset_type: "figma_desktop",
    preset_slug: "figmadesktop",
    category: "design",
    scope: "local",
    transport: "http",
    display_name: "Figma Desktop",
    description:
      "Local MCP exposed by the Figma Desktop app — only available on machines with Figma Desktop running",
    default_local_url: "http://127.0.0.1:3845/mcp",
    is_template: false,
  },
  figma_console_local: {
    preset_type: "figma_console_local",
    // Same slug as figma_console: only one of the two is ever exposed to the
    // LLM for a given user, since they provide the same tool surface.
    preset_slug: "figmaconsole",
    category: "design",
    scope: "local",
    transport: "stdio",
    display_name: "Figma Console (local bridge)",
    description:
      "Local subprocess (npx figma-console-mcp) bridging to the Figma plugin via WebSocket",
    stdio_command: "npx",
    stdio_args: ["figma-console-mcp@latest"],
    is_template: false,
  },
  code_editor: {
    preset_type: "code_editor",
    preset_slug: "codeedit",
    category: "code",
    scope: "local",
    // Default transport for most IDE MCP servers; instances may override
    // to 'sse' via config.transport if their IDE uses SSE.
    transport: "http",
    display_name: "Code Editor MCP",
    description:
      "Local MCP exposed by an IDE (Cursor, VS Code, IntelliJ, Claude Code, Zed, ...). Users can configure multiple instances per device.",
    default_local_url: "http://127.0.0.1:3846/sse",
    is_template: true,
  },
};

/** All preset keys as a typed tuple (for exhaustive switches). */
export const BUILTIN_PRESET_KEYS = Object.keys(BUILTIN_PRESETS) as Array<
  keyof typeof BUILTIN_PRESETS
>;

/** Return the preset slug for a given preset_type, or the preset_type itself as a fallback. */
export function presetSlugOf(presetType: string): string {
  return BUILTIN_PRESETS[presetType]?.preset_slug ?? presetType;
}

/** Return the category ('design' | 'code') for a given preset_type, or undefined if unknown. */
export function categoryOf(presetType: string): Category | undefined {
  return BUILTIN_PRESETS[presetType]?.category;
}

/** Return the scope ('cloud' | 'local') for a given preset_type, or undefined if unknown. */
export function scopeOf(presetType: string): Scope | undefined {
  return BUILTIN_PRESETS[presetType]?.scope;
}

/** Lookup a preset by its key. */
export function getPreset(presetType: string): BuiltinPreset | undefined {
  return BUILTIN_PRESETS[presetType];
}

/** True if the preset supports multiple instances on the same device. */
export function isTemplatePreset(presetType: string): boolean {
  return BUILTIN_PRESETS[presetType]?.is_template === true;
}

/**
 * Compose the full tool name prefix for an instance.
 * Format: `<preset_slug>_<label>_`
 *
 * Examples:
 *   buildToolPrefix('figma_mcp', 'perso')      → 'figma_perso_'
 *   buildToolPrefix('github', 'stevering')     → 'github_stevering_'
 *   buildToolPrefix('code_editor', 'cursor_mac') → 'codeedit_cursor_mac_'
 */
export function buildToolPrefix(presetType: string, label: string): string {
  const slug = presetSlugOf(presetType);
  // When label matches slug (default single instance), don't double the prefix.
  // e.g., figmaconsole + figmaconsole → "figmaconsole_" not "figmaconsole_figmaconsole_"
  if (label === slug) return `${slug}_`;
  return `${slug}_${label}_`;
}

/**
 * Given a prefixed tool name, try to extract the (slug, label, raw_tool_name).
 * Returns undefined if the name does not match any known preset slug.
 *
 * Note: ambiguity is possible when two presets share a slug (figma_console and
 * figma_console_local both use 'figmaconsole'). The caller must resolve this
 * against the user's actual instances.
 */
export function parseToolName(
  prefixedName: string,
): { slug: string; label: string; rawName: string } | undefined {
  for (const preset of Object.values(BUILTIN_PRESETS)) {
    const prefix = `${preset.preset_slug}_`;
    if (!prefixedName.startsWith(prefix)) continue;
    const remainder = prefixedName.slice(prefix.length);
    // label is the first underscore-delimited segment; the rest is the tool name
    const firstUnderscore = remainder.indexOf("_");
    if (firstUnderscore === -1) continue;
    const label = remainder.slice(0, firstUnderscore);
    const rawName = remainder.slice(firstUnderscore + 1);
    if (label.length === 0 || rawName.length === 0) continue;
    return { slug: preset.preset_slug, label, rawName };
  }
  return undefined;
}
