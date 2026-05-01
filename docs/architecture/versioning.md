# Versioning & releases

The monorepo uses [Changesets](https://github.com/changesets/changesets) to manage per-package versioning, changelog generation, and store-manifest synchronisation.

## Strategy

Per-package SemVer with two **linked** groups (packages that always share the same version):

| Group | Packages | Reason |
|---|---|---|
| Figma surface | `@guardian/figma-plugin`, `@guardian/figma-widget`, `@guardian/bridge` | Share the bridge code; a change in one usually requires a coordinated release of the others. |
| Temporal pipeline | `@guardian/orchestrations`, `@guardian/temporal` | The worker (`temporal`) embeds the engine (`orchestrations`); a mismatched pair fails at runtime. |

All other packages (`web`, `chrome-extension`, `electron-overlay`, `mcp-server`, `figma-desktop-plugin`, `figma-desktop-plugin-beta`, `design-system-sample`) are independently versioned.

Every package is `private: true` for now. `privatePackages: { version: true, tag: true }` in `.changeset/config.json` makes Changesets version private packages anyway. No npm publish happens — we only track versions internally and on store manifests.

## Daily workflow

1. **Author a change** on a feature branch.
2. **Record the change** before opening the PR:
   ```bash
   pnpm changeset
   ```
   The CLI asks which packages changed, the bump level (`patch` / `minor` / `major`), and a short description. It writes a markdown file in `.changeset/`.
3. **Commit and push** the generated `.changeset/<name>.md` together with your code changes.
4. **PR review and merge** to `main` as usual.
5. **Release PR**: the GitHub Action `Release` (`.github/workflows/release.yml`) opens (or updates) a PR titled `chore(release): version packages` that:
   - bumps versions in every affected `package.json`,
   - writes / appends `CHANGELOG.md` in each package,
   - syncs `chrome-extension/manifest.json` via `scripts/sync-manifests.mjs`,
   - refreshes `pnpm-lock.yaml`.
6. **Review and merge the release PR** when you decide to ship. That merge is the release.

The release PR is fully reviewable — you can edit changelog entries, drop noisy lines, or rewrite the wording before merging.

## Tagging store releases

Merging the release PR does not automatically push to Figma Community or the Chrome Web Store. After the merge:

- For the Chrome extension, the manifest version has already been synced by the post-version script. Build and upload to the Web Store.
- For Figma plugins / widget, the manifest does not carry a version field. Use git tags (e.g. `figma-plugin@1.4.0`) so the published artefact can be traced back to a commit.

## CI gate

`.github/workflows/check-changeset.yml` runs on every PR to `main` and fails if `pnpm changeset:status` reports no pending changeset. To intentionally bypass the gate (typo fixes, doc-only changes), commit an empty changeset:

```bash
pnpm changeset --empty
```

## Interaction with the Vercel deploy pipeline

Vercel and the Changesets GitHub Actions react to the same git events but do orthogonal work — Vercel deploys, GitHub Actions tracks releases. They never write to the same surface.

| Trigger | Vercel | GHA `release.yml` | GHA `check-changeset.yml` |
|---|---|---|---|
| Push on a feature branch | Builds a preview | — | — |
| PR opened against `main` | Builds a preview for the PR | — | Validates a changeset exists |
| Push on `main` (feature merge) | Deploys to production | Opens / updates the "Version Packages" PR | — |
| The "Version Packages" PR itself | Builds a preview (useful to validate the bumped versions) | — | Passes (the PR consumes pending changesets) |
| Merge of the release PR into `main` | Deploys to production with bumped versions | Re-runs, finds 0 pending changesets, exits clean | — |

No infinite loop is possible: `changesets/action` never pushes directly to `main`, it always opens a PR that a human merges.

### Caveats worth knowing

- **Vercel will preview-build the "Version Packages" PR.** That is intentional — it lets you smoke-test the build with the bumped versions before merging — but it consumes Vercel build minutes. Do **not** add `[skip ci]` to the release commit message: when the release PR is merged, you want Vercel to rebuild production with the new versions.
- **`concurrency` block** in `release.yml` (`${{ github.workflow }}-${{ github.ref }}`) prevents two release runs from overlapping if you push to `main` rapidly.
- **Store publication is still manual.** The post-version script syncs `chrome-extension/manifest.json`, but uploading the `.zip` to the Chrome Web Store and submitting the Figma plugin / widget to Community remain operator steps.
- **Branch protection on `main`.** If you later require status checks before merging into `main`, make sure both `Release` and `Check changeset` are listed. The `changesets/action` itself does not need to bypass any rule because it operates through PRs, not direct pushes.

## Files

| Path | Purpose |
|---|---|
| `.changeset/config.json` | Linked groups, base branch, GitHub changelog renderer, private-package handling. |
| `.changeset/README.md` | Quick reference for contributors. |
| `scripts/sync-manifests.mjs` | Post-version hook: copies `package.json` versions into store manifests that carry a `version` field (currently only `chrome-extension`). |
| `.github/workflows/release.yml` | Maintains the "Version Packages" PR on `main`. |
| `.github/workflows/check-changeset.yml` | Blocks PRs that forgot to add a changeset. |

## Migration to a dedicated repository

Real releases are **not** run from `stevering/IDS-hackathon-2026` (the hackathon repo). The Changesets pipeline is configured and ready, but the first actual release will happen once the project moves to its dedicated `figdesys/guardian` repository.

When the migration happens:

1. **Update `.changeset/config.json`**: change the `changelog` repo field from `stevering/IDS-hackathon-2026` to the new owner/repo (e.g. `figdesys/guardian`) so changelog entries link to the right PRs and authors.
2. **Update release branch references** in `.github/workflows/release.yml` and `check-changeset.yml` if the default branch differs from `main`.
3. **Activate GitHub Actions permissions** on the new repo: **Settings → Actions → General → Workflow permissions** = `Read and write` + check `Allow GitHub Actions to create and approve pull requests`. Without this, the `Release` workflow runs but fails to push the "Version Packages" PR with a `403` from the GitHub API. The `GITHUB_TOKEN` secret is automatic — no extra secret to create.
4. **Existing `CHANGELOG.md` files** are unaffected: they hold absolute links that GitHub's repo-rename mechanism will redirect.
