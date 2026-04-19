# Git hooks

Versioned hooks live in `scripts/git-hooks/` and are activated per clone via:

```bash
git config core.hooksPath scripts/git-hooks
```

Run this once after cloning the repo. It is already set on the maintainer's clone.

## `pre-push`

Chain of two checks, in order:

### 1. Leak scan (all branches) — `checks/leak-scan.sh`

Sends the diff between `HEAD` and the upstream tracking branch to the `claude` CLI
(`claude -p --bare --model sonnet`) with a prompt focused on leak detection:

- Hardcoded secrets (API keys, tokens, JWTs, private keys, connection strings with creds)
- Internal IDs hardcoded in app code (user UUIDs, real account IDs)
- Real personal data (real emails / names outside test fixtures)
- Internal URLs / endpoints
- `.env` contents in config

It explicitly **does not** flag placeholders, `NEXT_PUBLIC_` anon keys, the public
Supabase project id, or test fixtures.

**Output**: either `NO_LEAKS` (hook exits 0) or one `FINDING|<SEV>|<file>|<what>|<fix>`
line per issue. On findings, the script prompts on `/dev/tty`:

- `y` → push anyway (user judgement, logged in terminal output)
- `n` / Enter → abort push
- `r` → show raw model response

**Bypass**:
- `SKIP_LEAK_SCAN=1 git push` — skip for this invocation
- `touch .leak-scan-skip && git push` — one-shot bypass (file is auto-deleted after use)
- Missing `claude` CLI or empty model response → scan is skipped with a warning, push proceeds

**Lockfiles / binaries / `dist/` / `node_modules/` / `.next/`** are filtered from the diff.
The diff is capped at 120 KB before being sent to the model.

### 2. Migration check (deploy branches only) — via `scripts/check-migrations.sh`

Runs only on `feat/preview`, `main`, `master`. Verifies that every `supabase/migrations/*.sql`
in the push has already been applied to the cloud Supabase project. Bypass once with
`touch .migration-applied && git push` (see the inline help in `scripts/git-hooks/pre-push`).
