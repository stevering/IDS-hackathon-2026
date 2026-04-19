#!/bin/bash
# Pre-push check: scan the diff about to be pushed for leaked secrets / PII / internal IDs
# via the Claude CLI. Interactive: on findings, prompts the user via /dev/tty to allow or abort.
#
# Exit codes:
#   0 = no leaks (or user chose to push anyway)
#   1 = user aborted
#
# Opt-out: set SKIP_LEAK_SCAN=1 or create .leak-scan-skip in repo root for a one-shot bypass.

set -u

REPO_ROOT="$(git rev-parse --show-toplevel)"
remote="${1:-origin}"

if [ "${SKIP_LEAK_SCAN:-}" = "1" ]; then
  echo "⏭  Leak scan skipped (SKIP_LEAK_SCAN=1)."
  exit 0
fi

if [ -f "$REPO_ROOT/.leak-scan-skip" ]; then
  rm -f "$REPO_ROOT/.leak-scan-skip"
  echo "⏭  Leak scan skipped (one-shot .leak-scan-skip consumed)."
  exit 0
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "⚠️  claude CLI not found in PATH — skipping leak scan."
  exit 0
fi

# Determine diff range: compare HEAD against the upstream tracking branch.
tracking=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
if [ -z "$tracking" ]; then
  tracking="$remote/main"
fi

# Ignore lockfiles, minified files, binaries, generated dirs.
changed_files=$(git diff --name-only "$tracking"...HEAD 2>/dev/null \
  | grep -vE '(^|/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|\.min\.js|\.map|\.ico|\.png|\.jpg|\.jpeg|\.pdf|\.woff2?|\.ttf|dist/|\.next/|node_modules/)' \
  || true)

if [ -z "$changed_files" ]; then
  exit 0
fi

file_count=$(echo "$changed_files" | wc -l | tr -d ' ')
echo "🔍 Claude leak scan on ${file_count} file(s) vs ${tracking}..."

# Extract the diff, cap at 120KB to keep the prompt manageable.
diff_content=$(echo "$changed_files" | xargs -I{} git diff "$tracking"...HEAD -- {} 2>/dev/null || true)
diff_size=${#diff_content}
MAX_DIFF=120000
if [ "$diff_size" -gt "$MAX_DIFF" ]; then
  diff_content="${diff_content:0:$MAX_DIFF}

[... TRUNCATED: original diff was ${diff_size} bytes, showing first ${MAX_DIFF}]"
fi

if [ -z "$diff_content" ]; then
  exit 0
fi

prompt='You are a security reviewer. Analyze the git diff below for leaks of sensitive data about to be pushed to a remote repository.

FLAG these categories only:
- Hardcoded secrets: API keys, bearer tokens, passwords, JWT strings, private keys (PEM), service-role keys, connection strings with embedded credentials.
- Internal IDs appearing in application code (not fixtures, not migrations, not docs): user UUIDs, internal resource IDs, account IDs that look real.
- Real personal data: real emails / real names of users outside of obvious test fixtures.
- Internal URLs / hostnames / service endpoints not meant to be public.
- Raw .env file contents or credentials added to config files.

DO NOT FLAG:
- Placeholders: example.com, localhost, 127.0.0.1, XXX, foo@bar.com, test@test, <your-key-here>, process.env lookups.
- Public Supabase anon keys on NEXT_PUBLIC_ env vars (they are intended to be public).
- The Supabase project id "ookghxkvzdnqicjdslej" — already public in CLAUDE.md.
- Test fixtures with obviously fake data.
- Code style, bugs, architecture — scope is LEAKS ONLY.

Output format — no markdown, no preamble, no trailing explanation:
- If nothing to flag, output EXACTLY: NO_LEAKS
- Otherwise, one line per finding:
  FINDING|<CRITICAL|HIGH|MEDIUM|LOW>|<file path>|<what leaked, one short sentence>|<fix suggestion, one short sentence>

Diff to analyze:
'

response=$(printf '%s\n%s\n' "$prompt" "$diff_content" \
  | claude -p --bare --model sonnet --output-format text 2>/dev/null || true)

if [ -z "$response" ]; then
  echo "⚠️  Leak scan: empty response from claude — skipping (network or auth issue?)."
  exit 0
fi

cleaned=$(echo "$response" | tr -d '[:space:]')
if [ "$cleaned" = "NO_LEAKS" ]; then
  echo "✓ No leaks detected."
  exit 0
fi

findings=$(echo "$response" | grep '^FINDING|' || true)
if [ -z "$findings" ]; then
  # Claude answered something unparseable — show it and ask the user.
  echo ""
  echo "⚠️  Leak scan returned an unparseable response:"
  echo "---"
  echo "$response"
  echo "---"
else
  echo ""
  echo "⚠️  Potential leaks detected:"
  echo ""
  echo "$findings" | while IFS='|' read -r _ sev file what suggestion; do
    echo "  [$sev] $file"
    echo "    $what"
    echo "    → $suggestion"
    echo ""
  done
fi

# Interactive prompt. Needs a TTY; if absent, block by default.
if [ ! -e /dev/tty ]; then
  echo "⛔ No TTY available — cannot confirm interactively. Aborting push."
  echo "   Bypass once: touch .leak-scan-skip && git push"
  exit 1
fi

while true; do
  printf "Push anyway? [y]es / [N]o / [r]aw response: "
  IFS= read -r answer < /dev/tty || answer="n"
  lower=$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')
  case "$lower" in
    y|yes)
      echo "→ Push allowed by user despite findings."
      exit 0
      ;;
    ""|n|no)
      echo "⛔ Push aborted. Fix the leaks (or bypass once: touch .leak-scan-skip)."
      exit 1
      ;;
    r|raw)
      echo "---"
      echo "$response"
      echo "---"
      ;;
    *)
      echo "Please answer y, n, or r."
      ;;
  esac
done
