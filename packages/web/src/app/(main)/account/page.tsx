"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useGuardianPresence } from "@/app/hooks/useGuardianPresence";
import { ConnectedClients } from "@/components/ConnectedClients";
import { GlassDropdown } from "@/components/GlassDropdown";
import { LegalFooter } from "@/components/LegalFooter";
import { useUserMCPInstances, type CloudPresetView } from "@/app/hooks/useUserMCPInstances";
import { LocalServicesSection } from "./LocalServicesSection";

type StoredKey = {
  id: string;
  provider: string;
  label: string | null;
  key_hint: string | null;
  is_default: boolean;
  default_model: string | null;
  created_at: string;
  updated_at: string;
};

type DynamicProvider = {
  id: string;
  name: string;
};

type CatalogModel = {
  id: string;
  name: string;
  owned_by: string;
  tags?: string[];
};

type UsageSource = "included" | "byok";

const PROVIDER_HINTS: Record<string, string> = {
  openai: "sk-...",
  anthropic: "sk-ant-...",
  google: "AIza...",
  xai: "xai-...",
  meta: "...",
  mistral: "...",
  deepseek: "...",
  gateway: "gw-...",
};

// Tier definitions (mirrored from tiers.ts for client use)
const TIERS = [
  {
    id: "free" as const,
    name: "Free",
    price: null,
    features: ["250k tokens / 24h", "Selected free models", "Basic features", "Cloud platform", "BYOK support"],
    comingSoon: false,
  },
  {
    id: "pro" as const,
    name: "Pro",
    price: "Monthly",
    features: ["500k tokens / 24h", "All models", "Pro features", "BYOK support", "24h support"],
    comingSoon: true,
  },
  {
    id: "enterprise" as const,
    name: "Enterprise",
    price: "Custom",
    features: ["1M tokens / 24h", "All models", "Enterprise features", "BYOK support", "4h support"],
    comingSoon: true,
  },
];

