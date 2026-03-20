#!/bin/bash
# Replay a pre-recorded orchestration scenario.
#
# Usage:
#   ./scripts/replay-scenario.sh mini-design-system [--dry-run] [--verbose]
#
# The scenario name maps to:
#   scripts/replay-collab-scenario-templates/<name>/
#
# Prerequisites:
#   - .env.local with STORAGE_SUPABASE_SERVICE_ROLE_KEY
#   - Figma plugins connected (use start_collab from Guardian MCP first)
#   - Slow delegation enabled (Account > Developers)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCENARIO_NAME="${1:-}"
shift || true

if [ -z "$SCENARIO_NAME" ]; then
    echo "Usage: ./scripts/replay-scenario.sh <scenario-name> [--dry-run] [--verbose]"
    echo ""
    echo "Available scenarios:"
    for d in "$SCRIPT_DIR/scripts/replay-collab-scenario-templates"/*/; do
        name=$(basename "$d")
        desc=$(python3 -c "import json; print(json.load(open('$d/scenario.json')).get('description',''))" 2>/dev/null || echo "")
        echo "  $name — $desc"
    done
    exit 1
fi

SCENARIO_DIR="$SCRIPT_DIR/scripts/replay-collab-scenario-templates/$SCENARIO_NAME"

if [ ! -d "$SCENARIO_DIR" ]; then
    echo "Error: scenario '$SCENARIO_NAME' not found at $SCENARIO_DIR"
    exit 1
fi

echo "╔════════════════════════════════════════════════════════════╗"
echo "║  Orchestration Replay: $SCENARIO_NAME"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

exec python3 "$SCRIPT_DIR/scripts/replay-engine.py" "$SCENARIO_DIR" "$@"
