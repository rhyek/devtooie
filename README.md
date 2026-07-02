# devtooie

Dependency-aware CLI for running a monorepo's local dev processes.

You describe your apps/services once, in a small typed config file. devtooie
resolves build-time, dev-time, and runtime dependencies between them, builds
whatever needs building (in the right order), and then runs the services you
picked — either in a full terminal UI or a plain log-streaming mode. Other
tooling in your monorepo (a reverse proxy, a codegen script, ...) can import
the same typed config instead of duplicating it.

devtooie ships two things from one package:

- **A library** — `defineAppConfigs`, `AppType`, `findApp`, and supporting
  types, for authoring your services config and importing it from other
  scripts.
- **A CLI binary** (`devtooie`) — driven entirely by a small committed
  `devtooie.yaml` file. There are no `--config`/`--port` flags: the CLI reads
  everything it needs from that file.

## Requirements

- **Node ≥23.6** (Node 24 LTS recommended). devtooie loads your services file
  with a native dynamic `import()` of a `.ts` file, which relies on Node's
  built-in TypeScript type-stripping — available starting in Node 23.6, and
  on by default in Node 24 LTS. If you're on an older Node, point `services`
  (see below) at a compiled `.js`/`.mjs` file instead.
- **Unix only** (macOS/Linux) for now. The dev-session handoff, port
  sweeping, and process-group management devtooie uses under the hood are
  POSIX-specific. Windows is not supported.
