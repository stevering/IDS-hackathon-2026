# BYOK & Model Resolution Architecture

## Overview

Guardian supports three ways to access AI models:

1. **Included usage** — platform pays via `AI_GATEWAY_API_KEY`, tier-limited (250k/500k/1M tokens/24h)
2. **BYOK Gateway** — user's own Vercel AI Gateway key (`vck_...`), no quota
3. **BYOK Direct** — user's own provider key (OpenAI, xAI, Anthropic, etc.), no quota

The user chooses their default source in Account settings. In the chat, they can override per-message.

## Data Model

### user_api_keys (Supabase)

```sql
id              UUID PRIMARY KEY
user_id         UUID REFERENCES auth.users
provider        TEXT        -- "gateway", "openai", "xai", "alibaba", etc.
label           TEXT        -- user-friendly name, e.g. "vercel-gateway-1", "xai-1"
key_hint        TEXT        -- first 3 + last 3 chars, e.g. "xai...6CJ"
is_default      BOOLEAN     -- one default per user
default_model   TEXT        -- per-key model preference, e.g. "xai/grok-4-1-fast-reasoning"
vault_id        UUID        -- Supabase Vault (cloud) — encrypted secret
secret_plain    TEXT        -- plaintext fallback (local Docker)
```

Multiple keys per provider are allowed (UNIQUE constraint removed in migration 029).

### user_settings

```sql
usage_source    TEXT DEFAULT 'included'  -- "included" or "byok"
default_model   TEXT                      -- model for included mode
```

## Model Catalogs

### Two catalog sources

| Source | Endpoint | Data | Use case |
|---|---|---|---|
| **Vercel AI Gateway** | `https://ai-gateway.vercel.sh/v1/models` | Rich: id, name, tags, context_window, max_tokens, pricing | Gateway keys, Included usage, metadata enrichment |
| **Provider native** | `https://api.x.ai/v1/models` (etc.) | Minimal: id, object, created, owned_by | Direct provider keys |

### The naming problem

Gateway and native model IDs often differ:

