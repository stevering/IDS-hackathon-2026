/**
 * Provider + model catalog for Guardian BYOK system.
 *
 * Three modes:
 *  1. Free tier  — platform uses AI_GATEWAY_API_KEY + FREE_TIER_MODEL
 *  2. BYOK gateway — user's Vercel AI Gateway key, any model
 *  3. BYOK direct  — user's per-provider key (openai/anthropic/google/xai)
 */

export type ProviderId = "openai" | "anthropic" | "google" | "xai" | "gateway";

export type ModelDef = {
  id: string;
  name: string;
  /** Model supports extended thinking / reasoning mode */
  supportsReasoning: boolean;
  /** This model is used for the platform free tier */
  isFreeTier?: boolean;
};

export type ProviderDef = {
  id: ProviderId;
  name: string;
  /** Model ID prefix used when routing via Vercel AI Gateway, e.g. "openai/gpt-4o" */
  gatewayPrefix: string;
  models: ModelDef[];
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: "openai",
    name: "OpenAI",
    gatewayPrefix: "openai",
    models: [
      { id: "gpt-4.1", name: "GPT-4.1", supportsReasoning: false },
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", supportsReasoning: false },
      { id: "o4-mini", name: "o4 Mini", supportsReasoning: true },
      { id: "o3", name: "o3", supportsReasoning: true },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    gatewayPrefix: "anthropic",
    models: [
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", supportsReasoning: false },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", supportsReasoning: false },
      { id: "claude-opus-4-5", name: "Claude Opus 4.5", supportsReasoning: false },
    ],
  },
  {
    id: "google",
    name: "Google",
    gatewayPrefix: "google",
    models: [
      {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        supportsReasoning: true,
        isFreeTier: true,
      },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", supportsReasoning: true },
    ],
  },
  {
    id: "xai",
    name: "xAI",
    gatewayPrefix: "xai",
    models: [
      { id: "grok-3-fast", name: "Grok 3 Fast", supportsReasoning: false },
      { id: "grok-3", name: "Grok 3", supportsReasoning: false },
      { id: "grok-3-mini", name: "Grok 3 Mini", supportsReasoning: true },
    ],
  },
];

/** The gateway "provider" is a virtual entry — it uses a Vercel AI Gateway key
 *  and can route to any of the models above via their gateway prefix. */
export const GATEWAY_PROVIDER: ProviderDef = {
  id: "gateway",
  name: "Vercel AI Gateway",
  gatewayPrefix: "",
  models: PROVIDERS.flatMap((p) =>
    p.models.map((m) => ({ ...m, id: `${p.gatewayPrefix}/${m.id}` }))
  ),
};

/** Default free-tier model (platform gateway key + this model). */
export const FREE_TIER_MODEL = "google/gemini-2.5-flash";

/** All providers including the virtual gateway entry. */
export const ALL_PROVIDERS: ProviderDef[] = [...PROVIDERS, GATEWAY_PROVIDER];

/** Find a model definition by provider + model id. */
export function findModel(providerId: ProviderId | string, modelId: string): ModelDef | undefined {
  if (providerId === "gateway") {
    return GATEWAY_PROVIDER.models.find((m) => m.id === modelId);
  }
  const provider = PROVIDERS.find((p) => p.id === providerId);
  return provider?.models.find((m) => m.id === modelId);
}

/**
 * Whether a model tag from the Gateway catalog indicates reasoning support.
 * The Gateway API uses the "reasoning" tag.
 */
export function gatewayModelSupportsReasoning(tags: string[]): boolean {
  return tags.includes("reasoning");
}
