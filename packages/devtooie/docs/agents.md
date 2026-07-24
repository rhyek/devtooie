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
  view; in the TUI you can filter it down to a package or a search term (the `f` hotkey;
  matching is case- and accent-insensitive).
- **Two run modes.** An interactive terminal UI, or a `--plain` log-streaming mode for
  coding agents.
- **One-off commands.** `devtooie cmd` runs a single command (or a package script/target) in a
  package's directory with that package's resolved environment — for migrations, seeds,
  scrapers, or an agent driving your project.
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
| `logs`         | Log display options: `{ timestamps?: boolean }` (default `false`) — see [Log timestamps](#log-timestamps). |
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
  Pass **`null`** for a package with **no dev process** — devtooie never starts it (build/dep-only)
  and it's hidden from the picker. See [Package lifecycle](#package-lifecycle-when-you-change-code).
- **`autostart`** (default `true`) — whether to auto-start this package in the run phase. Set
  **`false`** to leave it stopped; start it with the **`s`** hotkey or a control-API `restart`
  (`POST /command/restart/<name>` starts a stopped package). Ignored when `command` is `null`.
- **`port`** — the package's dev port; feeds `$port` substitution, injected as `PORT`, and swept on session handoff.
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
- **`logs`** — per-package log options `{ timestamps?, formatter? }`. `timestamps` overrides the
  top-level [`logs.timestamps`](#log-timestamps) for this package (inheriting it when omitted);
  `formatter` (`(line: string) => string`) **overrides the default structured-log formatter** that
  devtooie already applies to every package. See [Structured logs](#structured-logs).

### Log timestamps

By default log lines are shown without a timestamp. Set `logs.timestamps: true` to prefix
every on-screen log line (both the interactive TUI and `--plain` output) with a
`YYYY-MM-DD HH:MM:SS` local-time (24-hour) stamp:

```ts
export default defineConfig({
  logs: { timestamps: true },
  packages: [/* … */],
});
```

```
2026-07-13 13:53:32 [api]     backend ready, starting…
2026-07-13 13:53:32 [web]     VITE ready in 431 ms
```

The on-disk session log file always records timestamps (in the same format) regardless of this
setting; `logs.timestamps` only controls whether they're shown on screen.

**Per-package override.** A package can set its own on-screen visibility with a package-level
`logs.timestamps`. When set (`true` or `false`) it wins over the top-level default for that
package; when omitted, the package inherits the top-level value:

```ts
export default defineConfig({
  logs: { timestamps: false }, // top-level default
  packages: [
    { name: 'api' }, // inherits → no timestamps on screen
    { name: 'worker', logs: { timestamps: true } }, // overrides → timestamps on screen
  ],
});
```

### Structured logs

**Rarely something to configure:** most dev processes log plain text (passed through untouched),
and for the apps that do emit structured **JSON** in dev the default formatter already handles the
common cases — only reach for `logs.formatter` if a package's JSON logs aren't rendering right.

Some services log **structured JSON in every environment** (Go's `log/slog`, Node's pino/winston)
rather than branching the logger on `NODE_ENV`. **devtooie handles this out of the box** — it
applies a default formatter to *every* package's output that passes **non-JSON** lines through
untouched and pretty-prints a **JSON log** as a **`[LEVEL] message`** header (the `[LEVEL]` colored
by severity), with the remaining properties listed, indented, on the lines below (each key in a
muted color, its value in the normal foreground). A property whose value spans several lines keeps
its shape — the extra lines are aligned under where the value starts, so the entry still reads as
one block. So a slog line like:

```
{"time":"2026-07-13T13:53:32-06:00","level":"INFO","msg":"listening","port":3002}
```

is shown as:

```
[INFO] listening
  time: 2026-07-13T13:53:32-06:00
  port: 3002
```

You configure nothing for this. `logs.formatter` only **overrides** the default for a package.

**Levels.** A **string** level is uppercased and matched to devtooie's canonical levels (`TRACE`,
`DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`), folding aliases (`WARNING`→`WARN`, `ERR`→`ERROR`,
`CRITICAL`/`EMERGENCY`→`FATAL`, `VERBOSE`→`TRACE`, `NOTICE`→`INFO`, …); the matched `[LEVEL]` is
colored by severity. A **number** is **not** guessed (the numbers aren't standard — pino's `30` is
INFO, Python's is WARNING) — it prints `[UNKNOWN LOGLVL: 30]` until mapped; an unmatched string
prints `[UNKNOWN LOGLVL: FOOBAR]`.

**The `logging` helpers** (exported from `devtooie`) override a package's formatter:

```ts
import { defineConfig, logging } from 'devtooie';

export default defineConfig({
  packages: [
    { name: 'go-svc' }, // no config — slog's string levels just work via the default
    { name: 'api', logs: { formatter: logging.nodejs.pino.formatter() } },      // pino numeric levels
    { name: 'web', logs: { formatter: logging.nodejs.winston.formatter() } },   // winston message key + levels
  ],
});
```

- **`logging.formatter(config?)`** — the base factory, and the default applied to every package.
- **`logging.nodejs.pino.formatter(config?)`** — maps pino/bunyan's numeric levels
  (`logging.nodejs.pino.levels`).
- **`logging.nodejs.winston.formatter(config?)`** — winston's `message` key + level names
  (`logging.nodejs.winston.levels`).

`config` is `{ fields?, levels? }`, all optional: `fields.level`/`fields.message` (source keys,
default `level`/`msg`), `fields.custom` (rename/hide properties, keyed by display name —
`{ timestamp: 'ts' }`, `{ timestamp: { source: 'ts' } }`, `{ time: { show: false } }`), and
`levels` (a `{ rawValue: name }` map for numeric/non-standard levels; the ecosystem helpers set it).

`fields.custom` may instead be a **callback** receiving the parsed log, so the mapping can depend on
the entry itself — e.g. hiding a field only on certain events. It runs once per rendered line, and
never for lines that pass through unformatted:

```ts
logging.formatter({
  fields: {
    custom: (log) => ({
      time: { show: false }, // always hidden
      ...(log.context === 'message-ingest' ? { at: { show: false } } : {}),
    }),
  },
});
```

Or write your own: `logs.formatter` is just `(line: string) => string` — return the display
string, or the line unchanged to pass it through. A formatter that throws or returns a non-string
falls back to the raw line, so a bug can't take down the session. The returned string is what's
buffered, shown, **and written to the log file** (ANSI color allowed, stripped for the file); a
multi-line result is split into separate log lines. **devtooie owns the timestamp** (shown per
`logs.timestamps`, always in the log file), so drop the log's own time field rather than printing
it. `z` (zod) is re-exported by devtooie, so a hand-written formatter can validate shapes without a
dependency.

The [`example/`](https://github.com/rhyek/devtooie/tree/main/example) monorepo's Go `worker` (slog)
relies on the default formatter, overriding it only to hide slog's `time`.

### Dependencies

Three independent categories, resolved when you select a package:

- **`deps.build`** — extends the build-time deps devtooie already infers from your TypeScript
  [project references](#typescript-project-references--shared-libraries). Resolved transitively.
- **`deps.dev`** — compiled before running (currently behaves like a build dep).
- **`deps.runtime`** — other packages that must be _running_ alongside this one. **Not
  transitive**: only the packages you explicitly select have their runtime deps expanded. If a
  runtime dep needs its own runtime deps too, select it explicitly (or add it to your selection).

`devtooie resolvedeps <package>` prints the resolved build/dev/runtime sets for a single
package as JSON — handy for wiring other tooling to the same dependency graph.

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
- **Stop a session** (yours or one already running): `POST /command/quit` to the control API
  (see below) — it shuts every package down gracefully and frees the ports. **Always use the API
  command; never `kill`/`pkill`/`lsof … | kill` a devtooie process or its port.** A raw OS kill (or
  a stray signal) drops the process out from under devtooie and looks like the session died on its
  own — use `POST /command/quit` to stop, `POST /command/restart/<name>` to restart one package.
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

Every command works from **anywhere in the repo**: as a first step devtooie walks up to the
nearest `devtooie.config.*`, switches to that directory, and loads its workspace-scope `.env` —
so running from a subdirectory behaves the same as from the root. (`devtooie cmd` additionally
uses your original directory to decide which package you're inside.)

Common options:

| Option                 | Description                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `-p, --package <name>` | Repeatable. Package(s) to run, bypassing the interactive selector.                            |
| `--ui`                 | Interactive terminal UI (default). Mutually exclusive with `--plain`.                         |
| `--plain`              | No TUI — stream logs to stdout with colored name prefixes. Requires `-p` or `--last-answers`. |
| `--last-answers`       | Skip selection; reuse the last saved selection.                                               |
| `--build`              | Build the selected packages and their build-time deps, then exit (no run phase).              |
| `--rebuild`            | Like `--build`, but first clears `dist/` for every build target.                              |
| `--log-dir <dir>`      | Write the timestamped session log into this directory. Defaults to `node_modules/.devtooie/logs/`. Each run gets a fresh `<timestamp>.log`; previous sessions' logs are kept. Also used by `devtooie cmd`. |

Subcommands:

- **`devtooie init`** — interactive setup; see [Getting started](#getting-started-devtooie-init).
- **`devtooie reset`** — clear the saved package selection.
- **`devtooie resolvedeps <package>`** — print the resolved build/dev/runtime dependency
  sets for a single package as JSON.
- **`devtooie cmd`** — run a **one-off command** with a package's environment (its dir +
  resolved `.env`); package inferred from the cwd or named with `-p`; see
  [Run a one-off command in a package's dir](#run-a-one-off-command-in-a-packages-dir-with-its-environment).
- **`devtooie logs`** — print the current session's logfile (or `-f/--follow` to stream it);
  read-only, never disturbs the session; see
  [Read running-package logs for debugging](#read-running-package-logs-for-debugging).

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

### Run a one-off command in a package's dir with its environment

`devtooie cmd` runs a **single one-off command with a package's environment** — without starting
a session. The command runs in the package's directory with that package's resolved `.env` and
its `port` as `PORT` injected — the exact environment the TUI would spawn it with. Use it to
drive scripts, migrations, or scrapers. The package is chosen by **where you run it**: by default
there's no package argument — `cd` into the package's directory (or any subdirectory of it) and
run (or name one explicitly with `-p`, below):

```sh
devtooie cmd -- <command> [args...]         # run a literal command in the package dir
devtooie cmd -c <script> -- [args...]       # run the package's script/make target
devtooie cmd -p <name> -c <script> -- ...   # target <name> explicitly (from anywhere)
```

- **Which package**: the nearest **ancestor** directory that is a configured package. Below the
  config root but inside no package, it falls back to the **root** (working dir = root, only
  workspace-scope vars). Errors only if there's no `devtooie.config.*` at all (any supported
  extension: `.ts`/`.mts`/`.js`/`.mjs`). Pass `-p, --package <name>` to target a package
  explicitly (overrides the cwd inference), e.g. `devtooie cmd -p api -c start -- …`.
- `-c, --cmd <script>` — run a package **script or make target** (resolved the way devtooie runs
  a package: `pnpm run <script>` or `make <target>`, found in that dir's `package.json`/`Makefile`),
  forwarding anything after `--` to it as arguments. Errors if there's no such script/target.
- Without `-c`, a literal command after `--` is required.
- The command's exit code is propagated, and `devtooie cmd` exits as soon as the command does.
- Output streams to your terminal **and** is teed to a fresh timestamped logfile under
  `node_modules/.devtooie/logs/` (or `--log-dir`) — the path is printed on start.

You do not need this for packages devtooie is already running (their env is injected
automatically) — it's for driving commands yourself.

## Package lifecycle when you change code

devtooie does **not** watch source files. How a package should react to a code edit is declared
by its `command`, which you read from the `config` field of `GET /query/status`. `command` is a
script/target name or `[name, { watches, builds, cleans }]`:

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
session, read `node_modules/.devtooie/running.json` (for the port) and `GET /query/status` once
(read its `config` field). Then, each time you're about to restart/rebuild a package, **re-read
`running.json`** (the port changes if the user restarted devtooie) and **re-`GET /query/status`** —
the user may have edited the config and restarted the session, changing what a package needs.
Don't trust a cached copy across a possible restart.

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
current `{ "port", "pid", "logDir", "logFile" }` there (`logDir` is where this session's logs go;
`logFile` is the current logfile, kept up to date across in-session rotation). Always resolve the
port from that file rather than assuming one; a project may pin a fixed port with `apiPort` in
`devtooie.config.ts`, but `running.json` is always current.

Endpoints (all plain HTTP, no auth — localhost-only):

- `GET /query/status` — a single snapshot of the session, `{ pid, configPath, logFile, packages, config }`:
  - `pid` / `configPath` — the session's PID and the absolute path to the `devtooie.config.*` it
    was started with; available immediately, even while the session is still building.
  - `logFile` — absolute path to the logfile currently being written (tracks in-session rotation).
  - `packages` — per-package status map (e.g. `{ "web": "running" }`); `null` until the build finishes.
  - `config` — the whole **resolved** config (defaults applied, `command` normalized to
    `{ name, watches, builds, cleans }`), as loaded at startup (restart devtooie to pick up edits);
    `null` until the build finishes. Use it to decide package lifecycle — see
    [Package lifecycle](#package-lifecycle-when-you-change-code).
- `POST /command/restart/<name>` — restart one package in place (`202` if accepted, `404` for an
  unknown package).
- `POST /command/rebuild/<name>` — stop, clean-build, then start. Prefer this over `restart`
  whenever the package's build output (not just its source) changed.
- `POST /command/quit` — gracefully shut down the whole session (same as Ctrl+C). **Blocks**
  until the session's packages are torn down and their ports freed, then returns `200` (see
  [Graceful shutdown](#graceful-shutdown) below) — so once the request returns, the ports are
  clear. The request can take up to ~15s if a package is slow to exit, so allow for that when you
  call it. The session then closes its control server and exits a moment later; if you need to
  confirm the process itself is gone, poll `GET /` afterwards (connection refused = gone).

This is what lets a second `devtooie` invocation hand off from a running one, what `devtooie logs`
finds the current logfile with, and what an external tool (or the agent skill) uses to drive a
session headlessly.

Do not hardcode package names. Discover them either from a running session (`GET /query/status`)
or by asking devtooie directly:

```sh
devtooie resolvedeps <package>
```

which prints that package's build/dev/runtime dependency names as JSON.

### Graceful shutdown

Ctrl+C and `POST /command/quit` funnel through the **same** graceful shutdown, so the teardown is
identical however it's triggered. Each package is given a chance to exit cleanly before it's forced,
in three phases:

1. **`SIGTERM`.** Every package's **process group** is signalled — the package and anything it
   spawned (a package manager, a nested dev server) all receive `SIGTERM` together. This is the
   cue for a package to run its own cleanup and exit.
2. **Grace period.** devtooie waits up to **10 seconds** for each package to exit on its own.
3. **`SIGKILL`.** Any package still alive when the grace period elapses has its process group
   `SIGKILL`ed.

The whole sequence is bounded by a safety net (~15s) so a wedged child can't hang the exit forever.
Once every package is down (ports freed), the control server closes and the process exits. A
**second** Ctrl+C (or a repeat `POST /command/quit`) while a shutdown is already in progress skips
the grace entirely and `SIGKILL`s everything immediately — use it if you don't want to wait out the
grace.

A **blocking `POST /command/quit`** is acknowledged at the end of phase 3 — packages down and ports
freed, just before the control server closes — so a caller that awaits the response knows the ports
are clear the moment it returns. This is how a newer `devtooie` invocation hands off from a running
one: it calls `POST /command/quit`, waits for that ack, and only then binds the ports itself (falling
back to force-killing the old process if it overruns its graceful window). You get the same guarantee
for free — await the response and the session's ports are yours.

If a package needs to flush or persist state on shutdown, do it on `SIGTERM`, and keep it under the
10-second grace or it will be `SIGKILL`ed mid-cleanup.

## Read running-package logs for debugging

A running devtooie session streams the combined stdout/stderr of every package it runs into a
timestamped logfile. The simplest way to read the **current** session's log is the built-in
subcommand:

```sh
devtooie logs        # print the whole current logfile
devtooie logs -f     # ...then stream new lines live (Ctrl+C to stop — the session keeps running)
devtooie logs --path # print just the resolved logfile path (for piping), then exit
```

`devtooie logs` is **strictly read-only** and never starts, hands off, or shuts down a session. It
resolves the current logfile in order of precedence: (1) ask the running instance over the control
API (`GET /query/status` → `logFile`); (2) the `logFile` recorded in `running.json` (kept current
across in-session log rotation — the `t` hotkey — and more precise than scanning the dir, where a
stray `devtooie cmd` log could be newer), if it still exists; (3) the newest logfile in the
session's log directory. (`-f` uses the Unix `tail`/`cat`, so macOS/Linux only; `--path` is
mutually exclusive with `-f`.)

To locate the file yourself instead (e.g. to `grep` an earlier run), the directory devtooie writes
into is recorded in `node_modules/.devtooie/running.json` as **`logDir`**; it defaults to
`node_modules/.devtooie/logs/` and only differs when the session was started with `--log-dir`.
Each session (and each in-session log rotation) writes a **fresh** file named `<timestamp>.log`;
`devtooie cmd` writes one too. devtooie never truncates or overwrites an existing log, so logs
from earlier sessions stay on disk.

```sh
# the session's log dir from running.json, falling back to the default
dir=$(node -e "process.stdout.write(require('./node_modules/.devtooie/running.json').logDir)" 2>/dev/null || echo node_modules/.devtooie/logs)
log=$(ls -t "$dir"/*.log | head -1)   # newest = current session
tail -n 200 "$log"
grep -i error "$log"
```

`ls -t` sorts newest-first, and the running session's file is always the most recently written, so
`$log` is the current session. To dig into an **earlier** run, pick an older file from
`ls -t "$dir"` instead — prior logs are still there.

Mutating commands received over the control API (restart, rebuild, quit) are echoed into the same
log as `[dt:control]` lines, so you can confirm a command you sent actually landed and see the
package's own output that followed it. Each is a structured log: the command is the message, and
the variables it carried are listed as indented properties beneath it.

```
2026-07-23 16:41:22 [dt:control     ] [INFO] restart
2026-07-23 16:41:22 [dt:control     ]   package: backend
```

devtooie's own lifecycle notices (shutdown, git-branch change) are logged the same way under a
`[devtooie]` label — both channels render in a distinct gold so they read apart from package output:

```
2026-07-23 16:41:22 [devtooie       ] [WARN] shutting down...
```

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
   - `port` — the dev port it listens on. devtooie injects this into the package's process as the
     `PORT` env var, so the app can read `process.env.PORT` without you duplicating it in a `.env`
     (an explicit `.env` `PORT` still wins).
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

3. **Verify the graph.** `devtooie resolvedeps <app>` should now list the shared libraries under
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
