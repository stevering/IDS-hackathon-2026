import { createServiceClient } from "@/lib/supabase/service";

const VERCEL_GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type ModelPricing = {
  inputPerToken: number;
  outputPerToken: number;
};

// In-memory pricing cache (singleton across requests in the same server process)
const globalPricing = globalThis as unknown as {
  __modelPricingCache?: Map<string, ModelPricing>;
  __modelPricingFetchedAt?: number;
};

if (!globalPricing.__modelPricingCache) {
  globalPricing.__modelPricingCache = new Map();
}

const pricingCache = globalPricing.__modelPricingCache;

// Default fallback prices for known free-tier models (USD per token)
const FALLBACK_PRICING: Record<string, ModelPricing> = {
  "google/gemini-2.5-flash": { inputPerToken: 0.000000075, outputPerToken: 0.0000003 },
  "xai/grok-4-1-fast-non-reasoning": { inputPerToken: 0.000003, outputPerToken: 0.000015 },
};

/**
 * Refresh the in-memory pricing cache from Vercel AI Gateway API.
 * Also persists prices to the model_pricing_cache Supabase table.
 */
async function refreshPricingCache(): Promise<void> {
  try {
    console.log("[ModelPricing] Fetching pricing from Vercel AI Gateway...");
    const res = await fetch(VERCEL_GATEWAY_MODELS_URL);
    if (!res.ok) {
      console.error("[ModelPricing] Failed to fetch models:", res.status);
      return;
    }

    const data = await res.json();
    const models = data?.data ?? data ?? [];

    if (!Array.isArray(models)) {
      console.error("[ModelPricing] Unexpected response format");
      return;
    }

    const entries: Array<{ model_id: string; input_per_token: number; output_per_token: number }> = [];

    for (const model of models) {
      if (model.pricing?.input && model.pricing?.output) {
        const inputPerToken = parseFloat(model.pricing.input);
        const outputPerToken = parseFloat(model.pricing.output);
        if (!isNaN(inputPerToken) && !isNaN(outputPerToken)) {
          pricingCache.set(model.id, { inputPerToken, outputPerToken });
          entries.push({ model_id: model.id, input_per_token: inputPerToken, output_per_token: outputPerToken });
        }
      }
    }

    globalPricing.__modelPricingFetchedAt = Date.now();
    console.log(`[ModelPricing] Cached pricing for ${entries.length} models`);

    // Persist to DB (fire-and-forget)
    if (entries.length > 0) {
      try {
        const serviceClient = createServiceClient();
        for (const entry of entries) {
          void serviceClient
            .from("model_pricing_cache")
            .upsert({
              model_id: entry.model_id,
              input_per_token: entry.input_per_token,
              output_per_token: entry.output_per_token,
              fetched_at: new Date().toISOString(),
            }, { onConflict: "model_id" })
            .then(({ error }) => {
              if (error) console.error(`[ModelPricing] DB upsert error for ${entry.model_id}:`, error.message);
            });
        }
      } catch (e) {
        console.error("[ModelPricing] DB persist failed:", e);
      }
    }
  } catch (e) {
    console.error("[ModelPricing] Refresh failed:", e);
  }
}

/**
 * Try to load pricing from the Supabase model_pricing_cache table.
 */
async function loadFromDB(modelId: string): Promise<ModelPricing | null> {
  try {
    const serviceClient = createServiceClient();
    const { data, error } = await serviceClient
      .from("model_pricing_cache")
      .select("input_per_token, output_per_token")
      .eq("model_id", modelId)
      .single();
    if (error || !data) return null;
    return {
      inputPerToken: parseFloat(data.input_per_token),
      outputPerToken: parseFloat(data.output_per_token),
    };
  } catch {
    return null;
  }
}

/**
 * Get pricing for a specific model.
 * Resolution order: in-memory cache → DB table → hardcoded fallback → zero.
 */
export async function getModelPricing(modelId: string): Promise<ModelPricing> {
  // Refresh cache if stale or empty
  const lastFetch = globalPricing.__modelPricingFetchedAt ?? 0;
  if (pricingCache.size === 0 || Date.now() - lastFetch > CACHE_TTL_MS) {
    await refreshPricingCache();
  }

  // 1. In-memory cache
  const cached = pricingCache.get(modelId);
  if (cached) return cached;

  // 2. DB fallback
  const fromDB = await loadFromDB(modelId);
  if (fromDB) {
    pricingCache.set(modelId, fromDB);
    return fromDB;
  }

  // 3. Hardcoded fallback
  const fallback = FALLBACK_PRICING[modelId];
  if (fallback) return fallback;

  // 4. Unknown model — return zero (tokens still tracked, cost will be 0)
  console.warn(`[ModelPricing] No pricing found for model: ${modelId}`);
  return { inputPerToken: 0, outputPerToken: 0 };
}
