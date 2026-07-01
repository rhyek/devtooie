# devtooie — Technical Design Spec

> Status: approved design, ready for implementation planning.
> Audience: an engineer (or agent) picking this up cold, with no prior context.
> This document is self-contained: it fully specifies the package's public API,
> CLI, runtime behavior, build, and release pipeline.

---

## 1. Summary

**devtooie** is an npm package that provides an interactive CLI for starting a
monorepo's local development processes with **dependency-aware orchestration**.
A consumer declares their apps/services once in a config file; devtooie resolves
build-time, dev-time, and runtime dependencies, builds what needs building in the
right order, then runs the selected services together — either in a full terminal
UI (Ink/React) or a plain log-streaming mode.

It ships **two things** from one package:

1. **A library** — `defineAppConfigs(...)`, `AppType`, `findApp`, and supporting
   types. The consumer authors their config against these, and *sibling tools* in
   their monorepo (reverse proxies, codegen scripts, etc.) import the same typed
   config.
2. **A CLI binary** (`devtooie`) — driven by the consumer's config file, passed
   via `--config`.

This spec is self-contained and describes devtooie as a standalone product: its
public API, CLI, runtime behavior, build, and release pipeline in enough detail to
implement from scratch.

### Design pillars

- **Portable.** No dependency on any specific JS runtime (no Bun), env-file loader,
  or monorepo-specific directory scheme. Runs on plain modern Node.
- **Minimal consumer boilerplate.** The consumer's config file is essentially a
  single `export default defineAppConfigs({...})`.
- **Strong types with zero hand-maintenance.** Consumers and their sibling tools
  get a fully-typed, literal app-name union via optional generated module
  augmentation — no manually-kept type unions.
- **Unix-first.** macOS/Linux only for v1 (documented limitation).

---

## 2. Goals & Non-Goals

### Goals

- Publish `devtooie` to npmjs.
- Expose `defineAppConfigs` + related types as the public API surface consumers and
  their sibling tools build against.
- CLI invoked as `devtooie --config=<path>` (via `pnpm`, `npm run`, `npx`,
  `bun`, or any runner — the invocation mechanism is package-manager-agnostic).
- Decouple entirely from the internal monorepo's runtime, env scheme, and directory
  layout.
- Faithful, low-boilerplate consumer ergonomics (`export default`, generated types).
- A CHANGELOG-driven GitHub Actions release pipeline that publishes to npm with
  provenance.

### Non-Goals (v1)

- **Test/example applications.** Not needed yet. The repo layout leaves room to add
  a `packages/test/*` tier later without restructuring.
- **Windows support.** The session handoff, port sweeping, and process-group kills
  are POSIX-based. v1 is Unix-only and documents this.
- **Generalizing the spawned package manager.** The CLI spawns `pnpm run <script>`
  (or `make <target>`) to run each app's `dev`/`build`. Broadening to yarn/npm for
  the *spawned* commands is deferred. (This is independent of how the CLI *itself*
  is invoked, which is already agnostic.)
- **Dual CJS/ESM build.** The package is ESM-only (`"type": "module"`).
- **Build pipeline / CI-CD orchestration for the consumer.** devtooie is purely
  local dev DX; it only runs dev processes.

---

## 3. Repository Structure

Monorepo with a single publishable package under `packages/`. Root is a private
pnpm workspace.

```
devtooie/
├── package.json                 # private workspace root ("private": true)
├── pnpm-workspace.yaml          # packages: ['packages/*']  (room for packages/test/* later)
├── tsconfig.json                # root/base tsconfig
├── .npmrc                       # auto-install-peers=false
├── .tool-versions               # node + pnpm pins
├── .gitignore                   # node_modules, dist, .devtooie/, devtooie-env.d.ts, *.log
├── .prettierrc.yaml
├── eslint.config.js
├── CHANGELOG.md                 # drives release versioning (see §14)
├── README.md                    # published with the package
├── LICENSE                      # MIT
├── docs/
│   └── superpowers/specs/       # this document lives here
├── scripts/
│   ├── build.sh                 # compile packages/devtooie → dist
│   └── change-log-entry.sh      # extract a single CHANGELOG entry for release notes
├── .github/workflows/
│   ├── pr.yaml                  # eslint + build on PRs
│   └── release.yaml             # CHANGELOG-driven publish to npm
└── packages/
    └── devtooie/
        ├── package.json         # name: "devtooie", bin + exports, ESM-only
        ├── tsconfig.json        # build config (emits JS + .d.ts to dist)
        ├── README.md            # copied from root at release time
        └── src/
            ├── index.ts         # library entry — public exports (see §4)
            ├── config.ts        # defineAppConfigs, AppType, registry, findApp, token subst.
            ├── register.ts      # Register interface + derived AppConfig/AppName types
            ├── cli.ts           # CLI entry (bin) — #!/usr/bin/env node after build
            ├── load-config.ts   # locate + import the consumer's --config module
            ├── typegen.ts       # generate devtooie-env.d.ts augmentation file
            ├── lib.ts           # pure helpers: dep resolution, runner detection, groups, persistence
            ├── process-manager.ts
            ├── dev-session.ts   # single-active-session handoff (Unix)
            ├── command-server.ts# localhost control HTTP API
            ├── git-watch.ts     # branch-change monitor
            ├── plain-status.ts  # plain-runner handoff status line
            ├── debug-log.ts     # opt-in debug log (DEBUG_DEVTOOIE)
            ├── errors.ts        # handleShellError (portable, duck-typed)
            ├── runners/
            │   ├── plain.ts
            │   └── types.ts     # RunnerArgs
            └── components/
                ├── App.tsx
                ├── ServiceSelector.tsx
                ├── BuildProgress.tsx
                ├── NativeRunner.tsx
                └── HotkeyHints.tsx
```

