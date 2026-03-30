/**
 * Provider constants for Guardian BYOK system.
 *
 * The model catalog is fetched dynamically from the Vercel AI Gateway
 * at /api/gateway-models (cached 1h). This file only contains constants
 * that the server needs at startup.
 */

import { TIERS } from "@/lib/tiers";

/** Default free-tier model (re-exported from tiers for backward compat). */
export const FREE_TIER_MODEL = TIERS.free.defaultModel;
