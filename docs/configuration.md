# Configuration options

> Part of the [devtooie](../README.md) documentation.

`defineConfig` accepts:

| Field          | Meaning                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------- |
| `services`     | Your application services, **keyed by service name** (see below).                           |
| `workspaceDir` | Root each service's `relativeDir` resolves against. Defaults to `process.cwd()`.            |
| `serviceRootDir` | The directory the services live under, e.g. `'apps'`: each service's directory is inferred as `<serviceRootDir>/<key>`, and `relativeDir` becomes an optional override. Without it, every service must set `relativeDir`. **Recommended.** |
| `env`          | Environment options: [`vars`](#envvars), variables of the config's own, and [`override`](#envoverride). Which files load is chosen with `--mode`; see [Environment loading](../README.md#environment-env-loading). |
| `logs`         | Top-level log options (`{ timestamps? }`); timestamps + structured-log formatting — see [Logging](./logging.md). |
| `apiPort`      | Pin the [control API](./control-api.md) port (otherwise chosen automatically). A pinned port serves one mode's session at a time. |
| `urls`         | Workspace-wide footer links, not tied to a service. Same shape as a service's `urls`, but a callback here gets only `{ envs, tokens }`. |
| `tokens`       | Values of your own, handed to every callback as `tokens` (a service's own `tokens` are merged on top) — see [Callbacks](#callbacks-instead-of-interpolation). |
| `infra`        | Infra services — databases, caches, brokers — keyed by provider: `{ 'docker-compose': { file?, readyTimeout?, services? } }`, where `services` gives an infra service its `enabled`, its `port`, `proxy` and `urls`, and callbacks. Brought up, and waited on, before the application services start. See [Infra](./infra.md). |
| `devReverseProxy` | Run devtooie's own dev reverse proxy, routing `<subdomain>.<rootDomain>` to the application service or infra service whose `proxy` declares that subdomain. `{ port, rootDomain?, defaultService?, urlScheme? }`, where `rootDomain` may be an array (the canonical root, then aliases); present = enabled. See [Dev reverse proxy](./dev-reverse-proxy.md). |

`services` is an object keyed by service name:

```ts
services: {
  api: { port: 3001, healthcheck: '/health' }, // a path: probed at http://localhost:3001/health
  web: { port: 3000, waitFor: ['api'] },
}
```

The **key is the service's name** — what `-s <name>` takes, what `waitFor`/`deps` reference,
and what its directory is inferred from under `serviceRootDir`. So names can't be duplicated or drift out of sync, and
TypeScript checks every name reference against them. There is no `name` field.

Each service's value has a flat set of fields, all optional:

- **`relativeDir`** — directory containing the service, relative to `workspaceDir`. Optional
  when the config sets `serviceRootDir` — then it's inferred as `<serviceRootDir>/<key>`, the
  recommended setup — and required otherwise; TypeScript enforces both. Set it to override the
  inferred one (a scoped key like `@scope/web-api` would otherwise land at
  `apps/@scope/web-api`).
- **`selectable`** (default `true`) — show in the interactive picker.
- **`color`** — override the auto-assigned color of this service's log-prefix label. Any
  Ink/chalk color: a name (`'magenta'`, `'blueBright'`), hex (`'#af87ff'`),
  `'rgb(175,135,255)'`, or `'ansi256(140)'`. Otherwise a palette color is assigned by the
  service's position in the run.
- **`command`** — the dev process to run and how it behaves. A script/target name, or
  `[name, { watches, builds, cleans }]`. Defaults to `['dev', { watches: true, builds: true }]`.
  See [Service lifecycle](./service-lifecycle.md).
- **`autostart`** (default `true`) — whether to auto-start this service during the run phase.
  Set **`false`** to leave it stopped; start it yourself with the **`s`** hotkey (or a
  control-API `start`). (If a service `waitFor`s an `autostart: false` one, it waits until you
  start it.)
- **`port`** — the service's dev port; injected as `PORT`, handed to this service's
  `healthcheck`/`urls` callbacks, and swept on session handoff. Pass a **callback** to derive
  it from the service's [environment](../README.md#environment-env-loading) instead of
  hardcoding it — see [Callbacks](#callbacks-instead-of-interpolation) below. Return
  `undefined` for "no port" (the same as omitting the field); returning `NaN` — the usual sign
  of a missing variable — is an error naming the service and the env files that were loaded.
  Declaring a `port` is what lets this service's other callbacks use `port` — see
  [The `port` in a callback](#the-port-in-a-callback).
- **`proxy`** — how a reverse proxy reaches the service: `{ subdomain }`, the same block an
  [infra service](./infra.md#reaching-a-service-through-the-dev-reverse-proxy) takes.
  `subdomain` is a string, an array of them (the first is the canonical subdomain, the rest are
  aliases), or **`true`** for the service's own name — `api: { proxy: { subdomain: true } }` is
  `subdomain: 'api'`. (`true` needs a name that is itself a DNS label; a scoped or uppercase key
  has to spell its subdomain out.) With a top-level
  [`devReverseProxy`](./dev-reverse-proxy.md), devtooie routes `<subdomain>.<rootDomain>` to
  this service's `port` (aliases too) and injects `PUBLIC_ORIGIN` into its process (also
  exposed as `publicOrigin` on the resolved service). Without one, devtooie doesn't use it:
  it's data for tooling that reads the exported config (`config.services.api.proxy.subdomain`),
  such as a reverse proxy of your own. Either way the canonical entry is handed to this
  service's callbacks as `subdomain` — see [Callbacks](#callbacks-instead-of-interpolation).
  The proxy's [`defaultService`](./dev-reverse-proxy.md#config), served at the bare root, needs
  no `proxy`.
  Each entry must be a DNS label — lowercase letters, digits, and hyphens, not starting or
  ending with a hyphen, at most 63 characters — and no two application or infra services may
  declare the same one, canonical or alias.
- **`urls`** — links shown in the running footer, one entry per line. Each entry is a
  URL, a `{ label, url }`, or an **array** of those (rendered on the same line,
  space-separated). Any URL may be a callback, and any may be a **path** (`'/todos'`, or
  `'todos'`; `''` is the origin itself), based on the service's public origin under the
  [dev reverse proxy](./dev-reverse-proxy.md), or on
  `http://localhost:<port>` without one. A path's trailing slash is dropped: `'/todos/'` is
  `'/todos'`, and `'/'` is `''`. A path on a service with no `port` is an error.
  devtooie adds no links of its own. When `urls` is a single link with no label — one URL or
  path, `urls: ['']` — the footer shows no line for it: the service's name is that link. With
  a label, or more than one link, each line shows under the name.
- **`healthcheck`** — a URL polled for readiness; also required by anything
  that lists this service in its `waitFor`. A **path** (`'/health'`, or `'health'`) is probed
  at `http://localhost:<port>/health` — always the service itself, never through the dev
  reverse proxy — and its trailing slash is dropped, as in `urls`. May be a callback, or
  `{ url, timeout }` to give this service's probes longer than the 1500 ms default. See
  [Readiness probing](#readiness-probing).
- **`tokens`** — values of your own for this service's callbacks, merged **over** the
  top-level `tokens`. Only declare it where the service has tokens — never `tokens: {}`. See
  [Typed tokens](#typed-tokens).
- **`waitFor`** — service names to wait on (each must define a `healthcheck`)
  before this service starts. Type-checked against the keys of `services`.
- **`deps.runtime`** — see [Dependencies](#dependencies) below.
- **`logs`** — per-service log options `{ timestamps?, formatter? }`. `timestamps` overrides the
  top-level [`logs.timestamps`](./logging.md#timestamps) for this service (inheriting it when
  omitted); `formatter` (`(line: string) => string`) **overrides the default structured-log
  formatter** that devtooie already applies to every service. See [Logging](./logging.md).

## `env.vars`

Environment variables of the config's own, for everything devtooie starts: every service's
process, [`devtooie exec` and `devtooie run`](./cli.md#devtooie-exec-and-devtooie-run), build
scripts, and [infra](./infra.md) — Compose and the commands its callbacks run. A record, or a
callback over the workspace context `{ envs, tokens }`:

```ts
defineConfig({
  serviceRootDir: 'apps',
  env: {
    vars: ({ envs }) => ({
      WORKSPACE_DIR: envs.DEVTOOIE_WORKSPACE_DIR,
      UPLOADS_DIR: `${envs.DEVTOOIE_WORKSPACE_DIR}/.data/uploads`,
    }),
  },
  services: {/* … */},
});
```

With nothing else to set under `env`, the callback can stand in for the whole option:
`env: ({ envs }) => ({ … })` is `env: { vars: ({ envs }) => ({ … }) }`.

- **It runs first.** The callback is invoked once when the config loads, before anything else in
  it resolves, so every other callback — a service's `port`, `healthcheck` and `urls`,
  `devReverseProxy`, an infra service's — finds the result in its own `envs`. What the callback
  itself sees in `envs` is the workspace scope: the workspace's `.env` files and the ambient
  environment, [the variables devtooie sets](../README.md#variables-devtooie-sets) included.
- **It ranks as the first `.env` file.** A variable set here follows the rules of one from a
  file read before `.env`, at the workspace scope. Every file that defines it replaces it — the
  workspace's for everything, a service's own for that service. The ambient environment wins
  over it, so `FOO=bar devtooie` overrides it for one run, unless [`env.override`](#envoverride)
  names it. A `PORT` or `PUBLIC_ORIGIN` here, like one in a workspace `.env` file, does not
  replace the one devtooie injects into each service; only the service's own file does.
- **A `.env` file can reference it.** `${VAR}` in a file expands to a variable set here. The
  callback runs before that, so what it sees of such a line has the reference filled from the
  ambient environment, or left empty.
- **Values are literal strings.** A `$` in a value is a `$`: nothing in it is expanded. A variable
  whose value is `undefined` is left out; any other non-string is an error when the config
  loads, naming the variable.
- **It is evaluated once per run.** A variable set here keeps the value it had when the config
  loaded, until devtooie is restarted — including when a `.env` file the callback read is
  edited and the services restart.
- **It is part of the resolved config.** [`devtooie show-config`](./cli.md#devtooie-show-config)
  and the [control API](./control-api.md)'s `GET /query/status` print the values as the config set them, so a
  secret composed here shows up there.

## `env.override`

The ambient environment wins over `.env` files, as in Next.js, Vite and `node --env-file` — so
`FOO=bar devtooie` overrides a file for a single run. `env.override` names the variables where the
file — or [`env.vars`](#envvars), which ranks as the first file — is allowed to win instead:

```ts
defineConfig({
  serviceRootDir: 'apps',
  env: { override: ['NODE_OPTIONS'] },   // or `true` for every variable
  services: {/* … */},
});
```

The case it exists for is a file that *extends* an inherited value rather than replacing it —
`NODE_OPTIONS="$NODE_OPTIONS --disable-warning=ExperimentalWarning"`. Without the override that
line silently does nothing whenever the shell already sets `NODE_OPTIONS`, which VS Code's
integrated terminal always does.

An override holds wherever the variable is used. A `${VAR}` reference to it, in any line read
after the one that sets it, expands to the value that won, never the shell's; and the same
resolved environment goes to every service, one-off command, build script and infra service.

**Ambient means the environment devtooie was started with** — what the shell (or a CI runner)
exported. A value that comes from a `.env` file is never ambient, at either scope. So
`env.override` only ever decides between the shell and the files; it never decides between two
files, where the higher-ranked one always wins. With `LOG_LEVEL=info` in the workspace's `.env`
and `LOG_LEVEL=warn` in `apps/api/.env`:

| The shell has     | `env.override`  | `api` gets `LOG_LEVEL=`                                    |
| ----------------- | --------------- | ---------------------------------------------------------- |
| `LOG_LEVEL=debug` | not set         | `debug` — the shell wins                                   |
| `LOG_LEVEL=debug` | `['LOG_LEVEL']` | `warn` — the files win, the service's over the workspace's |
| nothing           | not set         | `warn`                                                     |
| nothing           | `['LOG_LEVEL']` | `warn`                                                     |

Which **files** load isn't configured here — that's [`--mode`](./cli.md).

## Callbacks instead of interpolation

devtooie does **no string interpolation**. A value that depends on the port, the environment, or
anything else is written as a plain function of it, so it's ordinary TypeScript your editor
checks — nothing to learn, nothing to escape, and a `$` in a string is just a `$`.

`port`, `healthcheck`, and every `urls` entry (including the `url` inside a `{ label, url }`)
accept either a literal or a callback — as do the top-level `devReverseProxy.port` and
`rootDomain`, and [`env.vars`](#envvars), over the workspace context `{ envs, tokens }`. For a URL of this service's own,
a **relative path** is the literal to reach for first: it needs no callback at all, since devtooie
resolves it against the service's port (or its public origin under the dev reverse proxy).

```ts
export default defineConfig({
  serviceRootDir: 'apps',
  tokens: { domain: 'example.test' },
  services: {
    backend: {
      tokens: { region: 'us-east' },
      port: ({ envs }) => Number(envs.BACKEND_PORT),
      healthcheck: '/health', // a path: resolved against this service's port, no callback needed
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

| Key      | What it is                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `envs`   | The config's own [`env.vars`](#envvars) and the service's `.env` files, resolved and merged with `process.env` (which wins by default) — the same environment the dev process gets. See [Environment loading](../README.md#environment-env-loading). |
| `tokens` | The top-level `tokens` with this service's own `tokens` merged **over** them. Typed from what you declared, so a typo is a compile error. |
| `port`   | The service's resolved `port`, typed **`number`** (not `number \| undefined`) so it drops straight into a URL. A service that declares no `port` has nothing to give, which types can't express here — so reading `port` in that case throws when the config loads, naming the service. Not offered to `port` itself, nor to the workspace-wide `urls`. |
| `subdomain` | The service's canonical `proxy.subdomain` — the first entry when it declared several — so a URL can be built from it without repeating it: `` urls: [({ subdomain, envs }) => `https://${subdomain}.${envs.LOCALDEV_DOMAIN}`] ``. Plain data, unlike `port`: `undefined` (in type and in value) for a service that declares no `proxy`, so branch on it if a callback has to work either way. Not offered to `port`, nor to the workspace-wide `urls`. |

Callbacks run **once**, while the config is being defined, and must be synchronous. A `port`
callback returns a number (or `undefined`); the rest return a string.

### Typed tokens

`tokens` is typed from what you write: `tokens.region` is a known key, `tokens.regoin` is a
compile error, and a service's own tokens stay **private to that service** — `api`'s `region`
is not a key on `web`'s `tokens`.

Declare them only where you have them. A service with no tokens of its own writes nothing:

```ts
export default defineConfig({
  serviceRootDir: 'apps',
  tokens: { domain: 'example.test', proto: 'https' },
  services: {
    api: {
      tokens: { region: 'us-east', proto: 'http' },   // `proto` overrides the config's
      // tokens is { domain, proto, region } — all typed
      healthcheck: ({ tokens, port }) => `${tokens.proto}://${tokens.region}.${tokens.domain}:${port}`,
    },
    web: {
      // no `tokens` here — and `tokens.region` below would be a compile error
      healthcheck: ({ tokens, port }) => `${tokens.proto}://${tokens.domain}:${port}`,
    },
  },
});
```

A service's own tokens are an **override**, not a merge: a key it redeclares replaces the
config's for that service only.

The resolved tokens are on the config's exported value too, keyed by service name — so other
scripts in the repo can read them:

```ts
import config from './devtooie.config.js';

config.services.api.tokens.region;   // 'us-east'
config.services.web.tokens.domain;   // 'example.test'
config.services.web.tokens.region;   // compile error — that's api's
```

You can also skip `tokens` entirely and close over ordinary `const`s in the config file, which
is just as typed:

```ts
const domain = 'example.test';
// …
urls: [() => `https://api.${domain}`];
```

## Readiness probing

A service with a `healthcheck` is polled while it runs: the footer dot turns green once a probe
passes, and any service listing it in `waitFor` starts at that moment. devtooie probes each
service in exactly one place, no matter how many others wait on it.

Probes never overlap. The next one starts **2 s after the previous one started** — so a fast
answer leaves an idle gap, while a probe that runs past 2 s is followed immediately.

A probe that hasn't answered within `timeout` — **in milliseconds**, 1500 by default — is
aborted. Raise it for a
service slow to answer on a cold start: devtooie hanging up mid-request is itself what makes such
a server log a dropped connection, and the aborted probe leaves the service showing `starting`
until the next one lands.

```ts
services: {
  api: {
    port: 3001,
    healthcheck: {
      url: '/health', // a path: probed at http://localhost:<port>/health
      timeout: 10_000,
    },
  },
}
```

`timeout` is per service, so raising it slows that service's polling and affects no other.

### The `port` in a callback

A callback's `port` is typed **`number`**, not `number | undefined`, so it goes straight into a
URL or arithmetic with no `!` or `??`:

```ts
healthcheck: ({ port }) => `http://localhost:${port}/health`,
urls: [({ port }) => `http://localhost:${port + 1}/debug`],
```

That holds for a literal `port: 3000` and for a `port` callback alike. Whether a service
declared a `port` at all is the one thing that **can't** be reflected in the type: a mapped type
infers exactly one type parameter, and this config spends it on per-service
[`tokens`](#typed-tokens).

So the guarantee is enforced when the config loads instead. If a service with no `port` reads
`port` in a callback, devtooie throws immediately, naming the service:

```
api: a callback read `port`, but this service declares no `port`. Add `port` to api in
devtooie.config.ts, or drop `port` from the callback.
```

Every callback runs once, while the config loads, so this surfaces on the very next command —
rather than quietly producing `http://localhost:undefined/health`. A service with no `port`
whose callbacks never mention `port` is unaffected.

The **resolved** `port` on the exported config stays honest, since a service really may not have
one:

```ts
config.services.api.port; // number | undefined
```

## Logging

Timestamps and structured-log (JSON) formatting — the top-level and per-service `logs` options —
have their own page: **[Logging](./logging.md)**.

## Dependencies

**`deps.runtime`** lists other services that must be _running_ alongside this one: selecting
`web` with `deps: { runtime: ['api'] }` runs `api` too. **Not transitive**: only the services you
explicitly select have their runtime deps expanded. If a runtime dep needs its own runtime deps
too, select it explicitly (or add it to your own selection). To hold a service until another one
answers, add [`waitFor`](#readiness-probing) as well.

`devtooie resolvedeps <service>` prints a single service's resolved dependency sets as JSON —
handy for wiring other tooling to the same dependency graph.

## Advanced: typed service names

Most people don't need this. If you want other scripts in your repo to import a
literal union of your service names from `devtooie`, name the config value and
augment the `'devtooie'` module with it:

```ts
import { defineConfig } from 'devtooie';

const config = defineConfig({
  serviceRootDir: 'apps',
  services: {/* … */},
});
export default config;

declare module 'devtooie' {
  interface Register {
    serviceConfigs: typeof config.services;
  }
}
```

`import type { ServiceConfig, ServiceName } from 'devtooie'` then gives you:

- **`ServiceName`** — the literal union of your service names (the keys of `services`).
- **`ServiceConfig<'api'>`** — one service's resolved type, indexed by name, including its own
  [`tokens`](#typed-tokens). Bare `ServiceConfig` is the union of them all.

```ts
import type { ServiceConfig, ServiceName } from 'devtooie';

declare function restart(name: ServiceName): void;
restart('web');    // ok
restart('nope');   // compile error

type ApiTokens = ServiceConfig<'api'>['tokens'];   // { domain: …; region: … }
```

Purely opt-in — the scaffolded config doesn't include it, and you don't need it to get typed
`waitFor`/`deps` inside the config itself (those are checked against the keys either way).
