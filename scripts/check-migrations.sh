#!/bin/bash
# Check if local migration files have been applied to cloud Supabase.
# Queries supabase_migrations.schema_migrations via `supabase db query --linked`.
# Requires: `npx supabase login` + `npx supabase link` (one-time setup).
#
# Usage: ./scripts/check-migrations.sh file1.sql [file2.sql ...]
# Exit 0 = all applied. Exit 1 = some missing (prints them to stdout).
set -euo pipefail

if [ $# -eq 0 ]; then
  exit 0
fi

# Build SQL IN clause from filenames (strip path + .sql)
names=()
for f in "$@"; do
  names+=("'$(basename "$f" .sql)'")
done
in_clause=$(IFS=,; echo "${names[*]}")

# Query cloud
result=$(npx --yes supabase@latest db query \
  "SELECT name FROM supabase_migrations.schema_migrations WHERE name IN ($in_clause)" \
  --linked -o json 2>/dev/null) || {
  echo "QUERY_FAILED"
  exit 1
}

# Check each migration
missing=()
for f in "$@"; do
  base=$(basename "$f" .sql)
  if ! echo "$result" | grep -q "\"$base\""; then
    missing+=("$f")
  fi
done

if [ ${#missing[@]} -eq 0 ]; then
  exit 0
else
  for f in "${missing[@]}"; do
    echo "$f"
  done
  exit 1
fi