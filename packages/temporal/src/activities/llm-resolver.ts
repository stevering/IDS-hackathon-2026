/**
 * Model resolver for Temporal activities.
 *
 * Uses a service-role Supabase client to look up user API keys
 * directly (bypassing RLS and auth.uid()-based RPCs).
 *
 * Now supports source-based resolution (included / byok) aligned
 * with the web model-resolver.
 */

import { createClient } from "@supabase/supabase-js";
import type { LanguageModel } from "ai";

const FREE_TIER_MODEL = "google/gemini-2.5-flash";
const FREE_TIER_ALLOWED = ["google/gemini-2.5-flash", "google/gemini-2.5-pro"];

type ResolvedModel = {
  model: LanguageModel;
  isFreeTier: boolean;
  modelId: string;
};

type UsageSource = "included" | "byok";

function getServiceClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.STORAGE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return null;
  return createClient(supabaseUrl, serviceKey);
}

/**
 * Resolve the AI model for a Temporal activity.
 * Uses a service-role Supabase client to look up user API keys.
 */
export async function resolveModelForActivity(
  userId: string | undefined,
  requestedModel: string | undefined
): Promise<ResolvedModel> {
  if (!userId) {
    return resolveIncluded();
  }

  const supabase = getServiceClient();
  if (!supabase) {
    return resolveIncluded();
  }

  // Determine the user's preferred source and default model
  const { source, model: defaultModel } = await getUserPreferences(userId, supabase);
  const modelStr = requestedModel || defaultModel || "";

  if (source === "included" || !modelStr) {
    return resolveIncluded(modelStr || undefined);
  }

  // BYOK resolution
  const slashIdx = modelStr.indexOf("/");
  const requestedProvider = slashIdx > -1 ? modelStr.slice(0, slashIdx) : null;
  const requestedModelId = slashIdx > -1 ? modelStr.slice(slashIdx + 1) : modelStr;

  if (!requestedProvider) {
    return resolveIncluded(modelStr || undefined);
  }

  async function getUserApiKey(provider: string): Promise<string | null> {
    const { data, error } = await supabase!.rpc("get_api_key_for_user", {
      p_user_id: userId,
      p_provider: provider,
    });
    if (error || !data) return null;
    return data as string;
  }

  // Try direct provider key
  const providerSecret = await getUserApiKey(requestedProvider);
  if (providerSecret) {
    const model = await buildDirectProviderModel(requestedProvider, requestedModelId, providerSecret);
    if (model) return { model, isFreeTier: false, modelId: modelStr };
  }

  // Try gateway key
  const gatewaySecret = await getUserApiKey("gateway");
  if (gatewaySecret) {
    const { createGateway } = await import("@ai-sdk/gateway");
    const gw = createGateway({ apiKey: gatewaySecret });
    return { model: gw(modelStr), isFreeTier: false, modelId: modelStr };
  }

  // No matching key → fall back to included
  return resolveIncluded(modelStr || undefined);
}

/**
 * Look up user's usage_source preference and resolve the effective default model.
 */
async function getUserPreferences(
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
): Promise<{ source: UsageSource; model: string | null }> {
  try {
    // Get settings
    const { data: settings } = await supabase
      .from("user_settings")
      .select("usage_source, default_model")
      .eq("user_id", userId)
      .single();

    const source: UsageSource = settings?.usage_source === "byok" ? "byok" : "included";

    if (source === "included") {
      return { source, model: settings?.default_model ?? null };
    }

    // BYOK: get the default key's default_model
    const { data: defaultKey } = await supabase
      .from("user_api_keys")
      .select("provider, default_model")
      .eq("user_id", userId)
      .eq("is_default", true)
      .single();

    if (defaultKey?.default_model) {
      return { source: "byok", model: defaultKey.default_model };
    }

    // Has a default key but no model set on it — fall back to settings default_model
    return { source: "byok", model: settings?.default_model ?? null };
  } catch {
    return { source: "included", model: null };
  }
}

async function resolveIncluded(requestedModel?: string): Promise<ResolvedModel> {
  const platformGatewayKey = process.env.AI_GATEWAY_API_KEY;
  if (!platformGatewayKey) {
    throw new Error("Platform AI Gateway key (AI_GATEWAY_API_KEY) is not configured");
  }

  const modelId = requestedModel || FREE_TIER_MODEL;

  // Enforce tier model restriction (free tier only allows specific models)
  if (!FREE_TIER_ALLOWED.includes(modelId)) {
    // Fall back to default rather than throwing in Temporal context
    const { createGateway } = await import("@ai-sdk/gateway");
    const gw = createGateway({ apiKey: platformGatewayKey });
    return { model: gw(FREE_TIER_MODEL), isFreeTier: true, modelId: FREE_TIER_MODEL };
  }

  const { createGateway } = await import("@ai-sdk/gateway");
  const gw = createGateway({ apiKey: platformGatewayKey });
  return { model: gw(modelId), isFreeTier: true, modelId };
}

/** OpenAI-compatible base URLs for providers without a dedicated AI SDK. */
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

async function buildDirectProviderModel(
  provider: string,
  modelId: string,
  apiKey: string
): Promise<LanguageModel | null> {
  // Dedicated SDKs for providers with native features
  switch (provider) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({ apiKey })(modelId);
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({ apiKey })(modelId);
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      return createGoogleGenerativeAI({ apiKey })(modelId);
    }
    case "xai": {
      const { createXai } = await import("@ai-sdk/xai");
      return createXai({ apiKey })(modelId);
    }
  }

  // OpenAI-compatible providers via @ai-sdk/openai + custom baseURL
  const baseURL = OPENAI_COMPAT_PROVIDERS[provider];
  if (baseURL) {
    const { createOpenAI } = await import("@ai-sdk/openai");
    return createOpenAI({ apiKey, baseURL, compatibility: "compatible" }).chat(modelId);
  }

  return null;
}
