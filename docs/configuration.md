# Configuration options

> Part of the [devtooie](../README.md) documentation.

`defineConfig` accepts:

| Field          | Meaning                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------- |
| `packages`     | Your package definitions, **keyed by package name** (see below).                            |
| `workspaceDir` | Root each package's `relativeDir` resolves against. Defaults to `process.cwd()`.            |
| `packageRootDir` | The directory the packages live under, e.g. `'packages'`: each package's directory is inferred as `<packageRootDir>/<key>`, and `relativeDir` becomes an optional override. Without it, every package must set `relativeDir`. **Recommended.** |
| `env`          | Environment-loading options — currently just `override`, below. Which files load is chosen with `--mode`; see [Environment loading](../README.md#environment-env-loading). |
| `logs`         | Top-level log options (`{ timestamps? }`); timestamps + structured-log formatting — see [Logging](./logging.md). |
| `apiPort`      | Pin the [control API](./control-api.md) port (otherwise chosen automatically).              |
| `urls`         | Workspace-wide footer links, not tied to a package. Same shape as a package's `urls`, but a callback here gets only `{ envs, tokens }`. |
| `tokens`       | Values of your own, handed to every callback as `tokens` (a package's own `tokens` are merged on top) — see [Callbacks](#callbacks-instead-of-interpolation). |
| `devReverseProxy` | Run devtooie's own dev reverse proxy, routing `<subdomain>.<rootDomain>` to packages by their `subdomain`. `{ port, rootDomain?, defaultPackage?, urlScheme? }`; present = enabled. See [Dev reverse proxy](./dev-reverse-proxy.md). |

`packages` is an object keyed by package name:

```ts
packages: {
  api: { port: 3001, healthcheck: '/health' }, // a path: probed at http://localhost:3001/health
  web: { port: 3000, waitFor: ['api'] },
  // a build-only lib needs no fields at all
  isomorphic: { selectable: false },
}
```

The **key is the package's name** — what `-p <name>` takes, what `waitFor`/`deps` reference,
and what its directory is inferred from under `packageRootDir`. So names can't be duplicated or drift out of sync, and
TypeScript checks every name reference against them. There is no `name` field.

Each package's value has a flat set of fields, all optional (omit them all for a build-only
lib):

- **`relativeDir`** — directory containing the package, relative to `workspaceDir`. Optional
  when the config sets `packageRootDir` — then it's inferred as `<packageRootDir>/<key>`, the
  recommended setup — and required otherwise; TypeScript enforces both. Set it to override the
  inferred one (a scoped key like `@scope/web-api` would otherwise land at
  `packages/@scope/web-api`).
- **`selectable`** (default `true`) — show in the interactive picker.
- **`color`** — override the auto-assigned color of this package's log-prefix label. Any
  Ink/chalk color: a name (`'magenta'`, `'blueBright'`), hex (`'#af87ff'`),
  `'rgb(175,135,255)'`, or `'ansi256(140)'`. Otherwise a palette color is assigned by the
  package's position in the run.
- **`command`** — the dev process to run and how it behaves. A script/target name, or
  `[name, { watches, builds, cleans }]`. Defaults to `['dev', { watches: true, builds: true }]`.
  Pass **`null`** for a package with **no dev process** — devtooie never starts it (it's
  build/dep-only) and it's hidden from the interactive picker. See
  [Package lifecycle](./package-lifecycle.md).
- **`autostart`** (default `true`) — whether to auto-start this package during the run phase.
  Set **`false`** to leave it stopped; start it yourself with the **`s`** hotkey (or a
  control-API `restart`). Ignored when `command` is `null`. (If a package `waitFor`s an
  `autostart: false` one, it waits until you start it.)
- **`port`** — the package's dev port; injected as `PORT`, handed to this package's
  `healthcheck`/`urls` callbacks, and swept on session handoff. Pass a **callback** to derive
  it from the package's [environment](../README.md#environment-env-loading) instead of
  hardcoding it — see [Callbacks](#callbacks-instead-of-interpolation) below. Return
  `undefined` for "no port" (the same as omitting the field); returning `NaN` — the usual sign
  of a missing variable — is an error naming the package and the env files that were loaded.
  Declaring a `port` is what lets this package's other callbacks use `port` — see
  [The `port` in a callback](#the-port-in-a-callback).
- **`subdomain`** — the package's dev subdomain, a string or an array of them (the first is
  the canonical subdomain, the rest are aliases). With a top-level
  [`devReverseProxy`](./dev-reverse-proxy.md), devtooie routes `<subdomain>.<rootDomain>` to
  this package's `port` (aliases too) and injects `PUBLIC_ORIGIN` into its process (also
  exposed as `publicOrigin` on the resolved package). Without
  one, devtooie doesn't use it: it's data for tooling that reads the exported config
  (`config.packages.api.subdomain`), such as a reverse proxy of your own. Either way the
  canonical entry is handed to this package's callbacks as `subdomain` — see
  [Callbacks](#callbacks-instead-of-interpolation). Each entry must be a DNS label — lowercase
  letters, digits, and hyphens, not starting or ending with a hyphen, at most 63 characters —
  and no two packages may declare the same one, canonical or alias.
- **`urls`** — links shown in the running footer, one entry per line. Each entry is a
  URL, a `{ label, url }`, or an **array** of those (rendered on the same line,
  space-separated). Any URL may be a callback, and any may be a **path** (`'/todos'`, or
  `'todos'`; `''` is the origin itself), based on the package's public origin under the
  [dev reverse proxy](./dev-reverse-proxy.md) — one link, not a localhost one too — or on
  `http://localhost:<port>` without one. A path on a package with no `port` is an error.
  devtooie adds no links of its own.
- **`healthcheck`** — a URL polled for readiness; also required by anything
  that lists this package in its `waitFor`. A **path** (`'/health'`, or `'health'`) is probed
  at `http://localhost:<port>/health` — always the package itself, never through the dev
  reverse proxy. May be a callback, or `{ url, timeout }` to give this package's probes longer
  than the 1500 ms default. See [Readiness probing](#readiness-probing).
- **`tokens`** — values of your own for this package's callbacks, merged **over** the
  top-level `tokens`. Only declare it where the package has tokens — never `tokens: {}`. See
  [Typed tokens](#typed-tokens).
- **`waitFor`** — package names to wait on (each must define a `healthcheck`)
  before this package starts. Type-checked against the keys of `packages`.
- **`tsconfig`** — the tsconfig file (relative to the package dir) devtooie reads for
  this package's project references. Defaults to `tsconfig.build.json`, then
  `tsconfig.json`. See [project references](#typescript-project-references--shared-libraries).
- **`deps.build`** / **`deps.dev`** / **`deps.runtime`** — see below.
- **`logs`** — per-package log options `{ timestamps?, formatter? }`. `timestamps` overrides the
  top-level [`logs.timestamps`](./logging.md#timestamps) for this package (inheriting it when
  omitted); `formatter` (`(line: string) => string`) **overrides the default structured-log
  formatter** that devtooie already applies to every package. See [Logging](./logging.md).

## `env.override`

The ambient environment wins over `.env` files, as in Next.js, Vite and `node --env-file` — so
`FOO=bar devtooie` overrides a file for a single run. `env.override` names the variables where the
file is allowed to win instead:

```ts
defineConfig({
  packageRootDir: 'packages',
  env: { override: ['NODE_OPTIONS'] },   // or `true` for every variable
  packages: {/* … */},
});
```

The case it exists for is a file that *extends* an inherited value rather than replacing it —
`NODE_OPTIONS="$NODE_OPTIONS --disable-warning=ExperimentalWarning"`. Without the override that
line silently does nothing whenever the shell already sets `NODE_OPTIONS`, which VS Code's
integrated terminal always does.

Which **files** load isn't configured here — that's [`--mode`](./cli.md).

## Callbacks instead of interpolation

devtooie does **no string interpolation**. A value that depends on the port, the environment, or
anything else is written as a plain function of it, so it's ordinary TypeScript your editor
checks — nothing to learn, nothing to escape, and a `$` in a string is just a `$`.

`port`, `healthcheck`, and every `urls` entry (including the `url` inside a `{ label, url }`)
accept either a literal or a callback — as do the top-level `devReverseProxy.port` and
`rootDomain`, over the workspace context `{ envs, tokens }`. For a URL of this package's own,
a **relative path** is the literal to reach for first: it needs no callback at all, since devtooie
resolves it against the package's port (or its public origin under the dev reverse proxy).

```ts
export default defineConfig({
  packageRootDir: 'packages',
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

| Key      | What it is                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `envs`   | The package's `.env` files resolved and merged with `process.env` (which wins by default) — the same environment the dev process gets. See [Environment loading](../README.md#environment-env-loading). |
| `tokens` | The top-level `tokens` with this package's own `tokens` merged **over** them. Typed from what you declared, so a typo is a compile error. |
| `port`   | The package's resolved `port`, typed **`number`** (not `number \| undefined`) so it drops straight into a URL. A package that declares no `port` has nothing to give, which types can't express here — so reading `port` in that case throws when the config loads, naming the package. Not offered to `port` itself, nor to the workspace-wide `urls`. |
| `subdomain` | The package's canonical `subdomain` — the first entry when it declared several — so a URL can be built from it without repeating it: `` urls: [({ subdomain, envs }) => `https://${subdomain}.${envs.LOCALDEV_DOMAIN}`] ``. Plain data, unlike `port`: `undefined` (in type and in value) for a package that declares none, so branch on it if a callback has to work either way. Not offered to `port`, nor to the workspace-wide `urls`. |

Callbacks run **once**, while the config is being defined, and must be synchronous. A `port`
callback returns a number (or `undefined`); the rest return a string.

### Typed tokens

`tokens` is typed from what you write: `tokens.region` is a known key, `tokens.regoin` is a
compile error, and a package's own tokens stay **private to that package** — `api`'s `region`
is not a key on `web`'s `tokens`.

Declare them only where you have them. A package with no tokens of its own writes nothing:

```ts
export default defineConfig({
  packageRootDir: 'packages',
  tokens: { domain: 'example.test', proto: 'https' },
  packages: {
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

A package's own tokens are an **override**, not a merge: a key it redeclares replaces the
config's for that package only.

The resolved tokens are on the config's exported value too, keyed by package name — so other
scripts in the repo can read them:

```ts
import config from './devtooie.config.js';

config.packages.api.tokens.region;   // 'us-east'
config.packages.web.tokens.domain;   // 'example.test'
config.packages.web.tokens.region;   // compile error — that's api's
```

You can also skip `tokens` entirely and close over ordinary `const`s in the config file, which
is just as typed:

```ts
const domain = 'example.test';
// …
urls: [() => `https://api.${domain}`];
```

## Readiness probing

A package with a `healthcheck` is polled while it runs: the footer dot turns green once a probe
passes, and any package listing it in `waitFor` starts at that moment. devtooie probes each
package in exactly one place, no matter how many others wait on it.

Probes never overlap. The next one starts **2 s after the previous one started** — so a fast
answer leaves an idle gap, while a probe that runs past 2 s is followed immediately.

A probe that hasn't answered within `timeout` — **in milliseconds**, 1500 by default — is
aborted. Raise it for a
service slow to answer on a cold start: devtooie hanging up mid-request is itself what makes such
a server log a dropped connection, and the aborted probe leaves the package showing `starting`
until the next one lands.

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

### The `port` in a callback

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

## Logging

Timestamps and structured-log (JSON) formatting — the top-level and per-package `logs` options —
have their own page: **[Logging](./logging.md)**.

## Dependencies

Three independent categories, resolved when you select a package:

- **`deps.build`** — extends the build-time deps devtooie already infers from your
  TypeScript [project references](#typescript-project-references--shared-libraries).
  Resolved transitively.
- **`deps.dev`** — compiled before running (currently behaves like a build dep).
- **`deps.runtime`** — other packages that must be _running_ alongside this
  one. **Not transitive**: only the packages you explicitly select have
  their runtime deps expanded. If a runtime dep needs its own runtime deps
  too, select it explicitly (or add it to your own selection).

`devtooie resolvedeps <package>` prints the resolved build/dev/runtime
sets for a single package as JSON — handy for wiring other tooling to the same
dependency graph.

## TypeScript project references & shared libraries

devtooie infers build-time deps from your **project references**: for each package it reads
`tsconfig` (else `tsconfig.build.json`, else `tsconfig.json`) and follows its `references`,
building those deps first. Give a shared lib a watching `dev` (e.g. `tsc --watch` emitting to
`dist`) and it runs alongside the apps, so its edits propagate live. Keep each package's
`dev`/`build` building only itself — the lib owns its watcher. See the
[`example/`](https://github.com/rhyek/devtooie/tree/main/example) monorepo.

## Advanced: typed package names

Most people don't need this. If you want other scripts in your repo to import a
literal union of your package names from `devtooie`, name the config value and
augment the `'devtooie'` module with it:

```ts
import { defineConfig } from 'devtooie';

const config = defineConfig({
  packageRootDir: 'packages',
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
restart('web');    // ok
restart('nope');   // compile error

type ApiTokens = PackageConfig<'api'>['tokens'];   // { domain: …; region: … }
```

Purely opt-in — the scaffolded config doesn't include it, and you don't need it to get typed
`waitFor`/`deps` inside the config itself (those are checked against the keys either way).
