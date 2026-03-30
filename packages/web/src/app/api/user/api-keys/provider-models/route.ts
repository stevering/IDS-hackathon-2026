/* Native provider model catalog with gateway enrichment */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// ── Types ───────────────────────────────────────────────────────────────────

type EnrichedModel = {
  id: string;              // native model ID (sent to the provider)
  name: string;            // friendly name from gateway, or derived from ID
  owned_by: string;
  tags: string[];          // ["reasoning", "tool-use", "vision", ...]
  context_window?: number;
  max_tokens?: number;
  gatewayId?: string;      // matching gateway ID (for reference)
};

type GatewayModel = {
  id: string;
  name: string;
  owned_by: string;
  description?: string;
  context_window: number;
  max_tokens: number;
  type: string;
  tags: string[];
};

// ── Caches ──────────────────────────────────────────────────────────────────

/** Per-key model cache: invalidated when key_hint changes (= secret updated) */
const modelCache = new Map<string, { models: EnrichedModel[]; hint: string; ts: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

/** Gateway catalog cache (shared across all keys) */
let gwCache: { models: GatewayModel[]; ts: number } | null = null;
const GW_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ── Provider config ─────────────────────────────────────────────────────────

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  xai: "https://api.x.ai/v1",
  alibaba: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  deepseek: "https://api.deepseek.com/v1",
  mistral: "https://api.mistral.ai/v1",
  perplexity: "https://api.perplexity.ai",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  cohere: "https://api.cohere.com/compatibility/v1",
  moonshot: "https://api.moonshot.cn/v1",
};

/** Providers without a standard /v1/models endpoint — use gateway catalog as fallback */
const NO_MODELS_ENDPOINT = new Set([
  "anthropic",   // No OpenAI-compat /v1/models
  "google",      // No OpenAI-compat /v1/models
  "perplexity",  // /models returns 404
  "fireworks",   // Requires /v1/accounts/{id}/models — non-standard
]);

// ── Gateway catalog fetcher ─────────────────────────────────────────────────

