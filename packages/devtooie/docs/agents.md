# devtooie — agent guide & reference

devtooie is a dependency-aware CLI that runs a monorepo's local dev processes. It resolves
build-time, dev-time, and runtime dependencies between packages, builds whatever needs
building (in the right order), and runs the packages you pick — driven by a small typed
config file (`devtooie.config.ts`).

**This single file is the complete guide for a coding agent:** how to drive devtooie
headlessly, control a running session over its HTTP API, onboard a package, read logs for
debugging, plus the full configuration/CLI/API reference. It consolidates everything a human
reads across the README and the topic docs, so you only need this one file.

A complete, runnable example monorepo — a shared TypeScript library, a Node API, a Go worker
driven through a `Makefile`, and a web frontend — lives at
[`example/`](https://github.com/rhyek/devtooie/tree/main/example) in the devtooie repo (it's
not shipped inside the installed package, so use that URL rather than a `node_modules` path).
It's a good reference for how a real workspace is wired: project-reference build ordering,
`.env` loading, healthchecks, and `waitFor`.

## Overview

- **Dependency-aware builds.** Declare build/dev/runtime deps once; devtooie builds what
  needs building, in the right order, before it runs anything.
- **Language-agnostic packages.** A package is driven through a handful of named scripts, so
  it can be a Node package (via its `package.json`) or a Go/Rust/… package (via a `Makefile`
  with the equivalent targets). See [Package supporting scripts](#package-supporting-scripts).
- **Streamed, filterable logs.** Every package's output is streamed live into one combined
  view; in the TUI you can filter it down to a package or a search term (the `f` hotkey).
- **Two run modes.** An interactive terminal UI, or a `--plain` log-streaming mode for
  coding agents.
- **Per-package hierarchical `.env` loading.** Each package's `.env` files (workspace- and
  package-scoped) are resolved and injected into its process — and live-reloaded, restarting
  the affected package on change.
- **Readiness ordering.** `healthcheck` + `waitFor` hold a package until the services it
  needs are up.
- **Lifecycle-aware.** Each package declares whether its dev process watches or just builds,
  so you know exactly what to do after a code edit.
- **Control API + agent skill.** A localhost HTTP API drives a running session headlessly and
  lets a second invocation hand off cleanly.

## Requirements

- **Node 20+.** A `.ts` config additionally needs **Node ≥23.6** (native type-stripping); on
  older Node, use a compiled `devtooie.config.js`/`.mjs`.
- **Unix only** (macOS/Linux). Windows is not supported.
- **pnpm.** Node packages are run with `pnpm run <script>`, and packages that depend on each
  other are resolved through pnpm workspace links (`workspace:*`). (Makefile packages are run
  with `make` instead.)
