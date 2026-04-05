#!/bin/bash
# Launch the full dev stack.
# - Terminal: colored output
# - logs/dev.log: clean text (ANSI codes stripped)

set -e

mkdir -p logs
: > logs/dev.log

# Check that Supabase local is running
if ! npx supabase status > /dev/null 2>&1; then
  echo ""
  echo "⚠  Supabase local is not running."
  echo ""
  read -rp "   Start it now? (Y/n) " answer
  if [[ "$answer" =~ ^[Nn] ]]; then
    echo "   Skipping. Run 'pnpm dev:supabase' to start it manually."
    echo "   To stop it later: 'pnpm dev:supabase:stop'"
  else
    echo "   Starting Supabase local..."
    npx supabase start
    echo "   Supabase is running in background. To stop it: 'pnpm dev:supabase:stop'"
    echo ""
  fi
fi

# Check that port 7233 (Temporal gRPC) is free before concurrently tries to bind it.
# A zombie `temporal server start-dev` from a previous session will silently prevent
# the new server from starting, and the worker will then fail to connect.
if lsof -iTCP:7233 -sTCP:LISTEN -t > /dev/null 2>&1; then
  stale_pid=$(lsof -iTCP:7233 -sTCP:LISTEN -t | head -n 1)
  stale_name=$(ps -p "$stale_pid" -o comm= 2>/dev/null | tr -d ' ')
  echo ""
  echo "⚠  Port 7233 is already in use by PID $stale_pid ($stale_name)."
  if [[ "$stale_name" == *temporal* ]]; then
    echo "   Looks like a Temporal server zombie from a previous session."
    read -rp "   Kill it and continue? (Y/n) " answer
    if [[ "$answer" =~ ^[Nn] ]]; then
      echo "   Aborting. Run 'kill $stale_pid' manually, then retry."
      exit 1
    fi
    kill "$stale_pid" 2>/dev/null || true
    sleep 1
    if lsof -iTCP:7233 -sTCP:LISTEN -t > /dev/null 2>&1; then
      echo "   Still running — force killing..."
      kill -9 "$stale_pid" 2>/dev/null || true
      sleep 0.5
    fi
    echo "   Port 7233 freed."
    echo ""
  else
    echo "   This is NOT a Temporal process. Free the port manually before running 'pnpm dev'."
    echo "   Investigate: lsof -iTCP:7233 -sTCP:LISTEN"
    exit 1
  fi
fi

export FORCE_COLOR=1

TURBO_FILTERS="\
    --filter=@guardian/web \
    --filter=@guardian/mcp-server \
    --filter=@guardian/figma-plugin \
    --filter=@guardian/figma-desktop-plugin \
    --filter=@guardian/figma-widget \
    --filter=@guardian/bridge \
    --filter=@guardian/electron-overlay \
    --filter=@guardian/temporal"

concurrently -k -n srv,apps -c yellow,cyan \
  "temporal server start-dev" \
  "FORCE_COLOR=1 turbo run dev $TURBO_FILTERS" \
  2>&1 | node -e "
const fs = require('fs');
const out = fs.createWriteStream('logs/dev.log');
const strip = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { process.stdout.write(d); out.write(strip(d)); });
process.stdin.on('end', () => out.end());
process.on('SIGINT', () => { out.end(); process.exit(); });
"
