import { NextResponse } from "next/server";

/**
 * GET /api/gateway-models
 *
 * Proxies the Vercel AI Gateway public model catalog.
 * Filters to language models only (type === "language").
 * Cached server-side for 1 hour.
 *
 * Returns: { models: GatewayModel[] }
 */

export type GatewayModel = {
  id: string;          // "openai/gpt-4.1"
  name: string;        // "GPT-4.1"
  owned_by: string;    // "openai"
  description?: string;
  context_window: number;
  max_tokens: number;
  tags: string[];      // ["reasoning", "tool-use", "vision", ...]
};

// Cache for 1 hour on Vercel Edge cache
export const revalidate = 3600;

export async function GET() {
  try {
    const res = await fetch("https://ai-gateway.vercel.sh/v1/models", {
      next: { revalidate: 3600 },
    });

    if (!res.ok) {
      return NextResponse.json({ error: "Failed to fetch models" }, { status: 502 });
    }

    const json = await res.json();
    const all: Array<{
      id: string;
      name: string;
      owned_by: string;
      description?: string;
      context_window: number;
      max_tokens: number;
      type: string;
      tags: string[];
    }> = json.data ?? [];

    // Filter language models only, exclude embedding/image/video
    const models: GatewayModel[] = all
      .filter((m) => m.type === "language")
      .map((m) => ({
        id: m.id,
        name: m.name,
        owned_by: m.owned_by,
        description: m.description,
        context_window: m.context_window,
        max_tokens: m.max_tokens,
        tags: m.tags ?? [],
      }));

    return NextResponse.json({ models });
  } catch (e) {
    console.error("[gateway-models] Error fetching models:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
