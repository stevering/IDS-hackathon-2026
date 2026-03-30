/**
 * Shared model resolver for the Guardian platform.
 *
 * Resolution depends on the `source` parameter:
 *
 *  source = "included" → platform AI Gateway key + tier-allowed models + quota tracking
 *  source = "byok"     → user's own key (direct provider or gateway) + no quota
 *
 * Legacy callers that don't pass `source` fall back to the old heuristic
 * (check user keys, then free tier).
 */

import { createXai } from "@ai-sdk/xai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGateway } from "@ai-sdk/gateway";
import type { LanguageModel } from "ai";
import { getUserTier, isModelAllowedForTier } from "@/lib/tiers";

export type UsageSource = "included" | "byok";

export type ResolvedModel = {
  model: LanguageModel;
  isFreeTier: boolean;
  supportsWebSearch: boolean;
  modelId: string;
};

/**
 * Resolve the AI model for a given request.
 *
 * @param userId - The authenticated user ID (null for anonymous)
 * @param requestedModel - Model string (e.g. "openai/gpt-4o" or "google/gemini-2.5-flash")
 * @param supabase - Supabase client with access to get_api_key RPC
 * @param source - "included" (platform key, quota) or "byok" (user key, no quota)
 * @param keyId - specific BYOK key ID selected by the user (avoids ambiguity when multiple keys exist)
 */
export async function resolveModel(
  userId: string | null | undefined,
  requestedModel: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  source?: UsageSource,
  keyId?: string,
): Promise<ResolvedModel> {
  // Anonymous users always get included/free tier
  if (!userId) {
    return resolveIncluded(requestedModel);
  }

  // Explicit source routing
  if (source === "included") {
    return resolveIncluded(requestedModel, userId);
  }

  if (source === "byok") {
    return resolveBYOK(userId, requestedModel, supabase, keyId);
  }

  // Legacy fallback (no source param): try BYOK keys, then free tier
  return resolveLegacy(userId, requestedModel, supabase);
}

/**
 * Resolve using the platform's included usage (AI Gateway with platform key).
 * Enforces tier-based model restrictions.
 */
async function resolveIncluded(requestedModel?: string, userId?: string): Promise<ResolvedModel> {
  const platformGatewayKey = process.env.AI_GATEWAY_API_KEY;
  if (!platformGatewayKey) {
    throw new Error("Platform AI Gateway key (AI_GATEWAY_API_KEY) is not configured");
  }

  const tier = getUserTier(userId);
  const modelId = requestedModel || tier.defaultModel;

  if (!isModelAllowedForTier(modelId, tier)) {
    throw new Error(`Model "${modelId}" is not available on the ${tier.name} tier`);
  }

  const gw = createGateway({ apiKey: platformGatewayKey });
  return {
    model: gw(modelId),
    isFreeTier: true,
    supportsWebSearch: false,
    modelId,
  };
}

/**
 * Resolve using the user's own BYOK key.
 * If keyId is provided, use that specific key. Otherwise, try direct provider then gateway.
 */