The package's `package.json`:

```jsonc
{
  "name": "devtooie",
  "version": "0.0.0",                     // set from CHANGELOG at release time
  "description": "Dependency-aware CLI for running a monorepo's local dev processes.",
  "author": "Carlos González <carlos.rgn@gmail.com>",
  "license": "MIT",
  "type": "module",
  "repository": { "type": "git", "url": "https://github.com/<owner>/devtooie.git" },
  "keywords": ["monorepo", "dev", "cli", "orchestration", "dependencies", "tui", "ink"],
  "engines": { "node": ">=23.6" },        // native .ts config import (24 LTS recommended)
  "bin": { "devtooie": "./dist/cli.js" },
  "files": ["dist"],
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "dependencies": { /* see §12 */ },
  "peerDependencies": { "typescript": ">=5.0.0" },
  "devDependencies": { /* see §12 */ }
}
```

---

## 4. Package Public API (library surface)

Everything below is exported from `packages/devtooie/src/index.ts`.

### 4.1 `defineAppConfigs`

The single function a consumer must call. It takes an **options object** (not a bare
array), validates the config, computes each app's on-disk `path`, performs URL/token
substitution, registers the result in a module-level singleton (so `findApp` and the
CLI can read it), and returns the fully-typed, resolved config array.

```ts
export type AppTypeValue = 'backend' | 'browser' | 'lib';

export interface RunConfig<N extends string> {
  /** Show in the CLI selector. Default true. Set false for infra-only deps. */
  selectable?: boolean;
  /** Short display name for the process-prefix column. Falls back to `name`. */
  shortName?: string;
  /** Subdomain(s) for reverse-proxy routing. `:subdomain` token uses the first. */
  subdomain?: string | string[];
  /** Service port. Used for `:port` substitution. */
  port?: number;
  /** Dedicated HMR WebSocket port (e.g. Vite). Swept during session handoff. */
  hmrPort?: number;
  /** URLs shown in the runner footer. Support token substitution (§7.2). */
  urls?: (string | { label: string; url: string })[];
  /** URL polled for readiness. Supports token substitution. */
  healthcheck?: string;
  /** App names to wait for (must each define a healthcheck). Validated. */
  waitFor?: NoInfer<N>[];
  deps?: {
    build?: NoInfer<N>[];   // explicit build deps (extend tsconfig refs)
    dev?: NoInfer<N>[];     // compile-time deps (built before running)
    runtime?: NoInfer<N>[]; // services that must be running during dev
  };
}

export interface AppConfigInput<N extends string> {
  name: N;
  /** Dir relative to workspaceDir. Defaults to `projects/<name>`. */
  relativeDir?: string;
  types: AppTypeValue[];
  run?: RunConfig<N>;
}

export interface DefineAppConfigsOptions<N extends string> {
  apps: AppConfigInput<N>[];
  /**
   * Root against which each app's `relativeDir` is resolved to an absolute `path`.
   * Defaults to `process.cwd()`. Optional; supply (e.g. via import.meta.dirname)
   * only if the config may be imported from a different working directory and you
   * need `path` to remain stable.
   */
  workspaceDir?: string;
  /**
   * Values for extrinsic URL tokens. e.g. { domain: 'example.com', proxyport: '3000' }
   * substitutes `:domain` and `:proxyport`. Intrinsic tokens (:name, :port,
   * :subdomain) are always available and need not be listed here.
   */
  tokens?: Record<string, string | undefined>;
}

/** The resolved shape returned per app (input + computed fields). */
export type ResolvedAppConfig<N extends string> = AppConfigInput<N> & {
  relativeDir: string;
  path: string;
};

export function defineAppConfigs<const N extends string>(
  opts: DefineAppConfigsOptions<N>,
): ResolvedAppConfig<N>[];
```

Notes:
- **`const N`** (const type parameter) preserves the literal union of app names
  without requiring the consumer to write `as const`. This is what makes
  `waitFor`/`deps`/name typos compile errors, and what powers the generated type
  augmentation (§4.5).
- **Validation performed at call time** (throws with a clear message):
  - every `waitFor` target must exist and must define a `healthcheck`;
  - a URL/healthcheck using `:subdomain` requires `run.subdomain`;
  - a URL/healthcheck using `:port` requires `run.port`;
  - a URL/healthcheck using an extrinsic token (e.g. `:domain`) requires that token
    to be present in `opts.tokens`.
- **Registry side-effect.** The returned array is stored in a module-level singleton
  inside the package. Importing the consumer's config module (which calls
  `defineAppConfigs`) is therefore what populates the registry — both for the CLI
  and for any sibling tool in the same process.
- **`AppType` value access.** `AppType` is exported as a runtime object so existing
  usage `AppType.BACKEND` keeps working while remaining erasable under Node's
  type-stripping:
  ```ts
  export const AppType = { BACKEND: 'backend', BROWSER: 'browser', LIB: 'lib' } as const;
  export type AppType = (typeof AppType)[keyof typeof AppType]; // 'backend'|'browser'|'lib'
  ```
  Consumers may write either `types: ['backend']` (string literals) or
  `types: [AppType.BACKEND]`.

