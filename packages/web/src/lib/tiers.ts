/**
 * Guardian subscription tier definitions.
 *
 * Each tier defines its daily token quota (rolling 24h window),
 * the set of models available via the platform's included usage,
 * and a default model.
 *
 * `allowedModels: null` means all gateway models are available.
 */

export type TierId = "free" | "pro" | "enterprise";

export interface TierDef {
  id: TierId;
  name: string;
  dailyTokenLimit: number;
  /** Gateway model IDs allowed for included usage. `null` = all models. */
  allowedModels: string[] | null;
  defaultModel: string;
  features: string[];
  badge?: string;
  comingSoon?: boolean;
}

export const TIERS: Record<TierId, TierDef> = {
  free: {
    id: "free",
    name: "Free",
    dailyTokenLimit: 250_000,
    allowedModels: [
      "google/gemini-2.5-flash",
      "google/gemini-2.5-pro",
    ],
    defaultModel: "google/gemini-2.5-flash",
    features: [
      "250k tokens / 24h rolling",
      "Selected free models",
      "Basic features",
      "Cloud platform",
      "BYOK support",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    dailyTokenLimit: 500_000,
    allowedModels: null,
    defaultModel: "google/gemini-2.5-flash",
    features: [
      "500k tokens / 24h rolling",
      "All models",
      "Pro features",
      "BYOK support",
      "24h support",
    ],
    comingSoon: true,
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    dailyTokenLimit: 1_000_000,
    allowedModels: null,
    defaultModel: "google/gemini-2.5-flash",
    features: [
      "1M tokens / 24h rolling",
      "All models",
      "Enterprise features",
      "BYOK support",
      "4h support",
    ],
    comingSoon: true,
  },
};

/** Get the tier definition for a user. For now, everyone is free. */
export function getUserTier(_userId?: string): TierDef {
  return TIERS.free;
}

/** Check if a model is allowed for a given tier's included usage. */
export function isModelAllowedForTier(modelId: string, tier: TierDef): boolean {
  if (tier.allowedModels === null) return true;
  return tier.allowedModels.includes(modelId);
}
