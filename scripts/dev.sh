#!/bin/bash
# Launch the full dev stack.
# - Terminal: colored output
# - logs/dev.log: clean text (ANSI codes stripped)

set -e

mkdir -p logs
: > logs/dev.log

export FORCE_COLOR=1

concurrently -k -n srv,apps -c yellow,cyan \
  "temporal server start-dev" \
  "FORCE_COLOR=1 turbo run dev \
    --filter=@guardian/web \
    --filter=@guardian/mcp-server \
    --filter=@guardian/figma-plugin \
    --filter=@guardian/figma-desktop-plugin \
    --filter=@guardian/figma-widget \
    --filter=@guardian/bridge \
    --filter=@guardian/electron-overlay \
    --filter=@guardian/temporal" \
  2>&1 | node -e "
const fs = require('fs');
const out = fs.createWriteStream('logs/dev.log');
const strip = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { process.stdout.write(d); out.write(strip(d)); });
process.stdin.on('end', () => out.end());
process.on('SIGINT', () => { out.end(); process.exit(); });
"
