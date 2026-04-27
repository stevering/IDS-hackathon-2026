# Changesets

This folder is used by [Changesets](https://github.com/changesets/changesets) to track release notes and version bumps for the monorepo packages.

## Workflow

1. After making a change to one or more packages, run:
   ```bash
   pnpm changeset
   ```
   The CLI asks which packages changed, the bump level (patch / minor / major), and a description. It writes a markdown file in this folder.

2. Commit the generated `.changeset/<name>.md` along with your code changes.

3. When the PR is merged into `main`, the GitHub Action opens (or updates) a "Version Packages" PR that bundles every pending changeset, bumps versions, regenerates `CHANGELOG.md`, and syncs `chrome-extension/manifest.json`.

4. Merging that "Version Packages" PR is the release.

## Linked groups

Packages in a linked group always share the same version. Bumping one bumps all of them.

- `@guardian/figma-plugin` ↔ `@guardian/figma-widget` ↔ `@guardian/bridge` — share the bridge code.
- `@guardian/orchestrations` ↔ `@guardian/temporal` — the Temporal worker depends on the engine.

## Migration note

The `repo` field in `config.json` points to `stevering/IDS-hackathon-2026`. When the repository moves to its dedicated `guardian` home, update that field so changelog links keep working.
