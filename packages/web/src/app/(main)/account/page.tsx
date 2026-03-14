"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useGuardianPresence } from "@/app/hooks/useGuardianPresence";
import { ConnectedClients } from "@/components/ConnectedClients";
import { GlassDropdown } from "@/components/GlassDropdown";

type StoredKey = {
  id: string;
  provider: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

type DynamicProvider = {
  id: string;   // "openai", "anthropic", etc. — or "gateway" for Vercel AI Gateway
  name: string; // Human-readable label
};

type CatalogModel = {
  id: string;       // "openai/gpt-4.1"
  name: string;     // "GPT-4.1"
  owned_by: string; // "openai"
  tags?: string[];
};

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

/** Capitalize first letter */
function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function AccountPage() {
  const router = useRouter();
  const { clients: presenceClients, loading: presenceLoading } = useGuardianPresence();
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

  // Dynamic provider list fetched from Gateway catalog
  const [providers, setProviders] = useState<DynamicProvider[]>([
    { id: "gateway", name: "Vercel AI Gateway" },
  ]);
  const [selectedProvider, setSelectedProvider] = useState("gateway");
  const [secret, setSecret] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [search, setSearch] = useState("");
  const dropdownBtnRef = useRef<HTMLButtonElement>(null);

  // Default model selection
  const [catalogModels, setCatalogModels] = useState<CatalogModel[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [savingDefaultModel, setSavingDefaultModel] = useState(false);
  const [defaultModelDropdownOpen, setDefaultModelDropdownOpen] = useState(false);
  const [defaultModelSearch, setDefaultModelSearch] = useState("");
  const defaultModelBtnRef = useRef<HTMLButtonElement>(null);

  // Orchestration settings
  const [approvalMode, setApprovalMode] = useState<"trust" | "brave">("trust");
  const [guardEnabled, setGuardEnabled] = useState(true);
  const [savingOrchSettings, setSavingOrchSettings] = useState(false);

  const handleDropdownClose = useCallback(() => {
    setDropdownOpen(false);
    setSearch("");
  }, []);

  const handleDefaultModelDropdownClose = useCallback(() => {
    setDefaultModelDropdownOpen(false);
    setDefaultModelSearch("");
  }, []);

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

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [keysRes, usageRes, modelsRes, settingsRes] = await Promise.all([
        fetch("/api/user/api-keys"),
        fetch("/api/user/usage"),
        fetch("/api/gateway-models"),
        fetch("/api/user/settings"),
      ]);

      if (keysRes.status === 401) { router.push("/login"); return; }

      const keysData = await keysRes.json();
      const usageData = await usageRes.json();
      setKeys(keysData.keys ?? []);
      setUsage(usageData.daily ? usageData : null);

      // Load user settings (default model + orchestration)
      if (settingsRes.ok) {
        const settingsData = await settingsRes.json();
        setDefaultModel(settingsData.defaultModel ?? null);
        if (settingsData.approvalMode) setApprovalMode(settingsData.approvalMode);
        if (typeof settingsData.guardEnabled === "boolean") setGuardEnabled(settingsData.guardEnabled);
      }

      // Build dynamic provider list from Gateway catalog
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        const models: CatalogModel[] = modelsData.models ?? [];
        setCatalogModels(models);
        // Extract unique owned_by values preserving first-seen order
        const seen = new Set<string>();
        const dynamic: DynamicProvider[] = [];
        for (const m of models) {
          if (m.owned_by && !seen.has(m.owned_by)) {
            seen.add(m.owned_by);
            dynamic.push({ id: m.owned_by, name: capitalize(m.owned_by) });
          }
        }
        // Pin "Vercel AI Gateway" first, then all direct providers
        setProviders([{ id: "gateway", name: "Vercel AI Gateway" }, ...dynamic]);
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
        body: JSON.stringify({ provider: selectedProvider, secret: secret.trim() }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to save key");
      } else {
        setSecret("");
        await loadData();
      }
    } finally {
      setSaving(null);
    }
  }

  async function handleDelete(provider: string) {
    setDeleting(provider);
    setError(null);
    try {
      const res = await fetch(`/api/user/api-keys?provider=${encodeURIComponent(provider)}`, {
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

  async function handleSetDefault(provider: string) {
    setError(null);
    try {
      const res = await fetch("/api/user/api-keys/default", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to set default");
      } else {
        await loadData();
      }
    } catch {
      setError("Failed to set default");
    }
  }

  const providerLabel = (id: string) =>
    providers.find((p) => p.id === id)?.name ?? capitalize(id);

  /** Format a token count for display (e.g. 124532 → "124,532") */
  const fmt = (n: number) => n.toLocaleString("en-US");

  /** Format a USD cost for display */
  const fmtCost = (n: number) => n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;

  /** Compact token display (e.g. 124532 → "125k") */
  const fmtCompact = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

  return (
      <div className="px-4 py-8 max-w-2xl mx-auto">
      {/* Page title */}
      <div className="mb-8">
        <h1 className="text-xl font-semibold">Account settings</h1>
        <p className="text-sm text-white/40 mt-0.5">Manage your API keys and usage</p>
      </div>

      {/* Usage */}
      <section className="mb-8 p-4 rounded-xl bg-white/[0.06] border border-white/[0.15] backdrop-blur-md">
        <h2 className="text-sm font-medium mb-3">Free tier usage</h2>
        {loading ? (
          <div className="h-4 w-32 bg-white/10 rounded animate-pulse" />
        ) : usage ? (
          <>
            {/* Daily (rolling 24h) — main quota */}
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

            {/* Monthly (rolling 30 days) */}
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

            {/* Lifetime */}
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
              Rolling 24-hour window. Add your own API key below to remove the limit.
            </p>
          </>
        ) : (
          <p className="text-xs text-white/30">No usage data available.</p>
        )}
      </section>

      {/* Add / update a key */}
      <section className="mb-8 p-4 rounded-xl bg-white/[0.06] border border-white/[0.15] backdrop-blur-md">
        <h2 className="text-sm font-medium mb-4">Add or update an API key</h2>

        <form onSubmit={handleSave} className="flex flex-col gap-3">
          {/* Provider selector — searchable dropdown */}
          {loading ? (
            <div className="h-10 w-full rounded-lg bg-white/10 animate-pulse" />
          ) : (
            <div className="relative">
              <button
                ref={dropdownBtnRef}
                type="button"
                onClick={() => { setDropdownOpen(!dropdownOpen); setSearch(""); }}
                className="w-full flex items-center justify-between px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm transition-colors hover:border-white/20 cursor-pointer"
              >
                <span className="truncate">{providerLabel(selectedProvider)}</span>
                <svg
                  width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  className={`shrink-0 text-white/40 transition-transform ${dropdownOpen ? "rotate-180" : ""}`}
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>

              <GlassDropdown open={dropdownOpen} onClose={handleDropdownClose} anchorRef={dropdownBtnRef}>
                  {/* Search input */}
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
                  {/* Options list */}
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
          )}

          {/* Description for Vercel AI Gateway */}
          {selectedProvider === "gateway" && (
            <p className="text-xs text-white/40 -mt-1">
              One key for all models via{" "}
              <a href="https://vercel.com/docs/ai-gateway" target="_blank" rel="noopener noreferrer" className="underline hover:text-white/60">
                Vercel AI Gateway
              </a>
              . Recommended if you don&apos;t have individual provider accounts.
            </p>
          )}

          <input
            type="password"
            placeholder={PROVIDER_HINTS[selectedProvider] ?? "API key…"}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            required
            autoComplete="off"
            className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm font-mono outline-none focus:border-white/30 transition-colors"
          />

          {error && <p className="text-red-400 text-xs px-1">{error}</p>}

          <button
            type="submit"
            disabled={!!saving || !secret.trim()}
            className="self-start px-4 py-2 rounded-lg bg-white text-black text-sm font-medium disabled:opacity-40 transition-opacity cursor-pointer"
          >
            {saving ? "Saving…" : keys.some((k) => k.provider === selectedProvider) ? "Update key" : "Save key"}
          </button>
        </form>
      </section>

      {/* Stored keys */}
      <section>
        <h2 className="text-sm font-medium mb-3">Stored keys</h2>
        {loading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-14 rounded-xl bg-white/[0.04] animate-pulse" />
            ))}
          </div>
        ) : keys.length === 0 ? (
          <p className="text-sm text-white/30 py-4 text-center">
            No API keys configured — you&apos;re on the free tier.
          </p>
        ) : (
          <div className="space-y-2">
            {keys.map((k) => (
              <div
                key={k.id}
                className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.06]"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="text-sm font-medium truncate">{providerLabel(k.provider)}</span>
                  {k.is_default && (
                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-violet-600/30 border border-violet-500/30 text-violet-300 font-medium">
                      default
                    </span>
                  )}
                  <span className="text-xs text-white/30 truncate hidden sm:block">
                    saved {new Date(k.updated_at).toLocaleDateString()}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {!k.is_default && (
                    <button
                      onClick={() => handleSetDefault(k.provider)}
                      className="text-xs text-white/40 hover:text-white/70 transition-colors cursor-pointer"
                    >
                      Set default
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(k.provider)}
                    disabled={deleting === k.provider}
                    className="text-xs text-red-400/70 hover:text-red-400 transition-colors disabled:opacity-40 cursor-pointer"
                  >
                    {deleting === k.provider ? "Removing…" : "Remove"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Default model */}
      <section className="mt-8 mb-8 p-4 rounded-xl bg-white/[0.06] border border-white/[0.15] backdrop-blur-md">
        <h2 className="text-sm font-medium mb-1">Default model</h2>
        <p className="text-xs text-white/40 mb-4">
          Choose the model used by default when you open a new chat. Only models available with your configured keys are shown.
        </p>

        {loading ? (
          <div className="h-10 w-full rounded-lg bg-white/10 animate-pulse" />
        ) : (() => {
          // Compute visible models based on user's keys (same logic as chat page)
          const hasGateway = keys.some((k) => k.provider === "gateway");
          const directProviders = new Set(keys.filter((k) => k.provider !== "gateway").map((k) => k.provider));
          const visibleModels = hasGateway
            ? catalogModels
            : keys.length > 0
              ? catalogModels.filter((m) => directProviders.has(m.owned_by))
              : catalogModels; // Show all models for free-tier users
          const getModelValue = (m: CatalogModel) =>
            hasGateway ? m.id : `${m.owned_by}/${m.id.split("/").pop()}`;

          // Group models by provider
          const grouped = visibleModels.reduce<Record<string, CatalogModel[]>>((acc, m) => {
            (acc[m.owned_by] ??= []).push(m);
            return acc;
          }, {});

          const query = defaultModelSearch.toLowerCase();
          const filteredGrouped = Object.entries(grouped).reduce<Record<string, CatalogModel[]>>((acc, [provider, models]) => {
            const filtered = models.filter((m) =>
              m.name.toLowerCase().includes(query) || provider.toLowerCase().includes(query)
            );
            if (filtered.length > 0) acc[provider] = filtered;
            return acc;
          }, {});

          // Find the currently selected model label
          const selectedGw = visibleModels.find((m) => getModelValue(m) === defaultModel);
          const selectedLabel = selectedGw
            ? `${selectedGw.name}${selectedGw.tags?.includes("reasoning") ? " ✦" : ""}`
            : defaultModel ?? "None (auto-select)";

          return (
            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <button
                  ref={defaultModelBtnRef}
                  type="button"
                  onClick={() => { setDefaultModelDropdownOpen(!defaultModelDropdownOpen); setDefaultModelSearch(""); }}
                  disabled={savingDefaultModel}
                  className="w-full flex items-center justify-between px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm transition-colors hover:border-white/20 cursor-pointer disabled:opacity-40"
                >
                  <span className="truncate">{selectedLabel}</span>
                  <svg
                    width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    className={`shrink-0 text-white/40 transition-transform ${defaultModelDropdownOpen ? "rotate-180" : ""}`}
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>

                <GlassDropdown open={defaultModelDropdownOpen} onClose={handleDefaultModelDropdownClose} anchorRef={defaultModelBtnRef}>
                  {/* Search input */}
                  <div className="p-2 border-b border-white/[0.06]">
                    <input
                      type="text"
                      placeholder="Search models..."
                      value={defaultModelSearch}
                      onChange={(e) => setDefaultModelSearch(e.target.value)}
                      autoFocus
                      className="w-full px-3 py-1.5 rounded-md bg-white/5 border border-white/10 text-sm outline-none focus:border-white/25 transition-colors placeholder:text-white/25"
                    />
                  </div>
                  {/* Options list */}
                  <div className="max-h-60 overflow-y-auto py-1">
                    {/* "None" option to clear default */}
                    {(!query || "none".includes(query) || "auto".includes(query)) && (
                      <button
                        type="button"
                        onClick={() => {
                          handleSaveDefaultModel(null);
                          setDefaultModelDropdownOpen(false);
                          setDefaultModelSearch("");
                        }}
                        className={`w-full text-left px-4 py-2 text-sm transition-colors cursor-pointer ${
                          defaultModel === null
                            ? "bg-violet-600/30 text-white"
                            : "text-white/60 hover:bg-white/5 hover:text-white/90"
                        }`}
                      >
                        None (auto-select)
                      </button>
                    )}
                    {/* Grouped models */}
                    {Object.entries(filteredGrouped).map(([provider, models]) => (
                      <div key={provider}>
                        <div className="px-4 py-1.5 text-[10px] font-semibold text-white/30 uppercase tracking-wider">
                          {capitalize(provider)}
                        </div>
                        {models.map((m) => {
                          const value = getModelValue(m);
                          const isReasoning = m.tags?.includes("reasoning");
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => {
                                handleSaveDefaultModel(value);
                                setDefaultModelDropdownOpen(false);
                                setDefaultModelSearch("");
                              }}
                              className={`w-full text-left px-4 py-2 text-sm transition-colors cursor-pointer ${
                                defaultModel === value
                                  ? "bg-violet-600/30 text-white"
                                  : "text-white/60 hover:bg-white/5 hover:text-white/90"
                              }`}
                            >
                              {m.name}{isReasoning ? <span title="Supports reasoning">{" "}✦</span> : ""}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                    {Object.keys(filteredGrouped).length === 0 && !(!query || "none".includes(query) || "auto".includes(query)) && (
                      <p className="px-4 py-3 text-sm text-white/30 text-center">No model found</p>
                    )}
                  </div>
                </GlassDropdown>
              </div>
              {savingDefaultModel && (
                <span className="text-xs text-white/40 shrink-0">Saving...</span>
              )}
            </div>
          );
        })()}
      </section>

      {/* Orchestration settings */}
      <section className="mb-8 p-4 rounded-xl bg-white/[0.06] border border-white/[0.15] backdrop-blur-md">
        <h2 className="text-sm font-medium mb-1">Orchestration</h2>
        <p className="text-xs text-white/40 mb-4">
          Control how remote code execution behaves during collaborative orchestration.
        </p>

        {/* Trust / Brave selector */}
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
                    ? "border-amber-500/40 bg-amber-500/10"
                    : "border-emerald-500/40 bg-emerald-500/10"
                  : "border-white/10 bg-white/[0.03] hover:bg-white/5"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${
                    approvalMode === mode
                      ? mode === "trust"
                        ? "border-amber-400"
                        : "border-emerald-400"
                      : "border-white/30"
                  }`}
                >
                  {approvalMode === mode && (
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        mode === "trust" ? "bg-amber-400" : "bg-emerald-400"
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

        {/* Guard toggle */}
        <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-white/10 bg-white/[0.03]">
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

      {/* Connected Clients */}
      <ConnectedClients clients={presenceClients} loading={presenceLoading} />
      </div>
  );
}
