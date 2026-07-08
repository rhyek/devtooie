# devtooie

Monorepo for the published `devtooie` npm package.

- `packages/devtooie/` — the package source.
- `example/` — a self-contained example monorepo that consumes the package via
  `devtooie: link:../packages/devtooie` (see `example/package.json`).

`README.md` lives **inside the package** at `packages/devtooie/README.md` (not the repo
root). It's the canonical copy — edit it in place. Keeping it in the package means it's
published to npm and is present when the package is consumed via `pnpm link` locally
(`npm publish` drops symlinks, so a root-level symlink is not an option). Only `LICENSE`
is still copied in from the repo root at release time.

## Documentation — keep in lockstep

Whenever a change affects how devtooie is configured, invoked, or driven — `defineConfig`
options, the package/`run` schema, tokens, CLI flags, or the control API — update the docs
**in the same change**, not later:

- `packages/devtooie/README.md` — the human-facing reference.
- `packages/devtooie/docs/usage-guide.md` — the agent-facing guide (see below).
- `packages/devtooie/assets/skill.md` — the installed skill. It is intentionally just
  frontmatter + auto-expanded `@node_modules/devtooie/README.md` and
  `@node_modules/devtooie/docs/usage-guide.md` references (README first), so put actual
  content in those files, not here. Only a **top-level** skill-body reference auto-expands
  — a reference nested inside one of those docs would not — which is why both live here.

After touching any of that surface, grep `packages/devtooie/README.md` and
`docs/usage-guide.md` for the affected names and reconcile.

### `docs/usage-guide.md` scope

This file is read by an AI agent to **use and interact with** devtooie via the CLI and the
control API. Keep it strictly to that: how to run it headlessly, drive a running session
over the control API, onboard a package, and read logs for debugging. **No internals** —
no source layout, implementation details, or how features are built — and don't describe
past/removed architecture, only the current surface.

## Building

Build with:

```sh
pnpm build
```

The root `build` script delegates to `pnpm --filter devtooie build`, which cleans
`dist/`, compiles with `tsc -p tsconfig.build.json`, and marks the compiled CLI
(`dist/cli.js`) executable. CI (`.github/workflows/pr.yaml` and `release.yaml`)
uses this same command.

## Testing changes in `./example`

After **any** change to `packages/devtooie`, rebuild so the change is picked up
in the example:

```sh
pnpm build
```

Because `example/` links the package directly (`link:../packages/devtooie`), the
freshly built `dist/` is used immediately — no reinstall needed. Then run the
example:

```sh
cd example && pnpm dev   # runs the `devtooie` bin
```