- A `package.json` (or `Makefile`) per app with the scripts devtooie drives
  (`dev`, `build`, ...) — see [CLI usage](#cli-usage) below.

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

This is an interactive, idempotent setup flow (re-running it just updates
your answers). It will:

1. Ask whether to install the [agent skill](#agent-skill) (recommended: yes).
2. Ask where your services file lives (default `./services.ts`) — and
   scaffold an empty one there if it doesn't exist yet.
3. Ask which port the local control API should listen on (default `4099`).
4. Write (or update) `devtooie.yaml` at your repo root with those answers.
5. If you opted in to the skill, install it and generate the
   `devtooie-env.d.ts` type-augmentation file (see
   [Type augmentation](#type-augmentation) below).

After that, fill in the scaffolded services file with your real apps (see
below) and run `devtooie`.

## `devtooie.yaml`

This file is the single source of truth the CLI reads on every run — there
are no CLI flags for any of it. It's written and kept up to date by
`devtooie init`, and is meant to be committed:

```yaml
# devtooie.yaml — created/managed by `devtooie init`
services: ./services.ts # path to the defineAppConfigs module (required)
apiPort: 4099 # local control HTTP API port
skill: true # whether the agent skill is installed + kept up to date
```

| Field      | Meaning                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| `services` | Path (relative to the repo root) to the module whose default export is your resolved `defineAppConfigs(...)` array. |
| `apiPort`  | Port for devtooie's localhost-only control API (status/restart/rebuild/quit). Defaults to `4099` if omitted. |
| `skill`    | Whether the [agent skill](#agent-skill) is installed and auto-refreshed on new devtooie versions.            |

If neither `devtooie.yaml` nor `devtooie.yml` exists, the CLI exits with a
message pointing you at `devtooie init`.

## The services file

The one file you author: a single `export default defineAppConfigs({...})`.

```ts
import { defineAppConfigs } from 'devtooie';

export default defineAppConfigs({
  // Values for any extrinsic URL tokens you reference below.
  tokens: { domain: process.env.APP_DOMAIN, proxyport: process.env.PROXY_PORT },
  apps: [
    {
      name: 'core-api',
      types: ['backend'],
      run: {
        port: 3001,
        healthcheck: 'http://localhost::port/health',
      },
    },
    {
      name: 'reverse-proxy',
      types: ['backend'],
      run: {
        selectable: false, // infra dep, never shown in the picker
        healthcheck: 'https://:domain::proxyport/_health',
      },
    },
    {
      name: 'web',
      types: ['browser'],
      run: {
        port: 3000,
        urls: ['https://app.:domain::proxyport'],
        waitFor: ['core-api'],
        deps: { runtime: ['core-api', 'reverse-proxy'] },
      },
    },
  ],
});
```

Each app entry:

- **`name`** — a unique identifier. Referenced from the CLI (`-s <name>`),
  from `waitFor`, and from `deps`.
- **`types`** — one or more of `'backend' | 'browser' | 'lib'`. Drives
  grouping in the interactive selector.
- **`relativeDir`** (optional) — directory containing the app, relative to
  `workspaceDir`. Defaults to `projects/<name>`.
- **`run`** (optional) — everything about how to run/select/link the app;
  omit it entirely for a build-only lib. Notable fields:
  - `selectable` (default `true`) — show in the interactive picker.
  - `port`, `hmrPort` — the app's port(s); used for substitution and swept
    on session handoff.
  - `subdomain` — for reverse-proxy routing; used for `:subdomain`
    substitution.
  - `urls` — strings or `{ label, url }`, shown in the running footer.
  - `healthcheck` — a URL polled for readiness; also required by anything
    that lists this app in its `waitFor`.
  - `waitFor` — app names to wait on (each must define a `healthcheck`)
    before this app starts.
  - `deps.build` / `deps.dev` / `deps.runtime` — see below.

`defineAppConfigs` also accepts:

- **`workspaceDir`** (optional) — root each app's `relativeDir` resolves
  against. Defaults to `process.cwd()`.
- **`tokens`** (optional) — see [Tokens](#tokens).

### Dependencies

Three independent categories, resolved when you select a service:

- **`deps.build`** — extends the build-time deps devtooie already infers
  from your `tsconfig.build.json` project references. Resolved
  transitively.
- **`deps.dev`** — compiled before running; currently behaves like a build
  dep, tracked separately for future divergence.
- **`deps.runtime`** — other services that must be *running* alongside this
  one. **Not transitive**: only the services you explicitly select have
  their runtime deps expanded. If a runtime dep needs its own runtime deps
  too, select it explicitly (or add it to your own selection).

`devtooie resolvedeps -s <name> [...]` prints the resolved build/dev/runtime
sets as JSON, which is handy for wiring other tooling (targeted typechecks,
codegen, etc.) to the same dependency graph.

## Tokens

`urls` and `healthcheck` strings support `:token` substitution, resolved once
at `defineAppConfigs()` call time:

**Intrinsic** (always available, derived from the app's own config):

- `:name` → the app's `name`
- `:port` → `run.port` (throws if the app has no `port`)
- `:subdomain` → `run.subdomain` (first element, if it's an array; throws if
  the app has no `subdomain`)

**Extrinsic** (yours to supply via `tokens: {...}`): any other `:key` in a
`urls`/`healthcheck` string is looked up in the `tokens` map you pass to
`defineAppConfigs`. Referencing a `:key` with no matching entry — or one
whose value is `undefined` — throws immediately, naming the app and the
token, so misconfiguration fails loudly at startup instead of silently.

This keeps devtooie itself free of any hardcoded environment-variable names:
you decide what feeds `tokens` (env vars, computed values, constants).

## Type augmentation

`devtooie init` (when you opt in to the skill) and `devtooie typegen` both
generate a small file — `devtooie-env.d.ts` at your repo root — that wires up
a fully-typed, literal union of your app names for anything that imports
types from `devtooie`:

```ts
// devtooie-env.d.ts — generated by devtooie. Do not edit.
declare module 'devtooie' {
  interface Register {
    appConfigs: typeof import('./services').default;
  }
}
```

Once this exists, `import type { AppConfig, AppName } from 'devtooie'`
narrows to your actual services instead of the generic wide types. It's
regenerated automatically (best-effort, non-fatal on failure) at the start
of every `devtooie` run, so you rarely need to invoke `devtooie typegen`
yourself.

**Add `devtooie-env.d.ts` to your `.gitignore`** — it's a generated file, and
the only one devtooie writes at your repo root. (Everything else devtooie
writes lives under the already-ignored `node_modules/.devtooie/`, or is a
file you're expected to commit, like `devtooie.yaml` and the services file.)

```gitignore
devtooie-env.d.ts
```

## CLI usage

```bash
devtooie                 # interactive TUI: pick services, build, run
devtooie --plain -s web  # no TUI: run `web` (+ its deps), streaming logs
devtooie -s web -s api   # repeatable -s: run multiple named services
devtooie --build -s web  # build `web` + its build-time deps, then exit
devtooie --rebuild -s web # like --build, but clears dist/ first
```

Common options:

| Option | Description |
| --- | --- |
| `-s, --service <name>` | Repeatable. Service(s) to run, bypassing the interactive selector. |
| `--ui` | Interactive terminal UI (default). Mutually exclusive with `--plain`. |
| `--plain` | No TUI — stream logs to stdout with colored name prefixes. Requires `-s` or `--last-answers`. |
| `--last-answers` | Skip selection; reuse the last saved service selection. |
| `--build` | Build the selected services and their build-time deps, then exit (no run phase). |
| `--rebuild` | Like `--build`, but first clears `dist/` for every build target. |
| `--logfile <path>` | Write all service output to this file (truncated each run). Defaults to `node_modules/.devtooie/devlog.txt`. |

Subcommands:

- **`devtooie init`** — interactive setup; see [above](#getting-started-devtooie-init).
- **`devtooie reset`** — clear the saved service selection.
- **`devtooie resolvedeps -s <name> [...]`** — print the resolved
  build/dev/runtime dependency sets as JSON.
- **`devtooie typegen [--out <path>]`** — (re)generate `devtooie-env.d.ts`.

There's no `--config` or `--api-port` flag — the services path and control
API port always come from `devtooie.yaml`.

### Control API

While a session is running (either runner mode), devtooie exposes a
localhost-only HTTP API on `apiPort` (default `4099`):

- `GET /query/pid` — the running session's PID.
- `GET /query/status[/<name>]` / `GET /query/services[?status=...]` — service
  status.
- `POST /command/restart/<name>` / `POST /command/rebuild/<name>` — restart
  or rebuild-then-restart a service.
- `POST /command/quit` — graceful shutdown (same as Ctrl+C).

This is what lets a second `devtooie` invocation cleanly hand off from a
still-running one, and what an external tool (or the agent skill) can use to
drive a session headlessly.

## Agent skill

If you opt in during `devtooie init` (or set `skill: true` in
`devtooie.yaml`), devtooie installs an agent-facing skill file at
`.claude/skills/devtooie/SKILL.md` (and, best-effort, under `.agents/` /
`.cursor/` if those directories already exist). It teaches a coding agent how
to run devtooie headlessly (`--plain -s <service>`), drive a running session
through the control API, read the fixed default logfile for debugging, and
onboard a new app into your services file. The installed file is refreshed
automatically on newer devtooie versions, as long as it hasn't been
hand-edited.

## License

MIT
