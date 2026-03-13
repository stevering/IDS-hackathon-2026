/**
 * Shared model resolver for the Guardian platform.
 *
 * Extracted from api/chat/route.ts for reuse by both the Next.js API
 * route and the Temporal LLM activity.
 *
 * BYOK priority:
 *  1. User has a `gateway` key → Vercel AI Gateway
 *  2. User has a direct key for the provider → use that SDK
 *  3. No keys → platform free tier (AI_GATEWAY_API_KEY + FREE_TIER_MODEL or XAI fallback)
 */

import { xai } from "@ai-sdk/xai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGateway } from "@ai-sdk/gateway";
import type { LanguageModel } from "ai";
import { FREE_TIER_MODEL } from "@/lib/providers";

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
 * @param requestedModel - Model string (e.g. "openai/gpt-4o" or legacy "grok-4")
 * @param supabase - Supabase client with access to get_api_key RPC
 */
export async function resolveModel(
  userId: string | null | undefined,
  requestedModel: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any
): Promise<ResolvedModel> {
  const modelStr = requestedModel ?? "";
  const slashIdx = modelStr.indexOf("/");
  const requestedProvider = slashIdx > -1 ? modelStr.slice(0, slashIdx) : null;
  const requestedModelId = slashIdx > -1 ? modelStr.slice(slashIdx + 1) : modelStr;

  // ── Free tier (not logged in or legacy XAI model string) ──────────────────
  if (!userId || !requestedProvider) {
    return resolveFreeTier(userId);
  }

  // ── Check user's Vercel AI Gateway key first ──────────────────────────────
  const { data: gatewaySecret } = await supabase.rpc("get_api_key", { p_provider: "gateway" });
  if (gatewaySecret) {
    const gw = createGateway({ apiKey: gatewaySecret });
    return { model: gw(modelStr), isFreeTier: false, supportsWebSearch: false, modelId: modelStr };
  }

  // ── Check user's direct provider key ──────────────────────────────────────
  const { data: providerSecret } = await supabase.rpc("get_api_key", { p_provider: requestedProvider });
  if (providerSecret) {
    const model = buildDirectProviderModel(requestedProvider, requestedModelId, providerSecret);
    if (model) return { model, isFreeTier: false, supportsWebSearch: false, modelId: modelStr };
  }

  // ── No matching key → fall back to free tier ──────────────────────────────
  return resolveFreeTier(userId);
}

export function buildDirectProviderModel(provider: string, modelId: string, apiKey: string): LanguageModel | null {
  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey })(modelId);
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case "xai":
      return xai(modelId);
    default:
      return null;
  }
}

export async function resolveFreeTier(userId: string | null | undefined): Promise<ResolvedModel> {
  const platformGatewayKey = process.env.AI_GATEWAY_API_KEY;
  if (platformGatewayKey) {
    const gw = createGateway({ apiKey: platformGatewayKey });
    return { model: gw(FREE_TIER_MODEL), isFreeTier: true, supportsWebSearch: false, modelId: FREE_TIER_MODEL };
  }

  // Fallback: platform XAI key
  return {
    model: xai.responses("grok-4-1-fast-non-reasoning"),
    isFreeTier: true,
    supportsWebSearch: true,
    modelId: "xai/grok-4-1-fast-non-reasoning",
  };
}