async function resolveBYOK(
  userId: string,
  requestedModel: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  keyId?: string,
): Promise<ResolvedModel> {
  const modelStr = requestedModel ?? "";
  const slashIdx = modelStr.indexOf("/");
  const requestedModelId = slashIdx > -1 ? modelStr.slice(slashIdx + 1) : modelStr;

  // If a specific key ID was selected by the user, use that exact key
  if (keyId) {
    const { data: keyRow } = await supabase
      .from("user_api_keys")
      .select("provider, secret_plain")
      .eq("id", keyId)
      .eq("user_id", userId)
      .single();

    if (keyRow?.secret_plain) {
      if (keyRow.provider === "gateway") {
        // Gateway key → route through Vercel AI Gateway
        const gw = createGateway({ apiKey: keyRow.secret_plain });
        return { model: gw(modelStr), isFreeTier: false, supportsWebSearch: false, modelId: modelStr };
      }
      // Direct provider key → use SDK (native or OpenAI-compat)
      const model = buildDirectProviderModel(keyRow.provider, requestedModelId, keyRow.secret_plain);
      if (model) return { model, isFreeTier: false, supportsWebSearch: false, modelId: modelStr };
    }

    // keyId provided but secret not found — try RPC fallback (vault-based)
    if (keyRow?.provider) {
      const { data: secret } = await supabase.rpc("get_api_key", { p_provider: keyRow.provider });
      if (secret) {
        if (keyRow.provider === "gateway") {
          const gw = createGateway({ apiKey: secret });
          return { model: gw(modelStr), isFreeTier: false, supportsWebSearch: false, modelId: modelStr };
        }
        const model = buildDirectProviderModel(keyRow.provider, requestedModelId, secret);
        if (model) return { model, isFreeTier: false, supportsWebSearch: false, modelId: modelStr };
      }
    }
  }

  // No keyId — fallback to provider-based lookup (legacy behavior)
  const requestedProvider = slashIdx > -1 ? modelStr.slice(0, slashIdx) : null;

  if (requestedProvider) {
    const { data: providerSecret } = await supabase.rpc("get_api_key", { p_provider: requestedProvider });
    if (providerSecret) {
      const model = buildDirectProviderModel(requestedProvider, requestedModelId, providerSecret);
      if (model) return { model, isFreeTier: false, supportsWebSearch: false, modelId: modelStr };
    }
  }

  // Try gateway key
  const { data: gatewaySecret } = await supabase.rpc("get_api_key", { p_provider: "gateway" });
  if (gatewaySecret) {
    const gw = createGateway({ apiKey: gatewaySecret });
    return { model: gw(modelStr), isFreeTier: false, supportsWebSearch: false, modelId: modelStr };
  }

  // BYOK requested but no matching key — do NOT fallback to included
  throw new Error(
    `No API key found for model "${modelStr}". Add a matching key (${requestedProvider ?? "gateway"}) in your Account settings.`
  );
}

/**
 * Legacy resolution (for callers not yet passing `source`).
 * Keeps the old priority: direct key → gateway key → free tier.
 */
async function resolveLegacy(
  userId: string,
  requestedModel: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
): Promise<ResolvedModel> {
  const modelStr = requestedModel ?? "";
  const slashIdx = modelStr.indexOf("/");
  const requestedProvider = slashIdx > -1 ? modelStr.slice(0, slashIdx) : null;
  const requestedModelId = slashIdx > -1 ? modelStr.slice(slashIdx + 1) : modelStr;

  if (!requestedProvider) {
    return resolveIncluded(requestedModel, userId);
  }

  // Check direct provider key
  const { data: providerSecret } = await supabase.rpc("get_api_key", { p_provider: requestedProvider });
  if (providerSecret) {
    const model = buildDirectProviderModel(requestedProvider, requestedModelId, providerSecret);
    if (model) return { model, isFreeTier: false, supportsWebSearch: false, modelId: modelStr };
  }

  // Fallback: gateway key
  const { data: gatewaySecret } = await supabase.rpc("get_api_key", { p_provider: "gateway" });
  if (gatewaySecret) {
    const gw = createGateway({ apiKey: gatewaySecret });
    return { model: gw(modelStr), isFreeTier: false, supportsWebSearch: false, modelId: modelStr };
  }

  return resolveIncluded(requestedModel, userId);
}

/**
 * OpenAI-compatible base URLs for providers without a dedicated AI SDK.
 * These providers expose an OpenAI-compatible API as their primary endpoint,
 * so using @ai-sdk/openai with a custom baseURL has zero feature loss.
 */
const OPENAI_COMPAT_PROVIDERS: Record<string, string> = {
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

export function buildDirectProviderModel(provider: string, modelId: string, apiKey: string): LanguageModel | null {
  // Dedicated SDKs for providers with unique API formats (non-OpenAI-compatible)
  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey })(modelId);
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case "xai":
      return createXai({ apiKey })(modelId);
  }

  // OpenAI-compatible providers via @ai-sdk/openai + custom baseURL
  // Use Chat Completions API (not Responses API) for compatibility
  const baseURL = OPENAI_COMPAT_PROVIDERS[provider];
  if (baseURL) {
    return createOpenAI({ apiKey, baseURL, compatibility: "compatible" }).chat(modelId);
  }

  return null;
}

/** Kept for backward compat — now delegates to resolveIncluded. */
export async function resolveFreeTier(userId?: string | null): Promise<ResolvedModel> {
  return resolveIncluded(undefined, userId ?? undefined);
}
