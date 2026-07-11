# Configuration options

> Part of the [devtooie](../README.md) documentation.

`defineConfig` accepts:

| Field          | Meaning                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------- |
| `packages`     | Your package definitions (see below).                                                       |
| `workspaceDir` | Root each package's `relativeDir` resolves against. Defaults to `process.cwd()`.            |
| `env`          | `.env` files loaded per package — see [Environment loading](../README.md#environment-env-loading). |
| `apiPort`      | Pin the [control API](./control-api.md) port (otherwise chosen automatically).              |

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
  See [Package lifecycle](./package-lifecycle.md).
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

`devtooie resolvedeps -p <name> [...]` prints the resolved build/dev/runtime
sets as JSON — handy for wiring other tooling to the same dependency graph.

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
