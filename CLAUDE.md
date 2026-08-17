# devtooie

Monorepo for the published `devtooie` npm package.

- `packages/devtooie/` — the package source.
- `example/` — a self-contained example monorepo that consumes the package via
  `devtooie: link:../packages/devtooie` (see `example/package.json`).

## NEVER commit personal content — hard rule

This is a **public** repository. Do not put any of the user's personal material into the code,
docs, tests, comments, commit messages, or example/fixture data — **ever**. That includes:

- Personal conversations or message content (texts, DMs, chat/dating-app messages), from any
  source or any language.
- Real names of people, contacts, or private projects; personal locations, travel plans, or
  any other private details lifted from the user's life or communications.

When you need sample data — example log lines, fixtures, test inputs, doc snippets — **invent
neutral, obviously-synthetic technical content** (generic service names, `SELECT` queries,
`foo`/`bar`, placeholder users like `web`/`api`). Never reach for something real the user
happened to mention. If you're unsure whether a value is personal, treat it as personal and
use a neutral placeholder instead. When in doubt, ask before committing.

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
  config example, running, supporting scripts, logging, environment loading, agent skill). It links
  out to the topic docs for the deep reference using **relative** `docs/*.md` paths — keep
  them relative in source. npmjs.com renders only the README and rewrites relative links
  against the repo **root** (ignoring `repository.directory`), which would 404 for this
  monorepo package — so `release.yaml` rewrites them to version-pinned absolute GitHub URLs at
  publish time (runner checkout only; the commit stays relative). Don't "fix" these to
  absolute in source. (Relative links between the `docs/*.md` files themselves need no
  rewrite — npm never renders those.)
- `docs/configuration.md` — full `defineConfig` / package-field reference
  (fields, dependencies, TypeScript project references, typed package names). Links out to
  `docs/logging.md` for the `logs` option.
- `docs/logging.md` — timestamps and structured-log (JSON) formatting: the top-level and
  per-package `logs` options, the default formatter, the `logging` helpers, writing your own.
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
  frontmatter + an instruction to Read `node_modules/devtooie/docs/agents.md`, so put actual
  content in `agents.md`, not here. The path is deliberately **not** an `@` reference: `@`
  force-loads the whole guide on invocation, which defeats the progressive disclosure a skill
  exists to provide — the agent should read it when it decides to act, not before.
  - **Frontmatter must start on line 1.** `renderSkill` stamps the managed banner as a YAML
    comment *inside* the frontmatter for exactly this reason. A banner above the `---` means
    the block is never parsed as frontmatter, and the skill's `description` — the only basis
    on which it is ever invoked — is lost, silently. `skill.spec.ts` guards this; don't move
    the banner.

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

## Type-level tests — assert types, not "some error"

`defineConfig`'s inference (per-package `tokens`, the package-name union, the callback `port`)
is asserted in `packages/devtooie/src/config.test-d.ts` with vitest's `expectTypeOf`
(`expect-type`, already a vitest dependency — nothing to install):

```sh
pnpm test:types      # vitest --typecheck.only --run
```

**`expectTypeOf` is a no-op without `--typecheck`** — it compiles and "passes" under plain
`pnpm test`, which is why the assertions live in `*.test-d.ts` and get their own script and CI
step. `vitest.config.ts` points `typecheck.tsconfig` at `packages/devtooie/tsconfig.typecheck.json`,
which is the normal tsconfig minus three spec files that already fail typecheck on main — so a
real type error anywhere else still fails the run rather than being blanket-ignored.

Prefer these over `@ts-expect-error`. A `@ts-expect-error` passes when the line errors for *any*
reason, which has already hidden a bug here: an assertion meant to prove a token typo was
rejected was really only passing because the value was `string | undefined`. Assert the type
instead — `expectTypeOf(ctx.port).toEqualTypeOf<number>()`, or
`expectTypeOf(ctx.tokens).not.toHaveProperty('region')`. Keep `@ts-expect-error` only for
things that are genuinely "this must not compile" (an unknown field, a bad `waitFor` name), and
when you write one, confirm it fails for the intended reason.

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
native scrollback, and text selection is **app-managed** (SGR mouse reporting +
drag-to-copy) since native selection can't survive Ink's in-place repaints. Before
changing anything about the log viewport, scrolling, the footer, selection, or how
output reaches the screen, read
[`docs/architecture/rendering.md`](docs/architecture/rendering.md) — it documents
the virtualization (`log-window.ts`/`scroll.ts`), the buffer subscription, and the
mouse/selection/clipboard handling (`mouse.ts`/`selection.ts`/`clipboard.ts`). Exit
behavior (including releasing the mouse) is in
[`docs/architecture/exiting.md`](docs/architecture/exiting.md). (Internal
contributor docs — not part of the user-facing docs or `agents.md`.)