async function getGatewayCatalog(): Promise<GatewayModel[]> {
  if (gwCache && Date.now() - gwCache.ts < GW_CACHE_TTL) {
    return gwCache.models;
  }
  try {
    const res = await fetch("https://ai-gateway.vercel.sh/v1/models", {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return gwCache?.models ?? [];
    const json = await res.json();
    const models: GatewayModel[] = (json.data ?? []).filter(
      (m: GatewayModel) => m.type === "language"
    );
    gwCache = { models, ts: Date.now() };
    return models;
  } catch {
    return gwCache?.models ?? [];
  }
}

// ── Matching: native ID → gateway model ─────────────────────────────────────

function findGatewayMatch(
  nativeId: string,
  provider: string,
  gwModels: GatewayModel[],
): GatewayModel | null {
  const prefix = `${provider}/`;
  const providerGw = gwModels.filter((m) => m.id.startsWith(prefix));

  // 1. Exact match
  const exact = providerGw.find((m) => m.id === `${prefix}${nativeId}`);
  if (exact) return exact;

  // 2. Normalize dashes to dots in version numbers: grok-4-1-fast → grok-4.1-fast
  const dotted = nativeId.replace(/(\d+)-(\d+)(?=-|$)/g, "$1.$2");
  if (dotted !== nativeId) {
    const dotMatch = providerGw.find((m) => m.id === `${prefix}${dotted}`);
    if (dotMatch) return dotMatch;
  }

  // 3. Strip date suffixes: grok-4.20-0309-reasoning → grok-4.20-reasoning
  const stripped = nativeId.replace(/-\d{4}(?=-|$)/g, "");
  if (stripped !== nativeId) {
    const stripMatch = providerGw.find((m) => m.id === `${prefix}${stripped}`);
    if (stripMatch) return stripMatch;

    // 4. Combination: strip dates AND normalize dots
    const strippedDotted = stripped.replace(/(\d+)-(\d+)(?=-|$)/g, "$1.$2");
    if (strippedDotted !== stripped) {
      const comboMatch = providerGw.find((m) => m.id === `${prefix}${strippedDotted}`);
      if (comboMatch) return comboMatch;
    }
  }

  return null;
}

// ── Enrichment ──────────────────────────────────────────────────────────────

function enrichModels(
  rawModels: { id: string; owned_by: string }[],
  provider: string,
  gwModels: GatewayModel[],
): EnrichedModel[] {
  return rawModels.map((m) => {
    const match = findGatewayMatch(m.id, provider, gwModels);

    if (match) {
      return {
        id: m.id,
        name: match.name,
        owned_by: provider,
        tags: match.tags ?? [],
        context_window: match.context_window,
        max_tokens: match.max_tokens,
        gatewayId: match.id,
      };
    }

    // No gateway match — derive metadata from the name
    const tags: string[] = [];
    const idLower = m.id.toLowerCase();
    if (idLower.includes("-reasoning") && !idLower.includes("-non-reasoning")) tags.push("reasoning");
    if (idLower.includes("vision")) tags.push("vision");
    if (idLower.includes("code")) tags.push("code");

    // Friendly name: "grok-4-1-fast-reasoning" → "Grok 4 1 Fast Reasoning"
    const friendlyName = m.id
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

    return {
      id: m.id,
      name: friendlyName,
      owned_by: provider,
      tags,
    };
  });
}

// ── Route handler ───────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const keyId = new URL(req.url).searchParams.get("keyId");
  if (!keyId) {
    return NextResponse.json({ error: "keyId is required" }, { status: 400 });
  }

  // Fetch the key's provider and hint
  const { data: keyRow } = await supabase
    .from("user_api_keys")
    .select("provider, key_hint")
    .eq("id", keyId)
    .eq("user_id", user.id)
    .single();

  if (!keyRow) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }

  // Get the secret via RPC — by key ID, not provider (supports multiple keys per provider)
  const { data: secret } = await supabase.rpc("get_api_key_by_id", { p_key_id: keyId });
  if (!secret) {
    return NextResponse.json({ error: "Could not retrieve API key secret" }, { status: 500 });
  }

  // Gateway keys don't need native catalog — use /api/gateway-models
  if (keyRow.provider === "gateway") {
    return NextResponse.json({ models: [], useGatewayCatalog: true });
  }

  // Providers without /v1/models — enrich gateway catalog filtered by provider
  if (NO_MODELS_ENDPOINT.has(keyRow.provider)) {
    const gwModels = await getGatewayCatalog();
    const filtered = gwModels
      .filter((m) => m.owned_by === keyRow.provider)
      .map((m) => ({
        id: m.id.split("/").pop() ?? m.id, // strip provider prefix for native ID
        name: m.name,
        owned_by: keyRow.provider,
        tags: m.tags ?? [],
        context_window: m.context_window,
        max_tokens: m.max_tokens,
        gatewayId: m.id,
      }));
    return NextResponse.json({ models: filtered, provider: keyRow.provider });
  }

  const baseURL = PROVIDER_BASE_URLS[keyRow.provider];
  if (!baseURL) {
    return NextResponse.json({ models: [], useGatewayCatalog: true, filterProvider: keyRow.provider });
  }

  // Check cache (per keyId, invalidated if key_hint changed)
  const hint = keyRow.key_hint ?? "";
  const cached = modelCache.get(keyId);
  if (cached && cached.hint === hint && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json({ models: cached.models, provider: keyRow.provider, cached: true });
  }

  try {
    // Fetch native catalog + gateway catalog in parallel
    const [nativeRes, gwModels] = await Promise.all([
      fetch(`${baseURL}/models`, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(10000),
      }),
      getGatewayCatalog(),
    ]);

    if (!nativeRes.ok) {
      const text = await nativeRes.text().catch(() => "");
      console.error(`[provider-models] ${keyRow.provider} returned ${nativeRes.status}: ${text.slice(0, 200)}`);
      return NextResponse.json({
        error: `Provider returned ${nativeRes.status}`,
        models: [],
        useGatewayCatalog: true,
        filterProvider: keyRow.provider,
      });
    }

    const json = await nativeRes.json();
    const rawModels: Array<{ id: string; object?: string; owned_by?: string }> = json.data ?? [];

    // Filter to language/chat models
    const filtered = rawModels.filter((m) => {
      const id = m.id.toLowerCase();
      if (id.includes("embed") || id.includes("tts") || id.includes("whisper")
        || id.includes("dall-e") || id.includes("moderation")) return false;
      if (id.includes("imagine-image") || id.includes("imagine-video")) return false;
      return true;
    });

    // Enrich with gateway metadata
    const models = enrichModels(
      filtered.map((m) => ({ id: m.id, owned_by: keyRow.provider })),
      keyRow.provider,
      gwModels,
    ).sort((a, b) => a.name.localeCompare(b.name));

    // Cache the enriched result
    modelCache.set(keyId, { models, hint, ts: Date.now() });

    return NextResponse.json({ models, provider: keyRow.provider });
  } catch (err) {
    console.error(`[provider-models] Error fetching from ${keyRow.provider}:`, err);
    return NextResponse.json({
      models: [],
      useGatewayCatalog: true,
      filterProvider: keyRow.provider,
    });
  }
}
