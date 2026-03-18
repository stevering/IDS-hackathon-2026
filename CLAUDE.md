# DS AI Guardian Project Instructions

When you have to write code in the monorepo or show a snippet of code, you must do it in full English language (comments, code).

In any AI chat, discuss in the user language, based on the user messages, ignoring snippets of code or logs (probably in English).

## Dev environment

- `pnpm dev` logs are written live to `logs/dev.log` at project root. Always check this file to verify server restarts, hot reloads, or errors — don't ask the user to paste terminal output.
- The Temporal worker (`@guardian/temporal`) bundles workflows via webpack at startup. Changes in `packages/orchestrations/src/` trigger an auto-restart thanks to `--watch-path` in the dev script.

If you need a temprary directory for operations, create one here in the project root, in `tmp/`.