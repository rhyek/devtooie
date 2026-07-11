# devtooie

A dependency-aware **terminal UI** (TUI) for running a monorepo's packages during local development.

_dev_ + _TUI_ → **devtooie**.

You describe your packages once, in a small typed config file. devtooie
resolves build-time, dev-time, and runtime dependencies between them, builds
whatever needs building (in the right order), and then runs the packages you
picked.

![devtooie's terminal UI running three packages](https://raw.githubusercontent.com/rhyek/devtooie/main/packages/devtooie/assets/screenshot.png)

## Features

- **Dependency-aware builds.** Declare build/dev/runtime deps once; devtooie
  builds what needs building, in the right order, before it runs anything.
- **Language-agnostic packages.** A package is driven through a handful of named
  scripts, so it can be written in anything: a Node package (via its
  `package.json`) or a Go, Rust, … package (via a `Makefile` with the equivalent
  targets). See [Package supporting scripts](#package-supporting-scripts).
- **Streamed, filterable logs.** Every package's output is streamed live into one
  combined view; filter it down to a single package or a search term on the fly
  (the `f` hotkey).
- **Two run modes.** An interactive terminal UI to pick and watch packages, or a
  `--plain` log-streaming mode for coding agents.
- **Per-package hierarchical `.env` loading.** Each package's `.env` files (workspace- and
  package-scoped) are resolved and injected into its process automatically — and
  live-reloaded, restarting the affected package when a file changes.
- **Readiness ordering.** `healthcheck` + `waitFor` hold a package until the
  services it needs are actually up.
- **Lifecycle-aware.** Each package declares whether its dev process watches or
  just builds, so you (or an agent) know exactly what to do after a code edit.
- **Control API + agent skill.** A localhost HTTP API drives a running session
  headlessly and lets a second invocation hand off cleanly; an installable skill
  teaches a coding agent to use it.

## Requirements

- **Node 20+.** A `.ts` config additionally needs **Node ≥23.6** (native
  type-stripping); on older Node, use a compiled `devtooie.config.js`/`.mjs`.
- **Unix only** (macOS/Linux). Windows is not supported.
- **pnpm.** Node packages are run with `pnpm run <script>`, and packages that depend
  on each other are resolved through pnpm workspace links (`workspace:*`). (Makefile
  packages are run with `make` instead.)
- A `package.json` (or `Makefile`) per package with the scripts devtooie drives
  (`dev`, `build`, ...) — see [Package supporting scripts](#package-supporting-scripts) below.

## Install

```bash
pnpm add -D devtooie
```

## Getting started: `devtooie init`

```bash
pnpm devtooie init
```

This is an interactive, idempotent setup flow. It will:

1. Ask whether to install the [agent skill](#agent-skill) (recommended: yes).
2. Scaffold `devtooie.config.ts` at your repo root (an existing config file is
   left untouched).
3. Reconcile a root `tsconfig.json` so the config type-checks with Node globals
   in scope (idempotent — your other settings are left untouched).
4. If you opted in to the skill, install it.

Pass `-y`/`--yes` to accept the defaults non-interactively.

After that, fill in the scaffolded config's `packages` array with your real
packages (see below) and run `pnpm devtooie`.

## `devtooie.config.ts`

The one file you author and commit — the single source of truth the CLI reads
on every run.

```ts
import { defineConfig } from 'devtooie';

export default defineConfig({
  packages: [
    {
      name: 'core-api',
      port: 3001, // Is provided as PORT environment variable to the process
      // `$port` is substituted with this package's `port`.
      healthcheck: 'http://localhost:$port/health',
    },
    {
      name: 'worker',
      // A dev process that doesn't watch files: it builds once, then runs. devtooie
      // doesn't watch your source, so after you edit its code you (or an agent, via the
      // control API) restart it — the command's flags say which. See docs/package-lifecycle.md.
      command: ['start', { watches: false, builds: true }],
    },
    {
      name: 'web',
      port: 3000,
      waitFor: ['core-api'], // Hold until core-api's healthcheck passes
      deps: { runtime: ['core-api'] }, // Selecting web also runs core-api
    },
  ],
});
```

See **[Configuration options](docs/configuration.md)** for every `defineConfig`
and package field.

## Running

```bash
pnpm devtooie
```

## Package supporting scripts

devtooie drives each package through named scripts — a **Node** package declares them in its
`package.json` `scripts`; a package in any other language (Go, Rust, …) declares the equivalent
**`make` targets** in a `Makefile`. devtooie invokes them as `pnpm run <name>` or `make <name>`.

- **`dev`** — the long-running process devtooie starts and streams. An **application** usually
  needs only this; devtooie builds its dependencies for it.
- **`build`** — a **shared library** that other packages build against adds this too, so devtooie
  can build it in the build phase before its dependents start.

A shared library (Node) — `dev` + `build`:

```jsonc
// packages/shared/package.json
{
  "name": "shared",
  "scripts": {
    "dev": "tsc --watch", // re-emits dist on change
    "build": "tsc",
  },
}
```

An application needs only a `dev` process — a Node backend:

```jsonc
// packages/backend/package.json
{
  "name": "backend",
  "scripts": {
    "dev": "node --watch src/index.ts",
  },
}
```

…or a Go program, via a `Makefile`:

```makefile
# packages/worker/Makefile
.PHONY: dev
dev:
	@go run .
```

An app can add `build` + `clean` too, for the occasional case where you need to rebuild it from
scratch to clear stale build output — those enable the rebuild command (the `b` hotkey /
`POST /command/rebuild`); see [Package lifecycle](docs/package-lifecycle.md).

## Configuration options

The full `defineConfig` and per-package field reference — including dependencies,
TypeScript project references, and typed package names — lives in
**[docs/configuration.md](docs/configuration.md)**.

## Package lifecycle when you edit code

A package's `command` flags declare whether its dev process watches or just
builds, which tells you (or an agent) whether to restart or rebuild it after a
code edit. See **[docs/package-lifecycle.md](docs/package-lifecycle.md)**.

## Environment (`.env`) loading

devtooie loads `.env` files for every package it runs and injects them into that
package's child process — merged over the current `process.env` without mutating
it. Parsing is handled by [dotenvx](https://github.com/dotenvx/dotenvx) under the hood.
Files are resolved at **two scopes**: the workspace root and the package's own
directory. Only files that exist are loaded.

```
your-monorepo/
├── .env                     # workspace scope — base for every package
├── .env.local               # workspace scope, higher precedence
└── packages/
    ├── core-api/
    │   ├── .env              # package scope — overrides workspace scope
    │   └── .env.local        # highest precedence for core-api
    └── web/
        └── .env
```

Default files, **ascending precedence within a scope**:

1. `.env`
2. `.env.development`
3. `.env.local`

**Package scope overrides workspace scope**, and within a scope a later file
overrides an earlier one. `${VAR}` references expand against already-loaded files
and the current environment; file values win over the ambient environment (so
`NODE_OPTIONS=$NODE_OPTIONS --flag` extends the inherited value).

A package's `port` is also injected as `PORT` (an explicit `.env` `PORT`
still overrides it).

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

The same resolution is available as a standalone command for running a one-off
command with a package's env, or inspecting what resolves — see
[`devtooie env`](docs/cli.md#devtooie-env).

## Advanced CLI usage

Every flag and subcommand — plus `devtooie env` for resolving a package's
environment on demand — is documented in **[docs/cli.md](docs/cli.md)**.

## Agent skill

If you opt in during `devtooie init`, devtooie installs an agent-facing skill
file at `.claude/skills/devtooie/SKILL.md` (and, best-effort, under `.agents/` /
`.cursor/` if those directories already exist). It teaches a coding agent how
to run devtooie headlessly (`--plain -p <package>`), drive a running session
through the control API, read the logfile for debugging, and onboard a new
package. The installed file is **managed** — treat it as generated, not something
to hand-edit. `devtooie init` and every `devtooie` run refresh it to the
installed version.

The skill points the agent at a single consolidated guide,
**[docs/agents.md](docs/agents.md)** — the same material as this README plus how
to drive devtooie headlessly, in one self-contained file.

## Control API

While a session runs, devtooie exposes a localhost-only HTTP API for driving it
(restart/rebuild a package, query status, hand off between invocations). See
**[docs/control-api.md](docs/control-api.md)**.

## License

MIT
