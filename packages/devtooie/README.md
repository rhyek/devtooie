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
- **Streamed, per-package logs.** Every package's output is streamed live, tagged
  with a colored name prefix.
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
      // A dev process that doesn't watch files: it builds once, then runs.
      // devtooie will restart it for you after you edit its code — see
      // Package lifecycle below.
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
    "build": "tsc"
  }
}
```

An application needs only a `dev` process — a Node backend:

```jsonc
// packages/backend/package.json
{
  "name": "backend",
  "scripts": {
    "dev": "node --watch src/index.ts"
  }
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
`POST /command/rebuild`); see [Package lifecycle](#package-lifecycle-when-you-edit-code).

## Configuration options

`defineConfig` accepts:

| Field          | Meaning                                                                                |
| -------------- | -------------------------------------------------------------------------------------- |
| `packages`     | Your package definitions (see below).                                                  |
| `workspaceDir` | Root each package's `relativeDir` resolves against. Defaults to `process.cwd()`.       |
| `env`          | `.env` files loaded per package — see [Environment loading](#environment-env-loading). |
| `apiPort`      | Pin the [control API](#control-api) port (otherwise chosen automatically).             |

Each package entry has a flat set of fields (only `name` is required; omit the rest for a
build-only lib):

- **`name`** — a unique identifier. Referenced from the CLI (`-p <name>`),
  from `waitFor`, and from `deps`.
- **`relativeDir`** — directory containing the package, relative to
  `workspaceDir`. Defaults to `packages/<name>`.
- **`selectable`** (default `true`) — show in the interactive picker.
- **`color`** — override the auto-assigned color of this package's log-prefix label. Any
  Ink/chalk color: a name (`'magenta'`, `'blueBright'`), hex (`'#af87ff'`),
  `'rgb(175,135,255)'`, or `'ansi256(140)'`. Otherwise a palette color is assigned by the
  package's position in the run.
- **`command`** — the dev process to run and how it behaves. A script/target name, or
  `[name, { watches, builds, cleans }]`. Defaults to `['dev', { watches: true, builds: true }]`.
  See [Package lifecycle](#package-lifecycle-when-you-edit-code).
- **`port`, `hmrPort`** — the package's port(s); `$port` substitution and swept on
  session handoff.
- **`urls`** — links shown in the running footer, one entry per line. Each entry is a
  string, a `{ label, url }`, or an **array** of those (rendered on the same line,
  space-separated).
- **`healthcheck`** — a URL polled for readiness; also required by anything
  that lists this package in its `waitFor`.
- **`waitFor`** — package names to wait on (each must define a `healthcheck`)
  before this package starts.
- **`tsconfig`** — the tsconfig file (relative to the package dir) devtooie reads for
  this package's project references. Defaults to `tsconfig.build.json`, then
  `tsconfig.json`. See [project references](#typescript-project-references--shared-libraries).
- **`deps.build`** / **`deps.dev`** / **`deps.runtime`** — see below.

### Dependencies

Three independent categories, resolved when you select a package:

- **`deps.build`** — extends the build-time deps devtooie already infers from your
  TypeScript [project references](#typescript-project-references--shared-libraries).
  Resolved transitively.
- **`deps.dev`** — compiled before running (currently behaves like a build dep).
- **`deps.runtime`** — other packages that must be _running_ alongside this
  one. **Not transitive**: only the packages you explicitly select have
  their runtime deps expanded. If a runtime dep needs its own runtime deps
  too, select it explicitly (or add it to your own selection).

`devtooie resolvedeps -p <name> [...]` prints the resolved build/dev/runtime
sets as JSON — handy for wiring other tooling to the same dependency graph.

### TypeScript project references & shared libraries

devtooie infers build-time deps from your **project references**: for each package it reads
`tsconfig` (else `tsconfig.build.json`, else `tsconfig.json`) and follows its `references`,
building those deps first. Give a shared lib a watching `dev` (e.g. `tsc --watch` emitting to
`dist`) and it runs alongside the apps, so its edits propagate live. Keep each package's
`dev`/`build` building only itself — the lib owns its watcher. See the
[`example/`](https://github.com/rhyek/devtooie/tree/main/example) monorepo.

## Package lifecycle when you edit code

`command` declares **how a package's dev process behaves**, which tells you (or an
agent) what to do after editing that package's source. It's a script/target name or
`[name, { watches, builds, cleans }]`:

- `command: 'dev'` — the default: `{ watches: true, builds: true, cleans: false }`.
- `command: ['start', { watches: false }]` — `builds` defaults to `true`.
- `command: ['start', { watches: false, cleans: true }]` — its start is a clean rebuild.
- `command: ['serve', { watches: false, builds: false }]` — neither builds nor watches.

`command[0]` (or a bare string) is the npm script / Makefile target run as the dev
process (defaults to `dev`). The flags:

- **`watches`** — the script watches files and reloads itself (default `true`).
- **`builds`** — it (re)builds on start (default `true`). `watches: true` with `builds: false`
  is rejected — a watching script must also build.
- **`cleans`** — its start is a *clean* rebuild, with no stale output to clear (default
  `false`; requires `builds: true`). A `go run .`, for instance. This makes the package
  **rebuildable** without separate `clean`/`build` scripts — a rebuild just restarts it.

**After editing** the package's code — what devtooie (or an agent) does:

| resolved flags                  | after you edit the package's code                       |
| ------------------------------- | ------------------------------------------------------- |
| `watches: true` (default)       | nothing — the script reloads itself                     |
| `watches: false, builds: true`  | `POST /command/restart/<pkg>`                           |
| `watches: false, builds: false` | `POST /command/rebuild/<pkg>` (clean build, then start) |

**The two manual commands** (the `r`/`b` hotkeys and their endpoints):

- **restart** (`POST /command/restart`) — re-runs the dev command; available for any running package.
- **rebuild** (`POST /command/rebuild`) — a clean rebuild; available only when the package
  _can_ clean-rebuild: `cleans: true` (rebuild just restarts it), or it has `clean` + `build`
  (or `build:clean`) scripts. Otherwise it's a no-op (e.g. a plain `node --watch` app).

The resolved flags are served by [`GET /query/config`](#control-api) for tooling to read.

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
2. `.env.development.pre`
3. `.env.development`
4. `.env.local`

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
[`devtooie env`](#devtooie-env) below.

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
- **`devtooie env`** — resolve a package's `.env` files; see [below](#devtooie-env).

### `devtooie env`

Resolve a package's `.env` files (per [Environment loading](#environment-env-loading))
— handy for running a one-off command with a package's env, or inspecting what
resolves:

```bash
devtooie env                              # resolve for the current directory
devtooie env --dir packages/api           # ...for a specific package
devtooie env -- node ./scripts/seed.js    # run a command with them injected
devtooie env --dir packages/api -- npm run migrate
```

It works from anywhere (finding the nearest ancestor with a `devtooie.config.*`).
`--dir` is relative to that root and **defaults to your current directory**, so
running it inside a package resolves that package.

### Agent skill

If you opt in during `devtooie init`, devtooie installs an agent-facing skill
file at `.claude/skills/devtooie/SKILL.md` (and, best-effort, under `.agents/` /
`.cursor/` if those directories already exist). It teaches a coding agent how
to run devtooie headlessly (`--plain -p <package>`), drive a running session
through the control API, read the logfile for debugging, and onboard a new
package. The installed file is **managed** — treat it as generated, not something
to hand-edit. `devtooie init` and every `devtooie` run refresh it to the
installed version.

### Control API

While a session runs, devtooie exposes a localhost-only HTTP API — mostly useful
for coding agents (via the [skill](#agent-skill) above), but open to any tooling.
Its port is picked at startup and written (with the pid) to
`node_modules/.devtooie/running.json` — read the `port` field there. Pin a fixed
one with `apiPort` in `devtooie.config.ts`.

- `GET /query/pid` — the running session's PID **and the absolute path to the
  `devtooie.config.*` it was started with** (`{ pid, configPath }`).
- `GET /query/status[/<name>]` / `GET /query/packages[?status=...]` — package
  status.
- `GET /query/config` — the whole **resolved** config (defaults applied,
  `command` normalized to `{ name, watches, builds, cleans }`), as loaded at startup
  (restart devtooie to pick up edits).
- `POST /command/restart/<name>` / `POST /command/rebuild/<name>` — restart
  or rebuild-then-restart a package.
- `POST /command/quit` — graceful shutdown (same as Ctrl+C).

This is what lets a second `devtooie` invocation hand off from a running one, and
what an external tool (or the agent skill) uses to drive a session headlessly.

## Typed package names (optional, advanced)

Most people don't need this. If you want other scripts in your repo to import a
literal union of your package names from `devtooie`, name the config value and
augment the `'devtooie'` module with it:

```ts
import { defineConfig } from 'devtooie';

const config = defineConfig({
  packages: [/* … */],
});
export default config;

declare module 'devtooie' {
  interface Register {
    packageConfigs: typeof config.packages;
  }
}
```

`import type { PackageConfig, PackageName } from 'devtooie'` then narrows to your
actual package names instead of the generic wide types. Purely opt-in — the
scaffolded config doesn't include it.

## License

MIT
