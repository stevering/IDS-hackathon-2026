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
  /**
   * Cloud only: OAuth2 token endpoint for refresh_token grant (RFC 6749 §6).
   * If defined, the worker will auto-refresh expired tokens before using them.
   * If undefined, tokens are used as-is and expire naturally (user must re-auth).
   */
  oauth_token_endpoint?: string;
  /**
   * Cloud only: Base URL for RFC 8414 OAuth authorization server metadata discovery.
   * Alternative to oauth_token_endpoint — the token_endpoint is fetched from
   * `<url>/.well-known/oauth-authorization-server` at refresh time (cached).
   * Used by Figma MCP (mcp.figma.com) which publishes its metadata dynamically.
   */
  oauth_discovery_url?: string;
  /**
   * Cloud only: env var name holding the client_id for refresh requests.
   * If absent, refresh is skipped (assumes user manually re-auths on expiration).
   */
  oauth_client_id_env?: string;
  /**
   * Cloud only: env var name holding the client_secret (for confidential clients).
   * Public clients (PKCE) may omit this.
   */
  oauth_client_secret_env?: string;
  /** Local http/sse only: default URL if the user does not override. */
  default_local_url?: string;
  /** Local stdio only: command to spawn the subprocess. */
  stdio_command?: string;
  /** Local stdio only: arguments passed to the command. */
  stdio_args?: string[];
  /**
   * Local http/sse only: ports to probe on 127.0.0.1 to detect a running
   * instance. The Desktop Companion scans these periodically and reports
   * found services in its heartbeat as "discovered". Omit for stdio presets
   * (there's nothing to probe — they're always spawn-on-demand).
   *
   * Examples:
   *   figma_desktop → [3845]
   *   code_editor   → [3846, 63342, 6365, 64342, 3847, 52698]  (Cursor, IntelliJ Web, JetBrains MCP, JetBrains MCP alt, VSCode-Continue, Zed)
   */
  scan_ports?: number[];
  /**
   * Local http/sse only: path appended to the probed URL.
   * Defaults to "/mcp" for http, "/sse" for sse.
   */
  scan_path?: string;
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
    // Figma MCP publishes token endpoint via RFC 8414 discovery at mcp.figma.com.
    // `expires_in` advertised as 90 days but server may invalidate earlier →
    // reactive refresh on 401 handles that case.
    oauth_discovery_url: "https://mcp.figma.com",
    oauth_client_id_env: "FIGMA_CLIENT_ID",
    oauth_client_secret_env: "FIGMA_CLIENT_SECRET",
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
    // Southleft uses DCR (Dynamic Client Registration) — no static client creds in env.
    // The client_id/client_secret are generated at connect time and stored in the
    // Vault alongside the tokens (`_guardian_client_info` field). The refresh helper
    // extracts them from there instead of env vars.
    oauth_discovery_url: "https://figma-console-mcp.southleft.com",
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
    // GitHub Apps with user-to-server expiration enabled: 8h access + rotating refresh.
    oauth_token_endpoint: "https://github.com/login/oauth/access_token",
    oauth_client_id_env: "GITHUB_CLIENT_ID",
    oauth_client_secret_env: "GITHUB_CLIENT_SECRET",
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
    scan_ports: [3845],
    scan_path: "/mcp",
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
    // Default transport — used when creating a client without explicit transport.
    // Discovery scan always tries http (/mcp) first, then sse (/sse) as fallback.
    transport: "http",
    display_name: "Code Editor MCP",
    description:
      "Local MCP exposed by an IDE (Cursor, VS Code, IntelliJ, Claude Code, Zed, ...). Users can configure multiple instances per device.",
    default_local_url: "http://127.0.0.1:3846/mcp",
    // Common IDE MCP ports — the companion probes http then sse on each.
    // 3846: Cursor, 63342: IntelliJ Web Server, 6365: JetBrains MCP (default),
    // 64342: JetBrains MCP (alt), 3847: VSCode-Continue, 52698: Zed
    scan_ports: [3846, 63342, 6365, 64342, 3847, 52698],
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
