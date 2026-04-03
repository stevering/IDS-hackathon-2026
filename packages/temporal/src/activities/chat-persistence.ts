/**
 * Chat persistence activities — save/load messages for chat workflows.
 *
 * Uses a service-role Supabase client to bypass RLS.
 */

import { createClient } from "@supabase/supabase-js";
import { createLogger } from "../lib/log.js";

function getServiceClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.STORAGE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase credentials not configured");
  return createClient(supabaseUrl, serviceKey);
}

export async function persistChatMessage(params: {
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts?: unknown[];
  metadata?: Record<string, unknown>;
  userId: string;
}): Promise<{ messageId: string }> {
  const log = createLogger("chat-persist", {
    conv: params.conversationId.slice(0, 8),
    role: params.role,
  });

  const supabase = getServiceClient();

  // Insert directly (bypass RLS) — the save_message RPC uses auth.uid() which
  // is NULL for service-role clients, causing "Conversation not found".
  const { data, error } = await supabase
    .from("messages")
    .insert({
      conversation_id: params.conversationId,
      role: params.role,
      content: params.content,
      parts: params.parts ?? [{ type: "text", text: params.content }],
      metadata: params.metadata ?? {},
    })
    .select("id")
    .single();

  if (error) {
    log.error("failed to persist message", { error: error.message });
    throw new Error(`Failed to persist message: ${error.message}`);
  }

  // Bump conversation updated_at
  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", params.conversationId);

  const messageId = data.id as string;
  log.info("message persisted", { id: messageId, contentLen: params.content.length });
  return { messageId };
}

export async function loadChatHistory(params: {
  conversationId: string;
  userId: string;
  limit?: number;
}): Promise<Array<{ role: string; content: string; parts?: unknown[]; metadata?: Record<string, unknown> }>> {
  const log = createLogger("chat-history", {
    conv: params.conversationId.slice(0, 8),
  });

  const supabase = getServiceClient();
  const limit = params.limit ?? 100;

  const { data, error } = await supabase
    .from("messages")
    .select("role, content, parts, metadata")
    .eq("conversation_id", params.conversationId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    log.error("failed to load history", { error: error.message });
    throw new Error(`Failed to load chat history: ${error.message}`);
  }

  log.info("history loaded", { count: data?.length ?? 0 });
  return (data ?? []).map((row) => ({
    role: row.role,
    content: row.content ?? "",
    parts: row.parts as unknown[] | undefined,
    metadata: row.metadata as Record<string, unknown> | undefined,
  }));
}
