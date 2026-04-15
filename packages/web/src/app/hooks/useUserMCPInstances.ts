"use client";

import { useState, useEffect, useCallback } from "react";
import { BUILTIN_PRESETS, type Category } from "@guardian/orchestrations/mcp";

/** Enriched instance as returned by GET /api/user/mcp-instances. */
export type MCPInstance = {
  id: string;
  preset_type: string;
  preset: {
    display_name: string;
    description: string;
    preset_slug: string;
    transport: string;
    is_template: boolean;
    oauth_auth_path: string | null;
  } | null;
  category: string;
  scope: string;
  label: string;
  display_name: string | null;
  tool_prefix: string;
  device: {
    id: string;
    name: string;
    last_seen_at: string;
    online: boolean;
  } | null;
  connection: {
    server_id: string;
    scopes: string | null;
    expires_at: string | null;
    connected_at: string | null;
    expired: boolean;
  } | null;
  config: Record<string, unknown>;
  enabled: boolean;
  /** True if the user explicitly ignored this discovered service (enabled=false only). */
  dismissed: boolean;
  ready: boolean;
  created_at: string;
  updated_at: string;
};

export type MCPCategoryDefaults = {
  design: string | null;
  code: string | null;
};

/** Cloud preset enriched with user's instance data (if any). */
export type CloudPresetView = {
  preset_type: string;
  display_name: string;
  description: string;
  oauth_auth_path: string;
  category: Category;
  instance: MCPInstance | null;
};

export function useUserMCPInstances() {
  const [instances, setInstances] = useState<MCPInstance[]>([]);
  const [defaults, setDefaults] = useState<MCPCategoryDefaults>({ design: null, code: null });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    // Diagnostic timing: helps identify the "TargetSelector flashes offline
    // on nav back" pattern — measures empty-state duration on each remount.
    // Add ?slowMcp=2000 to URL to inject a synthetic delay (in ms) and
    // exaggerate the symptom for visual verification.
    const t0 = performance.now();
    const slowMs = typeof window !== "undefined"
      ? Number(new URLSearchParams(window.location.search).get("slowMcp")) || 0
      : 0;
    try {
      if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));
      const res = await fetch("/api/user/mcp-instances");
      if (!res.ok) return;
      const data = await res.json();
      const elapsed = Math.round(performance.now() - t0);
      const instCount = (data.instances ?? []).length;
      console.log(`[useUserMCPInstances] fetch done in ${elapsed}ms — ${instCount} instance(s)${slowMs ? ` (synthetic +${slowMs}ms)` : ""}`);
      setInstances(data.instances ?? []);
      setDefaults(data.defaults ?? { design: null, code: null });
    } catch (err) {
      console.error("[useUserMCPInstances] fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    console.log("[useUserMCPInstances] mount — empty state until fetch resolves");
    load();
    return () => {
      console.log("[useUserMCPInstances] unmount");
    };
  }, [load]);

  /** Cloud presets with instance overlaid. */
  const cloudPresets: CloudPresetView[] = Object.values(BUILTIN_PRESETS)
    .filter((p) => p.scope === "cloud")
    .map((p) => ({
      preset_type: p.preset_type,
      display_name: p.display_name,
      description: p.description,
      oauth_auth_path: p.oauth_auth_path ?? "",
      category: p.category,
      instance: instances.find(
        (i) => i.preset_type === p.preset_type && i.scope === "cloud",
      ) ?? null,
    }));

  const localInstances = instances.filter((i) => i.scope === "local");

  return {
    instances,
    cloudPresets,
    localInstances,
    defaults,
    loading,
    reload: load,
  };
}