- A `package.json` (or `Makefile`) per package with the scripts devtooie drives
  (`dev`, `build`, …) — see [Package supporting scripts](#package-supporting-scripts).

## Install

```bash
pnpm add -D devtooie
```

## Getting started: `devtooie init`

```bash
pnpm devtooie init
```

An interactive, idempotent setup flow. It will:

1. Ask whether to install the [agent skill](#agent-skill) (recommended: yes).
2. Scaffold `devtooie.config.ts` at the repo root (an existing config file is left untouched).
3. Reconcile a root `tsconfig.json` so the config type-checks with Node globals in scope
   (idempotent — other settings are left untouched).
4. If opted in to the skill, install it.

Pass `-y`/`--yes` to accept the defaults non-interactively.

## The config file (`devtooie.config.ts`)

The one file you author and commit — the single source of truth the CLI reads on every run.

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
      // control API) restart it — the command's flags say which. See Package lifecycle.
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
`POST /command/rebuild`); see [Package lifecycle](#package-lifecycle-when-you-change-code).

## Configuration options

`defineConfig` accepts:

| Field          | Meaning                                                                            |
| -------------- | ---------------------------------------------------------------------------------- |
| `packages`     | Your package definitions (see below).                                              |
| `workspaceDir` | Root each package's `relativeDir` resolves against. Defaults to `process.cwd()`.   |
| `env`          | `.env` files loaded per package — see [Environment loading](#environment-env-loading). |
| `apiPort`      | Pin the [control API](#drive-a-running-session-via-the-control-api) port (otherwise chosen automatically). |

Each package entry has a flat set of fields (only `name` is required; omit the rest for a
build-only lib):

- **`name`** — a unique identifier. Referenced from the CLI (`-p <name>`), from `waitFor`, and
  from `deps`.
- **`relativeDir`** — directory containing the package, relative to `workspaceDir`. Defaults
  to `packages/<name>`.
- **`selectable`** (default `true`) — show in the interactive picker.
- **`color`** — override the auto-assigned color of this package's log-prefix label. Any
  Ink/chalk color: a name (`'magenta'`, `'blueBright'`), hex (`'#af87ff'`),
  `'rgb(175,135,255)'`, or `'ansi256(140)'`. Otherwise a palette color is assigned by the
  package's position in the run.
- **`command`** — the dev process to run and how it behaves. A script/target name, or
  `[name, { watches, builds, cleans }]`. Defaults to `['dev', { watches: true, builds: true }]`.
  See [Package lifecycle](#package-lifecycle-when-you-change-code).
- **`port`, `hmrPort`** — the package's port(s); `$port` substitution and swept on session handoff.
- **`urls`** — links shown in the running footer, one entry per line. Each entry is a string, a
  `{ label, url }`, or an **array** of those (rendered on the same line, space-separated).
- **`healthcheck`** — a URL polled for readiness; also required by anything that lists this
  package in its `waitFor`.
- **`waitFor`** — package names to wait on (each must define a `healthcheck`) before this
  package starts.
- **`tsconfig`** — the tsconfig file (relative to the package dir) devtooie reads for this
  package's project references. Defaults to `tsconfig.build.json`, then `tsconfig.json`. See
  [project references](#typescript-project-references--shared-libraries).
- **`deps.build`** / **`deps.dev`** / **`deps.runtime`** — see below.

### Dependencies

Three independent categories, resolved when you select a package:

- **`deps.build`** — extends the build-time deps devtooie already infers from your TypeScript
  [project references](#typescript-project-references--shared-libraries). Resolved transitively.
- **`deps.dev`** — compiled before running (currently behaves like a build dep).
- **`deps.runtime`** — other packages that must be _running_ alongside this one. **Not
  transitive**: only the packages you explicitly select have their runtime deps expanded. If a
  runtime dep needs its own runtime deps too, select it explicitly (or add it to your selection).

`devtooie resolvedeps -p <name> [...]` prints the resolved build/dev/runtime sets as JSON —
handy for wiring other tooling to the same dependency graph.

### TypeScript project references & shared libraries

devtooie infers build-time deps from your **project references**: for each package it reads
`tsconfig` (else `tsconfig.build.json`, else `tsconfig.json`) and follows its `references`,
building those deps first. Give a shared lib a watching `dev` (e.g. `tsc --watch` emitting to
`dist`) and it runs alongside the apps, so its edits propagate live. Keep each package's
`dev`/`build` building only itself — the lib owns its watcher. See the
[`example/`](https://github.com/rhyek/devtooie/tree/main/example) monorepo.

## Invoke headlessly

Never launch devtooie's interactive TUI from an agent — there is no TTY to drive it. Always
pass `--plain` together with an explicit `-p <package>` (repeatable) so no interactive selector
is shown:

```sh
devtooie --plain -p <package> [-p <other-package> ...]
```

- **Build instead of run**: add `--build` (alias for `--phase build`) to build the selected
  package(s) and their dependencies, then exit — no long-running processes.
- **Force a clean rebuild**: add `--rebuild` — clears `dist/` for the whole build set first,
  then builds.
- **Stop a session you started**: send `SIGINT`/`SIGTERM` to the process (graceful shutdown),
  or use the control API's `POST /command/quit` (see below) if you no longer hold the process
  directly.
- **Environment**: each package's `.env` files are loaded and injected into its process
  automatically (see [Environment loading](#environment-env-loading)), so you don't set env
  vars yourself. A running session also restarts a package when its `.env` files change — so an
  unexpected restart may just be an env edit, not a crash.

## CLI usage

```bash
devtooie                  # interactive TUI: pick packages, build, run
devtooie --plain -p web   # no TUI: run `web` (+ its deps), streaming logs
devtooie -p web -p api    # repeatable -p: run multiple named packages
devtooie --build -p web   # build `web` + its build-time deps, then exit
devtooie --rebuild -p web # like --build, but clears dist/ first
```

Common options:

| Option                 | Description                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `-p, --package <name>` | Repeatable. Package(s) to run, bypassing the interactive selector.                            |
| `--ui`                 | Interactive terminal UI (default). Mutually exclusive with `--plain`.                         |
| `--plain`              | No TUI — stream logs to stdout with colored name prefixes. Requires `-p` or `--last-answers`. |
| `--last-answers`       | Skip selection; reuse the last saved selection.                                               |
| `--build`              | Build the selected packages and their build-time deps, then exit (no run phase).              |
| `--rebuild`            | Like `--build`, but first clears `dist/` for every build target.                              |
| `--log-dir <dir>`      | Write the timestamped session log into this directory. Defaults to `node_modules/.devtooie/logs/`. Each run gets a fresh `dev-<timestamp>.log`; previous sessions' logs are kept. |

Subcommands:

- **`devtooie init`** — interactive setup; see [Getting started](#getting-started-devtooie-init).
- **`devtooie reset`** — clear the saved package selection.
- **`devtooie resolvedeps -p <name> [...]`** — print the resolved build/dev/runtime dependency
  sets as JSON.
- **`devtooie env`** — resolve a package's `.env` files; see
  [Environment loading](#environment-env-loading).

## Environment (`.env`) loading

devtooie loads `.env` files for every package it runs and injects them into that package's child
process — merged over the current `process.env` without mutating it. Parsing is handled by
[dotenvx](https://github.com/dotenvx/dotenvx) under the hood. Files are resolved at **two
scopes**: the workspace root and the package's own directory. Only files that exist are loaded.

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

**Package scope overrides workspace scope**, and within a scope a later file overrides an earlier
one. `${VAR}` references expand against already-loaded files and the current environment; file
values win over the ambient environment (so `NODE_OPTIONS=$NODE_OPTIONS --flag` extends the
inherited value).

A package's `port` is also injected as `PORT` (an explicit `.env` `PORT` still overrides it).

Customize the list via `env.files` (each name is still resolved at both scopes):

```ts
defineConfig({
  env: { files: ['.env', '.env.local'] },
  packages: [/* … */],
});
```

While a session runs, devtooie **watches these files (and where new ones would appear) and
restarts the affected package(s)** on change — editing a workspace-level file restarts every
running package that uses it.

### Run a one-off command with a package's environment

The same resolution is available as a standalone command — use it to run scripts, migrations, or
checks with the exact env a package would run under:

```sh
devtooie env --dir <relativeDir> -- <command> [args...]
```

- `--dir <relativeDir>` — the package's `relativeDir` from `devtooie.config.ts`, relative to the
  workspace root. Omit it to default to your current directory — so running from inside a package
  resolves that package (workspace-level files included). Pass `--dir .` to resolve at the
  workspace root only.
- Everything after `--` is run with the resolved vars merged over the current environment; the
  command's exit code is propagated.
- Omit the `-- <command>` to instead **print** the resolved `KEY=value` pairs — useful for seeing
  what a package will get:

```sh
devtooie env --dir <relativeDir>
```

You do not need this for packages devtooie is already running (their env is injected
automatically) — it's for driving commands yourself.

## Package lifecycle when you change code

devtooie does **not** watch source files. How a package should react to a code edit is declared
by its `command`, which you read from `GET /query/config`. `command` is a script/target name or
`[name, { watches, builds, cleans }]`:

- `command: 'dev'` — the default: `{ watches: true, builds: true, cleans: false }`.
- `command: ['start', { watches: false }]` — `builds` defaults to `true`.
- `command: ['start', { watches: false, cleans: true }]` — its start is a clean rebuild.
- `command: ['serve', { watches: false, builds: false }]` — neither builds nor watches.

`command[0]` (or a bare string) is the npm script / Makefile target run as the dev process
(defaults to `dev`). The flags:

- **`watches`** — the script watches files and reloads itself (default `true`).
- **`builds`** — it (re)builds on start (default `true`). `watches: true` with `builds: false`
  is rejected — a watching script must also build.
- **`cleans`** — its start is a *clean* rebuild, with no stale output to clear (default `false`;
  requires `builds: true`). A `go run .`, for instance. This makes the package **rebuildable**
  without separate `clean`/`build` scripts — a rebuild just restarts it.

**Fetch the config early, and re-fetch before acting.** On first involvement with a running
session, read `node_modules/.devtooie/running.json` (for the port) and `GET /query/config` once.
Then, each time you're about to restart/rebuild a package, **re-read `running.json`** (the port
changes if the user restarted devtooie) and **re-`GET /query/config`** — the user may have edited
the config and restarted the session, changing what a package needs. Don't trust a cached copy
across a possible restart.

For the package you edited, look at its resolved `command` (`{ name, watches, builds, cleans }`):

| resolved flags                  | after you edit the package's code                       |
| ------------------------------- | ------------------------------------------------------- |
| `watches: true` (default)       | nothing — the script reloads itself                     |
| `watches: false, builds: true`  | `POST /command/restart/<pkg>`                           |
| `watches: false, builds: false` | `POST /command/rebuild/<pkg>` (clean build, then start) |

Rule: `watches` → nothing; else `builds` → restart; else rebuild.

`POST /command/rebuild/<name>` only succeeds when the package can clean-rebuild — its command has
`cleans: true` (a self-cleaning dev command like `go run .`, where rebuild just restarts it), or
it has `clean` + `build` (or `build:clean`) scripts. Otherwise it's a no-op; use restart.
`POST /command/restart/<name>` works for any running package.

## Drive a running session via the control API

A running devtooie session (whether started by you or a human) exposes a localhost-only HTTP
control API on a port chosen at startup — mostly useful for coding agents, but open to any
tooling. **Read the active port from `node_modules/.devtooie/running.json`** — devtooie writes the
current `{ "port", "pid", "logDir" }` there (`logDir` is where this session's logs go). Always
resolve the port from that file rather than assuming one; a project may pin a fixed port with
`apiPort` in `devtooie.config.ts`, but `running.json` is always current.

Endpoints (all plain HTTP, no auth — localhost-only):

- `GET /query/pid` — the running session's PID **and the absolute path to the `devtooie.config.*`
  it was started with** (`{ pid, configPath }`).
- `GET /query/status[/<name>]` — status of every package, or of one package.
- `GET /query/packages[?status=<status>]` — list package names, optionally filtered by status.
- `GET /query/config` — the whole **resolved** config (defaults applied, `command` normalized to
  `{ name, watches, builds, cleans }`), as loaded at startup (restart devtooie to pick up edits).
  Use it to decide package lifecycle — see [Package lifecycle](#package-lifecycle-when-you-change-code).
- `POST /command/restart/<name>` — restart one package in place.
- `POST /command/rebuild/<name>` — stop, clean-build, then start. Prefer this over `restart`
  whenever the package's build output (not just its source) changed.
- `POST /command/quit` — gracefully shut down the whole session (same as Ctrl+C).

This is what lets a second `devtooie` invocation hand off from a running one, and what an external
tool (or the agent skill) uses to drive a session headlessly.

Do not hardcode package names. Discover them either from a running session (`GET /query/status`)
or by asking devtooie directly:

```sh
devtooie resolvedeps -p <package>
```

which prints that package's build/dev/runtime dependency names as JSON.

## Read running-package logs for debugging

A running devtooie session streams the combined stdout/stderr of every package it runs into a
timestamped logfile. The directory it writes into is recorded in
`node_modules/.devtooie/running.json` as **`logDir`**; it defaults to `node_modules/.devtooie/logs/`
and only differs when the session was started with `--log-dir`.

Each session (and each in-session log rotation) writes a **fresh** file named `dev-<timestamp>.log`.
devtooie never truncates or overwrites an existing log, so logs from earlier sessions stay on disk.
To debug the **current** session, resolve that directory and read the most recent file in it:

```sh
# the session's log dir from running.json, falling back to the default
dir=$(node -e "process.stdout.write(require('./node_modules/.devtooie/running.json').logDir)" 2>/dev/null || echo node_modules/.devtooie/logs)
log=$(ls -t "$dir"/dev-*.log | head -1)   # newest = current session
tail -n 200 "$log"
grep -i error "$log"
```

`ls -t` sorts newest-first, and the running session's file is always the most recently written, so
`$log` is the current session. To dig into an **earlier** run, pick an older file from
`ls -t "$dir"` instead — prior logs are still there.

Mutating commands received over the control API (restart, rebuild, quit) are echoed into the same
log as `[dt:control]` lines (e.g. `[dt:control] restart backend`), so you can confirm a command you
sent actually landed and see the package's own output that followed it.

**You generally don't need `--log-dir`.** If you start the session yourself, leave it off and logs
land in the default `node_modules/.devtooie/logs/`. The flag only changes which directory the
_running_ session writes into — and because that directory is recorded in `running.json`
(`logDir`), the command above finds the logs either way.

## Onboard a package into devtooie

When asked to add, configure, or onboard one of the user's packages into devtooie:

1. **Ensure the package exposes the entry points devtooie drives.** devtooie chooses how to run a
   package from what's in its directory: with a `package.json` it runs npm scripts
   (`pnpm run <name>`); with a `Makefile` and no `package.json` it runs `make <target>`.
   (`package.json` wins if a package somehow has both.)

   Only the **dev entry point** is always required. `build` and `clean` are situational:
   - **`build`** — only if another package build-depends on this one, or to build it with
     `--build`. A leaf app that nothing depends on needs none (`--build` on it builds its deps,
     not the package itself).
   - **`clean`** — with `build` (or a single `build:clean`) it makes the package cleanly
     rebuildable: rebuild (the `b` hotkey / `POST /command/rebuild`) runs `clean` then `build`.
     A self-cleaning dev command needs neither — see `cleans` in
     [Package lifecycle](#package-lifecycle-when-you-change-code).

   For a **Node package**, these are npm scripts. For a **non-Node package** (no `package.json`),
   they're the equivalent **`make` targets**, invoked as `make <target>`. **If the package has
   neither a `package.json` nor a `Makefile`, create a `Makefile`** (a package with neither can't
   be driven); if it already has one, add whatever targets are missing.

   Example — a Go service whose dev command is `go run .`. Because `go run .` compiles from current
   source on every start, it's a clean rebuild on its own, so a single `start` target suffices; set
   `command: ['start', { watches: false, builds: true, cleans: true }]` and both restart and
   rebuild work without `build`/`clean` targets:

   ```makefile
   .PHONY: start
   start:
   	@go run .
   ```

   Recipe lines must be indented with a real tab. (If instead you want a compiled artifact — e.g.
   because another package build-depends on this one — add `build` (`go build -o ./bin/app .`) and
   `clean` (`rm -rf ./bin`) targets. A `make` target name can't contain a colon, so Makefile
   packages use the `clean` + `build` pair, never `build:clean`.)

2. **Rename equivalent existing scripts rather than duplicate them.** If the package already has a
   script that does the same job under a different name, rename it (and fix any references to the
   old name) instead of adding a second script that does the same thing:
   - `start:dev` or `serve` → rename to `dev`
   - `compile` or `tsc` → rename to `build`
   - a script that runs `rimraf dist` (or equivalent) → rename to `clean`

3. **Add the package to `devtooie.config.ts`.** Append a new entry to the `packages` array passed
   to `defineConfig`:

   ```ts
   {
     name: 'my-pkg',
     port: 3001,
     healthcheck: 'http://localhost:$port/health',
     deps: { runtime: ['other-pkg'] },
     waitFor: ['other-pkg'],
   }
   ```

   All package fields are flat (there is no `run` nesting). Infer them from what the package
   actually is:
   - `port` — the dev port it listens on (`hmrPort` for a browser package's HMR socket). devtooie
     injects this into the package's process as the `PORT` env var, so the app can read
     `process.env.PORT` without you duplicating it in a `.env` (an explicit `.env` `PORT` still wins).
   - `healthcheck` / `urls` — strings that may contain **tokens** substituted at load time:
     `$port`, `$name`, `$subdomain` (intrinsic), plus any extrinsic `$key` you declare in the
     top-level `tokens` map passed to `defineConfig`. Write `http://localhost:$port/health` rather
     than hardcoding the port, so it can't drift. Each `urls` entry is a string, a `{ label, url }`,
     or an array of those (an array entry's links render on one footer line, space-separated).
   - `deps: { build, dev, runtime }` — names of other packages this one depends on; drives
     build/start ordering and what gets pulled in when this package is selected. For **TypeScript**
     deps you usually don't need `deps.build`: devtooie infers build-time deps from project
     references — it reads `tsconfig` if set, else `tsconfig.build.json`, else `tsconfig.json`, and
     follows their `references` to other packages. Wire the real dependency the normal way (a
     `workspace:*` entry in the consumer's `package.json` so pnpm links it, plus a tsconfig
     `references` entry). Use `deps.build` only for edges TS can't express.
   - `waitFor` — names of packages whose `healthcheck` must pass before this one starts (each named
     package must itself define a `healthcheck`).

   Keep `name` consistent with how the package should be referred to elsewhere (control API paths,
   `-p` flags, etc).

   For workspace-wide links not tied to any package (dashboards, docs), add a top-level `urls`
   array to `defineConfig` — same entry shape as a package's `urls`. These render in the TUI footer
   above the per-package links and substitute only extrinsic `tokens` (no `$port`/`$name`/`$subdomain`).

4. **Shared TypeScript libraries.** A package others depend on (shared types/logic) is onboarded
   like any other, plus:
   - Give consumers a `workspace:*` dependency on it (pnpm links it) and a tsconfig `references`
     entry pointing at it — that's what makes devtooie build it first.
   - To make it update **live**, give it a watching `dev` script that emits its output (e.g.
     `tsc --watch` → `dist`) and `selectable: false`. devtooie runs its watcher alongside the apps;
     consumers import its emitted `dist` and pick up edits automatically. With no `dev` script it's
     just built once — edits then need an explicit rebuild of the lib.
   - Keep each package's `dev`/`build` building only itself; never root a whole-graph
     `tsc --build --watch` in an app (devtooie already builds the deps).

## Convert or improve a TypeScript monorepo for devtooie

When asked to improve a Node/TypeScript monorepo so its packages work well with devtooie —
typically **converting to TypeScript project references** and **reshaping dev scripts** — aim for
the end state below, then apply the per-package specifics from
[Onboard a package](#onboard-a-package-into-devtooie).

1. **Let project references drive the build graph.** For every cross-package import:
   - Make the dependency a real workspace package and add a `workspace:*` entry to each consumer's
     `package.json` (so pnpm links it and the consumer imports its published `exports`, not a
     relative path into its source).
   - Add a tsconfig `references` entry from each consumer to the package it imports. devtooie reads
     these to discover build-time deps and builds shared packages **first, in dependency order**. It
     reads `tsconfig` if set, else `tsconfig.build.json`, else `tsconfig.json` — so the references
     can live in a package's plain `tsconfig.json`; a separate build config is optional.
   - Make each **shared library** a composite project that **emits** its output (`composite: true`,
     `declaration: true`, `outDir: dist`). Consumers import the emitted `dist` (via the package's
     `exports`), never its source.

2. **Make each package's `dev`/`build` build only itself.** devtooie already builds a package's deps
   before running it, so nothing should rebuild the whole graph.
   - A **library**: a watching `dev` that re-emits (e.g. `tsc --watch`) plus `selectable: false`.
     devtooie runs its watcher alongside the apps, so edits to it propagate live to every consumer.
   - An **app**: a `dev` that watches only its own source (`node --watch`, `tsx watch`, `vite dev`,
     …) and consumes libraries through their emitted `dist`. **Never** root a whole-graph
     `tsc --build --watch` in an app — the library owns its watcher.
   - Normalize script names to `dev`/`build`/`clean`. A leaf app that nothing build-depends on needs
     only its dev script; drop its `build`/`clean` if present.

3. **Verify the graph.** `devtooie resolvedeps -p <app>` should now list the shared libraries under
   `build`; `devtooie --build -p <app>` then builds them in dependency order, and
   `devtooie --plain -p <app>` runs the app with its library watchers alongside it.

## Agent skill

If you opt in during `devtooie init`, devtooie installs an agent-facing skill file at
`.claude/skills/devtooie/SKILL.md` (and, best-effort, under `.agents/` / `.cursor/` if those
directories already exist). It teaches a coding agent how to run devtooie headlessly
(`--plain -p <package>`), drive a running session through the control API, read the logfile for
debugging, and onboard a new package. The installed file is **managed** — treat it as generated,
not something to hand-edit. `devtooie init` and every `devtooie` run refresh it to the installed
version. The skill points at this guide.

## Typed package names (advanced)

Most people don't need this. If you want other scripts in your repo to import a literal union of
your package names from `devtooie`, name the config value and augment the `'devtooie'` module with it:

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

`import type { PackageConfig, PackageName } from 'devtooie'` then narrows to your actual package
names instead of the generic wide types. Purely opt-in — the scaffolded config doesn't include it.