| Gateway ID | Native ID | Difference |
|---|---|---|
| `xai/grok-4.1-fast-reasoning` | `grok-4-1-fast-reasoning` | Dots vs dashes in version |
| `xai/grok-4.20-reasoning` | `grok-4.20-0309-reasoning` | Date suffix missing in gateway |
| `xai/grok-4` | `grok-4-0709` | Date suffix missing in gateway |
| `xai/grok-3-fast` | *(doesn't exist)* | Gateway alias |

### Enrichment: native + gateway matching

The endpoint `GET /api/user/api-keys/provider-models?keyId=xxx` does:

1. Fetch native catalog from provider (`/v1/models` with user's key)
2. Fetch gateway catalog (`https://ai-gateway.vercel.sh/v1/models`) — cached 1h
3. **Match** each native model to its gateway counterpart
4. Return **enriched** models: native ID + gateway metadata (name, tags, context_window)

Matching algorithm (in order):
1. **Exact**: `xai/grok-code-fast-1` matches `grok-code-fast-1`
2. **Dot normalization**: `grok-4-1-fast` → `grok-4.1-fast`
3. **Strip date suffixes**: `grok-4.20-0309-reasoning` → `grok-4.20-reasoning`
4. **Combination** of 2+3

Unmatched models get tags derived from the name (`-reasoning` → tag `reasoning`).

### Provider support

| Provider | SDK | Base URL | Native /v1/models |
|---|---|---|---|
| OpenAI | `@ai-sdk/openai` (native) | default | Yes |
| Anthropic | `@ai-sdk/anthropic` (native) | N/A | No — uses gateway catalog |
| Google | `@ai-sdk/google` (native) | N/A | No — uses gateway catalog |
| xAI | `@ai-sdk/xai` (native) | `api.x.ai/v1` | Yes |
| Alibaba | `@ai-sdk/openai` + baseURL | `dashscope-intl.aliyuncs.com/compatible-mode/v1` | Yes |
| DeepSeek | `@ai-sdk/openai` + baseURL | `api.deepseek.com/v1` | Yes |
| Mistral | `@ai-sdk/openai` + baseURL | `api.mistral.ai/v1` | Yes |
| Groq | `@ai-sdk/openai` + baseURL | `api.groq.com/openai/v1` | Yes |
| Together | `@ai-sdk/openai` + baseURL | `api.together.xyz/v1` | Yes |
| Cohere | `@ai-sdk/openai` + baseURL | `api.cohere.com/compatibility/v1` | Yes |
| Moonshot | `@ai-sdk/openai` + baseURL | `api.moonshot.cn/v1` | Yes |
| Perplexity | `@ai-sdk/openai` + baseURL | `api.perplexity.ai` | No (404) |
| Fireworks | N/A | Non-standard URL | No |

OpenAI-compat providers use `compatibility: "compatible"` + `.chat()` to force Chat Completions API (not Responses API).

## Resolution Flow

### Chat request

```
Client sends: { model: "xai/grok-4-1-fast-reasoning", source: "byok", keyId: "2ec58d0f-..." }
```

### resolveModel() — `packages/web/src/lib/model-resolver.ts`

```
1. source === "included" → resolveIncluded()
   → AI_GATEWAY_API_KEY + tier model restriction + usage tracking

2. source === "byok" + keyId → resolveBYOK()
   a. Fetch key by keyId from user_api_keys
   b. Fetch secret via `get_api_key_by_id(keyId)` (NOT `get_api_key(provider)`)
   c. If key.provider === "gateway" → createGateway({ apiKey })
   d. If key.provider has native SDK → buildDirectProviderModel()
   e. If key.provider has OpenAI-compat baseURL → createOpenAI({ apiKey, baseURL }).chat()
   f. No keyId → legacy fallback: try provider key, then gateway key
   g. No matching key → throw Error (no silent fallback to free tier)

3. No source → resolveLegacy() (backward compat)
```

### supportsReasoning detection

The chat body includes `supportsReasoning` which determines whether `extractReasoningMiddleware` is applied:

1. Check gateway catalog tags (`"reasoning"`)
2. Check enriched native model tags (`"reasoning"`)
3. If true → model handles reasoning natively
4. If false → middleware extracts `<thinking>` tags from text (fallback)

## Chat Model Selector UX

### Structure

```
┌─ INCLUDED (FREE TIER) ─────────────┐
│  Gemini 2.5 Flash                   │
│  Gemini 2.5 Pro                     │
├─ MY KEYS ───────────────────────────┤
│  ★ xai-1  xai...6CJ                │  ← key header (star = default)
│  │  Grok 4.1 Fast Non-Reasoning    │  ← enriched native models
│  │  ● Grok 4.1 Fast Reasoning ✦    │  ← selected, reasoning tag
│  │  Grok 4.20 Reasoning ✦          │
│  │                                  │
│  ☆ vercel-gateway-1  vck...x9f     │
│  │  ── Openai ──                   │
│  │    GPT-4.1                      │
│  │  ── Anthropic ──                │
│  │    Claude Sonnet 4.6            │
└─────────────────────────────────────┘
```

- **Gateway keys**: show full gateway catalog, grouped by provider
- **Direct keys**: show enriched native catalog (only models accessible with that key)
- **Tag on trigger button**: shows key label (e.g., `★ xai-1`) + friendly model name

### Loading strategy

All catalogs fetched at page mount (in parallel with settings + keys):
1. Gateway catalog → `/api/gateway-models`
2. Native catalogs → `/api/user/api-keys/provider-models?keyId=xxx` for each direct key
3. Skeleton shown until all loaded
4. No "Loading..." per key — everything ready before display

## Caching

| Cache | Location | TTL | Key | Invalidation |
|---|---|---|---|---|
| Gateway catalog | Server (Next.js revalidate) | 1h | global | time-based |
| Native catalogs (enriched) | Server (in-memory Map) | 1h | keyId + key_hint | key_hint change (secret updated) |
| Native catalogs | Client (React state) | session | keyId | F5, key change in Account |
| Gateway catalog (in enrichment endpoint) | Server (in-memory) | 1h | global | time-based |

## Error Handling

### PeekBanner component

Animated error banner above the chat input:
1. Slides up from below with ease-in
2. Auto-retracts to peek mode after 3s (first line visible)
3. User can expand (stays open) or dismiss
4. Supports close/expand/collapse buttons

### Error enrichment (server-side)

SSE error events from the AI stream are intercepted and enriched:
- Provider name + model ID added
- Auth errors → "Invalid API key for {provider}"
- Rate limits → "Rate limit reached for {provider}"
- Unique error ID for log correlation

## Model Tracing

Each assistant message is tagged with metadata about which model/key produced it:

### System prompt injection

The chat route appends a `## Current Model` section to the system prompt:
```
You are running as: **xai/grok-4-1-fast-reasoning** (user's own API key).
```
This lets the LLM correctly answer "what model are you?" even when the user switches mid-conversation.

### Per-message metadata

When an assistant message is saved to the database, the client includes metadata:
```json
{
  "model": "xai/grok-4-1-fast-reasoning",
  "source": "byok",
  "keyId": "2ec58d0f-...",
  "keyLabel": "xai-2",
  "keyHint": "xai...6CJ"
}
```

This uses the existing `p_metadata JSONB` field in the `save_message` RPC. The metadata is captured from the client's current state (selectedModel, selectedSource, selectedKeyId, byokKeys) at the moment the stream completes.

For included usage:
```json
{ "model": "google/gemini-2.5-flash", "source": "included" }
```

### RPCs

| RPC | Purpose |
|---|---|
| `get_api_key(provider)` | Get secret by provider (default key) — used for legacy/fallback |
| `get_api_key_by_id(key_id)` | Get secret for a specific key — used when keyId is known |

## Key Files

| File | Role |
|---|---|
| `packages/web/src/lib/model-resolver.ts` | Core resolution: source → SDK model instance |
| `packages/web/src/lib/tiers.ts` | Tier definitions, allowed models, token limits |
| `packages/web/src/app/api/user/api-keys/provider-models/route.ts` | Native catalog fetch + gateway enrichment |
| `packages/web/src/app/api/gateway-models/route.ts` | Gateway catalog proxy |
| `packages/web/src/app/api/user/api-keys/route.ts` | CRUD keys (multi-key, labels, hints) |
| `packages/web/src/app/api/chat/route.ts` | Chat handler: resolve model, stream, error enrichment |
| `packages/web/src/app/page.tsx` | Chat UI: model selector, PeekBanner, source/keyId tracking |
| `packages/web/src/app/(main)/account/page.tsx` | Account UI: tiers, usage, keys, per-key model selector |
| `packages/web/src/components/PeekBanner.tsx` | Animated retractable error banner |
| `packages/web/src/components/GlassDropdown.tsx` | Portal dropdown with scroll trap |
| `packages/temporal/src/activities/llm-resolver.ts` | Temporal resolver (mirrors web resolver) |
| `supabase/migrations/028_byok_model_and_usage_source.sql` | usage_source + per-key default_model |
| `supabase/migrations/029_multi_key_labels.sql` | Multi-key, labels, key_hint, ID-based RPCs |
| `supabase/migrations/030_get_api_key_by_id.sql` | RPC to fetch secret by key ID (not provider) |
| `supabase/local-only/fix-vault-ownership.sql` | Local Docker vault fix (supabase_admin ownership) |
