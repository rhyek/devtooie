# devtooie

Dependency-aware CLI for running a monorepo's local dev processes.

You describe your packages once, in a small typed config file. devtooie
resolves build-time, dev-time, and runtime dependencies between them, builds
whatever needs building (in the right order), and then runs the packages you
picked — either in a full terminal UI or a plain log-streaming mode. Other
tooling in your monorepo (a reverse proxy, a codegen script, ...) can import
the same typed config instead of duplicating it.

devtooie ships two things from one package:

- **A library** — `defineConfig`, `PackageType`, `findPackage`, and supporting
  types, for authoring your config and importing it from other scripts.
- **A CLI binary** (`devtooie`) — driven entirely by a small committed
  `devtooie.config.ts` file. There are no `--config`/`--port` flags: the CLI
  reads everything it needs from that file.

## Requirements

- **Node ≥23.6** (Node 24 LTS recommended). devtooie loads your
  `devtooie.config.ts` with a native dynamic `import()` of a `.ts` file, which
  relies on Node's built-in TypeScript type-stripping — available starting in
  Node 23.6, and on by default in Node 24 LTS. On an older Node you can use a
  compiled `devtooie.config.js`/`.mjs` instead (runtime only — the inline type
  augmentation described below requires the `.ts` form).
- **Unix only** (macOS/Linux) for now. The dev-session handoff, port
  sweeping, and process-group management devtooie uses under the hood are
  POSIX-specific. Windows is not supported.
