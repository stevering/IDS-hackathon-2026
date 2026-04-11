/**
 * Free-tier quota and model restriction enforcement for the Temporal chat routes.
 *
 * Two concerns bundled into a single pre-flight check:
 *
 *   1. **24h rolling token quota** — free-tier users get a daily token budget
 *      (`TierDef.dailyTokenLimit`, e.g. 250k for `free`). The `get_usage_for_user`
 *      RPC returns the rolling 24h total; if >= limit we reject with 429
 *      `daily_limit_exceeded` BEFORE starting a workflow. This prevents the
 *      previous silent-burn behaviour where the activity's fire-and-forget
 *      `increment_usage` would only RECORD the overage, never block it.
 *
 *   2. **Model restriction** — free-tier users can only use the models listed
 *      in `TierDef.allowedModels`. Previously this was only enforced inside
 *      the activity's `resolveModelForActivity`, which silently fell back to
 *      the tier's `defaultModel` if the user requested an unauthorized one.
 *      Now we reject with 400 `model_not_allowed` at the route so the user
 *      gets a clear error instead of a surprise model swap.
 *
 * BYOK users bypass both checks — their provider bills them directly and they
 * can use any model their API key unlocks.
 *
 * These checks were present in the legacy `/api/chat` route (removed in
 * commit 94bd1f4) and were lost during the Temporal migration. Restored in
 * the April 2026 audit pass.
 */

import { getUserTier, isModelAllowedForTier } from "@/lib/tiers";
import type { SupabaseClient } from "@supabase/supabase-js";

export type QuotaCheckResult =
  | { kind: "ok" }
  | { kind: "error"; status: number; body: Record<string, unknown> };

export type QuotaCheckParams = {
  /** Authenticated user ID */
  userId: string;
  /** The model the caller wants to use (may be undefined → default) */
  requestedModel: string | undefined;
  /** Service-role client for `get_usage_for_user` + `user_settings` reads */
  serviceClient: SupabaseClient;
};

/**
 * Run the free-tier pre-flight checks and return either `{ kind: "ok" }` or
 * an `{ kind: "error", status, body }` payload that the caller converts into
 * a `NextResponse.json(body, { status })`.
 *
 * Returns `ok` for BYOK users (nothing to enforce — they bring their own key).
 */
export async function enforceFreeTierQuota(
  params: QuotaCheckParams,
): Promise<QuotaCheckResult> {
  // Read the user's usage source. If they've explicitly opted into BYOK,
  // skip all quota / model restriction checks — their provider bills them.
  const { data: settings } = await params.serviceClient
    .from("user_settings")
    .select("usage_source")
    .eq("user_id", params.userId)
    .maybeSingle();

  const isByok = settings?.usage_source === "byok";
  if (isByok) {
    return { kind: "ok" };
  }

  const tier = getUserTier(params.userId);

  // ── Model restriction ────────────────────────────────────────────────
  // If the caller passed a specific model, verify it's allowed for this
  // tier. We only check when `requestedModel` is present — an undefined
  // model means "use the tier default", which is by definition allowed.
  if (params.requestedModel && !isModelAllowedForTier(params.requestedModel, tier)) {
    return {
      kind: "error",
      status: 400,
      body: {
        error: "model_not_allowed",
        model: params.requestedModel,
        tier: tier.id,
        allowedModels: tier.allowedModels,
        message: `Model "${params.requestedModel}" is not available on the ${tier.name} tier. Switch to a BYOK key in Account > Developers, or pick one of: ${tier.allowedModels?.join(", ") ?? "any"}.`,
      },
    };
  }

  // ── 24h rolling token quota ──────────────────────────────────────────
  // `get_usage_for_user` returns the sum of input+output tokens across all
  // `user_usage_log` rows for this user in the last 24 hours. Fail-open on
  // RPC error (log but don't block) — a broken quota RPC should not stop
  // the user from chatting, the subsequent `increment_usage` write will
  // catch up.
  const { data: currentUsage, error: usageError } = await params.serviceClient.rpc(
    "get_usage_for_user",
    { p_user_id: params.userId },
  );
  if (usageError) {
    // Non-fatal — the subsequent increment_usage write still happens
    // inside the activity, so we accept a brief over-burn in the name of
    // keeping the user unblocked when the quota RPC flakes.
    // eslint-disable-next-line no-console
    console.warn("[chat-quota] get_usage_for_user failed, fail-open:", usageError.message);
    return { kind: "ok" };
  }

  if (typeof currentUsage === "number" && currentUsage >= tier.dailyTokenLimit) {
    return {
      kind: "error",
      status: 429,
      body: {
        error: "daily_limit_exceeded",
        limit: tier.dailyTokenLimit,
        used: currentUsage,
        tier: tier.id,
        message: `Daily token limit reached (${currentUsage.toLocaleString()}/${tier.dailyTokenLimit.toLocaleString()}). Quota resets on a rolling 24h window — come back later, or connect a BYOK key in Account > Developers for unlimited usage.`,
      },
    };
  }

  return { kind: "ok" };
}
