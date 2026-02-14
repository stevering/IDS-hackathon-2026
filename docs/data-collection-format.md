# Guardian Dataset Format – v1.0

**Purpose**  
This document describes the canonical JSON format for a future version used by the Guardian web application to store user interactions, analyses, and feedback.  
The goal is to build a high-quality, versioned dataset over time for:

- Debugging and improving the current agent
- Future fine-tuning / LoRA of a specialized Guardian model
- Training a critic / validator agent
- Analyzing recurring drifts and emerging patterns across real usage

The format is designed to be **forward-compatible** (new fields can be added without breaking old data) and **backward-compatible** (old data remains usable with new models).

## Core Principles

- **JSONL** (JSON Lines) for the final exported dataset (one JSON object per line)
- **Flexible JSONB storage** in the database (Supabase / Postgres) during collection
- **Explicit versioning** at two levels: dataset version + prompt version
- **Rich raw data** preserved (MCP inputs, full messages) to allow re-parsing or replay
- **Human feedback** as the most valuable signal (👍 / 👎 + comment)

## Main JSON Structure (per entry)

```json
{
  "dataset_version": "1.0",                     // Global format version – incremented when schema breaks compatibility
  "entry_id": "uuid-or-timestamp",              // Unique identifier (uuid v4 or timestamp+hash)
  "timestamp": "2026-02-14T15:09:00+01:00",     // ISO 8601 with timezone
  "source": "guardian_analysis",                // "guardian_analysis" | "manual_annotation" | "synthetic" later

  "user_info": {
    "user_id": "uuid-or-anonymous",             // Anonymized if needed
    "session_id": "uuid",
    "query_language": "fr"                      // "fr" | "en" – auto-detected
  },

  "messages": [
    {
      "role": "system",
      "content": "... full system prompt used ...",
      "version": "prompt_v1.2"                  // Allows tracking prompt evolution
    },
    {
      "role": "user",
      "content": "Analyse ce composant Button...",
      "attachments": [                          // Extensible array for inputs
        {
          "type": "figma_node",
          "id": "123-456",
          "url": "https://figma.com/...",
          "raw_data": { ... }                   // Full MCP Figma JSON response (props, variants, etc.)
        },
        {
          "type": "code_file",
          "path": "src/components/Button.tsx",
          "content": "... source code string ...",
          "parsed_props": [ ... ]               // Optional: already parsed props array
        }
      ]
    },
    {
      "role": "assistant",
      "content": "... full markdown response ...",
      "structured_output": {                    // Extracted / parsed part – most valuable for training
        "props": [
          {
            "name": "size",
            "type": "string",
            "default": "medium",
            "figma_value": "medium",
            "code_value": null,
            "status": "mismatch"
          }
        ],
        "variants": [ ... ],
        "tokens": [ ... ],
        "issues": [
          {
            "type": "missing_default",
            "severity": "medium",
            "description": "Default manquant en code.",
            "recommendation": "Ajouter default=\"medium\""
          }
        ],
        "verdict": "DRIFT_DETECTED",
        "summary": "Great finding! 1 opportunité détectée."
      },
      "raw_tools_calls": [ ... ]                // Raw MCP tool calls and responses (for replay/debug)
    }
  ],

  "feedback": {
    "type": "up" | "down" | "neutral",         // Required after 👍/👎 UI action
    "comment": "Manque le default sur size" | null,
    "corrected_response": null | { ... }       // Optional: human-corrected assistant content (very high value)
  },

  "metadata": {                                 // Highly extensible bag – add anything later
    "app_version": "guardian_v2.3.1",
    "model_used": "grok-4",
    "mcp_versions": {
      "figma": "1.5.2",
      "code": "1.2.0"
    },
    "duration_ms": 12450,
    "extra_data": {                             // Free-form for future features
      "rag_chunks_used": [ ... ],
      "emerging_patterns_detected": [ ... ]
    }
  }
}
```

## Backward & Forward Compatibility Rules

New fields → Always add them inside existing objects (e.g. in metadata.extra_data, structured_output, or attachments) — old parsers can ignore unknown keys.
Breaking changes → Only when absolutely necessary (very rare): increment dataset_version to "2.0" and write a migration script that transforms old entries (e.g. rename issues → drift_issues).
Multiple versions in the same dataset → When training, filter or normalize by dataset_version. Example:
For v1.0 data: ignore new fields
For v1.1+: use new fields if present, fallback to old logic

Prompt version tracking → The messages[0].version field lets you group data by prompt era → very useful when comparing model behavior before/after prompt improvements.

## Storage & Collection Flow

Real-time → Every analysis + feedback → inserted as JSONB row in Supabase table guardian_entries
Export pipeline (cron job weekly/monthly):
Query all entries
Apply version-specific normalizers (if needed)
Output one big .jsonl file
Commit to private repo guardian-dataset with git tag (e.g. v2026-03-01)

Access control → Anonymize user_id before export if public/open-source

## Future Extensions (planned)

rag_context: array of retrieved chunks (tokens, guidelines…)
emerging_patterns: list of repeated snowflakes detected
user_correction: full corrected JSON when 👎 + manual fix
agent_thinking_trace: full chain-of-thought if we add reflection loops

This format should remain usable for years — even if Guardian switches from Grok to a fine-tuned Llama, or adds Figma-to-Storybook comparison.
Last updated: February 2026
Maintainer: Stéphane Chevreux (@stephaneChevreu)
