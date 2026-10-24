# devtooie

A dependency-aware **terminal UI** (TUI) for running a monorepo's application services during local
development.

_dev_ + _TUI_ → **devtooie**.

You describe your application services once, in a small typed config file. devtooie
resolves the dependencies between them, brings up the infrastructure they need, and
then runs the services you picked.

![devtooie's terminal UI driving the example monorepo](https://raw.githubusercontent.com/rhyek/devtooie/main/packages/devtooie/assets/demo-1786328802.gif)

## Features

- **Dependency-aware.** Declare once which services a service needs; selecting it runs
  them too, and `waitFor` holds it until they answer.
- **Language-agnostic services.** A service is driven through a handful of named
  scripts, so it can be written in anything: a Node service (via its
  `package.json`) or a Go, Rust, … service (via a `Makefile` with the equivalent
  targets). See [Service supporting scripts](#service-supporting-scripts).
- **Streamed, filterable logs.** Every service's output is streamed live into one
  combined view; filter it down to a single service or a search term on the fly
  (the `f` hotkey; matching is case- and accent-insensitive).
- **Structured logs, by default.** devtooie auto-formats every service's JSON logs (Go `slog`,
  pino, winston, …) as a colored `[LEVEL] message` for local dev — no `NODE_ENV` branching in your
  app, and nothing to configure. See [Logging](docs/logging.md).
- **Two run modes.** An interactive terminal UI to pick and watch services, or a
  `--headless` log-streaming mode for coding agents — which can also start the stack in the
  background and wait until it's healthy, for an e2e suite. See
  [Running in the background](docs/cli.md#running-in-the-background---detach).
- **One-off commands.** `devtooie exec` runs a single command, and `devtooie run` one of a
  service's scripts/targets, in a service's directory with that service's resolved
  environment — for migrations, seeds, scrapers, or an agent driving your project. See
  [Running one-off commands](#running-one-off-commands-devtooie-exec-devtooie-run).
- **Per-service hierarchical `.env` loading.** Each service's `.env` files (workspace- and
  service-scoped) are resolved and injected into its process automatically — and
  live-reloaded, restarting the affected service when a file changes.
- **Readiness ordering.** `healthcheck` + `waitFor` hold a service until the
  services it needs are actually up.
- **Infra included.** Point devtooie at your `docker-compose.yaml` and it brings the database,
  cache or broker up before the services start, waits for their healthchecks, and runs your
  migrations — per mode, so a test database never lands on the dev port. `devtooie infra up`
  does the same on its own. See [Infra](docs/infra.md).
- **One hostname per service.** Optionally, devtooie runs the dev reverse proxy itself:
  give a service a `proxy: { subdomain }` and reach it at `http://api.localhost:4000` — or
  `https://api.myproject.test` behind a TLS terminator — instead of a bare port, with a
  status page while the service is stopped or still starting. Vite HMR works through it, and
  an infra service — an object store, a mail catcher — can be routed the same way.
  See [Dev reverse proxy](docs/dev-reverse-proxy.md).
- **Lifecycle-aware.** Each service declares whether its dev process watches or
  just builds, so you (or an agent) know exactly what to do after a code edit.
- **Control API + agent skill.** A localhost HTTP API drives a running session
  headlessly and lets a second invocation hand off cleanly; an installable skill
  teaches a coding agent to use it.

## Example

A complete, runnable example monorepo lives in
[`example/`](https://github.com/rhyek/devtooie/tree/main/example): three application services
under `apps/` — a Node API (`backend`), a Go worker driven through a `Makefile` (`worker`), and a
web `frontend` — wired up with `.env` loading, healthchecks, and `waitFor` readiness ordering.
The code they share lives in workspace libraries under `libs/`, which the services import as
TypeScript source through pnpm `workspace:*` dependencies — nothing to build, and nothing for
devtooie to run. Its Postgres database is a Compose service that devtooie's
[infra](docs/infra.md) brings up and migrates before the backend starts, next to a Mailpit mail
catcher whose web UI the dev reverse proxy routes like a service, so running it needs Docker.

## Requirements

- **Node ≥22.18.** `devtooie.config.ts` is imported directly, so it needs Node's native
  TypeScript type-stripping — unflagged in 22.18 (and, on the 23.x line, 23.6).
- **Unix only** (macOS/Linux). Windows is not supported.
- **pnpm.** A service that imports a workspace library resolves it through a pnpm workspace link
  (`workspace:*`).
- A `package.json` (or `Makefile`) per service with the scripts devtooie drives
  (`dev`, ...) — see [Service supporting scripts](#service-supporting-scripts) below.
- **Docker with Compose v2** — only if the config declares [`infra`](docs/infra.md).

## Install

```bash
pnpm add -D devtooie
```

devtooie's `postinstall` sets the project up as it installs. A project with no
`devtooie.config.ts` yet gets `devtooie init --yes` — the config scaffold, the tsconfig
reconcile, and the [agent skill](#agent-skill); one that already has a config gets the agent
skill (re)written, so a fresh clone or an upgrade always carries the guide matching the installed
version. It acts only for the project that installed devtooie, is skipped in CI, and never fails
an install. Package managers run it when devtooie is installed or upgraded — not on an `install`
that changes nothing — and `devtooie init` does the same by hand at any time.

pnpm 10+ runs a dependency's scripts only once you allow it: run `pnpm approve-builds`, or add
`"pnpm": { "onlyBuiltDependencies": ["devtooie"] }` to the root `package.json`.

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

After that, fill in the scaffolded config's `services` object with your real
services (see below) and run `pnpm devtooie`.

## `devtooie.config.ts`

The one file you author and commit — the single source of truth the CLI reads
on every run.

```ts
import { defineConfig } from 'devtooie';

export default defineConfig({
  serviceRootDir: 'apps',
  // keyed by service name — the key is the name, so there's no `name` field
  services: {
    'core-api': {
      port: 3001, // is provided as PORT environment variable to the process
      // A relative path is resolved against this service's port (or its public origin under
      // the dev reverse proxy); `healthcheck` and `urls` also take a full URL or a callback over
      // `{ envs, tokens, port, subdomain }` — devtooie does no string interpolation of its own.
      healthcheck: '/health',
    },
    worker: {
      // a dev process that doesn't watch files: it builds once, then runs. devtooie
      // doesn't watch your source, so after you edit its code you (or an agent, via the
      // control API) restart it — the command's flags say which. See docs/service-lifecycle.md.
      command: ['start', { watches: false, builds: true }],
    },
    web: {
      port: 3000,
      waitFor: ['core-api'], // hold until core-api's healthcheck passes — typo-checked
      deps: { runtime: ['core-api'] }, // selecting web also runs core-api
      urls: [''], // the footer shows "web" as a link to its origin, http://localhost:3000
    },
  },
});
```

See **[Configuration options](docs/configuration.md)** for every `defineConfig`
and service field.

## Running the Terminal UI

```bash
pnpm devtooie
```

## Service supporting scripts

devtooie drives each service through named scripts — a **Node** service declares them in its
`package.json` `scripts`; a service in any other language (Go, Rust, …) declares the equivalent
**`make` targets** in a `Makefile`. See [How a script is run](#how-a-script-is-run).

A service needs only **`dev`** — the long-running process devtooie starts and streams. A Node
backend, run as TypeScript straight from its source by Node ≥24:

```jsonc
// apps/backend/package.json
{
  "name": "backend",
  "scripts": {
    "dev": "node --watch --watch-path=./src src/index.ts",
  },
}
```

devtooie runs the `dev` script exactly as written, so what the process watches is up to the script.
See [docs/service-lifecycle.md](docs/service-lifecycle.md#scoping-a-node---watch-dev-script) for why
`--watch-path` is worth adding when you use Node's own watcher.

…or a Go program, via a `Makefile`:

```makefile
# apps/worker/Makefile
.PHONY: dev
dev:
	@go run .
```

Code the services share goes in ordinary workspace packages — `libs/db`, say — whose
`package.json` `exports` point at their TypeScript source. A service depends on one with
`workspace:*` and imports it like any other module; there's nothing to build, and a library isn't
part of the devtooie config.

A compiled service can add `build` + `clean` too, for the occasional case where you need to
rebuild it from scratch to clear stale build output — those enable the rebuild command (the `b`
hotkey / `POST /command/service/rebuild/<name>`); see [Service lifecycle](docs/service-lifecycle.md).

### How a script is run

devtooie runs a `package.json` script itself: the script's text goes to `/bin/sh` in the service's
directory, with no package manager in between. A script that is a single command (`vite dev`)
usually becomes the service's process directly, since most shells replace themselves with it;
Debian's and Ubuntu's `/bin/sh` stays as a small parent process. A Makefile target is run as
`make <name>`.

- **`PATH`** starts with the service's `node_modules/.bin`, then that of each parent directory, so
  a script can name a binary installed in the service or at the workspace root.
- **Variables naming the service and script** are set: `npm_package_name`, `npm_package_version`,
  `npm_package_json`, `npm_lifecycle_event`, `npm_lifecycle_script`, plus `INIT_CWD` and
  `PNPM_SCRIPT_SRC_DIR` (both the service's directory). Every other `npm_*` variable is whatever
  devtooie itself was started with.
- **`pre<name>` and `post<name>` scripts are not run.** Put the step in the script itself:
  `"dev": "node codegen.ts && vite dev"`.
- **A package manager's script settings have no effect** (pnpm's `scriptShell`,
  `shellEmulator`, `verifyDepsBeforeRun`, …).
- **Exit code** — a script's exit code is reported as-is; one killed by a signal is reported as
  128 + the signal number (`137` for `SIGKILL`).

## Running one-off commands (`devtooie exec`, `devtooie run`)

Sometimes you don't want the whole session — you just need to run **one** command with a
service's exact environment: a migration, a seed script, a scraper, a REPL. `devtooie exec`
runs a command, and `devtooie run` one of the service's scripts or make targets, in a service's
directory with that service's resolved env vars injected — the same environment the TUI would
give it:

```bash
cd apps/api
devtooie exec -- node src/migrate.ts   # a command, in api's dir with api's env
devtooie run seed -- --rows=100        # api's `seed` script/target, forwarding args
cd ../..
devtooie run -s api seed               # or target a service by name, from anywhere
```

The service is inferred from your current directory (or named explicitly with `-s`). Output
streams to your terminal and is also written to a logfile. It's especially handy for a coding
agent driving your project. Full reference:
[`devtooie exec` and `devtooie run`](docs/cli.md#devtooie-exec-and-devtooie-run).

## Configuration options

The full `defineConfig` and per-service field reference — including dependencies and typed
service names — lives in
**[docs/configuration.md](docs/configuration.md)**.

## Logging

devtooie **auto-formats structured (JSON) logs** — from Go `slog`, pino, winston, … — into a
colored `[LEVEL] message` for local dev, with no `NODE_ENV` branching and nothing to configure.
Every line carries a timestamp (just the time, until two days share the screen), and you can
customize that JSON rendering per service with the `logging` helpers — or, for output that **isn't** JSON, write a `logs.formatter` over the raw line yourself.
See **[docs/logging.md](docs/logging.md)**.

Every session is also teed to a timestamped logfile. Read the current one from another terminal
with **`devtooie logs`** (or `devtooie logs -f` to follow it live) — see
[`devtooie logs`](docs/cli.md#devtooie-logs).

## Service lifecycle when you edit code

A service's `command` flags declare whether its dev process watches or just
builds, which tells you (or an agent) whether to restart or rebuild it after a
code edit. See **[docs/service-lifecycle.md](docs/service-lifecycle.md)**.

## Environment (`.env`) loading

devtooie loads `.env` files for every service it runs and injects them into that
service's child process — merged over the current `process.env` without mutating
it. Parsing is handled by [dotenvx](https://github.com/dotenvx/dotenvx) under the hood.
Files are resolved at **two scopes**: the workspace root and the service's own
directory. Only files that exist are loaded.

```
your-monorepo/
├── .env                     # workspace scope — base for every service
├── .env.local               # workspace scope, higher precedence
├── .env.development         # workspace scope, the default mode
└── apps/
    ├── core-api/
    │   ├── .env              # service scope — overrides workspace scope
    │   └── .env.local        # service scope, higher precedence
    └── web/
        └── .env
```

Files for a mode, **ascending precedence within a scope**:

1. `.env`
2. `.env.local`
3. `.env.<mode>`
4. `.env.<mode>.local`

The two `.local` files are the personal tier — commit `.env` and `.env.<mode>`, and keep
`.env*.local` out of git.

**Service scope overrides workspace scope**, and within a scope a later file
overrides an earlier one. A `${VAR}` reference expands to the value that wins for
that variable: the ambient environment's, or the already-loaded files' where the
ambient environment has none or `env.override` hands the files the win.

**The ambient environment wins over the files**, as in Next.js, Vite and
`node --env-file` — so `FOO=bar devtooie` overrides a file for one run. Ambient
means the environment devtooie was started with: a variable only the files define
takes its highest-ranked file's value, so a service's file replaces the
workspace's. Name the exceptions with `env.override` when a
file needs to *extend* an inherited value:

```ts
defineConfig({
  serviceRootDir: 'apps',
  env: { override: ['NODE_OPTIONS'] },   // or `true` for every variable
  services: {/* … */},
});
```

With that, `NODE_OPTIONS=$NODE_OPTIONS --flag` appends to whatever the shell
already set instead of losing to it.

`env.vars` sets variables from the config itself — a record, or a callback that
computes them from the environment — for every service, one-off command and
[infra](docs/infra.md) service. They rank as a file read before `.env`: any file
that defines the same variable overrides it, and so does the ambient environment
(unless `env.override` names the variable):

```ts
defineConfig({
  serviceRootDir: 'apps',
  // shorthand for `env: { vars: ({ envs }) => ({ … }) }`
  env: ({ envs }) => ({ WORKSPACE_DIR: envs.DEVTOOIE_WORKSPACE_DIR }),
  services: {/* … */},
});
```

See [`env.vars`](docs/configuration.md#envvars).

### Modes

`--mode <name>` picks which `.env.<mode>` files load; it defaults to
`development`, so plain `devtooie` loads `.env.development`.

```sh
devtooie --mode test               # loads .env.test / .env.test.local
devtooie --mode test exec -- vitest # same environment, one-off command
```

Any name works (`test`, `staging`, `e2e`), and the mode is passed to every child
process as `DEVTOOIE_MODE`. **Modes are exclusive** — `--mode test` does *not*
load `.env.development` — so values shared across modes belong in `.env` and
`.env.local`, which load in every mode.

**One session per mode.** A workspace runs one devtooie session per mode, side by side: a
`devtooie --mode test` session for an e2e run starts next to the `development` session you're
working in, and neither touches the other — each keeps its own record, logs, and processes.
Starting a second session in the **same** mode takes that mode's session over (see
[Taking over a running session](docs/cli.md#taking-over-a-running-session)). For two modes to run
at once, give each its own ports in its `.env.<mode>` file.

`--mode` deliberately leaves `NODE_ENV` alone (a mode name is free-form, and
`NODE_ENV` isn't). Set it from the mode's own file if you want it:
`NODE_ENV=test` in `.env.test`.

With a [dev reverse proxy](docs/dev-reverse-proxy.md) configured, a routable service also gets
`PUBLIC_ORIGIN` (its public `<urlScheme>://<subdomain>.<rootDomain>[:<port>]`, from its
`proxy.subdomain`, or the bare `<urlScheme>://<rootDomain>[:<port>]` for a `defaultService` with
no `proxy`), under the same rule.

A service's `port` is also injected as `PORT`. It wins over a `PORT` set
workspace-wide — in a workspace `.env` file or `env.vars` — and only a `PORT` in
the service's own `.env` file overrides it. The reverse direction works too — `port` may be a callback
that reads these same resolved files to decide the port:

```ts
backend: { port: ({ envs }) => Number(envs.BACKEND_PORT) }
```

`healthcheck` and `urls` take the same kind of callback, which additionally gets the
resolved `port`. `healthcheck` also accepts `{ url, timeout }`, for a service slow to
answer while it warms up — see
[Readiness probing](docs/configuration.md#readiness-probing). See
[Configuration](docs/configuration.md) for the details.

While a session runs, devtooie **watches these files (and where new ones would
appear) and restarts the affected service(s)** when one's content changes —
editing a workspace-level file restarts every running service that uses it. A
file that is a symlink is followed, through any symlinked directories on the way,
so editing the file it points to restarts the same services. A write that leaves
the content as it was, such as a `touch` or a sync client updating the file's
metadata, restarts nothing.

The same resolution is available as a standalone command: from inside a service's directory,
`devtooie exec -- <command>` runs a one-off command **in** that service's dir with its resolved
env, and `devtooie run <script>` one of its scripts/targets — see
[`devtooie exec` and `devtooie run`](docs/cli.md#devtooie-exec-and-devtooie-run).

### Variables devtooie sets

devtooie sets these in its own environment before the config loads, so they are in every
callback's `envs`, in every process it starts, and open to a `${VAR}` reference in a `.env` file:

| Variable                 | Value                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `DEVTOOIE_MODE`          | The active [mode](#modes).                                                                             |
| `DEVTOOIE_CWD`           | The directory devtooie was invoked in: the workspace root, or wherever below it the command was typed. |
| `DEVTOOIE_WORKSPACE_DIR` | The workspace root — the directory holding `devtooie.config.ts`.                                       |

They are typed on a callback's `envs`, so an editor completes `envs.DEVTOOIE_WORKSPACE_DIR`.

A script that imports the config without devtooie still finds all three in each callback's
`envs`: the default mode, its own working directory, and the config's `workspaceDir`.

Every process devtooie starts also gets `DEVTOOIE_INJECTED_ENV`: a comma-separated list of the
variables devtooie gave it that the shell devtooie was started in didn't set, or set to another
value — `.env` values, `env.vars`, `PORT`, `PUBLIC_ORIGIN` and the like. A devtooie started from
such a process (an e2e suite that `devtooie run` started, calling devtooie again) drops those
variables first, so its own `.env` files load as if from a clean shell, while variables the real
shell set still win as usual. `DEVTOOIE_MODE` is never in the list, so a nested devtooie runs in
the outer one's mode unless `--mode` says otherwise.

## Advanced CLI usage

Every flag and subcommand — plus `devtooie exec` and `devtooie run` for running a command or a
script in a service's environment on demand, `devtooie show-config` for printing the fully resolved config as JSON
without a session, and `devtooie infra` for the project's [infrastructure](docs/infra.md) — is
documented in **[docs/cli.md](docs/cli.md)**.

## Agent skill

If you opt in during `devtooie init`, devtooie installs an agent-facing skill
file at `.claude/skills/devtooie/SKILL.md` (and, best-effort, under `.agents/` /
`.cursor/` if those directories already exist). It teaches a coding agent how
to check whether an app in the repo is already running, run devtooie headlessly
(`--headless -s <service>`), start a stack in the background for tests
(`--headless --detach --wait`), drive a running session through the control API, bring the project's
[infra](docs/infra.md) up or reset it, read the logfile for debugging, and onboard a new service. The installed file is **managed** — treat it as generated, not something
to hand-edit. `devtooie init` and every `devtooie` run refresh it to the
installed version.

The skill points the agent at a single consolidated guide,
**[packages/devtooie/docs/agents.md](packages/devtooie/docs/agents.md)** — the same
material as this README plus how to drive devtooie headlessly, in one self-contained
file. It's the one doc that ships inside the npm package (so the skill can load it from
`node_modules`); the topic docs above live at the repo root.

## Infra

Databases, caches and brokers aren't application services, but your services need them running.
Declare them as infra services with a top-level `infra` block — `infra: { 'docker-compose': true }`
is enough for a self-contained `docker-compose.yaml` — and devtooie brings them up and waits for
their healthchecks **before starting the services**, then leaves them running when you quit.

```sh
devtooie infra up              # the same step on its own: start, wait until ready, exit
devtooie infra up --reset db   # wipe one infra service's data and start it clean
devtooie infra docker-compose logs -f db   # Compose itself, bound to this project and mode
```

Per-service callbacks (`beforeUp`, `afterReady`, `beforeDestroy`, `afterDestroy`) run your
migrations and seeds and can drive the running session (stop an application service while its
database is reset, say), `enabled` switches an infra service off by mode or by a missing
variable, a `port` and a `proxy` route it through the [dev reverse proxy](#dev-reverse-proxy) like
an application service, `urls` give it footer links, and each [mode](#modes) gets its own Compose
project, so `--mode test` has its own containers and ports.
In a session, the footer shows each infra service's live state, and one selected with the
arrow keys can be started, stopped, restarted or reset from it — or from the
[control API](docs/control-api.md).
See **[docs/infra.md](docs/infra.md)**.

## Dev reverse proxy

devtooie can run the project's dev reverse proxy itself: a loopback listener that routes
`<subdomain>.<rootDomain>` to the application service or [infra](docs/infra.md) service whose
`proxy` declares that subdomain, answering with a status page for a service that is stopped or still
starting. A TLS terminator (Caddy, say) forwards
`*.<rootDomain>` to it. Enable it with a top-level `devReverseProxy` block — see
**[docs/dev-reverse-proxy.md](docs/dev-reverse-proxy.md)**.

## Control API

While a session runs, devtooie exposes a localhost-only HTTP API for driving it
(start, stop, restart or rebuild a service, query status, hand off between invocations). See
**[docs/control-api.md](docs/control-api.md)**.

## License

MIT
