# Releasing

Publishing is automated in GitHub Actions with npm **trusted publishing** (OIDC).
No npm token is stored anywhere — GitHub Actions authenticates to npm over OIDC, and
[provenance](https://docs.npmjs.com/generating-provenance-statements) is attached
automatically.

## Cutting a release (the recurring flow)

1. Add an entry to the **top** of `CHANGELOG.md`:

   ```md
   ## 0.2.0

   - what changed
   ```

2. Get that onto `main` (merge a PR, or push).

That's it — no `git tag`, no `npm publish`, no local commands. On every push to `main`,
`.github/workflows/release.yaml`:

- reads the top `## X.Y.Z` heading from `CHANGELOG.md`,
- **skips** if a GitHub release for that version already exists (so re-runs and
  changelog-less pushes are no-ops),
- otherwise sets the package version, builds, creates the GitHub release, and runs
  `npm publish --provenance` — tokenless, via OIDC.

## One-time setup for a brand-new package

npm won't let you configure a trusted publisher until the package exists, so the very
first version is published once by hand; trusted publishing takes over after that. No
shared secrets or GitHub Apps are needed — only a per-package trusted-publisher entry
on npm.

1. **First publish (local, once):**

   ```sh
   pnpm build
   cp LICENSE packages/<pkg>/LICENSE
   cd packages/<pkg>
   npm version <first-version> --no-git-tag-version   # temporary, do not commit
   npm login                                          # if not already logged in
   npm publish --access public                        # no provenance on this first one
   cd ../.. && git checkout packages/<pkg>/package.json  # keep the repo version at 0.0.0
   ```

2. **Configure the trusted publisher** on npmjs.com → the package → **Settings → Trusted
   Publisher → GitHub Actions**:
   - Organization or user: `rhyek`
   - Repository: the repo name
   - Workflow filename: `release.yaml`
   - Environment: _(leave blank)_

3. **Mark that first version as already released** so CI never tries to republish it:

   ```sh
   gh release create <first-version> --title <first-version> \
     --notes-file <(./scripts/change-log-entry.sh) --target main
   ```

From the next version on, the recurring flow above publishes tokenlessly with provenance.