### 4.2 Wide config type

```ts
/** Wide config shape for code that only needs `.name`/`.run`/`.path` as data. */
export type AnyAppConfig = ResolvedAppConfig<string>;
```

Internal package code (dep resolution, ProcessManager, runners) is written against
`AnyAppConfig` — it only needs `name: string` at runtime. This is why the registry
+ wide-type approach works cleanly without threading the literal union everywhere.

### 4.3 `findApp`

```ts
/** Look up a registered app by name. Throws if not found. Reads the singleton. */
export function findApp(name: string): AnyAppConfig;
```

Works in any process that has imported the consumer's config (directly or
transitively), since that import populates the registry.

### 4.4 `Register` interface & type augmentation

The package ships an empty, augmentable `Register` interface and derives the narrow
public types from it, falling back to the wide type when unaugmented:

```ts
// register.ts
export interface Register {}   // augmentation target — intentionally empty

type Resolved =
  Register extends { appConfigs: infer T extends readonly AnyAppConfig[] }
    ? T
    : readonly AnyAppConfig[];

/** Narrow config type once Register is augmented; else AnyAppConfig. */
export type AppConfig = Resolved[number];
/** Literal union of app names once augmented; else string. */
export type AppName = AppConfig['name'];
```

A consumer (or the generated file, §5.4) augments it once:

```ts
declare module 'devtooie' {
  interface Register { appConfigs: typeof import('./apps').default }
}
```

After that, anywhere in the monorepo:

```ts
import type { AppConfig, AppName } from 'devtooie'; // narrow, auto-tracks the config
```

Because the augmentation points at `typeof import('./apps').default`, it never needs
regenerating when apps are added/removed — it is one-time wiring.

### 4.5 Full export list

```ts
// index.ts
export { defineAppConfigs, AppType, findApp } from './config';
export type {
  AppConfigInput, RunConfig, DefineAppConfigsOptions,
  ResolvedAppConfig, AnyAppConfig, AppTypeValue,
} from './config';
export type { Register, AppConfig, AppName } from './register';
```

---

## 5. Consumer Integration

### 5.1 The config file

The entire file the consumer must write (`apps.ts`, or any name they like):

```ts
import { defineAppConfigs } from 'devtooie';

export default defineAppConfigs({
  // workspaceDir?: path.resolve(import.meta.dirname, '../..'),  // optional; default cwd
  tokens: { domain: process.env.APP_DOMAIN, proxyport: process.env.PROXY_PORT },
  apps: [
    {
      name: 'core-svc',
      types: ['backend'],
      run: {
        port: 3001,
        healthcheck: 'http://localhost::port/health',
        deps: { runtime: ['reverse-proxy'] },
      },
    },
    {
      name: 'reverse-proxy',
      types: ['backend'],
      run: { selectable: false, healthcheck: 'https://:domain::proxyport/_health' },
    },
    {
      name: 'web',
      types: ['browser'],
      run: {
        port: 3000,
        urls: ['https://app.:domain::proxyport'],
        waitFor: ['core-svc'],
        deps: { runtime: ['core-svc', 'reverse-proxy'] },
      },
    },
  ],
});
```

`export default` means the consumer is never forced to name the variable; the CLI
reads the module's default export. If a sibling tool wants a named import too, the
consumer can add `export const appConfigs = ...; export default appConfigs;` — but
the default export is canonical.

### 5.2 CLI invocation

```bash
devtooie --config=apps.ts            # via npx, or a package.json script
pnpm devtooie --config=apps.ts       # same thing under pnpm
npm run dev                           # if "dev": "devtooie --config=apps.ts"
```

The `--config` path is resolved relative to the current working directory (or given
absolute). See §6.1 for loading details.

### 5.3 Sibling tools

Other tools in the consumer's monorepo import the config value from the consumer's
own file, and types from `devtooie`:

```ts
// e.g. a reverse proxy
import appConfigs from './apps';                 // default import (concrete, typed)
import { AppType, type AnyAppConfig } from 'devtooie';

for (const app of appConfigs) {
  const { subdomain, port, hmrPort } = app.run ?? {};
  // ...
}

function isBackend(app: AnyAppConfig) {
  return app.types.includes('backend'); // or AppType.BACKEND
}
```

They may also use `findApp` from `devtooie` (the registry is populated by importing
`./apps`), and — once augmentation is wired — the narrow `AppConfig`/`AppName`.

### 5.4 `typegen` and the generated augmentation file

`devtooie typegen --config=apps.ts` reads the config and writes a small file into
the consumer's project (default: `devtooie-env.d.ts` next to the config, git-ignored):

```ts
// devtooie-env.d.ts — generated by devtooie. Do not edit.
declare module 'devtooie' {
  interface Register { appConfigs: typeof import('./apps').default }
}
```

- The relative path (`./apps`) is computed from the generated file's location to the
  `--config` target.
- `typegen` also runs automatically at the start of `devtooie dev` (best-effort;
  failure is non-fatal and logged), so most consumers never invoke it directly.
- The generated file must be included in the consumer's `tsconfig` (root-level
  placement usually is already). devtooie does not modify the consumer's tsconfig.

---

## 6. CLI Reference

