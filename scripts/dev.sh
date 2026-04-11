#!/bin/bash
# Launch the full dev stack.
# - Terminal: colored output
# - logs/dev.log: clean text (ANSI codes stripped)
#
# Usage:
#   bash scripts/dev.sh              # default: @guardian/web runs via `next dev`
#                                    # (watch mode, React dev-mode overhead)
#
#   bash scripts/dev.sh --web-prod   # @guardian/web is built with `next build`
#                                    # and served with `next start` (production
#                                    # mode). Everything else in the stack
#                                    # (Temporal server, Temporal worker, MCP
#                                    # server, Figma plugins, bridge, overlay)
#                                    # still runs in dev/watch mode.
#                                    #
#                                    # Useful for perf testing — dev mode adds
#                                    # heavy overhead (jsxDEV stack capture,
#                                    # createTask instrumentation, double-render
#                                    # under StrictMode) that masks real
#                                    # bottlenecks in profiles. Prod mode strips
#                                    # all of it.
#                                    #
#                                    # The build step takes ~30-60s on a cold
#                                    # run. Subsequent rebuilds are incremental
#                                    # and much faster. HMR on @guardian/web is
#                                    # NOT available in this mode — you have to
#                                    # restart the script to pick up code changes.

set -e

# ── Parse flags ─────────────────────────────────────────────────────────
WEB_PROD=0
for arg in "$@"; do
  case "$arg" in
    --web-prod|-p)
      WEB_PROD=1
      ;;
    --help|-h)
      # Print the leading comment block as usage help
      sed -n '2,28p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Run 'bash scripts/dev.sh --help' for usage." >&2
      exit 1
      ;;
  esac
done

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

# ── Web prod mode: check port 3000 + build ─────────────────────────────
# In --web-prod mode we run `next start` which binds port 3000 directly
# (not under turbo's orchestration), so we need the port free before
# anything else. We also build the web package now, synchronously, so
# that when `next start` is kicked off inside concurrently it finds the
# .next directory ready.
if [[ "$WEB_PROD" == "1" ]]; then
  if lsof -iTCP:3000 -sTCP:LISTEN -t > /dev/null 2>&1; then
    stale_pid=$(lsof -iTCP:3000 -sTCP:LISTEN -t | head -n 1)
    stale_name=$(ps -p "$stale_pid" -o comm= 2>/dev/null | tr -d ' ')
    echo ""
    echo "⚠  Port 3000 is already in use by PID $stale_pid ($stale_name)."
    echo "   Free it before running --web-prod."
    echo "   Investigate: lsof -iTCP:3000 -sTCP:LISTEN"
    exit 1
  fi
  echo ""
  echo "🔨 Building @guardian/web in production mode..."
  echo "   (first build ~30-60s; subsequent incremental builds are faster)"
  pnpm --filter @guardian/web build
  echo "✓ Web prod build complete."
  echo ""
fi

export FORCE_COLOR=1

# ── Build the turbo filter list ─────────────────────────────────────────
# In --web-prod mode we EXCLUDE @guardian/web from turbo so it doesn't
# race with `next start`. The web package is served separately via an
# extra concurrently command below.
TURBO_FILTERS="\
    --filter=@guardian/mcp-server \
    --filter=@guardian/figma-plugin \
    --filter=@guardian/figma-desktop-plugin \
    --filter=@guardian/figma-widget \
    --filter=@guardian/bridge \
    --filter=@guardian/electron-overlay \
    --filter=@guardian/temporal"

if [[ "$WEB_PROD" != "1" ]]; then
  TURBO_FILTERS="--filter=@guardian/web $TURBO_FILTERS"
fi

# ── Assemble the concurrently command ──────────────────────────────────
# Default: temporal server + turbo run dev (with or without web).
# --web-prod mode: adds a third command that runs `next start` against
# the build we just produced.
CMDS=(
  "temporal server start-dev"
  "FORCE_COLOR=1 turbo run dev $TURBO_FILTERS"
)
NAMES="srv,apps"
COLORS="yellow,cyan"

if [[ "$WEB_PROD" == "1" ]]; then
  CMDS+=("pnpm --filter @guardian/web start")
  NAMES="$NAMES,web"
  COLORS="$COLORS,green"
fi

concurrently -k -n "$NAMES" -c "$COLORS" "${CMDS[@]}" 2>&1 | node -e "
const fs = require('fs');
const out = fs.createWriteStream('logs/dev.log');
const strip = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { process.stdout.write(d); out.write(strip(d)); });
process.stdin.on('end', () => out.end());
process.on('SIGINT', () => { out.end(); process.exit(); });
"
