/**
 * Figma docs fetch activity — fetches Plugin API documentation from the web.
 *
 * Thin wrapper around the shared fetchFigmaDocsFromWeb utility.
 * This activity runs in the Temporal worker process (Node.js)
 * and has access to the network.
 */

import type { FetchFigmaDocsParams, FetchFigmaDocsResult } from "@guardian/orchestrations";
import { fetchFigmaDocsFromWeb } from "@guardian/orchestrations";

export async function fetchFigmaDocs(params: FetchFigmaDocsParams): Promise<FetchFigmaDocsResult> {
  return fetchFigmaDocsFromWeb(params.topic, params.timeoutMs);
}