Argument parsing uses `commander`. Three subcommands (`reset`, `resolvedeps`,
`typegen`) are handled before the main parse so they don't alter default behavior.

### 6.1 Config discovery & loading (`load-config.ts`)

- `--config <path>` is **required** for any command that needs the config (`dev`,
  the default run, `resolvedeps`, `typegen`). Relative paths resolve against cwd.
- The config is loaded via **native dynamic `import()`**. Modern Node (≥23.6, default
  in 24 LTS) strips types from `.ts` files natively, so `import('/abs/apps.ts')`
  works with **no loader dependency**. `.js`/`.mjs` configs work on any Node.
- The loaded module's **default export** is the resolved config array. Importing it
  runs `defineAppConfigs`, which populates the registry; the CLI then reads the
  registry (or the returned default export directly).
- No filename auto-discovery in v1 (explicit `--config` only). A default-filename
  search can be added later without breaking the flag.

Minimum-Node note: because native `.ts` import gates on Node ≥23.6, the package's
`engines.node` is `>=23.6`; the README recommends Node 24 LTS. Consumers on older
Node can point `--config` at a compiled `.js`/`.mjs`.

### 6.2 Options

| Option | Description |
| --- | --- |
| `--config <path>` | **Required.** Path to the config module (`.ts`/`.js`/`.mjs`). |
| `-s, --service <name>` | Repeatable. Service(s) to run, bypassing the selector. Validated against the config. |
| `--ui` | Interactive Ink TUI (default). Mutually exclusive with `--plain`. |
| `--plain` | No TUI; stream logs with colored name prefixes. Mutually exclusive with `--ui`. |
| `--last-answers` | Skip selection; reuse the last saved selection. |
| `--phase <dev\|build>` | Pipeline phase. `dev` (default) resolves+builds+runs. `build` builds deps + selected services, then exits (no runner). |
| `--build` | Alias for `--phase build`. |
| `--rebuild` | Implies `--phase build`; first clears `dist/` of the whole build set, then builds. |
| `--logfile <path>` | Write all logs to this file. Defaults to `<workspaceDir>/devtooie.log` (truncated per session). |
| `--api-port <port>` | Port for the control HTTP API. Overrides env/default. |

Control-API port resolution order: `--api-port` → `DEVTOOIE_API_PORT` env → default
`4099`. No env-file reading.

### 6.3 Subcommands

- **`reset`** — clear persisted preferences (the saved selection). Exits.
- **`resolvedeps --config <path> --service <name> [...]`** — print dependency info as
  JSON and exit. Runs dep resolution three times (build / dev / runtime filters) and
  emits:
  ```json
  { "build": ["..."], "dev": ["..."], "runtime": ["..."] }
  ```
  (selected names excluded from each array). Intended for use by other tooling
  (e.g. targeted typecheck / codegen).
- **`typegen --config <path> [--out <path>]`** — generate the augmentation file (§5.4).

### 6.4 Runner modes

Two runner modes via `--ui` / `--plain`:

- **`ui` (default)** — full Ink/React TUI: interactive selector, animated build
  progress, native runner with hotkeys and a live footer (service status dots, URLs,
  git branch, logfile path).
- **`plain`** — no Ink: console build output, plain process streaming with colored
  name prefixes, SIGINT/SIGTERM graceful shutdown. Requires `--service` or
  `--last-answers` (no interactive selection).

### 6.5 Top-level flow

```
1. Handle typegen/reset/resolvedeps subcommands (pre-parse) → exit.
2. Parse options. Load --config (populates registry).
3. If phase === 'build':
   a. Resolve service names (from --service or --last-answers; error otherwise).
   b. If --rebuild: rm -rf dist/ of selected + their build deps.
   c. Build dependencies (console output), then build selected services. Exit.
4. If runner === 'plain':
   a. Resolve service names.
   b. Acquire the dev session (hand off any running session — §9.5).
   c. Start the control API server (pid + quit available immediately).
   d. Build dependencies, then run plain (attach manager to the API server).
5. If runner === 'ui':
   a. Render Ink <App>. Phase machine: service-select → building → running.
   b. BuildProgress performs the session handoff + starts the control API server
      before the build loop; hands the server to App → NativeRunner, which attaches
      the ProcessManager at the run phase.
```

---

## 7. Configuration Model

### 7.1 The `run` block

Fields (all optional; an app with no `run` is a build-only lib or infra):

- `selectable` (default `true`) — whether the app appears in the CLI selector. Set
  `false` for services only pulled in as dependencies.
- `shortName` — short name used in the process-output prefix column.
- `subdomain` (`string | string[]`) — reverse-proxy routing. `:subdomain` token uses
  the first element when an array.
- `port` — service port; drives `:port` substitution.
- `hmrPort` — dedicated HMR WebSocket port (e.g. Vite). Included in the port sweep
  during session handoff.
- `urls` — array of plain URL strings or `{ label, url }` objects, shown in the
  footer. Support token substitution.
- `healthcheck` — URL polled for readiness; drives colored status indicators and
  `waitFor` gating.
- `waitFor` — app names that must pass their healthcheck before this app starts.
  Every target must define a healthcheck (validated at `defineAppConfigs` time).
- `deps.build` — explicit build deps, extending tsconfig project references.
- `deps.dev` — compile-time deps (built before running; tracked separately from
  build for future divergence, currently identical behavior).
- `deps.runtime` — services that must be running during dev. **Not transitive**
  (see §8).