- A `package.json` (or `Makefile`) per package with the scripts devtooie
  drives (`dev`, `build`, ...) — see [CLI usage](#cli-usage) below.

## Install

```bash
pnpm add -D devtooie
# or: npm install --save-dev devtooie / yarn add -D devtooie
```

### The postinstall caveat

devtooie's package ships a best-effort `postinstall` hook that, on a plain
interactive install, offers to run `devtooie init` for you. **Don't rely on
it.** Many package managers skip dependency lifecycle scripts by default —
notably **pnpm ≥10**, which requires a package to be explicitly allow-listed
before its `postinstall` runs at all. CI installs and non-interactive
installs also skip the prompt intentionally.

The reliable, documented setup path is always to run `devtooie init`
yourself after installing.

## Getting started: `devtooie init`

```bash
npx devtooie init
```

This is an interactive, idempotent setup flow. It will:

1. Ask whether to install the [agent skill](#agent-skill) (recommended: yes).
2. Scaffold `devtooie.config.ts` at your repo root (an existing config file is
   left untouched).
3. Reconcile a root `tsconfig.json` so the config type-checks with Node globals
   in scope — creating one if absent, or just adding `devtooie.config.ts` to its
   `include` (and `"node"` to a `types` array that lacks it) if one already
   exists — so editors don't flag `process.env.*` in the config with TS2591.
   Idempotent; your other settings are left untouched.
4. If you opted in to the skill, install it.

Pass `-y`/`--yes` to run it non-interactively (accepts the defaults — scaffold
the config and install the skill — without prompting), handy for automation.

After that, fill in the scaffolded config's `packages` array with your real
packages (see below) and run `devtooie`.

## `devtooie.config.ts`

The one file you author and commit — the single source of truth the CLI reads
on every run. There are no CLI flags for any of it. It holds your control-API
port, whether the agent skill is managed, and your package definitions, and it
wires your package _names_ into devtooie's exported types via a small inline
augmentation block at the bottom:

> **Note:** devtooie imports this file with a native `.ts` dynamic `import()`
> (see [Requirements](#requirements) above). If your project's
> `package.json` doesn't have `"type": "module"`, Node will still load it
> correctly but will print a `MODULE_TYPELESS_PACKAGE_JSON` performance
> warning. Add `"type": "module"` to your `package.json`, or name the file
> `devtooie.config.mts`, to silence it.

```ts
import { defineConfig } from 'devtooie';

const config = defineConfig({
  // Values for any extrinsic URL tokens you reference below.
  tokens: { domain: process.env.APP_DOMAIN, proxyport: process.env.PROXY_PORT },
  packages: [
    {
      name: 'core-api',
      types: ['backend'],
      run: {
        port: 3001,
        healthcheck: 'http://localhost:$port/health',
      },
    },
    {
      name: 'reverse-proxy',
      types: ['backend'],
      run: {
        selectable: false, // infra dep, never shown in the picker
        healthcheck: 'https://$domain:$proxyport/_health',
      },
    },
    {
      name: 'web',
      types: ['browser'],
      run: {
        port: 3000,
        urls: ['https://app.$domain:$proxyport'],
        waitFor: ['core-api'],
        deps: { runtime: ['core-api', 'reverse-proxy'] },
      },
    },
  ],
});
export default config;

// Wires your package names into devtooie's types. Keep as-is.
declare module 'devtooie' {
  interface Register {
    packageConfigs: typeof config.packages;
  }
}
```

`defineConfig` accepts:

| Field          | Meaning                                                                                |
| -------------- | -------------------------------------------------------------------------------------- |
| `packages`     | Your package definitions (see below).                                                  |
| `urls`         | Workspace-wide links, not tied to a package — see [Top-level URLs](#top-level-urls).   |
| `workspaceDir` | Root each package's `relativeDir` resolves against. Defaults to `process.cwd()`.       |
| `tokens`       | Values for extrinsic `$token` substitution — see [Tokens](#tokens).                    |
| `env`          | `.env` files loaded per package — see [Environment loading](#environment-env-loading). |

If no `devtooie.config.ts` (or `.mts`/`.js`/`.mjs`) exists, the CLI exits with
a message pointing you at `devtooie init`.

Each package entry:

- **`name`** — a unique identifier. Referenced from the CLI (`-p <name>`),
  from `waitFor`, and from `deps`.
- **`types`** — one or more of `'backend' | 'browser' | 'lib'`. Drives
  grouping in the interactive selector.
- **`relativeDir`** (optional) — directory containing the package, relative to
  `workspaceDir`. Defaults to `packages/<name>`.
- **`run`** (optional) — everything about how to run/select/link the package;
  omit it entirely for a build-only lib. Notable fields:
  - `selectable` (default `true`) — show in the interactive picker.
  - `port`, `hmrPort` — the package's port(s); used for substitution and swept
    on session handoff.
  - `subdomain` — for reverse-proxy routing; used for `$subdomain`
    substitution.
  - `urls` — links shown in the running footer, one entry per line. Each entry is a
    string, a `{ label, url }`, or an **array** of those (rendered on the same line,
    space-separated).
  - `healthcheck` — a URL polled for readiness; also required by anything
    that lists this package in its `waitFor`.
  - `waitFor` — package names to wait on (each must define a `healthcheck`)
    before this package starts.
  - `deps.build` / `deps.dev` / `deps.runtime` — see below.

### Dependencies

Three independent categories, resolved when you select a package:

- **`deps.build`** — extends the build-time deps devtooie already infers
  from your `tsconfig.build.json` project references. Resolved
  transitively.
- **`deps.dev`** — compiled before running; currently behaves like a build
  dep, tracked separately for future divergence.
- **`deps.runtime`** — other packages that must be _running_ alongside this
  one. **Not transitive**: only the packages you explicitly select have
  their runtime deps expanded. If a runtime dep needs its own runtime deps
  too, select it explicitly (or add it to your own selection).

`devtooie resolvedeps -p <name> [...]` prints the resolved build/dev/runtime
sets as JSON, which is handy for wiring other tooling (targeted typechecks,
codegen, etc.) to the same dependency graph.

## Top-level URLs

The top-level `urls` field holds workspace-wide links that aren't tied to any single
package — dashboards, admin panels, docs. They render in the TUI footer **above** the
per-package links, separated by a dim rule:

```ts
defineConfig({
  urls: [
    'https://status.internal',
    { label: 'Grafana', url: 'https://grafana.$domain' },
    // An array entry renders its links on one line, space-separated:
    [
      { label: 'repo', url: 'https://github.com/acme/app' },
      { label: 'CI', url: 'https://ci.acme.dev' },
    ],
  ],
  tokens: { domain: 'example.com' },
  packages: [/* ... */],
});
```

Same shape as a package's `run.urls` — each entry is a string, a `{ label, url }`, or an
array of those. Only **extrinsic** tokens (from `tokens`) are substituted; there is no
package, so an intrinsic `$name`/`$port`/`$subdomain` reference has nothing to resolve
against and throws (see [Tokens](#tokens)).

## Tokens

`urls` and `healthcheck` strings support `$token` substitution, resolved once
at `defineConfig()` call time. Using `$` (rather than `:`) keeps tokens from
colliding with the `:` that precedes a port in a URL — e.g.
`http://localhost:$port`:

**Intrinsic** (always available, derived from the package's own config):

- `$name` → the package's `name`
- `$port` → `run.port` (throws if the package has no `port`)
- `$subdomain` → `run.subdomain` (first element, if it's an array; throws if
  the package has no `subdomain`)

**Extrinsic** (yours to supply via `tokens: {...}`): any other `$key` in a
`urls`/`healthcheck` string is looked up in the `tokens` map you pass to
`defineConfig`. Referencing a `$key` with no matching entry — or one
whose value is `undefined` — throws immediately, naming the source (the package, or
`top-level url`) and the token, so misconfiguration fails loudly at startup instead of
silently. Top-level `urls` support **only** these extrinsic tokens.

This keeps devtooie itself free of any hardcoded environment-variable names:
you decide what feeds `tokens` (env vars, computed values, constants).

## Environment (`.env`) loading

devtooie loads `.env` files for every package it runs and injects them into that
package's child process — merged over the current `process.env` without mutating
it. Files are resolved at two scopes (the workspace root and the package's own
directory); only files that exist are loaded.

Default files, **ascending precedence within a scope**:

1. `.env`
2. `.env.development.pre`
3. `.env.development`
4. `.env.local`

**Package scope always overrides workspace scope**, and within a scope a file
later in the list overrides an earlier one — so a package's `.env.local` wins
over everything and the workspace `.env` is the base. `${VAR}` references are
expanded against already-loaded files and the current environment.

A package's `run.port` is also injected as the `PORT` env var (so the app can
read `process.env.PORT` without duplicating it), sitting between the inherited
environment and the `.env` files — a default the config provides, which an
explicit `.env` `PORT` still overrides.

Customize the list via `env.files` (each name is still resolved at both scopes):

```ts
defineConfig({
  env: { files: ['.env', '.env.local'] },
  packages: [/* … */],
});
```

While a session runs, devtooie **watches these files (and where new ones would
appear) and restarts the affected package(s)** on change — editing a
workspace-level file restarts every running package that uses it.

### `devtooie env`

The same resolution is available as a standalone command — handy for running a
one-off command with a package's env, or inspecting what resolves:

```bash
devtooie env                              # resolve for the current directory
devtooie env --dir packages/api           # ...for a specific package
devtooie env -- node ./scripts/seed.js    # run a command with them injected
devtooie env --dir packages/api -- npm run migrate
```

It discovers the workspace root (the nearest ancestor holding a
`devtooie.config.*`) and reads its `env.files`, so it works from anywhere.
`--dir` is relative to that root and **defaults to your current directory** — so
running it from inside a package resolves that package (workspace-level files
included), just like devtooie would when it runs the package.

## Type augmentation

The `declare module 'devtooie'` block at the bottom of `devtooie.config.ts`
wires up a fully-typed, literal union of your package names for anything that
imports types from `devtooie`:

```ts
declare module 'devtooie' {
  interface Register {
    packageConfigs: typeof config.packages;
  }
}
```

Because it references the config's own `packages`, it can never drift and
needs no code generation. Once it's present, `import type { PackageConfig,
PackageName } from 'devtooie'` narrows to your actual packages instead of the
generic wide types. `devtooie init` scaffolds this block for you; keep it as-is
when you add packages.

## CLI usage

```bash
devtooie                  # interactive TUI: pick packages, build, run
devtooie --plain -p web   # no TUI: run `web` (+ its deps), streaming logs
devtooie -p web -p api    # repeatable -p: run multiple named packages
devtooie --build -p web   # build `web` + its build-time deps, then exit
devtooie --rebuild -p web # like --build, but clears dist/ first
```

Common options:

| Option                 | Description                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `-p, --package <name>` | Repeatable. Package(s) to run, bypassing the interactive selector.                                           |
| `--ui`                 | Interactive terminal UI (default). Mutually exclusive with `--plain`.                                        |
| `--plain`              | No TUI — stream logs to stdout with colored name prefixes. Requires `-p` or `--last-answers`.                |
| `--last-answers`       | Skip selection; reuse the last saved selection.                                                              |
| `--build`              | Build the selected packages and their build-time deps, then exit (no run phase).                             |
| `--rebuild`            | Like `--build`, but first clears `dist/` for every build target.                                             |
| `--logfile <path>`     | Write all package output to this file (truncated each run). Defaults to `node_modules/.devtooie/devlog.txt`. |

Subcommands:

- **`devtooie init`** — interactive setup; see [above](#getting-started-devtooie-init).
- **`devtooie reset`** — clear the saved package selection.
- **`devtooie resolvedeps -p <name> [...]`** — print the resolved
  build/dev/runtime dependency sets as JSON.
- **`devtooie env [--dir <relativeDir>] [-- <cmd...>]`** — resolve a package's
  `.env` files and print them, or run a command with them injected. See
  [Environment loading](#environment-env-loading).

There's no `--config` or `--api-port` flag. The control API port is chosen at
startup and written to `node_modules/.devtooie/running.json`; read it from there.

### Control API

While a session is running (either runner mode), devtooie exposes a
localhost-only HTTP API. The port is picked at startup from a small range
(`14000`–`14099`) and recorded — along with the session pid — in
`node_modules/.devtooie/running.json`; read the `port` field there to reach it.
Restarts of the same workspace reuse the recorded port, and a fixed port can be
pinned with `apiPort` in `devtooie.config.ts`.

- `GET /query/pid` — the running session's PID **and the absolute path to the
  `devtooie.config.*` it was started with** (`{ pid, configPath }`).
- `GET /query/status[/<name>]` / `GET /query/packages[?status=...]` — package
  status.
- `POST /command/restart/<name>` / `POST /command/rebuild/<name>` — restart
  or rebuild-then-restart a package.
- `POST /command/quit` — graceful shutdown (same as Ctrl+C).

This is what lets a second `devtooie` invocation cleanly hand off from a
still-running one, and what an external tool (or the agent skill) can use to
drive a session headlessly.

## Agent skill

If you opt in during `devtooie init`, devtooie installs an agent-facing skill
file at `.claude/skills/devtooie/SKILL.md` (and, best-effort, under `.agents/` /
`.cursor/` if those directories already exist). It teaches a coding agent how
to run devtooie headlessly (`--plain -p <package>`), drive a running session
through the control API, read the fixed default logfile for debugging, and
onboard a new package into your `devtooie.config.ts`. The installed file is
**managed** — treat it as generated, not something to hand-edit. `devtooie init`
and the package's `postinstall` hook refresh it to match the installed devtooie
version automatically (overwriting local changes), so it stays in lockstep with
the package.

## License

MIT
