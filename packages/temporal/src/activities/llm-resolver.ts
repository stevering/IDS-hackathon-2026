/**
 * Model resolver for Temporal activities.
 *
 * Uses a service-role Supabase client to look up user API keys
 * directly (bypassing RLS and auth.uid()-based RPCs).
 */

import { createClient } from "@supabase/supabase-js";
import type { LanguageModel } from "ai";

const FREE_TIER_MODEL = "google/gemini-2.5-flash";

type ResolvedModel = {
  model: LanguageModel;
  isFreeTier: boolean;
  modelId: string;
};

/**
 * Resolve the AI model for a Temporal activity.
 * Uses a service-role Supabase client to look up user API keys.
 */
export async function resolveModelForActivity(
  userId: string | undefined,
  requestedModel: string | undefined
): Promise<ResolvedModel> {
  const modelStr = requestedModel ?? "";
  const slashIdx = modelStr.indexOf("/");
  const requestedProvider = slashIdx > -1 ? modelStr.slice(0, slashIdx) : null;
  const requestedModelId = slashIdx > -1 ? modelStr.slice(slashIdx + 1) : modelStr;

  // Free tier for non-authenticated or legacy model strings
  if (!userId || !requestedProvider) {
    return resolveFreeTier();
  }

  // Create a service-role client for key lookups
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.STORAGE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return resolveFreeTier();
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // Look up user API key directly via tables + vault (service-role bypasses RLS).
  // The get_api_key RPC uses auth.uid() which is NULL for service-role clients.
  async function getUserApiKey(provider: string): Promise<string | null> {
    const { data: keyRow } = await supabase
      .from("user_api_keys")
      .select("vault_id")
      .eq("user_id", userId!)
      .eq("provider", provider)
      .maybeSingle();

    if (!keyRow?.vault_id) return null;

    const { data: secret } = await supabase
      .schema("vault")
      .from("decrypted_secrets")
      .select("decrypted_secret")
      .eq("id", keyRow.vault_id)
      .maybeSingle();

    return secret?.decrypted_secret ?? null;
  }

  // Check gateway key first
  const gatewaySecret = await getUserApiKey("gateway");
  if (gatewaySecret) {
    const { createGateway } = await import("@ai-sdk/gateway");
    const gw = createGateway({ apiKey: gatewaySecret });
    return { model: gw(modelStr), isFreeTier: false, modelId: modelStr };
  }

  // Check direct provider key
  const providerSecret = await getUserApiKey(requestedProvider);
  if (providerSecret) {
    const model = await buildDirectProviderModel(requestedProvider, requestedModelId, providerSecret);
    if (model) return { model, isFreeTier: false, modelId: modelStr };
  }

  return resolveFreeTier();
}

async function buildDirectProviderModel(
  provider: string,
  modelId: string,
  apiKey: string
): Promise<LanguageModel | null> {
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
      const { xai } = await import("@ai-sdk/xai");
      return xai(modelId);
    }
    default:
      return null;
  }
}

async function resolveFreeTier(): Promise<ResolvedModel> {
  const platformGatewayKey = process.env.AI_GATEWAY_API_KEY;

  if (platformGatewayKey) {
    const { createGateway } = await import("@ai-sdk/gateway");
    const gw = createGateway({ apiKey: platformGatewayKey });
    return { model: gw(FREE_TIER_MODEL), isFreeTier: true, modelId: FREE_TIER_MODEL };
  }

  // Fallback: platform XAI key
  const { xai } = await import("@ai-sdk/xai");
  return {
    model: xai.responses("grok-4-1-fast-non-reasoning"),
    isFreeTier: true,
    modelId: "xai/grok-4-1-fast-non-reasoning",
  };
}