// Models allowed in free tier included usage
const FREE_TIER_MODELS = ["google/gemini-2.5-flash", "google/gemini-2.5-pro"];

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function AccountPage() {
  const router = useRouter();
  const { clients: presenceClients, loading: presenceLoading, connectionStatus: presenceConnectionStatus } = useGuardianPresence();
  const [keys, setKeys] = useState<StoredKey[]>([]);
  const [usage, setUsage] = useState<{
    daily: { total_tokens: number; input_tokens: number; output_tokens: number; cost_input_usd: number; cost_output_usd: number; limit: number };
    monthly: { total_tokens: number; input_tokens: number; output_tokens: number; cost_input_usd: number; cost_output_usd: number };
    lifetime: { total_tokens: number; input_tokens: number; output_tokens: number; cost_input_usd: number; cost_output_usd: number };
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Usage source
  const [usageSource, setUsageSource] = useState<UsageSource>("included");

  // Dynamic provider list
  const [providers, setProviders] = useState<DynamicProvider[]>([
    { id: "gateway", name: "Vercel AI Gateway" },
  ]);
  const [selectedProvider, setSelectedProvider] = useState("gateway");
  const [secret, setSecret] = useState("");
  const [keyLabel, setKeyLabel] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [search, setSearch] = useState("");
  const dropdownBtnRef = useRef<HTMLButtonElement>(null);

  // Included model selection (for included usage source)
  const [catalogModels, setCatalogModels] = useState<CatalogModel[]>([]);
  // Native model catalogs per direct-provider key (enriched with gateway metadata server-side)
  const [nativeModels, setNativeModels] = useState<Record<string, { id: string; name: string; owned_by: string; tags?: string[]; context_window?: number; max_tokens?: number }[]>>({});
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [savingDefaultModel, setSavingDefaultModel] = useState(false);
  const [includedModelDropdownOpen, setIncludedModelDropdownOpen] = useState(false);
  const [includedModelSearch, setIncludedModelSearch] = useState("");
  const includedModelBtnRef = useRef<HTMLButtonElement>(null);

  // Per-key model dropdowns
  const [keyModelDropdownOpen, setKeyModelDropdownOpen] = useState<string | null>(null);
  const [keyModelSearch, setKeyModelSearch] = useState("");
  const [savingKeyModel, setSavingKeyModel] = useState<string | null>(null);
  const keyModelBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const handleKeyModelDropdownClose = useCallback(() => {
    setKeyModelDropdownOpen(null);
    setKeyModelSearch("");
  }, []);

  // Orchestration settings
  const [approvalMode, setApprovalMode] = useState<"trust" | "brave">("trust");
  const [guardEnabled, setGuardEnabled] = useState(true);
  const [savingOrchSettings, setSavingOrchSettings] = useState(false);

  // Connected MCP services (legacy — kept for backward compat during migration)
  const [mcpServices, setMcpServices] = useState<Array<{
    id: string; name: string; description: string; authPath: string;
    connected: boolean; expired: boolean; scopes: string | null;
    connectedAt: string | null; expiresAt: string | null;
  }>>([]);
  const [disconnectingService, setDisconnectingService] = useState<string | null>(null);

  // New MCP instance registry (Phase 3)
  const mcpHook = useUserMCPInstances();

  // Developer settings
  const [developerMode, setDeveloperMode] = useState(false);
  const [devShowAllEvents, setDevShowAllEvents] = useState(false);
  const [devLLMDelegation, setDevLLMDelegation] = useState(false);
  const [devSlowDelegation, setDevSlowDelegation] = useState(false);
  const [savingDevSettings, setSavingDevSettings] = useState(false);
  const [devMatrix, setDevMatrix] = useState(false);

  // Account deletion
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteTyped, setDeleteTyped] = useState("");
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDeleteAccount() {
    setDeletingAccount(true);
    setDeleteError(null);
    try {
      const res = await fetch("/api/user/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok) {
        const data = await res.json();
        setDeleteError(data.error ?? "Deletion failed");
        setDeletingAccount(false);
        return;
      }
      // Account deleted — redirect to login
      window.location.href = "/login";
    } catch {
      setDeleteError("Network error. Please try again.");
      setDeletingAccount(false);
    }
  }

  // Load matrix mode from localStorage on mount
  useEffect(() => {
    setDevMatrix(localStorage.getItem("guardian_matrix") === "1");
  }, []);

  const handleDropdownClose = useCallback(() => {
    setDropdownOpen(false);
    setSearch("");
  }, []);

  const handleIncludedModelDropdownClose = useCallback(() => {
    setIncludedModelDropdownOpen(false);
    setIncludedModelSearch("");
  }, []);

  // Save included usage default model
  async function handleSaveDefaultModel(modelId: string | null) {
    setSavingDefaultModel(true);
    setError(null);
    try {
      const res = await fetch("/api/user/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultModel: modelId }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to save default model");
      } else {
        setDefaultModel(modelId);
      }
    } finally {
      setSavingDefaultModel(false);
    }
  }

  // Save usage source
  async function handleSetUsageSource(source: UsageSource) {
    // Don't allow BYOK if no keys
    if (source === "byok" && keys.length === 0) return;
    setUsageSource(source);
    try {
      await fetch("/api/user/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usageSource: source }),
      });
    } catch { /* ignore */ }
  }

  // Save per-key default model
  async function handleSaveKeyModel(keyId: string, modelId: string | null) {
    setSavingKeyModel(keyId);
    try {
      const res = await fetch("/api/user/api-keys/model", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: keyId, defaultModel: modelId }),
      });
      if (res.ok) {
        setKeys((prev) =>
          prev.map((k) => k.id === keyId ? { ...k, default_model: modelId } : k)
        );
      }
    } finally {
      setSavingKeyModel(null);
      setKeyModelDropdownOpen(null);
      setKeyModelSearch("");
    }
  }

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Sync OAuth cookies → DB before loading services (popup may have set cookies without DB write)
      await fetch("/api/user/connected-services/persist", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});

      const [keysRes, usageRes, modelsRes, settingsRes, servicesRes] = await Promise.all([
        fetch("/api/user/api-keys"),
        fetch("/api/user/usage"),
        fetch("/api/gateway-models"),
        fetch("/api/user/settings"),
        fetch("/api/user/connected-services"),
      ]);

      if (keysRes.status === 401) { router.push("/login"); return; }

      const keysData = await keysRes.json();
      const usageData = await usageRes.json();
      setKeys(keysData.keys ?? []);
      setUsage(usageData.daily ? usageData : null);

      // Load user settings
      if (settingsRes.ok) {
        const settingsData = await settingsRes.json();
        setDefaultModel(settingsData.defaultModel ?? null);
        setUsageSource(settingsData.usageSource ?? "included");
        if (settingsData.approvalMode) setApprovalMode(settingsData.approvalMode);
        if (typeof settingsData.guardEnabled === "boolean") setGuardEnabled(settingsData.guardEnabled);
        if (typeof settingsData.developerMode === "boolean") setDeveloperMode(settingsData.developerMode);
        if (typeof settingsData.devShowAllEvents === "boolean") setDevShowAllEvents(settingsData.devShowAllEvents);
        if (typeof settingsData.devLLMDelegation === "boolean") setDevLLMDelegation(settingsData.devLLMDelegation);
        if (typeof settingsData.devSlowDelegation === "boolean") setDevSlowDelegation(settingsData.devSlowDelegation);
      }

      // Load connected MCP services
      if (servicesRes.ok) {
        const servicesData = await servicesRes.json();
        setMcpServices(servicesData.services ?? []);
      }

      // Build dynamic provider list from Gateway catalog
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        const models: CatalogModel[] = modelsData.models ?? [];
        setCatalogModels(models);
        const seen = new Set<string>();
        const dynamic: DynamicProvider[] = [];
        for (const m of models) {
          if (m.owned_by && !seen.has(m.owned_by)) {
            seen.add(m.owned_by);
            dynamic.push({ id: m.owned_by, name: capitalize(m.owned_by) });
          }
        }
        setProviders([{ id: "gateway", name: "Vercel AI Gateway" }, ...dynamic]);
      }

      // Fetch native model catalogs for direct-provider keys
      const directKeys: StoredKey[] = (keysData.keys ?? []).filter((k: StoredKey) => k.provider !== "gateway");
      if (directKeys.length > 0) {
        const nativeResults = await Promise.all(
          directKeys.map((key) =>
            fetch(`/api/user/api-keys/provider-models?keyId=${key.id}`)
              .then((r) => r.ok ? r.json() : null)
              .then((data) => ({ keyId: key.id, models: data?.models ?? [] }))
              .catch(() => ({ keyId: key.id, models: [] as { id: string; name: string; owned_by: string }[] }))
          )
        );
        const nativeMap: Record<string, { id: string; name: string; owned_by: string }[]> = {};
        for (const { keyId, models: nModels } of nativeResults) {
          if (nModels.length > 0) nativeMap[keyId] = nModels;
        }
        setNativeModels(nativeMap);
      }
    } catch {
      setError("Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!secret.trim()) return;
    setSaving(selectedProvider);
    setError(null);
    try {
      const res = await fetch("/api/user/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: selectedProvider, secret: secret.trim(), label: keyLabel.trim() || undefined }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to save key");
      } else {
        setSecret("");
        setKeyLabel("");
        await loadData();
      }
    } finally {
      setSaving(null);
    }
  }

  async function handleDelete(keyId: string) {
    setDeleting(keyId);
    setError(null);
    try {
      const res = await fetch(`/api/user/api-keys?id=${encodeURIComponent(keyId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to delete key");
      } else {
        await loadData();
      }
    } finally {
      setDeleting(null);
    }
  }

  async function handleSetDefault(keyId: string) {
    setError(null);
    // Optimistic update — no full reload
    setKeys((prev) =>
      prev.map((k) => ({ ...k, is_default: k.id === keyId }))
    );
    try {
      const res = await fetch("/api/user/api-keys/default", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: keyId }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to set default");
        await loadData(); // Revert on error
      }
    } catch {
      setError("Failed to set default");
      await loadData();
    }
  }

  const providerLabel = (id: string) =>
    providers.find((p) => p.id === id)?.name ?? capitalize(id);

  const fmt = (n: number) => n.toLocaleString("en-US");
  const fmtCost = (n: number) => n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
  const fmtCompact = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

  // Models available for a given key
  function modelsForKey(key: StoredKey): (CatalogModel | { id: string; name: string; owned_by: string })[] {
    if (key.provider === "gateway") return catalogModels;
    // Use native catalog if available, otherwise fallback to gateway filtered
    return nativeModels[key.id] ?? catalogModels.filter((m) => m.owned_by === key.provider);
  }

  // Models for included usage (free tier = restricted)
  const includedModels = catalogModels.filter((m) => FREE_TIER_MODELS.includes(m.id));

  // Default key info
  const defaultKey = keys.find((k) => k.is_default);
  const hasKeys = keys.length > 0;

  // Effective model label for the usage source display
  const effectiveModelLabel = usageSource === "byok" && defaultKey
    ? (() => {
        const m = catalogModels.find((cm) => cm.id === defaultKey.default_model);
        return m ? m.name : defaultKey.default_model ?? "Auto-select";
      })()
    : (() => {
        const m = catalogModels.find((cm) => cm.id === defaultModel);
        return m ? m.name : defaultModel ?? "Gemini 2.5 Flash";
      })();

  return (
    <div className="px-4 py-8 max-w-2xl mx-auto">
      {/* Page title */}
      <div className="mb-8">
        <h1 className="text-xl font-semibold">Account settings</h1>
        <p className="text-sm text-white/40 mt-0.5">Manage your subscription, API keys, and preferences</p>
      </div>

      {/* ── Subscription Tiers ── */}
      <section className="mb-8">
        <h2 className="text-sm font-medium mb-3">Subscription</h2>
        <div className="grid grid-cols-3 gap-3">
          {TIERS.map((tier) => {
            const isActive = tier.id === "free";
            return (
              <div
                key={tier.id}
                className={`relative p-4 rounded-xl border transition-colors ${
                  isActive
                    ? "border-violet-400/40 bg-violet-500/[0.12] backdrop-blur-lg backdrop-saturate-[1.3] shadow-[0_0_24px_rgba(139,92,246,0.25)]"
                    : tier.comingSoon
                      ? "border-white/[0.08] bg-white/[0.06] backdrop-blur-lg backdrop-saturate-[1.3]"
                      : "border-white/[0.1] bg-white/[0.06] backdrop-blur-lg backdrop-saturate-[1.3]"
                }`}
              >
                {isActive && (
                  <span className="absolute top-2.5 right-2.5 text-[10px] px-1.5 py-0.5 rounded-full bg-violet-600/40 border border-violet-500/50 text-violet-200 font-medium shadow-[0_0_10px_rgba(139,92,246,0.4)]">
                    Active
                  </span>
                )}
                {tier.comingSoon && (
                  <span className="absolute top-2.5 right-2.5 text-[10px] px-1.5 py-0.5 rounded-full bg-white/10 border border-white/10 text-white/30 font-medium">
                    Soon
                  </span>
                )}
                <div className="text-sm font-semibold mb-0.5">{tier.name}</div>
                <div className="text-xs text-white/40 mb-3">
                  {tier.price ?? "Free"}
                </div>
                <ul className="space-y-1.5">
                  {tier.features.map((f) => (
                    <li key={f} className="flex items-start gap-1.5 text-[11px] text-white/50">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5 text-emerald-400/70">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Included usage ── */}
      <section className="mb-8 p-4 rounded-xl border border-violet-400/40 bg-violet-500/[0.12] backdrop-blur-lg backdrop-saturate-[1.3] shadow-[0_0_24px_rgba(139,92,246,0.25)]">
        <h2 className="text-sm font-medium mb-3">Included usage</h2>
        {loading ? (
          <div className="h-4 w-32 bg-white/10 rounded animate-pulse" />
        ) : usage ? (
          <>
            <div className="flex items-end gap-2 mb-2">
              <span className="text-2xl font-semibold">{fmt(usage.daily.total_tokens)}</span>
              <span className="text-white/40 text-sm mb-0.5">/ {fmt(usage.daily.limit)} tokens (last 24h)</span>
              <div className="relative group ml-1 mb-0.5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/30 hover:text-white/60 transition-colors cursor-help">
                  <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
                </svg>
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 hidden group-hover:block z-10 w-56 p-3 rounded-lg border border-white/15 shadow-xl glass-dropdown text-xs">
                  <div className="flex justify-between mb-1"><span className="text-white/50">Input</span><span className="text-white/70">{fmt(usage.daily.input_tokens)} tokens</span></div>
                  <div className="flex justify-between mb-1"><span className="text-white/50">Output</span><span className="text-white/70">{fmt(usage.daily.output_tokens)} tokens</span></div>
                  <div className="border-t border-white/10 my-1.5" />
                  <div className="flex justify-between mb-1"><span className="text-white/50">Input cost</span><span className="text-white/70">{fmtCost(usage.daily.cost_input_usd)}</span></div>
                  <div className="flex justify-between mb-1"><span className="text-white/50">Output cost</span><span className="text-white/70">{fmtCost(usage.daily.cost_output_usd)}</span></div>
                  <div className="border-t border-white/10 my-1.5" />
                  <div className="flex justify-between"><span className="text-white/50">Guardian cost</span><span className="font-medium text-violet-400">{fmtCost(usage.daily.cost_input_usd + usage.daily.cost_output_usd)}</span></div>
                </div>
              </div>
            </div>
            <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-violet-500 transition-all"
                style={{ width: `${Math.min(100, (usage.daily.total_tokens / usage.daily.limit) * 100)}%` }}
              />
            </div>

            <div className="flex items-center gap-2 mt-4 text-xs text-white/40">
              <span className="font-medium text-white/60">Last 30 days</span>
              <span>{fmt(usage.monthly.total_tokens)} tokens</span>
              <div className="relative group">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/30 hover:text-white/60 transition-colors cursor-help">
                  <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
                </svg>
                <div className="absolute bottom-5 left-1/2 -translate-x-1/2 hidden group-hover:block z-10 w-52 p-2.5 rounded-lg border border-white/15 shadow-xl glass-dropdown text-xs">
                  <div className="flex justify-between mb-1"><span className="text-white/50">Input</span><span className="text-white/70">{fmtCompact(usage.monthly.input_tokens)}</span></div>
                  <div className="flex justify-between mb-1"><span className="text-white/50">Output</span><span className="text-white/70">{fmtCompact(usage.monthly.output_tokens)}</span></div>
                  <div className="border-t border-white/10 my-1" />
                  <div className="flex justify-between"><span className="text-white/50">Guardian cost</span><span className="text-violet-400">{fmtCost(usage.monthly.cost_input_usd + usage.monthly.cost_output_usd)}</span></div>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 mt-1.5 text-xs text-white/40">
              <span className="font-medium text-white/60">Since signup</span>
              <span>{fmt(usage.lifetime.total_tokens)} tokens</span>
              <div className="relative group">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/30 hover:text-white/60 transition-colors cursor-help">
                  <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
                </svg>
                <div className="absolute bottom-5 left-1/2 -translate-x-1/2 hidden group-hover:block z-10 w-52 p-2.5 rounded-lg border border-white/15 shadow-xl glass-dropdown text-xs">
                  <div className="flex justify-between mb-1"><span className="text-white/50">Input</span><span className="text-white/70">{fmtCompact(usage.lifetime.input_tokens)}</span></div>
                  <div className="flex justify-between mb-1"><span className="text-white/50">Output</span><span className="text-white/70">{fmtCompact(usage.lifetime.output_tokens)}</span></div>
                  <div className="border-t border-white/10 my-1" />
                  <div className="flex justify-between"><span className="text-white/50">Guardian cost</span><span className="text-violet-400">{fmtCost(usage.lifetime.cost_input_usd + usage.lifetime.cost_output_usd)}</span></div>
                </div>
              </div>
            </div>

            <p className="text-xs text-white/30 mt-3">
              Rolling 24-hour window. Only tracks included usage — BYOK usage goes directly to your provider.
            </p>
          </>
        ) : (
          <p className="text-xs text-white/30">No usage data available.</p>
        )}
      </section>

      {/* ── Default source for new chats ── */}
      <section className="mb-8">
        <h2 className="text-sm font-medium mb-3">Default source for new chats</h2>
        <div className="flex gap-3">
          {/* ── Included usage card ── */}
          <button
            onClick={() => handleSetUsageSource("included")}
            className={`flex-1 p-3 rounded-lg border text-left transition-colors cursor-pointer ${
              usageSource === "included"
                ? "border-violet-400/40 bg-violet-500/[0.12] backdrop-blur-lg backdrop-saturate-[1.3] shadow-[0_0_24px_rgba(139,92,246,0.25)]"
                : "border-white/10 bg-white/[0.06] backdrop-blur-lg backdrop-saturate-[1.3] hover:bg-white/[0.08]"
            }`}
          >
            <div className="flex items-center gap-2 mb-2">
              <span
                className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${
                  usageSource === "included" ? "border-violet-400" : "border-white/30"
                }`}
              >
                {usageSource === "included" && (
                  <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />
                )}
              </span>
              <span className="text-sm font-medium">Included usage</span>
            </div>
            <p className="text-[11px] text-white/40 ml-5 mb-2">
              Free tier &middot; 250k tokens / 24h
            </p>
            <div className="ml-5 text-[11px] text-white/50">
              Model: <span className="text-white/70 font-medium">{
                (() => {
                  const m = catalogModels.find((cm) => cm.id === defaultModel);
                  return m ? m.name : defaultModel ?? "Gemini 2.5 Flash";
                })()
              }</span>
            </div>
          </button>

          {/* ── My API key card ── */}
          <button
            onClick={() => handleSetUsageSource("byok")}
            disabled={!hasKeys}
            className={`flex-1 p-3 rounded-lg border text-left transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
              usageSource === "byok"
                ? "border-emerald-500/60 bg-emerald-500/[0.12] backdrop-blur-lg backdrop-saturate-[1.3] shadow-[0_0_24px_rgba(16,185,129,0.25)]"
                : "border-white/10 bg-white/[0.06] backdrop-blur-lg backdrop-saturate-[1.3] hover:bg-white/[0.08]"
            }`}
            title={!hasKeys ? "Add an API key first" : undefined}
          >
            <div className="flex items-center gap-2 mb-2">
              <span
                className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${
                  usageSource === "byok" ? "border-emerald-400" : "border-white/30"
                }`}
              >
                {usageSource === "byok" && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                )}
              </span>
              <span className="text-sm font-medium">My API key</span>
            </div>
            <p className="text-[11px] text-white/40 ml-5 mb-2">
              No quota &middot; Your own billing
            </p>
            <div className="ml-5 text-[11px] text-white/50">
              {defaultKey ? (
                <>
                  Key: <span className="text-white/70 font-medium">{providerLabel(defaultKey.provider)}</span>
                  {" "}&middot;{" "}
                  Model: <span className="text-white/70 font-medium">{
                    (() => {
                      const m = catalogModels.find((cm) => cm.id === defaultKey.default_model);
                      return m ? m.name : defaultKey.default_model ?? "Auto-select";
                    })()
                  }</span>
                </>
              ) : (
                <span className="text-white/30">No API key configured</span>
              )}
            </div>
          </button>
        </div>

        {/* Included model selector (below the cards, when source = included) */}
        {usageSource === "included" && (
          <div className="mt-3">
            <div className="relative">
              <button
                ref={includedModelBtnRef}
                type="button"
                onClick={() => { setIncludedModelDropdownOpen(!includedModelDropdownOpen); setIncludedModelSearch(""); }}
                disabled={savingDefaultModel}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.06] border border-white/[0.1] backdrop-blur-lg backdrop-saturate-[1.3] text-xs transition-colors hover:border-white/20 cursor-pointer disabled:opacity-40"
              >
                <span className="truncate text-white/70">
                  Change included model: <span className="text-white font-medium">{
                    (() => {
                      const m = catalogModels.find((cm) => cm.id === defaultModel);
                      return m ? m.name : defaultModel ?? "Gemini 2.5 Flash";
                    })()
                  }</span>
                </span>
                <svg
                  width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  className={`shrink-0 text-white/40 transition-transform ${includedModelDropdownOpen ? "rotate-180" : ""}`}
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>

              <GlassDropdown open={includedModelDropdownOpen} onClose={handleIncludedModelDropdownClose} anchorRef={includedModelBtnRef}>
                <div className="p-2 border-b border-white/[0.06]">
                  <input
                    type="text"
                    placeholder="Search models..."
                    value={includedModelSearch}
                    onChange={(e) => setIncludedModelSearch(e.target.value)}
                    autoFocus
                    className="w-full px-3 py-1.5 rounded-md bg-white/5 border border-white/10 text-sm outline-none focus:border-white/25 transition-colors placeholder:text-white/25"
                  />
                </div>
                <div className="max-h-48 overflow-y-auto py-1">
                  {includedModels
                    .filter((m) => m.name.toLowerCase().includes(includedModelSearch.toLowerCase()))
                    .map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          handleSaveDefaultModel(m.id);
                          setIncludedModelDropdownOpen(false);
                        }}
                        className={`w-full text-left px-4 py-2 text-sm transition-colors cursor-pointer ${
                          defaultModel === m.id
                            ? "bg-violet-600/30 text-white"
                            : "text-white/60 hover:bg-white/5 hover:text-white/90"
                        }`}
                      >
                        {m.name}
                      </button>
                    ))}
                  {includedModels.filter((m) => m.name.toLowerCase().includes(includedModelSearch.toLowerCase())).length === 0 && (
                    <p className="px-4 py-3 text-sm text-white/30 text-center">No model found</p>
                  )}
                </div>
              </GlassDropdown>
            </div>
          </div>
        )}
      </section>

      {/* ── API Keys (BYOK) ── */}
      <section className="mb-8">
        <h2 className="text-sm font-medium mb-1">API Keys (BYOK)</h2>
        <p className="text-xs text-white/40 mb-3">
          Bring your own API keys to use any model without quota limits.
        </p>

        {/* Stored keys with per-key model selector */}
        {loading ? (
          <div className="space-y-2 mb-4">
            {[1, 2].map((i) => (
              <div key={i} className="h-20 rounded-xl bg-white/[0.04] animate-pulse" />
            ))}
          </div>
        ) : keys.length === 0 ? (
          <p className="text-sm text-white/30 py-4 text-center mb-4">
            No API keys configured — you&apos;re on included usage.
          </p>
        ) : (
          <div className="space-y-2 mb-4">
            {keys.map((k) => {
              const keyModels = modelsForKey(k);
              // Look up model name from native catalog first, then gateway
              const allKeyModels = modelsForKey(k);
              const dmId = k.default_model;
              const selectedModelObj = allKeyModels.find((m) => m.id === dmId || `${k.provider}/${m.id}` === dmId)
                ?? catalogModels.find((m) => m.id === dmId);
              const modelLabel = selectedModelObj?.name ?? k.default_model ?? "Auto-select";
              const isKeyDropdownOpen = keyModelDropdownOpen === k.id;
              const query = keyModelSearch.toLowerCase();
              const keyLabel = k.label || `${k.provider}-1`;

              // Group models by provider for gateway keys
              const grouped = keyModels.reduce<Record<string, CatalogModel[]>>((acc, m) => {
                (acc[m.owned_by] ??= []).push(m);
                return acc;
              }, {});
              const filteredGrouped = Object.entries(grouped).reduce<Record<string, CatalogModel[]>>((acc, [prov, models]) => {
                const filtered = models.filter((m) =>
                  m.name.toLowerCase().includes(query) || prov.toLowerCase().includes(query)
                );
                if (filtered.length > 0) acc[prov] = filtered;
                return acc;
              }, {});

              return (
                <div
                  key={k.id}
                  className={`px-4 py-3 rounded-xl backdrop-blur-lg backdrop-saturate-[1.3] ${
                    k.is_default
                      ? "border border-emerald-400/40 bg-emerald-500/[0.12] shadow-[0_0_24px_rgba(16,185,129,0.25)]"
                      : "bg-white/[0.06] border border-white/[0.1]"
                  }`}
                >
                  {/* Key header row */}
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {/* Star — always visible, colored when default, clickable when not */}
                      <button
                        onClick={() => !k.is_default && handleSetDefault(k.id)}
                        disabled={k.is_default}
                        title={k.is_default ? "Default key" : "Set as default"}
                        className={`shrink-0 p-1 rounded-md transition-colors cursor-pointer ${
                          k.is_default
                            ? "text-emerald-400"
                            : "text-white/20 hover:text-white/50 hover:bg-white/[0.08]"
                        }`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill={k.is_default ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                        </svg>
                      </button>
                      <div className="min-w-0 flex flex-col gap-0.5">
                        <span className="text-sm font-medium truncate">{keyLabel}</span>
                        <span className="text-[11px] text-white/30 leading-none">{providerLabel(k.provider)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="flex flex-col items-end gap-0.5">
                        {k.key_hint && (
                          <span className="text-[10px] text-white/45 font-mono">{k.key_hint}</span>
                        )}
                        <span className="text-[10px] text-white/20">
                          {new Date(k.updated_at).toLocaleDateString()}
                        </span>
                      </div>
                      <button
                        onClick={() => handleDelete(k.id)}
                        disabled={deleting === k.id}
                        title="Remove key"
                        className="p-1.5 rounded-md text-white/30 hover:text-red-400 hover:bg-red-400/[0.08] transition-colors disabled:opacity-40 cursor-pointer"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Per-key model selector */}
                  <div className="relative">
                    <button
                      ref={(el) => { keyModelBtnRefs.current[k.id] = el; }}
                      type="button"
                      onClick={() => {
                        setKeyModelDropdownOpen(isKeyDropdownOpen ? null : k.id);
                        setKeyModelSearch("");
                      }}
                      disabled={savingKeyModel === k.id}
                      className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/[0.1] backdrop-blur-lg backdrop-saturate-[1.3] text-xs transition-colors hover:border-white/15 cursor-pointer disabled:opacity-40"
                    >
                      <span className="truncate text-white/60">
                        Default model: <span className="text-white/80 font-medium">{modelLabel}</span>
                      </span>
                      <svg
                        width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                        className={`shrink-0 text-white/30 transition-transform ${isKeyDropdownOpen ? "rotate-180" : ""}`}
                      >
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>

                    <GlassDropdown
                      open={isKeyDropdownOpen}
                      onClose={handleKeyModelDropdownClose}
                      anchorRef={{ current: keyModelBtnRefs.current[k.id] ?? null }}
                    >
                      <div className="p-2 border-b border-white/[0.06]">
                        <input
                          type="text"
                          placeholder="Search models..."
                          value={keyModelSearch}
                          onChange={(e) => setKeyModelSearch(e.target.value)}
                          autoFocus
                          className="w-full px-3 py-1.5 rounded-md bg-white/5 border border-white/10 text-sm outline-none focus:border-white/25 transition-colors placeholder:text-white/25"
                        />
                      </div>
                      <div className="max-h-52 overflow-y-auto py-1">
                        <button
                          type="button"
                          onClick={() => handleSaveKeyModel(k.id, null)}
                          className={`w-full text-left px-4 py-2 text-sm transition-colors cursor-pointer ${
                            !k.default_model
                              ? "bg-violet-600/30 text-white"
                              : "text-white/60 hover:bg-white/5 hover:text-white/90"
                          }`}
                        >
                          Auto-select
                        </button>
                        {k.provider === "gateway" ? (
                          Object.entries(filteredGrouped).map(([prov, models]) => (
                            <div key={prov}>
                              <div className="px-4 py-1.5 text-[10px] font-semibold text-white/30 uppercase tracking-wider">
                                {capitalize(prov)}
                              </div>
                              {models.map((m) => {
                                const isReasoning = "tags" in m && (m as { tags?: string[] }).tags?.includes("reasoning");
                                const fullId = m.id.includes("/") ? m.id : `${k.provider}/${m.id}`;
                                return (
                                  <button
                                    key={m.id}
                                    type="button"
                                    onClick={() => handleSaveKeyModel(k.id, fullId)}
                                    className={`w-full text-left px-4 py-2 text-sm transition-colors cursor-pointer ${
                                      k.default_model === fullId || k.default_model === m.id
                                        ? "bg-violet-600/30 text-white"
                                        : "text-white/60 hover:bg-white/5 hover:text-white/90"
                                    }`}
                                  >
                                    {m.name}{isReasoning ? <span title="Supports reasoning">{" "}✦</span> : ""}
                                  </button>
                                );
                              })}
                            </div>
                          ))
                        ) : (
                          keyModels
                            .filter((m) => m.name.toLowerCase().includes(query))
                            .map((m) => {
                              const isReasoning = "tags" in m && (m as { tags?: string[] }).tags?.includes("reasoning");
                              const fullId = m.id.includes("/") ? m.id : `${k.provider}/${m.id}`;
                              return (
                                <button
                                  key={m.id}
                                  type="button"
                                  onClick={() => handleSaveKeyModel(k.id, fullId)}
                                  className={`w-full text-left px-4 py-2 text-sm transition-colors cursor-pointer ${
                                    k.default_model === fullId || k.default_model === m.id
                                      ? "bg-violet-600/30 text-white"
                                      : "text-white/60 hover:bg-white/5 hover:text-white/90"
                                  }`}
                                >
                                  {m.name}{isReasoning ? <span title="Supports reasoning">{" "}✦</span> : ""}
                                </button>
                              );
                            })
                        )}
                        {Object.keys(filteredGrouped).length === 0 && query && (
                          <p className="px-4 py-3 text-sm text-white/30 text-center">No model found</p>
                        )}
                      </div>
                    </GlassDropdown>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Add a key — responsive: row on desktop, stacked on mobile */}
        <form onSubmit={handleSave} className="px-4 py-2.5 rounded-xl bg-white/[0.06] border border-white/[0.1] backdrop-blur-lg backdrop-saturate-[1.3]">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            {/* Provider selector */}
            <div className="relative shrink-0">
              <button
                ref={dropdownBtnRef}
                type="button"
                onClick={() => { setDropdownOpen(!dropdownOpen); setSearch(""); }}
                className="w-full sm:w-auto flex items-center justify-between gap-1 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs transition-colors hover:border-white/20 cursor-pointer"
              >
                <span className="truncate text-white/70 sm:min-w-[140px]">{providerLabel(selectedProvider)}</span>
                <svg
                  width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  className={`shrink-0 text-white/40 transition-transform ${dropdownOpen ? "rotate-180" : ""}`}
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>

              <GlassDropdown open={dropdownOpen} onClose={handleDropdownClose} anchorRef={dropdownBtnRef}>
                <div className="p-2 border-b border-white/[0.06]">
                  <input
                    type="text"
                    placeholder="Search providers..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    autoFocus
                    className="w-full px-3 py-1.5 rounded-md bg-white/5 border border-white/10 text-sm outline-none focus:border-white/25 transition-colors placeholder:text-white/25"
                  />
                </div>
                <div className="max-h-52 overflow-y-auto py-1">
                  {providers
                    .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
                    .map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setSelectedProvider(p.id);
                          setDropdownOpen(false);
                          setSearch("");
                        }}
                        className={`w-full text-left px-4 py-2 text-sm transition-colors cursor-pointer ${
                          selectedProvider === p.id
                            ? "bg-violet-600/30 text-white"
                            : "text-white/60 hover:bg-white/5 hover:text-white/90"
                        }`}
                      >
                        {p.name}
                      </button>
                    ))}
                  {providers.filter((p) => p.name.toLowerCase().includes(search.toLowerCase())).length === 0 && (
                    <p className="px-4 py-3 text-sm text-white/30 text-center">No provider found</p>
                  )}
                </div>
              </GlassDropdown>
            </div>

            {/* API key input */}
            <input
              type="password"
              placeholder={PROVIDER_HINTS[selectedProvider] ?? "API key..."}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              required
              autoComplete="off"
              className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs font-mono outline-none focus:border-white/30 transition-colors"
            />

            {/* Label + Add button row */}
            <div className="flex items-center gap-2 sm:shrink-0">
              <input
                type="text"
                placeholder="Label"
                value={keyLabel}
                onChange={(e) => setKeyLabel(e.target.value)}
                autoComplete="off"
                className="flex-1 sm:w-20 sm:flex-none px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs outline-none focus:border-white/30 transition-colors placeholder:text-white/25"
              />
              <button
                type="submit"
                disabled={!!saving || !secret.trim()}
                title="Add key"
                className="shrink-0 p-1.5 rounded-lg bg-white text-black disabled:opacity-30 transition-opacity cursor-pointer"
              >
                {saving ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
                    <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                )}
              </button>
            </div>
          </div>
          {error && <p className="text-red-400 text-[11px] mt-1.5">{error}</p>}
        </form>
      </section>

      {/* ── Orchestration settings ── */}
      <section className="mb-8">
        <h2 className="text-sm font-medium mb-1">Orchestration</h2>
        <p className="text-xs text-white/40 mb-4">
          Control how remote code execution behaves during collaborative orchestration.
        </p>

        <div className="flex gap-3 mb-4">
          {(["trust", "brave"] as const).map((mode) => (
            <button
              key={mode}
              onClick={async () => {
                setApprovalMode(mode);
                setSavingOrchSettings(true);
                await fetch("/api/user/settings", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ approvalMode: mode }),
                }).catch(() => {});
                setSavingOrchSettings(false);
              }}
              disabled={savingOrchSettings}
              className={`flex-1 p-3 rounded-lg border text-left transition-colors cursor-pointer ${
                approvalMode === mode
                  ? mode === "trust"
                    ? "border-amber-400/40 bg-amber-500/[0.12] backdrop-blur-lg backdrop-saturate-[1.3] shadow-[0_0_24px_rgba(245,158,11,0.25)]"
                    : "border-orange-400/40 bg-orange-500/[0.12] backdrop-blur-lg backdrop-saturate-[1.3] shadow-[0_0_24px_rgba(249,115,22,0.25)]"
                  : "border-white/[0.1] bg-white/[0.06] backdrop-blur-lg backdrop-saturate-[1.3] hover:bg-white/[0.08]"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${
                    approvalMode === mode
                      ? mode === "trust"
                        ? "border-amber-400"
                        : "border-orange-400"
                      : "border-white/30"
                  }`}
                >
                  {approvalMode === mode && (
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        mode === "trust" ? "bg-amber-400" : "bg-orange-400"
                      }`}
                    />
                  )}
                </span>
                <span className="text-sm font-medium capitalize">{mode}</span>
              </div>
              <p className="text-[11px] text-white/40 ml-5">
                {mode === "trust"
                  ? "Review and approve each code execution before it runs."
                  : "Auto-execute all commands. Faster, but no review step."}
              </p>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-white/[0.1] bg-white/[0.06] backdrop-blur-lg backdrop-saturate-[1.3]">
          <div>
            <div className="text-sm font-medium">Guard</div>
            <p className="text-[11px] text-white/40 mt-0.5">
              Always require approval for critical operations (remove, flatten, detach) regardless of mode.
            </p>
          </div>
          <button
            onClick={async () => {
              const next = !guardEnabled;
              setGuardEnabled(next);
              setSavingOrchSettings(true);
              await fetch("/api/user/settings", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ guardEnabled: next }),
              }).catch(() => {});
              setSavingOrchSettings(false);
            }}
            disabled={savingOrchSettings}
            className={`relative shrink-0 w-10 h-5 rounded-full transition-colors cursor-pointer ${
              guardEnabled ? "bg-emerald-600" : "bg-white/20"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                guardEnabled ? "translate-x-5" : ""
              }`}
            />
          </button>
        </div>
      </section>

      {/* ── Cloud Services (MCP) ── */}
      <section className="mb-8">
        <h2 className="text-sm font-medium mb-1">Cloud services</h2>
        <p className="text-xs text-white/40 mb-4">
          Connect cloud MCP services to enable structured tools in workflows. Agents use these tools automatically.
        </p>

        {mcpHook.loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-14 rounded-xl bg-white/[0.04] animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {mcpHook.cloudPresets.map((cp) => (
              <CloudServiceRow
                key={cp.preset_type}
                preset={cp}
                isDefault={
                  mcpHook.defaults[cp.category as "design" | "code"] === cp.instance?.id
                }
                disconnecting={disconnectingService === cp.preset_type}
                onConnect={() => {
                  const sessionId = Math.random().toString(36).slice(2);
                  const authUrl = cp.oauth_auth_path + (cp.oauth_auth_path.includes("?") ? "&" : "?") + `session=${sessionId}`;
                  const w = window.open(authUrl, "_blank", "width=500,height=700,popup=1");
                  let handled = false;

                  // Listen for postMessage from popup (primary path when callback runs)
                  const handler = async (e: MessageEvent) => {
                    if (handled) return;
                    if (e.data?.success) {
                      handled = true;
                      window.removeEventListener("message", handler);
                      if (e.data?.tokensJson) {
                        try {
                          await fetch("/api/user/connected-services/persist", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ serverId: cp.preset_type, tokensJson: e.data.tokensJson }),
                          });
                        } catch { /* non-fatal */ }
                      }
                      await mcpHook.reload();
                      await loadData();
                    }
                  };
                  window.addEventListener("message", handler);

                  // Fallback: poll for popup closure → check oauth-store for tokens
                  const poll = setInterval(() => {
                    if (w?.closed) {
                      clearInterval(poll);
                      setTimeout(async () => {
                        window.removeEventListener("message", handler);
                        if (!handled) {
                          try {
                            // Read tokens from in-memory oauth-store (works even when cookies are cross-domain)
                            const res = await fetch("/api/set-oauth-result", { headers: { "X-Auth-Token": sessionId } });
                            const data = await res.json();
                            if (data?.success && data?.tokens) {
                              const tokensJson = Object.values(data.tokens)[0] as string;
                              if (tokensJson) {
                                await fetch("/api/user/connected-services/persist", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ serverId: cp.preset_type, tokensJson }),
                                });
                              }
                            }
                          } catch { /* non-fatal */ }
                          // Also try cookie-based persist as last resort
                          try {
                            await fetch("/api/user/connected-services/persist", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: "{}",
                            });
                          } catch { /* non-fatal */ }
                          await mcpHook.reload();
                          await loadData();
                        }
                      }, 500);
                    }
                  }, 500);
                }}
                onDisconnect={async () => {
                  if (!cp.instance) return;
                  setDisconnectingService(cp.preset_type);
                  try {
                    await fetch(`/api/user/mcp-instances?id=${encodeURIComponent(cp.instance.id)}`, { method: "DELETE" });
                    // Also clean legacy localStorage tokens
                    if (cp.preset_type === "figma_mcp") localStorage.removeItem("figma_mcp_tokens");
                    if (cp.preset_type === "github") localStorage.removeItem("github_mcp_tokens");
                    if (cp.preset_type === "figma_console") localStorage.removeItem("southleft_access_token");
                    await mcpHook.reload();
                    await loadData();
                  } finally {
                    setDisconnectingService(null);
                  }
                }}
                onSetDefault={async () => {
                  if (!cp.instance) return;
                  await fetch("/api/user/category-defaults", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ category: cp.category, instance_id: cp.instance.id }),
                  });
                  await mcpHook.reload();
                }}
                onLabelChange={async (newLabel: string) => {
                  if (!cp.instance) return false;
                  const res = await fetch(`/api/user/mcp-instances?id=${encodeURIComponent(cp.instance.id)}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ label: newLabel }),
                  });
                  if (res.ok) await mcpHook.reload();
                  return res.ok;
                }}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Local Services (Desktop Companion bridge) ── */}
      <LocalServicesSection />

      {/* ── Developer settings ── */}
      <section className="mb-8">
        <h2 className="text-sm font-medium mb-1">Developers</h2>
        <p className="text-xs text-white/40 mb-4">
          Advanced options for debugging and development.
        </p>

        <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-white/[0.1] bg-white/[0.06] backdrop-blur-lg backdrop-saturate-[1.3]">
          <div>
            <div className="text-sm font-medium">Developer mode</div>
            <p className="text-[11px] text-white/40 mt-0.5">
              Enable advanced developer options below.
            </p>
          </div>
          <button
            onClick={async () => {
              const next = !developerMode;
              setDeveloperMode(next);
              setSavingDevSettings(true);
              await fetch("/api/user/settings", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ developerMode: next }),
              }).catch(() => {});
              setSavingDevSettings(false);
            }}
            disabled={savingDevSettings}
            className={`relative shrink-0 w-10 h-5 rounded-full transition-colors cursor-pointer ${
              developerMode ? "bg-violet-600" : "bg-white/20"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                developerMode ? "translate-x-5" : ""
              }`}
            />
          </button>
        </div>

        {developerMode && (
          <div className="mt-3 ml-3 pl-3 border-l border-white/10 space-y-3">
            <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-white/[0.1] bg-white/[0.06] backdrop-blur-lg backdrop-saturate-[1.3]">
              <div>
                <div className="text-sm font-medium">Display all events</div>
                <p className="text-[11px] text-white/40 mt-0.5">
                  Display all events in chats and orchestrations, including noise events normally hidden.
                </p>
              </div>
              <button
                onClick={async () => {
                  const next = !devShowAllEvents;
                  setDevShowAllEvents(next);
                  setSavingDevSettings(true);
                  await fetch("/api/user/settings", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ devShowAllEvents: next }),
                  }).catch(() => {});
                  setSavingDevSettings(false);
                }}
                disabled={savingDevSettings}
                className={`relative shrink-0 w-10 h-5 rounded-full transition-colors cursor-pointer ${
                  devShowAllEvents ? "bg-violet-600" : "bg-white/20"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    devShowAllEvents ? "translate-x-5" : ""
                  }`}
                />
              </button>
            </div>

            {/* Matrix consciousness background */}
            <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-white/[0.1] bg-white/[0.06] backdrop-blur-lg backdrop-saturate-[1.3]">
              <div>
                <div className="text-sm font-medium">Matrix</div>
                <p className="text-[11px] text-white/40 mt-0.5">
                  Reveal the streams of consciousness flowing behind the interface.
                </p>
              </div>
              <button
                onClick={() => {
                  const next = !devMatrix;
                  setDevMatrix(next);
                  localStorage.setItem("guardian_matrix", next ? "1" : "0");
                  window.dispatchEvent(new Event("guardian_matrix_toggle"));
                }}
                className={`relative shrink-0 w-10 h-5 rounded-full transition-colors cursor-pointer ${
                  devMatrix ? "bg-violet-600" : "bg-white/20"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    devMatrix ? "translate-x-5" : ""
                  }`}
                />
              </button>
            </div>

            {process.env.NODE_ENV !== "production" && (
              <>
                <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-white/[0.1] bg-white/[0.06] backdrop-blur-lg backdrop-saturate-[1.3]">
                  <div>
                    <div className="text-sm font-medium">LLM call delegation</div>
                    <p className="text-[11px] text-white/40 mt-0.5">
                      Delegate code review and file review LLM calls to an external responder (e.g. Claude Code) via Supabase Realtime.
                    </p>
                  </div>
                  <button
                    onClick={async () => {
                      const next = !devLLMDelegation;
                      setDevLLMDelegation(next);
                      setSavingDevSettings(true);
                      await fetch("/api/user/settings", {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ devLLMDelegation: next }),
                      }).catch(() => {});
                      setSavingDevSettings(false);
                    }}
                    disabled={savingDevSettings}
                    className={`relative shrink-0 w-10 h-5 rounded-full transition-colors cursor-pointer ${
                      devLLMDelegation ? "bg-violet-600" : "bg-white/20"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                        devLLMDelegation ? "translate-x-5" : ""
                      }`}
                    />
                  </button>
                </div>

                {devLLMDelegation && (
                  <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-white/[0.1] bg-white/[0.06] backdrop-blur-lg backdrop-saturate-[1.3] ml-3 border-l border-white/10">
                    <div>
                      <div className="text-sm font-medium">Slow delegation</div>
                      <p className="text-[11px] text-white/40 mt-0.5">
                        Extend all timeouts (30 min per call, 4 hours total) to allow interactive discussion at each step.
                      </p>
                    </div>
                    <button
                      onClick={async () => {
                        const next = !devSlowDelegation;
                        setDevSlowDelegation(next);
                        setSavingDevSettings(true);
                        await fetch("/api/user/settings", {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ devSlowDelegation: next }),
                        }).catch(() => {});
                        setSavingDevSettings(false);
                      }}
                      disabled={savingDevSettings}
                      className={`relative shrink-0 w-10 h-5 rounded-full transition-colors cursor-pointer ${
                        devSlowDelegation ? "bg-violet-600" : "bg-white/20"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                          devSlowDelegation ? "translate-x-5" : ""
                        }`}
                      />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </section>

      {/* ── Connected Clients ── */}
      <ConnectedClients clients={presenceClients} loading={presenceLoading} connectionStatus={presenceConnectionStatus} />

      {/* ── Danger Zone ── */}
      <section className="mt-10 pt-8 border-t border-red-400/20">
        <h2 className="text-sm font-medium text-red-400 mb-3">Danger Zone</h2>

        {!showDeleteConfirm ? (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="px-4 py-2 rounded-lg border border-red-400/30 text-sm text-red-400 hover:bg-red-400/10 transition-colors"
          >
            Delete my account
          </button>
        ) : (
          <div className="rounded-lg border border-red-400/30 bg-red-400/5 p-4 max-w-md">
            <p className="text-sm text-white/70 mb-2">
              This will permanently delete your account and all associated data
              (conversations, API keys, settings). This action cannot be undone.
            </p>
            <p className="text-xs text-white/50 mb-3">
              Type <strong className="text-white/70">DELETE</strong> to confirm:
            </p>
            <input
              type="text"
              value={deleteTyped}
              onChange={(e) => setDeleteTyped(e.target.value)}
              placeholder="DELETE"
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm outline-none focus:border-red-400/50 transition-colors mb-3"
            />
            {deleteError && (
              <p className="text-red-400 text-xs mb-2">{deleteError}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={handleDeleteAccount}
                disabled={deleteTyped !== "DELETE" || deletingAccount}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium disabled:opacity-40 transition-opacity"
              >
                {deletingAccount ? "Deleting…" : "Permanently delete account"}
              </button>
              <button
                onClick={() => { setShowDeleteConfirm(false); setDeleteTyped(""); setDeleteError(null); }}
                className="px-4 py-2 rounded-lg border border-white/10 text-sm text-white/60 hover:text-white transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      <LegalFooter />
    </div>
  );
}

// ── Cloud Service Row (sub-component) ─────────────────────────────────────

function CloudServiceRow({
  preset,
  isDefault,
  disconnecting,
  onConnect,
  onDisconnect,
  onSetDefault,
  onLabelChange,
}: {
  preset: CloudPresetView;
  isDefault: boolean;
  disconnecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onSetDefault: () => void;
  onLabelChange: (label: string) => Promise<boolean>;
}) {
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [labelError, setLabelError] = useState<string | null>(null);

  const inst = preset.instance;
  const connected = !!inst?.connection;
  const expired = inst?.connection?.expired ?? false;

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-white/[0.06] border border-white/[0.1] backdrop-blur-lg backdrop-saturate-[1.3]">
      <div className="flex items-center gap-2.5 min-w-0">
        <span
          className={`shrink-0 w-2 h-2 rounded-full ${
            connected
              ? expired ? "bg-amber-400" : "bg-emerald-400"
              : "bg-white/20"
          }`}
        />
        <div className="min-w-0">
          <span className="text-sm font-medium">{preset.display_name}</span>
          <p className="text-[11px] text-white/30 truncate">{preset.description}</p>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {connected ? (
          <>
            {/* Label badge (click to edit) */}
            {editingLabel ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setLabelError(null);
                  if (!/^[a-z0-9_]+$/.test(labelDraft)) {
                    setLabelError("a-z, 0-9, _ only");
                    return;
                  }
                  const ok = await onLabelChange(labelDraft);
                  if (ok) setEditingLabel(false);
                  else setLabelError("Label taken");
                }}
                className="flex items-center gap-1"
              >
                <input
                  autoFocus
                  value={labelDraft}
                  onChange={(e) => { setLabelDraft(e.target.value); setLabelError(null); }}
                  onBlur={() => { setEditingLabel(false); setLabelError(null); }}
                  className="w-20 text-[10px] px-1.5 py-0.5 rounded bg-white/10 border border-white/20 text-white font-mono focus:outline-none focus:border-violet-400"
                />
                {labelError && <span className="text-[9px] text-red-400">{labelError}</span>}
              </form>
            ) : (
              <button
                onClick={() => { setLabelDraft(inst?.label ?? ""); setEditingLabel(true); }}
                className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/5 text-white/40 font-mono hover:bg-white/10 transition-colors cursor-pointer"
                title="Click to rename label"
              >
                {inst?.label}
              </button>
            )}

            {expired && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/30 text-amber-300">
                expired
              </span>
            )}

            {!isDefault && (
              <button
                onClick={onSetDefault}
                className="text-[10px] text-white/30 hover:text-white/60 transition-colors cursor-pointer"
                title="Set as default for this category"
              >
                set default
              </button>
            )}
            {isDefault && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-300">
                default
              </span>
            )}

            <button
              onClick={onDisconnect}
              disabled={disconnecting}
              className="text-xs text-red-400/70 hover:text-red-400 transition-colors disabled:opacity-40 cursor-pointer"
            >
              {disconnecting ? "..." : "Disconnect"}
            </button>
          </>
        ) : (
          <button
            onClick={onConnect}
            className="text-xs px-3 py-1.5 rounded-lg bg-white/10 border border-white/15 hover:bg-white/15 transition-colors cursor-pointer"
          >
            Connect
          </button>
        )}
      </div>
    </div>
  );
}
