#!/bin/bash
# Launch the dev stack in preview mode (lean).
#
# What runs:
#   - Figma plugin + desktop-plugin + widget (watch, iframe → preview.guardian.figdesys.com)
#   - bridge (shared types, tsc watch)
#
# What does NOT run (served by cloud):
#   - @guardian/web (webapp is on preview.guardian.figdesys.com)
#   - @guardian/mcp-server (MCP is on Vercel)
#   - @guardian/temporal (worker runs on Railway)
#   - @guardian/electron-overlay (not needed for preview testing)
#   - Temporal dev server (using Temporal Cloud)
#   - Supabase local (using Supabase Cloud)
#
# Env loading:
#   1. .env.local — local defaults (Figma keys, etc.)
#   2. .env.preview — overrides cloud vars (Temporal Cloud, Supabase Cloud)
#   3. GUARDIAN_URL forced to preview

set -e

# 1. Load local defaults
if [ -f .env.local ]; then
  set -a
  source .env.local
  set +a
fi

# 2. Override with preview/cloud values
if [ -f .env.preview ]; then
  set -a
  source .env.preview
  set +a
fi

# 3. Preview-specific
export GUARDIAN_URL="${GUARDIAN_URL:-https://preview.guardian.figdesys.com}"
export FORCE_COLOR=1

mkdir -p logs
: > logs/dev.log

TURBO_FILTERS="\
    --filter=@guardian/figma-plugin \
    --filter=@guardian/figma-desktop-plugin \
    --filter=@guardian/figma-widget \
    --filter=@guardian/bridge"

echo "☁  Preview mode (plugin build only — worker runs on Railway)"
echo "   Plugin URL:  $GUARDIAN_URL"
echo ""

FORCE_COLOR=1 turbo run dev $TURBO_FILTERS \
  2>&1 | node -e "
const fs = require('fs');
const out = fs.createWriteStream('logs/dev.log');
const strip = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { process.stdout.write(d); out.write(strip(d)); });
process.stdin.on('end', () => out.end());
process.on('SIGINT', () => { out.end(); process.exit(); });
"