### 7.2 Token substitution

Applied to `urls` and `healthcheck` strings at `defineAppConfigs` time.

- **Intrinsic tokens** (always available, computed from the app itself):
  - `:name` → the app's `name`
  - `:port` → `run.port` (throws if used without `port`)
  - `:subdomain` → `run.subdomain` (first element if array; throws if used without it)
- **Extrinsic tokens** (consumer-supplied via `opts.tokens`): any other `:key`
  substitutes `tokens[key]`. Referencing a `:key` with no matching token throws a
  clear error naming the app and token.

This removes all hardcoded environment-variable names from the package. The consumer
decides what feeds `tokens` (env vars, computed values, constants).

### 7.3 `workspaceDir` & `path` resolution

- Each app's absolute `path` = `resolve(workspaceDir, relativeDir)`, where
  `relativeDir` defaults to `projects/<name>`.
- `workspaceDir` defaults to `process.cwd()`. Since `devtooie` is normally invoked
  from the monorepo root, this resolves app paths against the repo root.
- Consumers whose config may be imported from a different cwd (and who read
  `app.path`) should pass an explicit `workspaceDir` (e.g. via `import.meta.dirname`)
  to keep `path` stable regardless of caller cwd.

---

## 8. Dependency Resolution

Three dependency categories, merged during resolution:

### Build-time deps
Two sources, unioned:
1. **TypeScript project references** — read from each app's `tsconfig.build.json`
   `"references"`, resolved **transitively** (uses the `typescript` peer dep's
   `ts.readConfigFile`).
2. **`run.deps.build`** — explicit overrides extending the tsconfig-discovered set.

### Dev deps
`run.deps.dev` — compiled before running (added to the build set). Functionally
identical to build deps today; tracked separately for future divergence.

### Runtime deps
`run.deps.runtime` — services that must be **running** during dev.
**Critical rule: runtime deps are NOT transitive.** Only explicitly-selected
services have their `run.deps.runtime` resolved. A service pulled in as another's
runtime dep does not have its own runtime deps followed. (If you explicitly select
that service too, then its runtime deps are resolved.)

### Algorithm

```
resolveAll(selectedApps, depTypes = [BUILD, DEV, RUNTIME]):
  runSet = Set(selectedApps); reasons = {}
  for app in selectedApps:
    reasons[app] = "selected"
    if RUNTIME in depTypes:
      for dep in app.run.deps.runtime: runSet.add(dep); reasons[dep] = "runtime dep of "+app

  buildSet = Set(); queue = [...runSet]           # build/dev deps ARE transitive
  while queue:
    app = queue.shift()
    if BUILD in depTypes:
      for dep in tsconfigBuildApps(app) ∪ app.run.deps.build:
        if dep not in buildSet: buildSet.add(dep); queue.push(dep)
    if DEV in depTypes:
      for dep in app.run.deps.dev:
        if dep not in buildSet: buildSet.add(dep); queue.push(dep)

  allApps = union(runSet, buildSet)
  return { allApps, buildSet, runSet, reasons }
```

`--phase dev` uses all three categories; `--phase build` uses only `[BUILD]`.
`resolvedeps` runs it once per category to produce its JSON.

### Worked example

