/**
 * Provider constants for Guardian BYOK system.
 *
 * The model catalog is fetched dynamically from the Vercel AI Gateway
 * at /api/gateway-models (cached 1h). This file only contains constants
 * that the server needs at startup.
 */

/** Default free-tier model (platform gateway key + this model). */
export const FREE_TIER_MODEL = "google/gemini-2.5-flash";
