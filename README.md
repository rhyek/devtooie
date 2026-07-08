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
2. Ask which port the local control API should listen on (default `4099`).
3. Scaffold `devtooie.config.ts` at your repo root with those answers (an
   existing config file is left untouched).
4. If you opted in to the skill, install it.

After that, fill in the scaffolded config's `packages` array with your real
packages (see below) and run `devtooie`.

## `devtooie.config.ts`

The one file you author and commit — the single source of truth the CLI reads
on every run. There are no CLI flags for any of it. It holds your control-API
port, whether the agent skill is managed, and your package definitions, and it
wires your package *names* into devtooie's exported types via a small inline
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
  apiPort: 4099, // local control HTTP API port (default 4099)
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

| Field      | Meaning                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| `packages` | Your package definitions (see below).                                                                        |
| `apiPort`  | Port for devtooie's localhost-only control API (status/restart/rebuild/quit). Defaults to `4099` if omitted. |
| `skill`    | Whether the [agent skill](#agent-skill) is installed and auto-refreshed on new devtooie versions.            |
| `workspaceDir` | Root each package's `relativeDir` resolves against. Defaults to `process.cwd()`.                          |
| `tokens`   | Values for extrinsic `$token` substitution — see [Tokens](#tokens).                                          |

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
  - `urls` — strings or `{ label, url }`, shown in the running footer.
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
- **`deps.runtime`** — other packages that must be *running* alongside this
  one. **Not transitive**: only the packages you explicitly select have
  their runtime deps expanded. If a runtime dep needs its own runtime deps
  too, select it explicitly (or add it to your own selection).

`devtooie resolvedeps -p <name> [...]` prints the resolved build/dev/runtime
sets as JSON, which is handy for wiring other tooling (targeted typechecks,
codegen, etc.) to the same dependency graph.

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
whose value is `undefined` — throws immediately, naming the package and the
token, so misconfiguration fails loudly at startup instead of silently.

This keeps devtooie itself free of any hardcoded environment-variable names:
you decide what feeds `tokens` (env vars, computed values, constants).

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

| Option | Description |
| --- | --- |
| `-p, --package <name>` | Repeatable. Package(s) to run, bypassing the interactive selector. |
| `--ui` | Interactive terminal UI (default). Mutually exclusive with `--plain`. |
| `--plain` | No TUI — stream logs to stdout with colored name prefixes. Requires `-p` or `--last-answers`. |
| `--last-answers` | Skip selection; reuse the last saved selection. |
| `--build` | Build the selected packages and their build-time deps, then exit (no run phase). |
| `--rebuild` | Like `--build`, but first clears `dist/` for every build target. |
| `--logfile <path>` | Write all package output to this file (truncated each run). Defaults to `node_modules/.devtooie/devlog.txt`. |

Subcommands:

- **`devtooie init`** — interactive setup; see [above](#getting-started-devtooie-init).
- **`devtooie reset`** — clear the saved package selection.
- **`devtooie resolvedeps -p <name> [...]`** — print the resolved
  build/dev/runtime dependency sets as JSON.

There's no `--config` or `--api-port` flag — the control API port always comes
from `devtooie.config.ts`.

### Control API

While a session is running (either runner mode), devtooie exposes a
localhost-only HTTP API on `apiPort` (default `4099`):

- `GET /query/pid` — the running session's PID.
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
refreshed automatically on newer devtooie versions, as long as it hasn't been
hand-edited.

## License

MIT