Select `web` only:
- `runSet = {web, core-svc, reverse-proxy}` (web's runtime deps, one level).
- `buildSet` = tsconfig refs of everything in runSet (e.g. a shared lib).
- Build phase builds the lib; dev phase runs the lib + reverse-proxy + core-svc + web.

---

## 9. Runtime Architecture (module-by-module)

This section specifies each module's responsibility and behavior in enough detail to
implement. Items tagged **[portability]** are constraints that keep the package free
of any runtime, env-file, or directory-layout coupling (see §11).

### 9.1 `cli.ts` (bin entry)
Shebang `#!/usr/bin/env node` (after build). Parses options, loads config, routes to
build/plain/ui paths per §6.5. **[portability]** Node shebang only; imports
`handleShellError` from local `errors.ts`; reads `--config` and loads it via
`load-config.ts`.

### 9.2 `errors.ts`
`handleShellError(err)` — prints `stdout`/`stderr` cleanly and exits with the error's
`exitCode` (or 1). Duck-typed on `{ stdout, stderr, exitCode }`, so it works with any
execa-style error. Self-contained; no runtime coupling.

### 9.3 `lib.ts` (pure helpers)
- **Command-runner detection** — `getCommandRunner(app)` returns `'pnpm'` if the app
  has `package.json`, else `'make'` if it has a `Makefile`, else `'pnpm'`.
  `getExecArgs(app, script)` → `['pnpm', ['run', script]]` or `['make', [script]]`.
  `hasScript`, `hasDevScript`, `getExtraCommands` (excludes runner-managed
  `dev`/`build`/`build:clean`/`build-clean`), `getMakeTargets`.
- **tsconfig build-dep discovery** — `getTsconfigBuildDeps(dir)` reads
  `tsconfig.build.json` references transitively via the `typescript` peer dep;
  `getTsconfigBuildApps(app)` maps resolved dirs back to registered apps by `path`.
- **Dep resolution** — `resolveDeps(selectedApps, lookupApp?, depTypes?)` implements
  §8. `DepType` enum, `ALL_DEP_TYPES`.
- **Selector groups** — `getServiceGroups()` (Backend/Frontend groups of selectable,
  dev-scripted apps), `getRuntimeDepsMap()`.
- **Display sort** — `sortForDisplay(apps, selectedSet)`: selected → selectable deps
  → non-selectable infra; within each, backend → frontend → libs, alphabetical.
- **Runner-args assembly** — `buildRunnerArgs(selectedApps, deps)` computes
  `RunnerArgs` (§9.10): sorted apps, selected/build/rebuildable sets, `waitForMap`,
  `healthcheckUrls`, `extraCommandsMap`.
- **Control-API port** — `getApiPort()`: `--api-port` (threaded in) → `DEVTOOIE_API_PORT`
  → `4099`. **[portability]** No `.env.*` file parsing; no `dotenv`.
- **Persistence** — read/write/reset the saved selection. **[portability]** Stored
  under `<workspaceDir>/.devtooie/selection.json` (never inside the package dir);
  see §10.
- **Git branch** — `getGitBranch()` via `git rev-parse --abbrev-ref HEAD`, short-SHA
  fallback on detached HEAD, null when not a repo.

### 9.4 `process-manager.ts` — `ProcessManager` class
Plain class, no UI. Owns process lifecycle:
- Spawn each service via execa with `{ stdin:'ignore', stdout:'pipe', stderr:'pipe',
  reject:false, buffer:false, detached:true }`. `detached:true` creates process groups
  for clean tree-killing via `process.kill(-pid, signal)`. **No shell wrapper** for
  long-running processes (avoids EMFILE on macOS).
- `pnpm dev` vs `make dev` chosen from the per-process `runner` field.
- Public surface: `startAll`, `start`, `stop`, `restart`, `rebuild`, `runCommand`,
  `runCustomCommand`, `killAll`, `shutdownAll`, `forceKillAll`,
  `static forceKillAllInstances`, `getRunning/getStopped/getWaiting/getRebuildable`,
  `getStatus/getAllStatuses`, `setFilter/getFilter/clearBuffer/refresh`,
  `truncateLogFile`, `logSystem`.
- **Rebuild** = stop → `pnpm run build:clean` → start; failure shows output and does
  not restart. `getRebuildable()` = running procs whose app has a `build:clean` script.
- **Extra commands** (`runCommand`/`runCustomCommand` via a shared `spawnExtra`):
  fire-and-forget one-off scripts / arbitrary shell commands, output interleaved with
  demarcation lines (`▶ running`, `✔ finished`/`✘ exited`), tracked in `extraProcs`
  for cleanup. `shell:true` only for custom commands.
- **Output buffering & filtering** — up to 50k lines buffered for retroactive
  filtering. Group-aware filtering (continuation lines starting with whitespace share
  the primary line's group). Terminal cleared with raw escape codes bypassing Ink.
- **Deferred startup (`waitFor`)** — services with `waitFor` marked `waiting`; a 2s
  poll checks target healthchecks; started when all pass; `s` hotkey force-starts.
- **Exit handling** — multi-layer: first Ctrl+C graceful (`shutdownAll`, SIGTERM,
  3s deadline, SIGKILL all groups), second Ctrl+C force kill, `process.on('exit')`
  sync safety net.
- **Logfile** — when set, opens the file (truncating), writes each line as
  `HH:MM:SS [padded-name] line` with ANSI stripped, no wrapping.

### 9.5 `dev-session.ts` — single-active-session handoff (Unix)
Makes the newest `devtooie` invocation win, cleanly closing any prior session and
freeing dev ports.
- `acquireDevSession({ onStatus })`: on Windows → **no-op**. Else: `GET
  http://127.0.0.1:<apiPort>/query/pid` to detect a live session; if found (and not
  us) → `POST /command/quit` (graceful) → poll the pid's liveness until gone (with an
  ~11s ceiling then SIGKILL its process tree). Then always sweep dev ports.
- **Port sweep** — `findListenerPids(collectDevPorts())` via `lsof -t` (macOS) /
  `ss -tlnpH` (Linux), then `killTrees(holders)`.
- `killTrees(roots)` — one `ps -Ao pid=,ppid=`; build each root + all transitive
  descendants by parent-pid; SIGKILL roots then descendants (reaches the detached
  children a group-kill misses).
- `collectDevPorts()` — every app's `run.port` and `run.hmrPort`, plus the
  control-API port. **[portability]** Only ports derivable from the config plus the
  API port are swept — no env-specific ports are special-cased. Deduped, NaN-filtered.
- Pure helpers (`parseLsofPids`, `parseSsPids`, `buildKillSet`, `dedupePorts`) unit-
  tested. No `find-process` dependency.

### 9.6 `command-server.ts` — localhost control API
A `node:http` server bound to `127.0.0.1` only. Started **before** the build phase
(so a newer session can detect and close it while it's still building) and the
`ProcessManager` is `attach()`-ed at the run phase (same listening socket across the
build→run transition). The port comes from `getApiPort()` (§9.3/§6.2).
Endpoints (methods not enforced — local convenience):
- `GET /query/pid` → `{ pid }`. Always available (incl. build phase).
- `POST /command/quit` → graceful shutdown (same as Ctrl+C). Always available.
- `GET /query/status[/<app>]`, `GET /query/services[?status=…]` → 503 until the
  manager is attached.
- `POST /command/rebuild/<app>`, `POST /command/restart/<app>` → 202; 404 if unknown;
  503 until attached.
- `GET /` → health + pid + command/query listing.

### 9.7 `git-watch.ts`
During the run phase both runners poll the checked-out git branch every 2s. On the
first change vs startup, emit an interleaved system log line and trigger the same
graceful shutdown as Ctrl+C, then stop polling (fires once). Rationale: generated
artifacts (built libs, generated clients, DB schema) are branch-tied; auto-exit
forces a clean restart on the new branch. `read` injectable; change detection unit-
tested with fake timers.

### 9.8 `plain-status.ts`
`createPlainStatusReporter()` drives the plain runner's handoff status line: animated
trailing ellipsis on a TTY (via `\r`), static one-liners off a TTY, silent when
nothing is found.

### 9.9 `components/*.tsx` (ui runner)
- **`App.tsx`** — phase state machine: `service-select → building → running`. Holds
  the control server (from BuildProgress) and hands it to NativeRunner. Chooses the
  initial phase from `--service` / `--last-answers` / else selector.
- **`ServiceSelector.tsx`** — grouped multi-select (Backend/Frontend).
- **`BuildProgress.tsx`** — dependency summary + spinner build progress. Runs the
  session handoff + starts the control server before the build loop; fires
  `onControlReady` then `onComplete(runnerArgs)`.
- **`NativeRunner.tsx`** — owns the `ProcessManager` + `useInput` keystrokes; footer
  layout (hotkey hints, service status dots, git branch, logfile path, service URLs);
  the 5-state service-status model (`useServiceStatuses`) with healthcheck polling +
  a bidirectional reconcile loop; normal/filter/commands modes; footer measured via
  `measureElement` to avoid scrollback gaps.
- **`HotkeyHints.tsx`** — reusable hotkey-hints renderer.

### 9.10 `runners/` 
- **`types.ts`** — `RunnerArgs` interface: `sortedApps`, `selectedSet`,
  `buildDepSet`, `rebuildableSet`, `waitForMap`, `healthcheckUrls`,
  `extraCommandsMap`, `logFile?`.
- **`plain.ts`** — no-TUI runner: constructs a `ProcessManager` (plain mode), starts
  all, streams output; SIGINT/SIGTERM graceful then force. Attaches the manager to
  the control server and wires a single graceful `shutdown()`.

---

## 10. State & File Locations

All writable state lives in a **consumer-owned** directory, never inside the package
(which sits under `node_modules` and is read-only/ephemeral). Nothing is written via
the package's own `import.meta.dirname`:

- **Saved selection** → `<workspaceDir>/.devtooie/selection.json`
- **Default logfile** → `<workspaceDir>/devtooie.log` (override with `--logfile`)
- **Debug log** (opt-in via `DEBUG_DEVTOOIE`) → `<workspaceDir>/.devtooie/debug.log`
- **Generated types** → `devtooie-env.d.ts` next to the config (§5.4)

Recommend the consumer git-ignore `.devtooie/`, `devtooie.log`, and
`devtooie-env.d.ts`. The README documents this.

---

## 11. Portability Requirements

The package must not couple to any specific runtime, env-file loader, or fixed
directory layout. Concretely:

1. **Runtime** — `#!/usr/bin/env node` on the compiled bin; no runtime-specific APIs.
   The only shell-error handling is a duck-typed helper in `errors.ts`.
2. **Directory scheme** — no repo-root walk-up or `GITHUB_WORKSPACE` magic.
   `workspaceDir` comes from the config, defaulting to cwd (§7.3).
3. **Config layer** — `defineAppConfigs`/`AppType`/`findApp`/registry live in the
   package (`config.ts`). The consumer keeps only `export default defineAppConfigs(...)`.
4. **Tokens** — no hardcoded env-var names. Extrinsic URL tokens come from the
   consumer's `tokens` map; intrinsic tokens are computed from the config (§7.2).
5. **Control-API port** — no env-file reading. `--api-port` › `DEVTOOIE_API_PORT` ›
   `4099` (§9.3). No `dotenv`.
6. **Writable state** — selection/debug/log files live under the consumer's
   `workspaceDir`, never inside the package (§10).
7. **Port sweep** — only config-derivable ports + the API port are swept (§9.5).
8. **Naming** — env var `DEVTOOIE_API_PORT`, debug flag `DEBUG_DEVTOOIE`, default
   logfile `devtooie.log`, state dir `.devtooie/`.
9. **Config loading** — `load-config.ts`: `--config` + native Node `.ts` import, no
   loader dependency.
10. **Type augmentation** — `register.ts` + `typegen.ts` (§4.4, §5.4).

---

## 12. Dependencies

**Runtime `dependencies`** (bundled with the package):
- `ink`, `react`, `ink-spinner` — TUI.
- `chalk` — colored prefixes (both runners).
- `execa` — process spawning + `lsof`/`ss`/`ps` calls.
- `commander` — CLI parsing.
- `string-width`, `wrap-ansi` — ANSI-aware wrapping/measurement.

**`peerDependencies`**:
- `typescript` (`>=5.0.0`) — used to read `tsconfig.build.json` references for build-
  dep discovery. Peer because consumer monorepos already have it. (`.npmrc`
  `auto-install-peers=false`.)

**Explicitly not used:** no `dotenv` (no env-file reading), no directory walk-up
(`find-up`/`pkg-dir`), no `find-process`, no runtime/env-loader coupling.

**`devDependencies`** (root workspace): `typescript`, `@types/node`, `@types/react`,
`eslint` + plugins, `prettier`, `vitest` (for the unit specs). Pin Node/pnpm via
`.tool-versions`.

---

## 13. Build System

- **ESM-only.** `"type": "module"`, single build target. Avoids the dual-CJS/ESM
  `sed`-patching complexity. `import.meta.dirname` is available natively.
- `scripts/build.sh`: `rm -rf packages/devtooie/dist` → `pnpm tsc -p
  packages/devtooie/tsconfig.json` (emits `.js` + `.d.ts` to `dist/`). Ensure the bin
  (`dist/cli.js`) keeps the `#!/usr/bin/env node` shebang (either in source or
  re-added post-compile) and is executable.
- `packages/devtooie/tsconfig.json`: `module`/`moduleResolution` for Node ESM,
  `declaration: true`, `outDir: dist`, `target` modern (Node ≥23.6). JSX config for
  the Ink `.tsx` components (`jsx: react-jsx`).
- Root `tsconfig.json` is a thin base; the package extends it.

---

## 14. Publish Pipeline (CI)

Two GitHub Actions workflows.

### `.github/workflows/pr.yaml`
On PRs to `main`: install (frozen lockfile), run ESLint on changed files, run the
build. (No consumer test apps yet; add an E2E job when `packages/test/*` exists.)

### `.github/workflows/release.yaml`
On push to `main` (and `workflow_dispatch`). CHANGELOG-driven — no separate version
tag step in the PR:
1. **Determine version** — grep the top `## X.Y.Z` from `CHANGELOG.md`. If a GitHub
   release for that version already exists, skip. Else proceed.
2. Install toolchain (pin via `.tool-versions`), `pnpm install --frozen-lockfile`.
3. `npm version <version> --no-git-tag-version` in `packages/devtooie`.
4. `./scripts/build.sh`.
5. Copy root `README.md` → `packages/devtooie/README.md`.
6. Extract the changelog entry for the version → release-notes body
   (`scripts/change-log-entry.sh`).
7. Create the GitHub release (tag = version, `target_commitish` = sha).
8. `npm publish --provenance --access public` from `packages/devtooie` (needs
   `id-token: write` + npm auth configured in the workflow).

Releasing is therefore: land a PR that adds a `## X.Y.Z` heading atop `CHANGELOG.md`;
the merge to `main` publishes it.

---

## 15. Testing

Unit specs (no consumer apps needed):
- Dependency-resolution spec — the §8 algorithm against a fixture config.
- `dev-session` spec — `parseLsofPids`, `parseSsPids`, `buildKillSet`, `dedupePorts`.
- `git-watch` spec — change detection with fake timers + injected `read`.
- `defineAppConfigs` validation (waitFor without healthcheck, missing token, missing
  port/subdomain) and token substitution (intrinsic + extrinsic).
- `getApiPort` precedence (`--api-port` › env › default).
- `typegen` output (correct relative path, valid augmentation).

Run via `vitest`. CI `pr.yaml` runs eslint + build; add the vitest run once specs
exist.

---

## 16. Implementation Phases

Suggested order (each phase independently reviewable):

1. **Scaffold** — workspace root, `packages/devtooie`, tsconfig(s), eslint/prettier,
   `.tool-versions`, `.npmrc`, `.gitignore`, empty `CHANGELOG.md`, LICENSE, README
   skeleton, `scripts/build.sh`.
2. **Config layer** — `config.ts` (`defineAppConfigs` object-form + `const N`,
   `AppType`, registry, `findApp`, token substitution, validation), `register.ts`,
   `index.ts`. Unit-test validation + tokens.
3. **Runner core** — `lib.ts`, `process-manager.ts`, `runners/`, `dev-session.ts`,
   `command-server.ts`, `git-watch.ts`, `plain-status.ts`, `debug-log.ts`,
   `errors.ts`, `components/*.tsx`, per §9. Honor the §11 portability requirements
   throughout (workspaceDir, tokens, API port, state locations, node shebang).
   Include the unit specs.
4. **CLI + config loading** — `cli.ts` (commander, phases, subcommands),
   `load-config.ts` (`--config`, native `.ts` import), `--api-port`. Wire everything.
5. **typegen** — `typegen.ts` + the `typegen` subcommand + auto-run on `dev`.
6. **Publish pipeline** — `pr.yaml`, `release.yaml`, `change-log-entry.sh`, first
   `## 0.1.0` CHANGELOG entry, README (usage, config, tokens, Node requirement,
   Unix-only note, state files to git-ignore).
7. **Dry-run publish** — `npm pack` inspection; verify `bin`, `exports`, `files`,
   `.d.ts`, shebang, and that a scratch consumer with `export default
   defineAppConfigs({...})` + `--config` runs end-to-end.

---

## 17. Open Questions / Future Work

- **Spawned package manager** — v1 spawns `pnpm`/`make`. A future `packageManager`
  detection or config option could support yarn/npm-run for the spawned dev/build
  commands.
- **Windows** — the session handoff / port sweep / group kills are POSIX. A future
  version could add a Windows strategy (e.g. `netstat`/`taskkill`, job objects).
- **Config auto-discovery** — a default filename search (e.g. `devtooie.config.ts`)
  could make `--config` optional.
- **Dual CJS build** — only if a CJS-only sibling-tool consumer ever appears.
- **Name** — `devtooie` is the working package name (available, memorable; slightly
  non-descriptive for npm search). Confirm before first publish.
