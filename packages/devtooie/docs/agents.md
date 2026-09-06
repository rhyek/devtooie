# devtooie — agent guide & reference

devtooie is a dependency-aware CLI that runs a monorepo's local dev processes. It resolves
build-time, dev-time, and runtime dependencies between packages, builds whatever needs
building (in the right order), and runs the packages you pick — driven by a small typed
config file (`devtooie.config.ts`).

**This single file is the complete guide for a coding agent:** how to tell whether an app is
already running, drive devtooie headlessly, control a running session over its HTTP API, onboard a
package, read logs for debugging, plus the full configuration/CLI/API reference. It consolidates everything a human
reads across the README and the topic docs, so you only need this one file.

> **To reach a package — call it with `curl`, open its URL, find its port or hostname — run
> `devtooie show-config` first.** It prints the fully resolved config as JSON with no session
> running: each package's `publicOrigin` (the hostname it's served at) and `port`. Never guess a
> port or hostname from a config file or a `.env` — the resolved values are the truth. See
> [Reach a package](#reach-a-package-devtooie-show-config).

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
- **One hostname per package.** Optionally, devtooie runs the dev reverse proxy itself: give a
  package a `subdomain` and reach it at `http://api.localhost:4000` — or
  `https://api.myproject.test` behind a TLS terminator — instead of a bare port, with a status
  page while the package is stopped or still starting. Vite HMR works through it. See
  [Dev reverse proxy](#dev-reverse-proxy).
- **Lifecycle-aware.** Each package declares whether its dev process watches or just builds,
  so you know exactly what to do after a code edit.
- **Control API + agent skill.** A localhost HTTP API drives a running session headlessly and
  lets a second invocation hand off cleanly.

## Reach a package (`devtooie show-config`)

Before you `curl` a package, open it in a browser, or write code that calls it, ask devtooie
where it is:

```bash
devtooie show-config                 # the whole resolved config, as JSON
devtooie show-config --mode test     # resolved against .env.test files (default mode: development)
devtooie show-config | jq '.packages | map_values({port, publicOrigin, healthcheck})'
```

This needs **no running session** — it loads `devtooie.config.ts` exactly as a session would
(callbacks run, defaults applied, `command` normalized) and prints the same object a session
reports as `config` on `GET /query/status`. For each package you get, among the rest:

```jsonc
{
  "devReverseProxy": { "port": 4000, "rootDomain": "myproject.example.test", "defaultPackage": "web", "urlScheme": "https" },
  "packages": {
    "api": {
      "name": "api",
      "port": 3001, // what the package binds on localhost (injected as PORT)
      "publicOrigin": "https://api.myproject.example.test", // where it is served (injected as PUBLIC_ORIGIN)
      "healthcheck": { "url": "http://localhost:3001/health", "timeout": 1500 },
      "urls": [{ "label": "api.myproject.example.test", "url": "https://api.myproject.example.test" }],
      "path": "/abs/packages/api"
    }
  }
}
```

**Which URL to use:**

- **`publicOrigin` present** → the package is routed by the [dev reverse proxy](#dev-reverse-proxy):
  `curl https://api.myproject.example.test/todos`. That is the same origin a browser uses, and
  the one the app itself is configured for (its `PUBLIC_ORIGIN`). If the session is down or the
  package is still starting you get a **503 with `Retry-After`** naming the package and its status,
  not a connection error — see [Status pages](#status-pages). With a plain `localhost` root the
  origin already carries the proxy port (`http://api.localhost:21050`); `*.localhost` names
  resolve in browsers but not for `curl`, so pass the host explicitly:
  `curl -H 'Host: api.localhost' http://127.0.0.1:21050/todos`.
- **No `publicOrigin`** → the package is not routed; talk to it directly on loopback at its
  `port`: `curl http://localhost:3001/todos`. This works in every setup, proxy or not, but only
  while the package is running.
- **`healthcheck.url`** is the readiness probe devtooie itself polls — the right thing to hit to
  find out whether the package is up, and what `packages.<name>` on `/query/status` reflects.
- The `devReverseProxy.port` is the proxy's own listener, for the TLS terminator in front of it;
  you normally don't call it directly unless the root is plain `localhost` (above).

`--mode` matters: a `port` or `rootDomain` written as a callback over `envs` resolves against that
mode's `.env` files, so pass the same `--mode` the session runs with.

## Requirements

- **Node ≥22.18.** `devtooie.config.ts` is imported directly, so it needs Node's native
  TypeScript type-stripping — unflagged in 22.18 (and, on the 23.x line, 23.6). On older Node
  every command fails with `ERR_UNKNOWN_FILE_EXTENSION` for the config file.
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
  // Keyed by package name — the key IS the name, so there is no `name` field.
  packages: {
    'core-api': {
      port: 3001, // Is provided as PORT environment variable to the process
      // A relative path is resolved against this package's port (or its public origin under
      // the dev reverse proxy); `healthcheck` and `urls` also take a full URL or a callback over
      // `{ envs, tokens, port, subdomain }` — devtooie does no string interpolation of its own.
      healthcheck: '/health',
    },
    worker: {
      // A dev process that doesn't watch files: it builds once, then runs. devtooie
      // doesn't watch your source, so after you edit its code you (or an agent, via the
      // control API) restart it — the command's flags say which. See Package lifecycle.
      command: ['start', { watches: false, builds: true }],
    },
    web: {
      port: 3000,
      waitFor: ['core-api'], // Hold until core-api's healthcheck passes — typo-checked
      deps: { runtime: ['core-api'] }, // Selecting web also runs core-api
    },
  },
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
    "dev": "node --watch --watch-path=./src src/index.ts",
  },
}
```

devtooie runs the `dev` script exactly as written, so what the process watches is up to the script.

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

| Field          | Meaning                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages`     | Your package definitions, **keyed by package name** (see below).                                                                                                                              |
| `workspaceDir` | Root each package's `relativeDir` resolves against. Defaults to `process.cwd()`.                                                                                   |
| `env`          | Environment-loading options — currently just `override` (which variables a `.env` file may win over the ambient environment for). Which files load is chosen with `--mode`. See [Environment loading](#environment-env-loading). |
| `logs`         | Log display options: `{ timestamps?: boolean }` (default `false`) — see [Log timestamps](#log-timestamps).                                                         |
| `apiPort`      | Pin the [control API](#drive-a-running-session-via-the-control-api) port (otherwise chosen automatically).                                                         |
| `urls`         | Workspace-wide footer links, not tied to a package. Same shape as a package's `urls`, but a callback here gets only `{ envs, tokens }` (no package, so no `port`). |
| `tokens`       | Values of your own, handed to every callback as `tokens` (a package's own `tokens` are merged on top) — see [Callbacks](#callbacks-instead-of-interpolation).      |
| `devReverseProxy` | Run devtooie's own dev reverse proxy, routing `<subdomain>.<rootDomain>` to packages by their `subdomain`. `{ port, rootDomain?, defaultPackage?, urlScheme? }`; present = enabled. See [Dev reverse proxy](#dev-reverse-proxy). |

`packages` is an object **keyed by package name**:

```ts
packages: {
  api: { port: 3001, healthcheck: '/health' },
  web: { port: 3000, waitFor: ['api'] },
  isomorphic: { selectable: false }, // a build-only lib needs no fields at all
}
```

The key is the package's name — what `-p <name>` takes, what `waitFor`/`deps` reference, and
what `relativeDir` defaults from. **There is no `name` field**, names can't drift, and every
name reference is type-checked against the keys. Integer-like keys (`'2'`) are rejected at load
time, since JavaScript reorders them and that would change start order.

Each package's value has a flat set of fields, all optional (omit them all for a build-only
lib):

- **`relativeDir`** — directory containing the package, relative to `workspaceDir`. Defaults
  to `packages/<key>`.
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
- **`port`** — the package's dev port; injected as `PORT`, handed to this package's `healthcheck`/`urls` callbacks, and swept on session handoff. May be a **callback** deriving it from the package's [environment](#environment-env-loading) — see [Callbacks instead of interpolation](#callbacks-instead-of-interpolation). Return `undefined` for "no port" (same as omitting the field); returning `NaN` — the usual sign of a missing variable — is an error naming the package and the env files that were loaded. Declaring a `port` is what lets this package's other callbacks use `port` — see [The `port` in a callback](#the-port-in-a-callback).
- **`subdomain`** — the package's dev subdomain, a string or an array of them (the first is the
  canonical subdomain, the rest are aliases). It is data for tooling that reads the exported
  config — a reverse proxy building its routing table from each package's `subdomain` and
  resolved `port` (`config.packages.api.subdomain`). With a
  top-level [`devReverseProxy`](#dev-reverse-proxy), devtooie is that proxy: it routes
  `<subdomain>.<rootDomain>` to this package's `port` (aliases too) and injects `PUBLIC_ORIGIN`
  into its process. Without one, devtooie doesn't use it. Either way the canonical entry is
  handed to this package's callbacks as `subdomain` — see
  [Callbacks](#callbacks-instead-of-interpolation). Each entry must be a DNS label — lowercase
  letters, digits, and hyphens, not starting or ending with a hyphen, at most 63 characters —
  and no two packages may declare the same one, canonical or alias.
- **`urls`** — links shown in the running footer, one entry per line. Each entry is a URL, a
  `{ label, url }`, or an **array** of those (rendered on the same line, space-separated). Any
  URL may be a callback, and any may be a **path** (`'/todos'`, or `'todos'`), based on the package's public
  origin under the [dev reverse proxy](#dev-reverse-proxy) — one link, not a localhost one too —
  or on `http://localhost:<port>` without one. A path on a package with no `port` is an error.
- **`healthcheck`** — a URL polled for readiness; also required by anything that lists this
  package in its `waitFor`. A **path** (`'/health'`, or `'health'`) is probed at `http://localhost:<port>/health`
  — always the package itself, never through the dev reverse proxy. May be a callback, or
  `{ url, timeout }` to give this package's probes longer than the 1500 ms default. See
  [Readiness probing](#readiness-probing).
- **`waitFor`** — package names to wait on (each must define a `healthcheck`) before this
  package starts. Type-checked against the keys of `packages`.
- **`tokens`** — values of your own for this package's callbacks, merged **over** the top-level
  `tokens`. Only declare it where the package has tokens — never `tokens: {}`. See
  [Typed tokens](#typed-tokens).
- **`tsconfig`** — the tsconfig file (relative to the package dir) devtooie reads for this
  package's project references. Defaults to `tsconfig.build.json`, then `tsconfig.json`. See
  [project references](#typescript-project-references--shared-libraries).
- **`deps.build`** / **`deps.dev`** / **`deps.runtime`** — see below.
- **`logs`** — per-package log options `{ timestamps?, formatter? }`. `timestamps` overrides the
  top-level [`logs.timestamps`](#log-timestamps) for this package (inheriting it when omitted);
  `formatter` (`(line: string) => string`) **overrides the default structured-log formatter** that
  devtooie already applies to every package. See [Structured logs](#structured-logs).

### Callbacks instead of interpolation

devtooie does **no string interpolation**. A value that depends on the port, the environment, or
anything else is written as a plain function of it — ordinary TypeScript, checked by the compiler,
with nothing to escape. A `$` in a config string is just a `$`.

`port`, `healthcheck`, and every `urls` entry (including the `url` inside a `{ label, url }`)
accept either a literal or a callback — as do the top-level `devReverseProxy.port` and
`rootDomain`, over the workspace context `{ envs, tokens }`. For a URL of this package's own,
a **relative path** is the literal to reach for first: it needs no callback at all, since devtooie
resolves it against the package's port (or its public origin under the dev reverse proxy).

```ts
export default defineConfig({
  tokens: { domain: 'example.test' },
  packages: {
    backend: {
      tokens: { region: 'us-east' },
      port: ({ envs }) => Number(envs.BACKEND_PORT),
      healthcheck: '/health', // a path: resolved against this package's port, no callback needed
      urls: [
        '/todos',
        // `tokens` here is { domain, region } — both typed
        { label: 'public', url: ({ tokens }) => `https://${tokens.region}.${tokens.domain}` },
      ],
    },
  },
});
```

Each callback receives one object:

| Key      | What it is                                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `envs`   | The package's `.env` files resolved and merged with `process.env` (which wins by default) — the same environment the dev process gets. See [Environment loading](#environment-env-loading). |
| `tokens` | The top-level `tokens` with this package's own `tokens` merged **over** them. Typed from what you declared, so a typo is a compile error.                               |
| `port`   | The package's resolved `port`, typed **`number`** (not `number \| undefined`) so it drops straight into a URL. A package that declares no `port` has nothing to give, which types can't express here — so reading `port` in that case throws when the config loads, naming the package. Not offered to `port` itself, nor to the workspace-wide `urls`. |
| `subdomain` | The package's canonical `subdomain` — the first entry when it declared several — so a URL can be built from it without repeating it: `` urls: [({ subdomain, envs }) => `https://${subdomain}.${envs.LOCALDEV_DOMAIN}`] ``. Plain data, unlike `port`: `undefined` (in type and in value) for a package that declares none, so branch on it if a callback has to work either way. Not offered to `port`, nor to the workspace-wide `urls`. |

Callbacks run **once**, while the config is being defined, and must be synchronous. A `port`
callback returns a number (or `undefined`); the rest return a string.

#### Typed tokens

`tokens` is typed from what you write: `tokens.region` is a known key, `tokens.regoin` is a
compile error, and a package's own tokens are **private to that package** — `api`'s `region` is
not a key on `web`'s `tokens`.

Declare them only where you have them. A package with no tokens of its own writes nothing (no
`tokens: {}` needed):

```ts
export default defineConfig({
  tokens: { domain: 'example.test', proto: 'https' },
  packages: {
    api: {
      tokens: { region: 'us-east', proto: 'http' }, // `proto` overrides the config's
      // tokens is { domain, proto, region } — all typed
      healthcheck: ({ tokens, port }) =>
        `${tokens.proto}://${tokens.region}.${tokens.domain}:${port}`,
    },
    web: {
      // no `tokens` here — `tokens.region` below would be a compile error
      healthcheck: ({ tokens, port }) => `${tokens.proto}://${tokens.domain}:${port}`,
    },
  },
});
```

A package's own tokens are an **override**, not a merge: a key it redeclares replaces the
config's, for that package only.

The resolved tokens are on the exported config too, keyed by package name, so other scripts can
read them:

```ts
import config from './devtooie.config.js';

config.packages.api.tokens.region; // 'us-east'
config.packages.web.tokens.domain; // 'example.test'
config.packages.web.tokens.region; // compile error — that's api's
```

You can also skip `tokens` entirely and close over ordinary `const`s in the config file — just
as typed, with no rules to remember.

### Readiness probing

A package with a `healthcheck` is polled while it runs: the footer dot turns green once a probe
passes, and any package listing it in `waitFor` starts at that moment. devtooie probes each
package in exactly one place, no matter how many others wait on it.

Probes never overlap. The next one starts **2 s after the previous one started** — so a fast
answer leaves an idle gap, while a probe that runs past 2 s is followed immediately.

A probe that hasn't answered within `timeout` — **in milliseconds**, 1500 by default — is
aborted. Raise it for a
service slow to answer on a cold start: devtooie hanging up mid-request is itself what makes such
a server log a dropped connection (`ECONNRESET`, `Error: aborted`), and the aborted probe leaves
the package showing `starting` until the next one lands.

```ts
packages: {
  api: {
    port: 3001,
    healthcheck: {
      url: '/health', // a path: probed at http://localhost:<port>/health
      timeout: 10_000,
    },
  },
}
```

`timeout` is per package, so raising it slows that package's polling and affects no other.

#### The `port` in a callback

A callback's `port` is typed **`number`**, not `number | undefined`, so it goes straight into a
URL or arithmetic with no `!` or `??`:

```ts
healthcheck: ({ port }) => `http://localhost:${port}/health`,
urls: [({ port }) => `http://localhost:${port + 1}/debug`],
```

That holds for a literal `port: 3000` and for a `port` callback alike. Whether a package
declared a `port` at all is the one thing that **can't** be reflected in the type: a mapped type
infers exactly one type parameter, and this config spends it on per-package
[`tokens`](#typed-tokens).

So the guarantee is enforced when the config loads instead. If a package with no `port` reads
`port` in a callback, devtooie throws immediately, naming the package:

```
api: a callback read `port`, but this package declares no `port`. Add `port` to api in
devtooie.config.ts, or drop `port` from the callback.
```

Every callback runs once, while the config loads, so this surfaces on the very next command —
rather than quietly producing `http://localhost:undefined/health`. A package with no `port`
whose callbacks never mention `port` is unaffected.

The **resolved** `port` on the exported config stays honest, since a package really may not have
one:

```ts
config.packages.api.port; // number | undefined
```

### Log timestamps

By default log lines are shown without a timestamp. Set `logs.timestamps: true` to prefix
every on-screen log line (both the interactive TUI and `--plain` output) with a
`YYYY-MM-DD HH:MM:SS` local-time (24-hour) stamp:

```ts
export default defineConfig({
  logs: { timestamps: true },
  packages: {/* … */},
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
  packages: {
    api: {}, // inherits → no timestamps on screen
    worker: { logs: { timestamps: true } }, // overrides → timestamps on screen
  },
});
```

### Structured logs

**Rarely something to configure:** most dev processes log plain text (passed through untouched),
and for the apps that do emit structured **JSON** in dev the default formatter already handles the
common cases — only reach for `logs.formatter` if a package's JSON logs aren't rendering right.

Some services log **structured JSON in every environment** (Go's `log/slog`, Node's pino/winston)
rather than branching the logger on `NODE_ENV`. **devtooie handles this out of the box** — it
applies a default formatter to _every_ package's output that passes **non-JSON** lines through
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

**The `logging` helpers** (exported from `devtooie`) override a package's formatter. **They are for
structured (JSON) logs only** — each builds a formatter that parses every line as JSON and
configures how a _recognized log object_ is displayed, passing anything else through untouched. On a
process that logs plain prose they do nothing. To reshape arbitrary text output, write
`logs.formatter` by hand (below): a plain `(line: string) => string` over the raw line, with no JSON
assumption.

```ts
import { defineConfig, logging } from 'devtooie';

export default defineConfig({
  packages: {
    'go-svc': {}, // no config — slog's string levels just work via the default
    api: { logs: { formatter: logging.nodejs.pino.formatter() } }, // pino numeric levels
    web: { logs: { formatter: logging.nodejs.winston.formatter() } }, // winston message key + levels
  },
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

`config` may instead be a **callback** returning the config for the entry being rendered. It
receives the **parsed log** — devtooie does the parsing, so there is nothing to `JSON.parse` and no
non-JSON line to guard against — e.g. hiding a field only on certain events:

```ts
logging.formatter((log) => ({
  fields: {
    custom: {
      time: { show: false }, // hidden on every entry
      ...(log.context === 'healthcheck' ? { at: { show: false } } : {}),
    },
  },
}));
```

The whole config is per-entry, not just `fields.custom` — `levels` and the level/message keys can
vary too, for a stream carrying logs from more than one source. The ecosystem helpers accept the
callback form and keep their defaults, so `logging.nodejs.pino.formatter((log) => …)` still maps
pino's numeric levels. The callback runs once per **JSON-object** line: lines that aren't a JSON
object never reach it, while a JSON object with no recognizable level/message does (it chooses those
keys, so it runs before that check) and then passes through unformatted.

Or write your own — **the general hook**, and the right one when the output _isn't_ JSON (or is, but
needs a rendering the built-in formatter can't express): `logs.formatter` is just
`(line: string) => string` — return the display
string, or the line unchanged to pass it through. A formatter owns the presentation of the lines it
actually **rewrites**; one returned unchanged is rendered exactly as it would be with no formatter
configured — plain for stdout, **red for stderr** — so passing a line through never costs it its
color. A formatter that throws or returns a non-string
falls back to the raw line, so a bug can't take down the session. The returned string is what's
buffered, shown, **and written to the log file** (ANSI color allowed, stripped for the file); a
multi-line result is split into separate log lines, which devtooie keeps grouped as **one entry** —
so a filter matching any of them shows the whole block. That grouping comes from the split itself,
not from how the lines look, so you don't have to indent them to hold an entry together.
**devtooie owns the timestamp** (shown per
`logs.timestamps`, always in the log file), so drop the log's own time field rather than printing
it. `z` (zod) is re-exported by devtooie, so a hand-written formatter can validate shapes without a
dependency.

The [`example/`](https://github.com/rhyek/devtooie/tree/main/example) monorepo's Go `worker` (slog)
shows both config shapes: the plain object that only hides slog's `time`, and the callback it
actually runs, which additionally drops the `port` its base logger stamps on every line — useful on
the startup lines, noise on the heartbeat that repeats every 5s.

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

## Dev reverse proxy

devtooie can run the project's dev reverse proxy itself. A TLS terminator on the machine
(Caddy, say — not devtooie's concern) forwards `*.<rootDomain>` to one loopback port per
project; devtooie owns that port and routes each request by the first label of its `Host`
header to the package that declares that `subdomain`, on that package's resolved `port`.

Because devtooie also knows every package's live status, the proxy can **answer for a package
that is stopped or still starting** — a page saying so, rather than a bare connection error.

The proxy does no TLS, no path-based routing, and no auth.

### Config

```ts
export default defineConfig({
  devReverseProxy: {
    port: ({ envs }) => Number(envs.DEV_REVERSE_PROXY_PORT), // number | callback
    rootDomain: ({ envs }) => `myproject.${envs.LOCALDEV_DOMAIN}`, // string | callback, default 'localhost'
    defaultPackage: 'web', // optional: what the bare rootDomain routes to
    urlScheme: 'https', // optional; defaults from rootDomain: http on localhost, https elsewhere
  },
  packages: {
    web: { port: 3000, subdomain: ['web', 'www'] },
    api: { port: 3001, subdomain: 'api', healthcheck: '/health' },
    worker: { port: 3002 }, // a port but no subdomain: simply not routed
  },
});
```

- **The block's presence enables the proxy.** There is no `enabled` flag; remove the block to
  turn it off.
- **`port`** and **`rootDomain`** take a literal or a callback over the workspace-scope context
  `{ envs, tokens }` (the same one the workspace-wide `urls` get), resolved once at load like a
  package `port`. A callback returning `NaN` or an empty string is an error naming the field
  and the env files that were loaded. `rootDomain` defaults to **`localhost`**, which browsers
  resolve to loopback with nothing in front (see [No terminator](#no-terminator-plain-localhost)).
- **`defaultPackage`** — the package the bare `rootDomain` routes to. Must declare a `port`.
  Without it the bare root is a 404.
- **`urlScheme`** — `'http' | 'https'`. The scheme of the public URLs devtooie derives (footer
  links, `PUBLIC_ORIGIN`), and with it whether they carry a port. **Defaults from `rootDomain`**:
  `http` on `localhost`, `https` on any other root. `http` means the browser hits the proxy
  directly, so the URLs carry the proxy `port` — how a plain `localhost` setup works with nothing
  in front; `https` means a TLS terminator sits in front, so they carry no port. So the same
  package is `http://api.localhost:4000` under the default root and `https://api.myproject.test`
  under a custom one, with nothing else to set.

**Routable packages** are those declaring both `subdomain` and `port`. A package with a port
but no subdomain is simply not routed. Validation, when the block is present:

- `rootDomain` is a lowercase hostname (labels of `[a-z0-9-]`, no leading or trailing hyphen).
- `defaultPackage` names a declared package that has a `port`.
- A package that declares `subdomain` but no `port` is an error — it can't be routed.
- The proxy `port` equals no package's port.

Each error names the offender.

### Routing

The proxy strips any `:port` from the `Host` header, then:

| Host                    | Routes to                                                                |
| ----------------------- | ------------------------------------------------------------------------ |
| `<rootDomain>`          | `defaultPackage`, or 404 when unset.                                     |
| `<label>.<rootDomain>`  | The package whose canonical subdomain **or alias** is `<label>`.         |
| anything else           | 404 — including multi-label prefixes (`a.web.<rootDomain>`) and hosts outside `rootDomain`. |

The 404 is a small page listing every hostname that does exist, as public URLs you can click:
`<subdomain>.<rootDomain>` for every routable package, aliases included, plus the bare root when
`defaultPackage` is set.

Requests are forwarded to the package's port on `localhost`, trying both loopback families
(Vite on a modern Node listens on `[::1]` alone). The `Host` header is kept as received and every other request and response header passes through unchanged, except the
hop-by-hop ones (`connection`, `keep-alive`, `proxy-*`, `te`, `trailer`, `transfer-encoding`,
`upgrade`), which Node manages on each side. devtooie adds or rewrites no `X-Forwarded-*` —
the TLS terminator in front already sets them. Bodies stream both ways; nothing is buffered,
and the proxy has no request, response, or idle timeouts of its own, so SSE and long-lived
connections survive.

### Status pages

The proxy asks the process manager before forwarding:

| Package status                                      | Response                                                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stopped`, `waiting`, `rebuilding`, `restarting`    | **503** immediately: a small HTML page (when the request accepts `text/html`) or JSON otherwise, naming the package and its status and how to start it (`s` hotkey, or `POST /command/restart/<name>` on the [control API](#drive-a-running-session-via-the-control-api)). `Retry-After: 2`, `Cache-Control: no-store`; the HTML page refreshes itself. |
| `running`, with a `healthcheck` not yet passing     | The request is **held** up to 15 s, re-checking readiness, then proxied. Past 15 s, the same 503 with status `starting`.                                               |
| `running` and ready (or no `healthcheck`)           | Proxied. If the package refuses or resets the connection, a **502** page naming the package and port, `Retry-After: 1`.                                                 |
| not part of the running session                     | **503**, saying so.                                                                                                                                                      |

Before the session's process manager is up (during the build phase), every routable host
answers 503 with status `starting`. If the client disconnects mid-request, the upstream request
is aborted.

### WebSockets and Vite HMR

The proxy handles the `upgrade` event with the same `Host` routing, opens the upstream with the
original headers, and once the package answers `101` splices the two sockets both ways. An
upgrade to a package that is not `running` right now is **dropped** (the socket is destroyed)
rather than held, and so is one the package fails to accept because it isn't listening yet:
websocket clients reconnect on their own, and a real answer is there once the package is up.

Vite HMR is the canonical client. Point its client at the TLS terminator's port and let the
websocket ride the same connection as the page — no separate HMR port:

```ts
// vite.config.ts
export default defineConfig({
  server: {
    // PUBLIC_ORIGIN is injected by devtooie — see below
    allowedHosts: [new URL(process.env.PUBLIC_ORIGIN!).hostname],
    // the public port: the TLS terminator's, or the proxy's own under plain localhost
    hmr: { clientPort: Number(new URL(process.env.PUBLIC_ORIGIN!).port) || 443 },
  },
});
```

### `PUBLIC_ORIGIN`

Every routable package's process — one declaring both `subdomain` and `port` — gets
`PUBLIC_ORIGIN` injected next to `PORT`, under the same rule: an explicit `.env` `PUBLIC_ORIGIN`
wins. It is built from the block as

```
<urlScheme>://<canonical subdomain>.<rootDomain>[:<port>]
```

where the canonical subdomain is the package's `subdomain` (the first entry of an array — aliases
never appear here) and the port follows the [`urlScheme` rule](#config): the proxy `port` under
`http`, none under `https`. So `https://web.myproject.test` behind a TLS terminator, and
`http://web.localhost:21050` on plain `localhost`. A package with a port but no subdomain gets
no `PUBLIC_ORIGIN` at all.

Apps use it for things like Vite's `server.allowedHosts` and `server.hmr` without repeating the
subdomain in their own config. `devtooie cmd` hands the same variable to a one-off command.

### Footer links and the resolved config

For every routable package, `<urlScheme>://<canonical subdomain>.<rootDomain>` is prepended to
that package's resolved `urls` — one link, even for a package with aliases or the
`defaultPackage` (whose bare root routes too but isn't listed again) — labelled
with the hostname — so the public URL is the first thing in the footer. This happens in
`defineConfig`, so the exported config shows it too, as does `config.devReverseProxy`:

```ts
config.devReverseProxy; // { port: 4000, rootDomain: 'myproject.example.test', defaultPackage: 'web', urlScheme: 'https' } | undefined
config.packages.web.publicOrigin; // 'https://web.myproject.example.test' — the same value injected as PUBLIC_ORIGIN
config.packages.web.urls; // [{ label: 'web.myproject.example.test', url: 'https://web.myproject.example.test' }, …]
```

`devtooie show-config` prints all of this as JSON without starting a session.

### Lifecycle

The proxy starts **before any package**, in both the TUI and `--plain` modes, whenever the
loaded config has `devReverseProxy`. `devtooie cmd`, `logs`, `env`, and `init` never start it.
On shutdown it closes and destroys every open socket, proxied websockets included, so a
lingering connection can't hold the exit.

Its port goes through the same conflict handling package ports get: a previous devtooie
session being handed off releases it as it shuts down; anything still holding it after that is
a startup error naming the port.

At start, one `[devtooie]` log line lists the proxy port, the root domain, and each route as
`<host> → <package> :<port>`. The [control API](#drive-a-running-session-via-the-control-api)'s `GET /query/status` reports
the same table under `devReverseProxy`.

### No terminator: plain `localhost`

With the default `rootDomain` (`localhost`) nothing needs to sit in front: browsers resolve
every `*.localhost` name to the loopback address, so `http://web.localhost:<proxy port>` reaches
the proxy, which routes it by the `web` label. `localhost` implies `urlScheme: 'http'`, under
which the public URLs devtooie derives carry the proxy port, so footer links and
`PUBLIC_ORIGIN` are right and Vite's HMR client (see above) connects to the same port the page
came from.

```ts
devReverseProxy: {
  port: ({ envs }) => Number(envs.DEV_REVERSE_PROXY_PORT),
  defaultPackage: 'frontend', // http://localhost:<proxy port> is the app
},
```

`*.localhost` resolution is a browser feature, not the OS resolver's: `curl` needs an explicit
`Host` header (`curl -H 'Host: web.localhost' http://127.0.0.1:<proxy port>/`).

### The TLS terminator

Anything that terminates TLS and forwards to a loopback port works. Point `rootDomain` at its
domain: a root other than `localhost` implies `urlScheme: 'https'`, so the public URLs point at
the terminator with no port. With Caddy, one site block per project:

```caddyfile
*.myproject.example.test, myproject.example.test {
  tls internal
  reverse_proxy 127.0.0.1:4000
}
```

where `4000` is the project's `devReverseProxy.port`. Caddy sets `X-Forwarded-*` itself, which
is why devtooie doesn't.

## Is the app already running?

Start here whenever you need to know whether some app in the repo is up — a dev server, an API,
a worker — **including when you don't yet know whether devtooie manages it, or whether this repo
uses devtooie at all**. Work through these four steps; each is cheap, and any one of them can end
with a complete answer.

Check before you start anything. Only one session can run a project, so starting a second one
means quitting the first and every dev process under it. devtooie will **refuse** to do that
from an agent when a person started the running session — you'll get an error and a non-zero
exit, not a session (see [Taking over a running session](#taking-over-a-running-session)).
Starting devtooie "just to see" is never free: at best it's an error, at worst it restarts
everything the human had running.

**1. Is this repo devtooie-managed?** Walk up from the app's directory for a config file —
`devtooie.config.ts` (also `.mts`, `.js`, `.mjs`):

```sh
# prints the nearest config's path, or nothing at all
d=$PWD; while [ "$d" != / ]; do
  for f in "$d"/devtooie.config.{ts,mts,js,mjs}; do [ -f "$f" ] && { echo "$f"; break 2; }; done
  d=$(dirname "$d")
done
```

Nothing anywhere up the tree → devtooie doesn't manage anything here; skip to
[Apps devtooie doesn't manage](#apps-devtooie-doesnt-manage).

**2. Is this app one of its packages?** Read the `packages` array in that config. Each entry's
`name` is what devtooie knows the package by, and it's what you pass to `-p` and to the control
API — it need not match the directory name or the `package.json` name, and a repo may well hold
apps devtooie was never taught about. If the app isn't in that array, it is **not devtooie-managed**;
that's a legitimate answer to report, then check it directly with the fallback below.

**3. Is a session live right now?** `node_modules/.devtooie/running.json` (under the config's
directory) records the control-API `port`. **devtooie never deletes that file, so its existence
proves nothing** — an exited or killed session leaves it behind. Only a reply from the API proves a
session is up:

```sh
port=$(node -e "process.stdout.write(String(require('./node_modules/.devtooie/running.json').port))" 2>/dev/null)
curl -s --max-time 2 "http://127.0.0.1:$port/query/status"
```

- No `running.json`, connection refused, or no valid JSON → **no session is running** for this
  workspace. Nothing devtooie starts is up (though the app may still be running on its own — see
  the fallback below).
- It answers, but `configPath` is not this workspace's config → that port now belongs to a
  **different workspace's** session (sessions relocate ports), so there's no session here.

**4. Read the package's state** from the `packages` map in that answer (e.g. `{ "backend": "running" }`):

| Value                       | What it means                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `running`                   | its process is live. Readiness isn't reported here — poll its `healthcheck` yourself. |
| `waiting`                   | not up yet; held back by `waitFor` / a dependency's healthcheck.                    |
| `stopped`                   | not running — it exited, crashed, or was never started.                             |
| `restarting` / `rebuilding` | mid-cycle after a control command or a code/`.env` change; it's on its way back up. |

Two special cases: `packages` (and `config`) being `null` means the session is up but still
**building** — nothing runs yet, so poll again in a few seconds. And a package name that isn't a key
at all is configured but wasn't selected for this session — it is not running. The same answer
carries the whole resolved `config`, so you can settle step 2 from here instead of reading the file.

To start a package that isn't running, see [Invoke headlessly](#invoke-headlessly); to restart one
that is, `POST /command/restart/<name>` (see
[Drive a running session](#drive-a-running-session-via-the-control-api)).

### Apps devtooie doesn't manage

If the repo has no devtooie config, or the app isn't in `packages`, **say so** — "that app isn't
managed by devtooie" is a complete answer — and then check it the ordinary way. Find the port it
binds (its `.env` files or its own config), and:

```sh
lsof -nP -iTCP:$PORT -sTCP:LISTEN     # is anything listening, and what
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 2 "http://localhost:$PORT/"
pgrep -lf 'vite|next dev|nodemon'     # last resort: match the dev command itself
```

A devtooie-managed package can also be running **outside** devtooie — someone ran `pnpm dev` by
hand. `/query/status` can't see that; the port check can. A package reported `stopped` whose port is
nonetheless taken is exactly that case (or another project on the same port).

**Never kill what you find.** Not `kill`, not `pkill`, not `lsof … | kill`. Stop a devtooie session
with `POST /command/quit` and restart a single package with `POST /command/restart/<name>`; for a
process devtooie doesn't own, report it and let the human decide.

## Taking over a running session

Only one devtooie session can run a project at a time, so starting a second one quits the
first — and every dev process under it. What happens when you try:

| Situation                                        | What devtooie does                      |
| ------------------------------------------------ | --------------------------------------- |
| `--kill-others` passed                           | Quits the running session, no question  |
| The running session was also started by an agent | Quits it, no question                   |
| A TTY is attached (a human is there)             | Prompts for confirmation                |
| No TTY — the usual agent case                    | **Refuses**, exits `1`, leaves it alone |

Your shell has no TTY, so row 3 is never you: every start of yours resolves to row 2 (quietly
allowed) or row 4 (refused). devtooie detects an agent from the environment variables agents set (`CLAUDECODE`, `CURSOR_AGENT`, `GEMINI_CLI`,
`CODEX_SANDBOX`, `AGENT`, and others), and publishes each session's answer as `startedByAgent`
on [`GET /query/status`](#drive-a-running-session-via-the-control-api). So:

- **A session you (or another agent) started, you may replace.** No prompt, no flag, nothing
  to ask — it happens automatically. Expect your own session to be replaced the same way.
- **A session the user started, you may not.** devtooie exits `1` with an explanation instead
  of starting.

**Never add `--kill-others` on your own initiative** — not to "unblock" yourself, not after
hitting the error, not in a script you write for the user. It terminates a session the user is
probably watching in another terminal, along with every server and watcher under it, and the
error you just got is devtooie deliberately stopping you. When you hit it, report to the user
that a session is already running and ask what they want: reuse it (you usually can — see
[Drive a running session via the control API](#drive-a-running-session-via-the-control-api)),
have them stop it, or have them tell you to pass `--kill-others`. Only that last answer, from
the user, authorizes the flag.

Note that a running session is usually **better** than a new one: you can read its logs, query
package status, and restart individual packages over the control API without disturbing
anything else.

## Invoke headlessly

First confirm nothing is already running — see
[Is the app already running?](#is-the-app-already-running). If a session is up, read
[Taking over a running session](#taking-over-a-running-session) before doing anything else:
starting yours means ending theirs.

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

| Option                 | Description                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-p, --package <name>` | Repeatable. Package(s) to run, bypassing the interactive selector.                                                                                                                                         |
| `-m, --mode <name>`    | Environment mode selecting the `.env.<mode>` files to load. Defaults to `development`; also accepted after a subcommand. See [Modes](#modes---mode).                                                        |
| `--ui`                 | Interactive terminal UI (default). Mutually exclusive with `--plain`.                                                                                                                                      |
| `--plain`              | No TUI — stream logs to stdout with colored name prefixes. Requires `-p` or `--last-answers`.                                                                                                              |
| `--last-answers`       | Skip selection; reuse the last saved selection.                                                                                                                                                            |
| `--build`              | Build the selected packages and their build-time deps, then exit (no run phase).                                                                                                                           |
| `--rebuild`            | Like `--build`, but first clears `dist/` for every build target.                                                                                                                                           |
| `--log-dir <dir>`      | Write the timestamped session log into this directory. Defaults to `node_modules/.devtooie/logs/`. Each run gets a fresh `<timestamp>.log`; previous sessions' logs are kept. Also used by `devtooie cmd`. |
| `--kill-others`        | Quit a devtooie session already running for this project instead of asking. **Never pass this on your own initiative** — see [Taking over a running session](#taking-over-a-running-session).              |

Subcommands:

- **`devtooie init`** — interactive setup; see [Getting started](#getting-started-devtooie-init).
- **`devtooie reset`** — clear the saved package selection.
- **`devtooie show-config`** — print the **fully resolved config** as JSON, no session
  needed: every package's `port`, `publicOrigin`, `healthcheck`, `urls`, and the
  `devReverseProxy` block. Takes `--mode`. See [Reach a package](#reach-a-package-devtooie-show-config).
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
├── .env.development         # workspace scope, the default mode
└── packages/
    ├── core-api/
    │   ├── .env              # package scope — overrides workspace scope
    │   └── .env.local        # package scope, higher precedence
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

**Package scope overrides workspace scope**, and within a scope a later file overrides an earlier
one. `${VAR}` references expand against already-loaded files and the current environment.

**The ambient environment wins over the files**, as in Next.js, Vite and `node --env-file` — so
`FOO=bar devtooie` overrides a file for a single run. `env.override` names the exceptions, for
when a file needs to *extend* an inherited value rather than lose to it:

```ts
defineConfig({
  env: { override: ['NODE_OPTIONS'] },   // or `true` for every variable
  packages: {/* … */},
});
```

With that, `NODE_OPTIONS=$NODE_OPTIONS --flag` appends to whatever the shell already set.

A package's `port` is also injected as `PORT` (an explicit `.env` `PORT` still overrides it), and under the [dev reverse proxy](#dev-reverse-proxy) a routable package also gets `PUBLIC_ORIGIN` (its public `https://<subdomain>.<rootDomain>`) under the same rule. The reverse direction works too: `port` may be a callback (`port: ({ envs }) => Number(envs.BACKEND_PORT)`) that reads these same resolved files to decide the port, and `healthcheck`/`urls` callbacks get the same `envs` — see [Callbacks instead of interpolation](#callbacks-instead-of-interpolation).

### Modes (`--mode`)

`--mode <name>` selects which `.env.<mode>` files load. It defaults to `development`, so plain
`devtooie` loads `.env.development` / `.env.development.local`.

```sh
devtooie --mode test                  # loads .env.test / .env.test.local
devtooie --mode test cmd -- vitest    # the same environment, for a one-off command
devtooie cmd --mode test -- vitest    # equivalent — both flag positions work
```

Any name is valid (`test`, `staging`, `e2e.ci`); a name can't be empty, `.`/`..`, or contain a
path separator. `DEVTOOIE_MODE=test devtooie` is equivalent to the flag, and the resolved mode is
passed to every child process as `DEVTOOIE_MODE`.

**Modes are exclusive**: `--mode test` does *not* load `.env.development`. Values shared across
modes belong in `.env` / `.env.local`, which load in every mode. (This is deliberate — a
cumulative mode could override an inherited variable but never unset one, so a `.env.test` that
forgot `DATABASE_URL` would silently run against the development database.)

`--mode` does **not** set `NODE_ENV`: a mode name is free-form, while `NODE_ENV` is effectively
limited to `development`/`production`/`test` by the wider ecosystem. Set it from the mode's own
file instead — `NODE_ENV=test` inside `.env.test`. (That line is itself subject to ambient-wins,
so a shell or CI runner exporting `NODE_ENV` beats it; add it to `env.override` if that matters.)

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
  `node_modules/.devtooie/logs/` (or `--log-dir`). devtooie prints nothing of its own around it —
  the output you see is exactly the command's, so `devtooie cmd` is safe to pipe or capture.

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
- **`cleans`** — its start is a _clean_ rebuild, with no stale output to clear (default `false`;
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

### Scoping a `node --watch` dev script

devtooie runs the `dev` script exactly as written, so what the process watches is up to the script.
Worth knowing when you onboard a package that uses Node's own
watcher: `node --watch` registers a **recursive** watch on the directory of every file the process
loads, with no ignore list — so `node_modules` is watched wholesale. A service with a real
dependency tree ends up holding thousands of watch roots, which wastes restarts on files nobody
edits and, on macOS, can exhaust the machine-wide FSEvents budget and fail the watcher with
`EMFILE`.

Scope it by naming the directories in the script:

```jsonc
{
  "scripts": {
    // watches only what this package actually loads at runtime
    "dev": "node --watch --watch-path=./src --watch-path=../shared/dist src/index.ts",
  },
}
```

Good candidates are the package's own sources (or its `outDir` when it transpiles) plus the
directory each workspace dependency's `exports` actually resolves to — `./src/index.ts` → that
`src`, `./dist/index.js` → that `dist`. Other watchers (`tsx watch`, `nodemon`, `tsc --watch`)
don't behave this way and need nothing.

## Drive a running session via the control API

A running devtooie session (whether started by you or a human) exposes a localhost-only HTTP
control API on a port chosen at startup — mostly useful for coding agents, but open to any
tooling. **Read the active port from `node_modules/.devtooie/running.json`** — devtooie writes the
current `{ "port", "pid", "logDir", "logFile" }` there (`logDir` is where this session's logs go;
`logFile` is the current logfile, kept up to date across in-session rotation). Always resolve the
port from that file rather than assuming one; a project may pin a fixed port with `apiPort` in
`devtooie.config.ts`, but `running.json` is always current for the last session started. It is not
removed when a session ends, so it says where a session _would_ answer, not that one is live — see
[Is the app already running?](#is-the-app-already-running) to check that.

Endpoints (all plain HTTP, no auth — localhost-only):

- `GET /query/status` — a single snapshot of the session,
  `{ pid, configPath, startedByAgent, logFile, packages, config, devReverseProxy }`:
  - `pid` / `configPath` — the session's PID and the absolute path to the `devtooie.config.*` it
    was started with; available immediately, even while the session is still building.
  - `startedByAgent` — whether a coding agent started this session rather than a person. Decides
    whether a starting session may quit it without asking; see
    [Taking over a running session](#taking-over-a-running-session). Omitted by instances older
    than 0.7.0, which reads as `false`.
  - `logFile` — absolute path to the logfile currently being written (tracks in-session rotation).
  - `packages` — per-package status map (e.g. `{ "web": "running" }`), one of `running`,
    `stopped`, `waiting`, `restarting`, `rebuilding`; `null` until the build finishes. See
    [Is the app already running?](#is-the-app-already-running) for what each value tells you.
  - `config` — the whole **resolved** config (defaults applied, `command` normalized to
    `{ name, watches, builds, cleans }`), as loaded at startup (restart devtooie to pick up edits);
    `null` until the build finishes. Use it to decide package lifecycle — see
    [Package lifecycle](#package-lifecycle-when-you-change-code).
  - `devReverseProxy` — `{ port, rootDomain, routes: [{ host, package, port }] }` for the
    session's [dev reverse proxy](#dev-reverse-proxy), or `null` when the config declares none.
    Present from the start (the proxy binds before anything else); `routes` lists every public
    hostname and the package (and loopback port) it forwards to.
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

This is what lets a second `devtooie` invocation hand off from a running one — once that takeover
is authorized, see [Taking over a running session](#taking-over-a-running-session) — what
`devtooie logs` finds the current logfile with, and what an external tool (or the agent skill)
uses to drive a session headlessly.

Do not hardcode package names, ports, or hostnames. Discover them either from a running session
(`GET /query/status`) or by asking devtooie directly, no session needed:

```sh
devtooie show-config            # the whole resolved config: names, ports, public origins, healthchecks
devtooie resolvedeps <package>  # that package's build/dev/runtime dependency names
```

See [Reach a package](#reach-a-package-devtooie-show-config).

### Graceful shutdown

Ctrl+C, `POST /command/quit`, and the termination signals **`SIGHUP`**, `SIGINT` and `SIGTERM` all
funnel through the **same** graceful shutdown, so the teardown is identical however it's triggered.
`SIGHUP` matters most in practice: it's what a closing terminal window, a killed tmux pane, or a
dropped SSH connection delivers, and it must tear packages down rather than leave them running
without a parent. Each package is given a chance to exit cleanly before it's forced, in three
phases:

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
one — once that takeover is authorized (see
[Taking over a running session](#taking-over-a-running-session)): it calls `POST /command/quit`,
waits for that ack, and only then binds the ports itself (falling back to force-killing the old
process if it overruns its graceful window). You get the same guarantee for free — await the
response and the session's ports are yours.

If a package needs to flush or persist state on shutdown, do it on `SIGTERM`, and keep it under the
10-second grace or it will be `SIGKILL`ed mid-cleanup.

### Orphan cleanup at startup

`SIGKILL` can't be trapped, so a devtooie killed outright (or lost to a crashed terminal) leaves its
packages running, reparented to PID 1. To keep those from accumulating one generation per lost
session, devtooie records the processes it spawns in `node_modules/.devtooie/running.json` and, on
the next start, reaps whatever is still running.

Records are matched as **process groups**, not single pids. Packages are spawned detached, so each
recorded pid is also its group id — and the group outlives its leader. A dev command that wraps the
real worker (`env-cmd -- tsx watch …`, a package manager, any `foo -- bar` shim) exits as soon as it
has spawned, leaving the worker running in that group with no parent. Checking whether the recorded
pid is still alive would skip exactly those. Before anything is signalled, at least one live member
of the group must still be running in the directory the record was written with, so a recycled
number can't take an unrelated process with it, and a group containing devtooie itself is never
touched.

This sweep reaches packages that never bind a port, which the port check below cannot.

devtooie also frees its configured dev ports at startup, but only from processes belonging to **this
workspace**. A configured port is a claim on a number, not ownership of it: if another project (or
any other program) is listening there, devtooie reports it and leaves it running, and the package
that wanted the port fails to bind as it normally would. If you're diagnosing "my package won't
start, the port is taken", that message is the signal — find the other program rather than expecting
devtooie to clear it.

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

3. **Add the package to `devtooie.config.ts`.** Add a new key to the `packages` object passed to
   `defineConfig`. **The key is the package's name** — there is no `name` field:

   ```ts
   'my-pkg': {
     port: 3001,
     healthcheck: '/health',
     deps: { runtime: ['other-pkg'] },
     waitFor: ['other-pkg'],
   }
   ```

   All package fields are flat (there is no `run` nesting). Infer them from what the package
   actually is:
   - `port` — the dev port it listens on. devtooie injects this into the package's process as the
     `PORT` env var, so the app can read `process.env.PORT` without you duplicating it in a `.env`
     (an explicit `.env` `PORT` still wins).
   - `healthcheck` / `urls` — **prefer a relative path**: `healthcheck: '/health'`,
     `urls: ['/todos']`. devtooie resolves a path against the package's own `port`
     (`http://localhost:<port>/health`), and a `urls` path against its public origin under the
     [dev reverse proxy](#dev-reverse-proxy) when it has one — so the port is never repeated,
     can't drift, and the same config is right with or without the proxy. Write a full URL only
     for something that isn't this package (`https://status.example.test`), and a **callback**
     over `{ envs, tokens, port, subdomain }` only when the value genuinely depends on the
     environment (see [Callbacks](#callbacks-instead-of-interpolation)). **There is no
     `$port`/`$name` interpolation** — a `$` in a config string is a literal `$`. Each `urls`
     entry is a URL, a `{ label, url }`, or an array of those (an array entry's links render on
     one footer line, space-separated). `healthcheck` also takes `{ url, timeout }` when the
     package is slow to answer on a cold start — see [Readiness probing](#readiness-probing).
   - `deps: { build, dev, runtime }` — names of other packages this one depends on; drives
     build/start ordering and what gets pulled in when this package is selected. For **TypeScript**
     deps you usually don't need `deps.build`: devtooie infers build-time deps from project
     references — it reads `tsconfig` if set, else `tsconfig.build.json`, else `tsconfig.json`, and
     follows their `references` to other packages. Wire the real dependency the normal way (a
     `workspace:*` entry in the consumer's `package.json` so pnpm links it, plus a tsconfig
     `references` entry). Use `deps.build` only for edges TS can't express.
   - `waitFor` — names of packages whose `healthcheck` must pass before this one starts (each named
     package must itself define a `healthcheck`). Names in `waitFor`/`deps` are **type-checked
     against the keys of `packages`**, so a typo is a compile error (and still a clear load-time
     error for a config that reaches devtooie unchecked).
   - `tokens` — optional values of your own for this package's callbacks, merged over the config's
     top-level `tokens`. Only add it when this package actually has tokens — never write
     `tokens: {}`. See [Typed tokens](#typed-tokens).

   Choose the key to match how the package should be referred to elsewhere (control API paths,
   `-p` flags, etc). It must not be an integer-like string (`'2'`): JavaScript reorders such keys,
   which would change start order, so devtooie rejects them at load time.

   For workspace-wide links not tied to any package (dashboards, docs), add a top-level `urls`
   array to `defineConfig` — same entry shape as a package's `urls`. These render in the TUI footer
   above the per-package links; a callback there gets `{ envs, tokens }` but no `port`, since the
   entry belongs to no package.

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
directories already exist). It teaches a coding agent how to check whether an app in the repo is
already running, run devtooie headlessly (`--plain -p <package>`), drive a running session through
the control API, read the logfile for debugging, and onboard a new package. The installed file is **managed** — treat it as generated,
not something to hand-edit. devtooie's `postinstall` (see [Install](#install)), `devtooie init`,
and every `devtooie` run refresh it to the installed version. The skill points at this guide.

## Typed package names (advanced)

Most people don't need this. Name the config value and augment the `'devtooie'` module with it so
other scripts in your repo can import the resolved package type:

```ts
import { defineConfig } from 'devtooie';

const config = defineConfig({
  packages: {/* … */},
});
export default config;

declare module 'devtooie' {
  interface Register {
    packageConfigs: typeof config.packages;
  }
}
```

`import type { PackageConfig, PackageName } from 'devtooie'` then gives you:

- **`PackageName`** — the literal union of your package names (the keys of `packages`).
- **`PackageConfig<'api'>`** — one package's resolved type, indexed by name, including its own
  [`tokens`](#typed-tokens). Bare `PackageConfig` is the union of them all.

```ts
import type { PackageConfig, PackageName } from 'devtooie';

declare function restart(name: PackageName): void;
restart('web'); // ok
restart('nope'); // compile error

type ApiTokens = PackageConfig<'api'>['tokens']; // { domain: …; region: … }
```

Purely opt-in — the scaffolded config doesn't include it, and it is **not** needed for typed
`waitFor`/`deps` inside the config itself (those are checked against the keys either way).
