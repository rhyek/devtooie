# devtooie

Monorepo for the published `devtooie` npm package.

- `packages/devtooie/` — the package source.
- `example/` — a self-contained example monorepo that consumes the package via
  `devtooie: link:../packages/devtooie` (see `example/package.json`).

`README.md` is the **repo-root** file — edit it there; it's the canonical copy. It lives at
the root (not inside the package) so its relative `docs/*.md` links resolve when the README is
viewed from the repo root on GitHub. The human-facing topic docs live at repo-root `docs/`;
only `docs/agents.md` (the consolidated agent guide the installed skill loads) lives inside
the package, at `packages/devtooie/docs/agents.md`. At release time `release.yaml` copies the
root `README.md` into `packages/devtooie/` (like `LICENSE`), rewriting its relative doc links
to version-pinned absolute URLs so the npm page works. Because the skill loads `agents.md`
(not the README), the README no longer needs a live in-package copy for `pnpm link` consumers.

## Documentation — keep in lockstep

Whenever a change affects how devtooie is configured, invoked, or driven — `defineConfig`
options, the package schema, tokens, CLI flags, or the control API — update **all** the docs
in the same change, not later. The human-facing docs are split by topic; the agent-facing
doc is a single consolidated file that **duplicates** their content, so it is the easiest to
leave stale — treat keeping it current as mandatory.

Human-facing:

- `README.md` (repo root) — the slim landing page (overview, install, getting started,
  config example, running, supporting scripts, environment loading, agent skill). It links
  out to the topic docs for the deep reference using **relative** `docs/*.md` paths — keep
  them relative in source. npmjs.com renders only the README and rewrites relative links
  against the repo **root** (ignoring `repository.directory`), which would 404 for this
  monorepo package — so `release.yaml` rewrites them to version-pinned absolute GitHub URLs at
  publish time (runner checkout only; the commit stays relative). Don't "fix" these to
  absolute in source. (Relative links between the `docs/*.md` files themselves need no
  rewrite — npm never renders those.)
- `docs/configuration.md` — full `defineConfig` / package-field reference
  (fields, dependencies, TypeScript project references, typed package names).
- `docs/package-lifecycle.md` — how `command` flags decide
  restart-vs-rebuild after a code edit.
- `docs/cli.md` — every CLI flag and subcommand, plus `devtooie env`.
- `docs/control-api.md` — the localhost HTTP control-API reference.

Agent-facing:

- `packages/devtooie/docs/agents.md` — a single, self-contained guide for coding agents. It
  **consolidates all of the above** (README + every topic doc) plus the agent-only
  operational material (driving devtooie headlessly, reading logs, onboarding). **Any user-
  or agent-facing change to the README or a topic doc must be mirrored here in the same
  change** — it is the file the installed skill loads, and it must never fall behind.
- `packages/devtooie/assets/skill.md` — the installed skill. It is intentionally just
  frontmatter + a single auto-expanded `@node_modules/devtooie/docs/agents.md` reference, so
  put actual content in `agents.md`, not here. Only a **top-level** skill-body reference
  auto-expands — a reference nested inside `agents.md` would not (and globs/directories
  aren't supported), which is why the skill points at the one consolidated file.

After touching any of that surface, grep the README and `docs/` for the affected names and
reconcile every copy, `agents.md` included.

### `docs/agents.md` scope

This file is read by an AI agent to **use and interact with** devtooie. It is the single
source the skill loads, so it must be self-contained: the full configuration/CLI/control-API
reference **and** how to run devtooie headlessly, drive a running session, onboard a package,
and read logs for debugging. **No internals** — no source layout, implementation details, or
how features are built — and don't describe past/removed architecture, only the current surface.

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

## Terminal UI rendering (internals)

The interactive TUI is a **fullscreen alternate-screen app**: Ink owns the whole
viewport, a **virtualized `LogPane`** renders only the log rows that fit the
screen (from a subscribable `ProcessManager` buffer), and the footer is pinned to
the bottom by flex layout. Mouse-wheel + keyboard scrolling replace the terminal's
native scrollback. Before changing anything about the log viewport, scrolling, the
footer, or how output reaches the screen, read
[`docs/architecture/rendering.md`](docs/architecture/rendering.md) — it documents
the virtualization (`log-window.ts`/`scroll.ts`), the buffer subscription, and the
mouse handling (`mouse.ts`). (Internal contributor doc — not part of the
user-facing docs or `agents.md`.)
