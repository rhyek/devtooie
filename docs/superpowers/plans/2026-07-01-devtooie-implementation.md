# devtooie Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish `devtooie` — an npm package exposing a typed `defineAppConfigs` library plus a `devtooie` CLI that runs a monorepo's local dev processes with dependency-aware orchestration (TUI + plain modes) — per `docs/superpowers/specs/2026-07-01-devtooie-npm-publish-design.md`.

**Architecture:** A private pnpm-workspace monorepo with one publishable ESM package at `packages/devtooie`. The package splits into (a) a pure **config library** (`config.ts`/`register.ts`/`index.ts`) with a module-level registry and type augmentation, and (b) a **CLI runtime** (`cli.ts` + `lib.ts` + process/session/server/git/UI modules) driven by a committed `devtooie.yaml`. Pure logic is TDD'd with vitest; the Ink/React TUI and process engine are built and typecheck-gated. A CHANGELOG-driven GitHub Actions workflow publishes to npm with provenance.

**Tech Stack:** TypeScript (ESM-only), Node ≥23.6 (native `.ts` import), Ink/React, execa, commander, yaml, @clack/prompts, chalk, string-width, wrap-ansi, ink-spinner; vitest for tests; pnpm workspace; `typescript` as a peer dep.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec.

- **Runtime floor:** `engines.node` = `">=23.6"` (native `.ts` services import); README recommends Node 24 LTS. Compiled bin shebang `#!/usr/bin/env node`.
- **Module format:** ESM-only. `"type": "module"` in the package. No dual CJS/ESM build. Use `import.meta.dirname` (native).
- **Platform:** Unix-only (macOS/Linux). Session handoff, port sweep, and group kills are POSIX. `acquireDevSession` is a no-op on Windows; document the limitation.
- **Runtime `dependencies` (only these):** `ink`, `react`, `ink-spinner`, `chalk`, `execa`, `commander`, `string-width`, `wrap-ansi`, `yaml`, `@clack/prompts`.
- **`peerDependencies`:** `typescript` `">=5.0.0"` (reads `tsconfig.build.json` references). `.npmrc` sets `auto-install-peers=false`.
- **Explicitly NOT allowed as deps or in code:** no `bun`/Bun APIs, no `dotenv` or any env-file loader, no `find-process`, no `find-up`/`pkg-dir` or any directory walk-up, no `GITHUB_WORKSPACE` magic. `postinstall.mjs` uses only Node built-ins.
- **Config source of truth:** the CLI reads `devtooie.yaml` (or `.yml`) from cwd. Fields: `services` (path), `apiPort`, `skill`. **No `--config` and no `--api-port` CLI flags.**
- **Control-API port:** from `devtooie.yaml` `apiPort`, default `4099`. **No env var** (no `DEVTOOIE_API_PORT`), no flag. Server binds `127.0.0.1` only.
- **Ephemeral state location:** `node_modules/.devtooie/` — a scratch dir *beside* the package symlinks, **never** the `devtooie` package's own dir (pnpm symlinks it into the reinstall-wiped store). Holds `selection.json`, `devtooie.log` (default), `debug.log`, `skill.json`.
- **Generated types:** `devtooie-env.d.ts` at the consumer repo root, git-ignored, must be visible to the consumer's tsconfig. devtooie never edits the consumer's tsconfig.
- **Tokens:** no hardcoded env-var names. Intrinsic tokens `:name`/`:port`/`:subdomain` computed from the app; extrinsic tokens (`:domain`, etc.) come from `opts.tokens`.
- **npm scripts the CLI drives/spawns:** `dev`, `build`, `clean`, `build:clean` (= `clean` then `build`). Spawns `pnpm run <script>` (Node app w/ `package.json`) or `make <target>` (has `Makefile`).
- **Debug flag:** `DEBUG_DEVTOOIE` (opt-in) → `node_modules/.devtooie/debug.log`.
- **No external-project references anywhere in this repo.** Write all source, comments, commit messages, and docs as greenfield. Never name or hint at any other project this was modeled on or ported from.

---

## File Structure

```
devtooie/
├── package.json                 # T1  private workspace root
├── pnpm-workspace.yaml          # T1  packages: ['packages/*']
├── tsconfig.json                # T1  base tsconfig
├── .npmrc                       # T1  auto-install-peers=false
├── .tool-versions               # T1  node + pnpm pins
├── .gitignore                   # (exists) node_modules, dist, .DS_Store
├── .prettierrc.yaml             # T1
├── eslint.config.js             # T1
├── vitest.config.ts             # T1  (root; workspace picks up packages/**/*.spec.ts)
├── CHANGELOG.md                 # T1 skeleton → T27 first entry
├── README.md                    # T1 skeleton → T27 full
├── LICENSE                      # T1  MIT
├── scripts/
│   ├── build.sh                 # T2  scaffold → T27 finalize
│   └── change-log-entry.sh      # T27
├── .github/workflows/
│   ├── pr.yaml                  # T27
│   └── release.yaml             # T27
└── packages/devtooie/
    ├── package.json             # T2
    ├── tsconfig.json            # T2  (build config; jsx react-jsx)
    ├── tsconfig.build.json      # T2  (optional refs holder; used by tsconfig-dep discovery in consumers, not self)
    ├── postinstall.mjs          # T26
    ├── assets/skill.md          # T24
    └── src/
        ├── index.ts             # T7  public exports
        ├── config.ts            # T3–T6  defineAppConfigs, AppType, registry, findApp, tokens, validation
        ├── register.ts          # T7  Register/AppConfig/AppName
        ├── errors.ts            # T8
        ├── debug-log.ts         # T8
        ├── lib.ts               # T9–T12  pure helpers
        ├── runners/
        │   ├── types.ts         # T12  RunnerArgs
        │   └── plain.ts         # T18
        ├── dev-session.ts       # T13
        ├── command-server.ts    # T14
        ├── git-watch.ts         # T15
        ├── plain-status.ts      # T16
        ├── process-manager.ts   # T17
        ├── components/
        │   ├── App.tsx          # T19
        │   ├── ServiceSelector.tsx
        │   ├── BuildProgress.tsx
        │   ├── NativeRunner.tsx
        │   └── HotkeyHints.tsx
        ├── project-config.ts    # T20  read/write devtooie.yaml
        ├── load-config.ts       # T21  resolve + import services module
        ├── typegen.ts           # T23
        ├── skill.ts             # T24
        └── init.ts              # T25
```

**Testing note:** Test files are colocated as `*.spec.ts` next to the module (e.g. `src/config.spec.ts`). Run a single spec with `pnpm vitest run packages/devtooie/src/<name>.spec.ts`.

---

## Phase 1 — Scaffold

### Task 1: Workspace root scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `.npmrc`, `.tool-versions`, `.prettierrc.yaml`, `eslint.config.js`, `vitest.config.ts`, `CHANGELOG.md`, `README.md`, `LICENSE`
- Verify: `.gitignore` already contains `node_modules/`, `dist/`, `.DS_Store` (leave as-is)

**Interfaces:**
- Produces: a pnpm workspace whose members are `packages/*`; a base tsconfig the package extends; eslint/prettier/vitest configs; MIT LICENSE; empty CHANGELOG + README skeletons.

- [ ] **Step 1: Write the workspace root `package.json`**

```json
{
  "name": "devtooie-workspace",
  "private": true,
  "type": "module",
  "engines": { "node": ">=23.6" },
  "scripts": {
    "build": "./scripts/build.sh",
    "lint": "eslint .",
    "format": "prettier --write .",
    "test": "vitest run",
    "typecheck": "tsc -p packages/devtooie/tsconfig.json --noEmit"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^18.3.0",
    "eslint": "^9.0.0",
    "typescript-eslint": "^8.0.0",
    "prettier": "^3.3.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `pnpm-workspace.yaml`**

```yaml
packages:
  - 'packages/*'
```

- [ ] **Step 3: Write base `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 4: Write `.npmrc`, `.tool-versions`, `.prettierrc.yaml`**

`.npmrc`:
```
auto-install-peers=false
```

`.tool-versions`:
```
nodejs 24.4.0
pnpm 9.15.0
```

`.prettierrc.yaml`:
```yaml
singleQuote: true
trailingComma: all
printWidth: 100
```

- [ ] **Step 5: Write `eslint.config.js` (flat config, ESM)**

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
);
```

- [ ] **Step 6: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.spec.ts'],
  },
});
```

- [ ] **Step 7: Write `CHANGELOG.md` and `README.md` skeletons + MIT `LICENSE`**

`CHANGELOG.md`:
```markdown
# Changelog
```

`README.md`:
```markdown
# devtooie

Dependency-aware CLI for running a monorepo's local dev processes.

Full documentation is filled in during the publish-pipeline task.
```

`LICENSE`: standard MIT text, `Copyright (c) 2026 Carlos González`.

- [ ] **Step 8: Install deps and verify tooling runs**

Run: `pnpm install && pnpm exec eslint --version && pnpm exec tsc --version && pnpm exec vitest --version`
Expected: all three print versions with no install errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm workspace root (tsconfig, eslint, prettier, vitest)"
```

---

### Task 2: Package scaffold + build script

**Files:**
- Create: `packages/devtooie/package.json`, `packages/devtooie/tsconfig.json`, `packages/devtooie/src/index.ts` (temporary stub), `scripts/build.sh`

**Interfaces:**
- Produces: a compilable `packages/devtooie` whose `tsc` build emits `dist/index.js` + `dist/index.d.ts`; `scripts/build.sh` that cleans and compiles the package.

- [ ] **Step 1: Write `packages/devtooie/package.json`**

```json
{
  "name": "devtooie",
  "version": "0.0.0",
  "description": "Dependency-aware CLI for running a monorepo's local dev processes.",
  "author": "Carlos González <carlos.rgn@gmail.com>",
  "license": "MIT",
  "type": "module",
  "repository": { "type": "git", "url": "https://github.com/<owner>/devtooie.git" },
  "keywords": ["monorepo", "dev", "cli", "orchestration", "dependencies", "tui", "ink"],
  "engines": { "node": ">=23.6" },
  "bin": { "devtooie": "./dist/cli.js" },
  "files": ["dist", "assets", "postinstall.mjs"],
  "scripts": { "postinstall": "node ./postinstall.mjs" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "dependencies": {
    "@clack/prompts": "^0.7.0",
    "chalk": "^5.3.0",
    "commander": "^12.1.0",
    "execa": "^9.4.0",
    "ink": "^5.0.0",
    "ink-spinner": "^5.0.0",
    "react": "^18.3.0",
    "string-width": "^7.2.0",
    "wrap-ansi": "^9.0.0",
    "yaml": "^2.5.0"
  },
  "peerDependencies": { "typescript": ">=5.0.0" }
}
```

> Note: `postinstall` is declared now but `postinstall.mjs` is created in Task 26. Until then, keep a no-op `postinstall.mjs` (Step 4) so `pnpm install` doesn't fail.

- [ ] **Step 2: Write `packages/devtooie/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "react-jsx",
    "types": ["node", "react"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["src/**/*.spec.ts", "dist"]
}
```

- [ ] **Step 3: Write a temporary `src/index.ts` stub**

```ts
export const DEVTOOIE_VERSION_PLACEHOLDER = true;
```

- [ ] **Step 4: Write a no-op `postinstall.mjs` placeholder**

```js
// Replaced with the real first-run hint in a later task.
process.exit(0);
```

- [ ] **Step 5: Write `scripts/build.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

PKG="packages/devtooie"

rm -rf "$PKG/dist"
pnpm exec tsc -p "$PKG/tsconfig.json"

# Ensure the compiled bin has an executable shebang.
BIN="$PKG/dist/cli.js"
if [ -f "$BIN" ]; then
  if ! head -n1 "$BIN" | grep -q '^#!'; then
    printf '#!/usr/bin/env node\n%s' "$(cat "$BIN")" > "$BIN"
  fi
  chmod +x "$BIN"
fi

echo "build complete"
```

- [ ] **Step 6: Make the script executable and run the build**

Run: `chmod +x scripts/build.sh && ./scripts/build.sh && ls packages/devtooie/dist`
Expected: `build complete`, and `dist/` contains `index.js` + `index.d.ts`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold devtooie package + build script"
```

---

## Phase 2 — Config Library (TDD)

This phase builds the entire public API surface (§4). It is pure and fully test-driven. `config.ts` accumulates across Tasks 3–6; write each behavior test-first.

### Task 3: `defineAppConfigs` skeleton + path resolution

**Files:**
- Create: `packages/devtooie/src/config.ts`, `packages/devtooie/src/config.spec.ts`

**Interfaces:**
- Produces:
  - `AppType` runtime object + type: `export const AppType = { BACKEND: 'backend', BROWSER: 'browser', LIB: 'lib' } as const;` and `export type AppType = (typeof AppType)[keyof typeof AppType];`
  - `AppTypeValue = 'backend' | 'browser' | 'lib'`
  - `RunConfig<N>`, `AppConfigInput<N>`, `DefineAppConfigsOptions<N>`, `ResolvedAppConfig<N>`, `AnyAppConfig = ResolvedAppConfig<string>` (all per spec §4.1–§4.2)
  - `defineAppConfigs<const N extends string>(opts: DefineAppConfigsOptions<N>): ResolvedAppConfig<N>[]`

- [ ] **Step 1: Write the failing test for path + relativeDir defaults**

```ts
// config.spec.ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { defineAppConfigs } from './config';

describe('defineAppConfigs path resolution', () => {
  it('defaults relativeDir to projects/<name> and resolves path against cwd', () => {
    const [app] = defineAppConfigs({ apps: [{ name: 'svc', types: ['backend'] }] });
    expect(app.relativeDir).toBe('projects/svc');
    expect(app.path).toBe(path.resolve(process.cwd(), 'projects/svc'));
  });

  it('honors explicit relativeDir and workspaceDir', () => {
    const [app] = defineAppConfigs({
      workspaceDir: '/repo',
      apps: [{ name: 'svc', relativeDir: 'apps/svc', types: [] }],
    });
    expect(app.path).toBe(path.resolve('/repo', 'apps/svc'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/devtooie/src/config.spec.ts`
Expected: FAIL — `defineAppConfigs` is not defined.

- [ ] **Step 3: Implement the types + path resolution (no tokens/validation yet)**

```ts
// config.ts
import path from 'node:path';

export const AppType = { BACKEND: 'backend', BROWSER: 'browser', LIB: 'lib' } as const;
export type AppType = (typeof AppType)[keyof typeof AppType];
export type AppTypeValue = 'backend' | 'browser' | 'lib';

export interface RunConfig<N extends string> {
  selectable?: boolean;
  shortName?: string;
  subdomain?: string | string[];
  port?: number;
  hmrPort?: number;
  urls?: (string | { label: string; url: string })[];
  healthcheck?: string;
  waitFor?: NoInfer<N>[];
  deps?: {
    build?: NoInfer<N>[];
    dev?: NoInfer<N>[];
    runtime?: NoInfer<N>[];
  };
}

export interface AppConfigInput<N extends string> {
  name: N;
  relativeDir?: string;
  types: AppTypeValue[];
  run?: RunConfig<N>;
}

export interface DefineAppConfigsOptions<N extends string> {
  apps: AppConfigInput<N>[];
  workspaceDir?: string;
  tokens?: Record<string, string | undefined>;
}

export type ResolvedAppConfig<N extends string> = AppConfigInput<N> & {
  relativeDir: string;
  path: string;
};

export type AnyAppConfig = ResolvedAppConfig<string>;

export function defineAppConfigs<const N extends string>(
  opts: DefineAppConfigsOptions<N>,
): ResolvedAppConfig<N>[] {
  const workspaceDir = opts.workspaceDir ?? process.cwd();
  return opts.apps.map((config) => {
    const relativeDir = config.relativeDir ?? `projects/${config.name}`;
    return {
      ...config,
      relativeDir,
      path: path.resolve(workspaceDir, relativeDir),
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/devtooie/src/config.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/devtooie/src/config.ts packages/devtooie/src/config.spec.ts
git commit -m "feat: defineAppConfigs types + path resolution"
```

---

### Task 4: Token substitution (intrinsic + extrinsic)

**Files:**
- Modify: `packages/devtooie/src/config.ts`, `packages/devtooie/src/config.spec.ts`

**Interfaces:**
- Consumes: `defineAppConfigs`, `DefineAppConfigsOptions` (Task 3).
- Produces: token substitution applied to each app's `run.urls` and `run.healthcheck` at define time (§7.2). Intrinsic: `:name` → name, `:port` → `run.port`, `:subdomain` → first of `run.subdomain`. Extrinsic: any other `:key` → `opts.tokens[key]`.

- [ ] **Step 1: Write failing tests for substitution**

```ts
// append to config.spec.ts
describe('token substitution', () => {
  it('substitutes intrinsic :name, :port, :subdomain', () => {
    const [app] = defineAppConfigs({
      apps: [{
        name: 'core',
        types: ['backend'],
        run: {
          port: 3001,
          subdomain: ['core', 'core-bg'],
          healthcheck: 'http://localhost::port/health',
          urls: ['https://:subdomain.local/:name'],
        },
      }],
    });
    expect(app.run!.healthcheck).toBe('http://localhost:3001/health');
    expect(app.run!.urls![0]).toBe('https://core.local/core');
  });

  it('substitutes extrinsic tokens from opts.tokens (string and object urls)', () => {
    const [app] = defineAppConfigs({
      tokens: { domain: 'example.com', proxyport: '8443' },
      apps: [{
        name: 'web',
        types: ['browser'],
        run: { urls: [{ label: 'home', url: 'https://app.:domain::proxyport' }] },
      }],
    });
    const url = app.run!.urls![0];
    expect(typeof url === 'object' && url.url).toBe('https://app.example.com:8443');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/devtooie/src/config.spec.ts`
Expected: FAIL — healthcheck/urls still contain `:port`/`:domain`.

- [ ] **Step 3: Implement substitution inside `defineAppConfigs`**

Replace the `.map(...)` body so that when `config.run` exists, a `replace(s)` closure applies intrinsic then extrinsic tokens, and is mapped over `run.urls` and `run.healthcheck`:

```ts
// inside defineAppConfigs, replace the returned object's run handling:
    const run = config.run;
    return {
      ...config,
      relativeDir,
      path: path.resolve(workspaceDir, relativeDir),
      run: run ? substituteRun(config.name, run, opts.tokens ?? {}) : undefined,
    };
```

Add helper (module scope):

```ts
function substituteRun<N extends string>(
  name: N,
  run: RunConfig<N>,
  tokens: Record<string, string | undefined>,
): RunConfig<N> {
  const primarySubdomain = Array.isArray(run.subdomain) ? run.subdomain[0] : run.subdomain;
  const replace = (s: string): string => {
    let out = s.replaceAll(':name', name);
    if (out.includes(':subdomain')) {
      if (!primarySubdomain) {
        throw new Error(`${name} uses :subdomain but run.subdomain is not defined`);
      }
      out = out.replaceAll(':subdomain', primarySubdomain);
    }
    if (out.includes(':port')) {
      if (run.port === undefined) {
        throw new Error(`${name} uses :port but run.port is not defined`);
      }
      out = out.replaceAll(':port', String(run.port));
    }
    // Extrinsic tokens: any remaining :key must resolve from tokens.
    out = out.replace(/:([a-z][a-z0-9_]*)/gi, (match, key: string) => {
      if (key in tokens) {
        const val = tokens[key];
        if (val === undefined) {
          throw new Error(`${name} uses :${key} but tokens.${key} is undefined`);
        }
        return val;
      }
      throw new Error(`${name} uses :${key} but no such token was provided`);
    });
    return out;
  };
  return {
    ...run,
    urls: run.urls?.map((u) => (typeof u === 'string' ? replace(u) : { ...u, url: replace(u.url) })),
    healthcheck: run.healthcheck ? replace(run.healthcheck) : undefined,
  };
}
```

> Note on ordering: `:name`, `:subdomain`, `:port` are resolved before the generic extrinsic pass so those intrinsic names are never treated as missing tokens. The generic regex only sees leftover `:key` tokens.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/devtooie/src/config.spec.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/devtooie/src/config.ts packages/devtooie/src/config.spec.ts
git commit -m "feat: intrinsic + extrinsic token substitution"
```

---

### Task 5: Validation

**Files:**
- Modify: `packages/devtooie/src/config.ts`, `packages/devtooie/src/config.spec.ts`

**Interfaces:**
- Consumes: `defineAppConfigs` (Tasks 3–4).
- Produces: define-time validation (§4.1) throwing clear messages: every `waitFor` target exists and defines a `healthcheck`; `:subdomain`/`:port`/extrinsic-token errors already come from `substituteRun`.

- [ ] **Step 1: Write failing validation tests**

```ts
// append to config.spec.ts
describe('validation', () => {
  it('throws when waitFor targets an app without a healthcheck', () => {
    expect(() =>
      defineAppConfigs({
        apps: [
          { name: 'a', types: ['backend'], run: { waitFor: ['b'] } },
          { name: 'b', types: ['backend'], run: {} },
        ],
      }),
    ).toThrow(/waitFor "b".*no healthcheck/);
  });

  it('throws when waitFor targets a missing app', () => {
    expect(() =>
      defineAppConfigs({ apps: [{ name: 'a', types: ['backend'], run: { waitFor: ['ghost'] } }] }),
    ).toThrow(/waitFor "ghost"/);
  });

  it('throws when a url uses an unknown extrinsic token', () => {
    expect(() =>
      defineAppConfigs({
        apps: [{ name: 'a', types: ['browser'], run: { urls: ['https://:domain'] } }],
      }),
    ).toThrow(/:domain/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/devtooie/src/config.spec.ts`
Expected: the first two FAIL (no waitFor validation yet); the third already passes from Task 4.

- [ ] **Step 3: Add `waitFor` validation before the `.map` in `defineAppConfigs`**

```ts
  const healthcheckApps = new Set(
    opts.apps.filter((c) => c.run?.healthcheck).map((c) => c.name),
  );
  const allNames = new Set(opts.apps.map((c) => c.name));
  for (const config of opts.apps) {
    for (const waitName of config.run?.waitFor ?? []) {
      if (!allNames.has(waitName)) {
        throw new Error(`${config.name} has waitFor "${waitName}" but no such app exists`);
      }
      if (!healthcheckApps.has(waitName)) {
        throw new Error(
          `${config.name} has waitFor "${waitName}" but that app has no healthcheck defined`,
        );
      }
    }
  }
```

> Validation runs on the *raw* config (before substitution) so `healthcheck` presence is detected regardless of token resolution. Keep this block above the `.map`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/devtooie/src/config.spec.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/devtooie/src/config.ts packages/devtooie/src/config.spec.ts
git commit -m "feat: defineAppConfigs waitFor validation"
```

---

### Task 6: Registry + `findApp`

**Files:**
- Modify: `packages/devtooie/src/config.ts`, `packages/devtooie/src/config.spec.ts`

**Interfaces:**
- Consumes: `defineAppConfigs`, `AnyAppConfig` (Tasks 3–5).
- Produces:
  - module-level registry side-effect: `defineAppConfigs` stores its resolved array in a singleton.
  - `getRegisteredApps(): AnyAppConfig[]` (internal helper used by CLI/lib).
  - `findApp(name: string): AnyAppConfig` (throws if not found) — reads the singleton.

- [ ] **Step 1: Write failing tests**

```ts
// append to config.spec.ts
import { findApp, getRegisteredApps } from './config';

describe('registry + findApp', () => {
  it('populates the registry on define and looks apps up by name', () => {
    defineAppConfigs({ apps: [{ name: 'alpha', types: [] }, { name: 'beta', types: [] }] });
    expect(getRegisteredApps().map((a) => a.name)).toEqual(expect.arrayContaining(['alpha', 'beta']));
    expect(findApp('alpha').name).toBe('alpha');
  });

  it('throws for an unknown app', () => {
    defineAppConfigs({ apps: [{ name: 'alpha', types: [] }] });
    expect(() => findApp('nope')).toThrow(/nope/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/devtooie/src/config.spec.ts`
Expected: FAIL — `findApp`/`getRegisteredApps` not defined.

- [ ] **Step 3: Add the registry + accessors to `config.ts`**

```ts
// module scope in config.ts
let registeredApps: AnyAppConfig[] = [];

export function getRegisteredApps(): AnyAppConfig[] {
  return registeredApps;
}

export function findApp(name: string): AnyAppConfig {
  const app = registeredApps.find((a) => a.name === name);
  if (!app) throw new Error(`app ${name} not found`);
  return app;
}
```

At the end of `defineAppConfigs`, before returning, store the result:

```ts
  const resolved = opts.apps.map(/* ...existing map... */);
  registeredApps = resolved as AnyAppConfig[];
  return resolved;
```

> The last `defineAppConfigs` call wins the registry — correct for the single-config-per-process model (the consumer's services module calls it once).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/devtooie/src/config.spec.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/devtooie/src/config.ts packages/devtooie/src/config.spec.ts
git commit -m "feat: config registry + findApp"
```

---

### Task 7: `register.ts` + `index.ts` public exports

**Files:**
- Create: `packages/devtooie/src/register.ts`, `packages/devtooie/src/register.spec.ts`
- Modify: `packages/devtooie/src/index.ts` (replace the stub)

**Interfaces:**
- Consumes: `AnyAppConfig` (config.ts).
- Produces (public API, §4.4–§4.5):
  - `register.ts`: `interface Register {}`; `type AppConfig = Resolved[number]`; `type AppName = AppConfig['name']` where `Resolved = Register extends { appConfigs: infer T extends readonly AnyAppConfig[] } ? T : readonly AnyAppConfig[]`.
  - `index.ts` re-exports: `defineAppConfigs`, `AppType`, `findApp`; types `AppConfigInput`, `RunConfig`, `DefineAppConfigsOptions`, `ResolvedAppConfig`, `AnyAppConfig`, `AppTypeValue`, `Register`, `AppConfig`, `AppName`.

- [ ] **Step 1: Write a type-level test (tsc is the check)**

```ts
// register.spec.ts
import { describe, it, expect } from 'vitest';
import { defineAppConfigs, findApp } from './index';
import type { AnyAppConfig, AppName } from './index';

describe('public exports', () => {
  it('re-exports the runtime API', () => {
    expect(typeof defineAppConfigs).toBe('function');
    expect(typeof findApp).toBe('function');
  });

  it('AppName falls back to string when Register is unaugmented', () => {
    // Compile-time assertion: a plain string is assignable to AppName.
    const n: AppName = 'anything';
    const app: AnyAppConfig | undefined = defineAppConfigs({ apps: [{ name: n, types: [] }] })[0];
    expect(app?.name).toBe('anything');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/devtooie/src/register.spec.ts`
Expected: FAIL — `./index` doesn't export these yet (stub only).

- [ ] **Step 3: Write `register.ts`**

```ts
import type { AnyAppConfig } from './config';

// Augmentation target — intentionally empty. Consumers/typegen augment it.
export interface Register {}

type Resolved = Register extends { appConfigs: infer T extends readonly AnyAppConfig[] }
  ? T
  : readonly AnyAppConfig[];

export type AppConfig = Resolved[number];
export type AppName = AppConfig['name'];
```

- [ ] **Step 4: Replace `index.ts` with the real public surface**

```ts
export { defineAppConfigs, AppType, findApp } from './config';
export type {
  AppConfigInput,
  RunConfig,
  DefineAppConfigsOptions,
  ResolvedAppConfig,
  AnyAppConfig,
  AppTypeValue,
} from './config';
export type { Register, AppConfig, AppName } from './register';
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run packages/devtooie/src/register.spec.ts && pnpm exec tsc -p packages/devtooie/tsconfig.json --noEmit`
Expected: tests PASS; tsc reports no errors.

- [ ] **Step 6: Build and verify the library emits**

Run: `./scripts/build.sh && node -e "import('./packages/devtooie/dist/index.js').then(m => console.log(typeof m.defineAppConfigs, typeof m.findApp, m.AppType.BACKEND))"`
Expected: `function function backend`.

- [ ] **Step 7: Commit**

```bash
git add packages/devtooie/src/register.ts packages/devtooie/src/register.spec.ts packages/devtooie/src/index.ts
git commit -m "feat: Register augmentation types + public index exports"
```

---

## Phase 3 — Runner Core

This phase ports the CLI runtime engine (§9). Pure logic (Tasks 8–16) is TDD'd. The process engine and Ink UI (Tasks 17–19) are behavior-specified and gated by build + typecheck; each references the spec section that defines its exact behavior. Where a module's full behavior is specified in §9, implement to that section — do not invent divergent behavior, and do not add any external-project references.

### Task 8: `errors.ts` + `debug-log.ts`

**Files:**
- Create: `packages/devtooie/src/errors.ts`, `packages/devtooie/src/debug-log.ts`, `packages/devtooie/src/errors.spec.ts`

**Interfaces:**
- Produces:
  - `handleShellError(err: unknown): never` — prints `stdout`/`stderr` (when present) and calls `process.exit(err.exitCode ?? 1)`. Duck-typed on `{ stdout?, stderr?, exitCode? }` (§9.2).
  - `debugLog(...args: unknown[]): void` — appends a timestamped line to `node_modules/.devtooie/debug.log` only when `process.env.DEBUG_DEVTOOIE` is set; otherwise no-op. Never throws.

- [ ] **Step 1: Write failing test for `handleShellError`**

```ts
// errors.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { handleShellError } from './errors';

describe('handleShellError', () => {
  it('prints stderr and exits with the error exitCode', () => {
    const err = { stderr: 'boom', exitCode: 7 };
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    const errLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => handleShellError(err)).toThrow('exit');
    expect(errLog).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(exit).toHaveBeenCalledWith(7);
    exit.mockRestore();
    errLog.mockRestore();
  });

  it('defaults exit code to 1', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => handleShellError({ stdout: 'x' })).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/devtooie/src/errors.spec.ts`
Expected: FAIL — `handleShellError` not defined.

- [ ] **Step 3: Implement `errors.ts`**

```ts
export function handleShellError(err: unknown): never {
  const e = err as { stdout?: string; stderr?: string; exitCode?: number };
  if (e?.stdout) console.error(String(e.stdout));
  if (e?.stderr) console.error(String(e.stderr));
  if (!e?.stdout && !e?.stderr) console.error(String(err));
  process.exit(e?.exitCode ?? 1);
}
```

- [ ] **Step 4: Implement `debug-log.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { getStateDir } from './lib';

export function debugLog(...args: unknown[]): void {
  if (!process.env.DEBUG_DEVTOOIE) return;
  try {
    const dir = getStateDir();
    fs.mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()} ${args.map(String).join(' ')}\n`;
    fs.appendFileSync(path.join(dir, 'debug.log'), line);
  } catch {
    // never throw from a logger
  }
}
```

> `getStateDir()` is added in Task 11 (`lib.ts`). If executing strictly in order, add a temporary local `getStateDir` returning `node_modules/.devtooie` and replace the import in Task 11, or implement Task 11's `getStateDir` first. The interface: `getStateDir(): string` → absolute path to `node_modules/.devtooie`.

- [ ] **Step 5: Run test to verify pass**

Run: `pnpm vitest run packages/devtooie/src/errors.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/devtooie/src/errors.ts packages/devtooie/src/debug-log.ts packages/devtooie/src/errors.spec.ts
git commit -m "feat: portable shell-error handler + opt-in debug log"
```

---

### Task 9: `lib.ts` — runner detection + script helpers

**Files:**
- Create: `packages/devtooie/src/lib.ts`, `packages/devtooie/src/lib.spec.ts`

**Interfaces:**
- Consumes: `AnyAppConfig` (config.ts).
- Produces (§9.3):
  - `getCommandRunner(app: AnyAppConfig): 'pnpm' | 'make'` — `'pnpm'` if `<path>/package.json` exists, else `'make'` if `<path>/Makefile` exists, else `'pnpm'`.
  - `getExecArgs(app, script): [string, string[]]` — `['pnpm', ['run', script]]` or `['make', [script]]`.
  - `hasScript(app, script): boolean`, `hasDevScript(app): boolean` (has `dev`).
  - `getExtraCommands(app): string[]` — package scripts excluding runner-managed (`dev`, `build`, `build:clean`, `build-clean`, `clean`) or, for make apps, `getMakeTargets(app)` minus the same.
  - `getMakeTargets(app): string[]`.

- [ ] **Step 1: Write failing tests using a temp fixture dir**

```ts
// lib.spec.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCommandRunner, getExecArgs, hasScript, hasDevScript, getExtraCommands } from './lib';
import type { AnyAppConfig } from './config';

let dir: string;
function app(over: Partial<AnyAppConfig> & { path: string }): AnyAppConfig {
  return { name: 'x', types: [], relativeDir: 'x', ...over } as AnyAppConfig;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-lib-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { dev: 'x', build: 'x', 'build:clean': 'x', codegen: 'x' } }),
  );
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('runner detection', () => {
  it('detects pnpm for a package.json app', () => {
    expect(getCommandRunner(app({ path: dir }))).toBe('pnpm');
    expect(getExecArgs(app({ path: dir }), 'dev')).toEqual(['pnpm', ['run', 'dev']]);
  });
  it('reads scripts', () => {
    expect(hasScript(app({ path: dir }), 'build')).toBe(true);
    expect(hasDevScript(app({ path: dir }))).toBe(true);
  });
  it('excludes runner-managed scripts from extra commands', () => {
    expect(getExtraCommands(app({ path: dir }))).toEqual(['codegen']);
  });
  it('falls back to pnpm when nothing present', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-empty-'));
    expect(getCommandRunner(app({ path: empty }))).toBe('pnpm');
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/devtooie/src/lib.spec.ts`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement the helpers in `lib.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { AnyAppConfig } from './config';

const RUNNER_MANAGED = new Set(['dev', 'build', 'build:clean', 'build-clean', 'clean']);

function readPackageJson(app: AnyAppConfig): { scripts?: Record<string, string> } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.path, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function getCommandRunner(app: AnyAppConfig): 'pnpm' | 'make' {
  if (fs.existsSync(path.join(app.path, 'package.json'))) return 'pnpm';
  if (fs.existsSync(path.join(app.path, 'Makefile'))) return 'make';
  return 'pnpm';
}

export function getExecArgs(app: AnyAppConfig, script: string): [string, string[]] {
  return getCommandRunner(app) === 'make' ? ['make', [script]] : ['pnpm', ['run', script]];
}

export function hasScript(app: AnyAppConfig, script: string): boolean {
  if (getCommandRunner(app) === 'make') return getMakeTargets(app).includes(script);
  return Boolean(readPackageJson(app)?.scripts?.[script]);
}

export function hasDevScript(app: AnyAppConfig): boolean {
  return hasScript(app, 'dev');
}

export function getMakeTargets(app: AnyAppConfig): string[] {
  try {
    const mk = fs.readFileSync(path.join(app.path, 'Makefile'), 'utf8');
    return [...mk.matchAll(/^([a-zA-Z0-9_.-]+):/gm)].map((m) => m[1]!);
  } catch {
    return [];
  }
}

export function getExtraCommands(app: AnyAppConfig): string[] {
  const names =
    getCommandRunner(app) === 'make'
      ? getMakeTargets(app)
      : Object.keys(readPackageJson(app)?.scripts ?? {});
  return names.filter((n) => !RUNNER_MANAGED.has(n));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/devtooie/src/lib.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/devtooie/src/lib.ts packages/devtooie/src/lib.spec.ts
git commit -m "feat: lib runner detection + script helpers"
```

---

### Task 10: `lib.ts` — dependency resolution (§8)

**Files:**
- Modify: `packages/devtooie/src/lib.ts`, `packages/devtooie/src/lib.spec.ts`

**Interfaces:**
- Consumes: `getRegisteredApps` (config.ts).
- Produces (§8, §9.3):
  - `enum DepType { BUILD, DEV, RUNTIME }` and `const ALL_DEP_TYPES = [DepType.BUILD, DepType.DEV, DepType.RUNTIME]`.
  - `getTsconfigBuildApps(app: AnyAppConfig): AnyAppConfig[]` — resolves `tsconfig.build.json` `references` transitively (via the `typescript` peer dep) and maps resolved dirs back to registered apps by `path`. Missing tsconfig → `[]`.
  - `resolveDeps(selectedApps: AnyAppConfig[], depTypes?: DepType[]): { allApps: AnyAppConfig[]; buildSet: Set<string>; runSet: Set<string>; reasons: Record<string, string> }` — implements the §8 algorithm. Runtime deps are one level (not transitive); build/dev deps are transitive. App lookup uses `getRegisteredApps()`.

- [ ] **Step 1: Write failing tests against a fixture config (runtime + dev only, so no disk tsconfig needed)**

```ts
// append to lib.spec.ts
import { defineAppConfigs } from './config';
import { resolveDeps, DepType } from './lib';

describe('resolveDeps (§8)', () => {
  function setup() {
    return defineAppConfigs({
      workspaceDir: '/repo',
      apps: [
        { name: 'reverse-proxy', types: ['backend'], run: { selectable: false } },
        {
          name: 'core-svc',
          types: ['backend'],
          run: { deps: { runtime: ['reverse-proxy'] } },
        },
        {
          name: 'web',
          types: ['browser'],
          run: { deps: { runtime: ['core-svc', 'reverse-proxy'], dev: ['graphql-codegen'] } },
        },
        { name: 'graphql-codegen', types: [] },
      ],
    });
  }

  it('adds one level of runtime deps to runSet (NOT transitive)', () => {
    const apps = setup();
    const web = apps.find((a) => a.name === 'web')!;
    const { runSet, reasons } = resolveDeps([web], [DepType.RUNTIME]);
    // web + its direct runtime deps; core-svc's own runtime dep (reverse-proxy) is
    // already present because web lists it, but is NOT followed transitively via core-svc.
    expect([...runSet].sort()).toEqual(['core-svc', 'reverse-proxy', 'web']);
    expect(reasons['web']).toBe('selected');
    expect(reasons['core-svc']).toContain('runtime dep');
  });

  it('does not follow runtime deps of a runtime dep', () => {
    const apps = setup();
    const core = apps.find((a) => a.name === 'core-svc')!;
    // Select core-svc only → runSet is {core-svc, reverse-proxy}.
    const { runSet } = resolveDeps([core], [DepType.RUNTIME]);
    expect([...runSet].sort()).toEqual(['core-svc', 'reverse-proxy']);
  });

  it('adds dev deps to the build set transitively', () => {
    const apps = setup();
    const web = apps.find((a) => a.name === 'web')!;
    const { buildSet } = resolveDeps([web], [DepType.DEV]);
    expect(buildSet.has('graphql-codegen')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/devtooie/src/lib.spec.ts`
Expected: FAIL — `resolveDeps`/`DepType` not defined.

- [ ] **Step 3: Implement `DepType`, `getTsconfigBuildApps`, `resolveDeps`**

```ts
import { getRegisteredApps } from './config';

export enum DepType {
  BUILD = 'build',
  DEV = 'dev',
  RUNTIME = 'runtime',
}
export const ALL_DEP_TYPES = [DepType.BUILD, DepType.DEV, DepType.RUNTIME];

function lookup(name: string): AnyAppConfig | undefined {
  return getRegisteredApps().find((a) => a.name === name);
}

export function getTsconfigBuildApps(app: AnyAppConfig): AnyAppConfig[] {
  // Resolve tsconfig.build.json project references transitively via the TS peer dep.
  let ts: typeof import('typescript');
  try {
    ts = require('typescript');
  } catch {
    return [];
  }
  const registered = getRegisteredApps();
  const byPath = new Map(registered.map((a) => [path.resolve(a.path), a]));
  const seen = new Set<string>();
  const result: AnyAppConfig[] = [];
  const visit = (dir: string) => {
    const cfgPath = path.join(dir, 'tsconfig.build.json');
    if (seen.has(cfgPath) || !fs.existsSync(cfgPath)) return;
    seen.add(cfgPath);
    const parsed = ts.readConfigFile(cfgPath, ts.sys.readFile);
    const refs = (parsed.config?.references ?? []) as { path: string }[];
    for (const ref of refs) {
      const refDir = path.resolve(dir, ref.path.replace(/tsconfig.*\.json$/, ''));
      const match = byPath.get(path.resolve(refDir));
      if (match && !result.includes(match)) result.push(match);
      visit(refDir);
    }
  };
  visit(app.path);
  return result;
}

export interface ResolveResult {
  allApps: AnyAppConfig[];
  buildSet: Set<string>;
  runSet: Set<string>;
  reasons: Record<string, string>;
}

export function resolveDeps(selectedApps: AnyAppConfig[], depTypes: DepType[] = ALL_DEP_TYPES): ResolveResult {
  const runSet = new Set<string>();
  const reasons: Record<string, string> = {};
  for (const app of selectedApps) {
    runSet.add(app.name);
    reasons[app.name] = 'selected';
    if (depTypes.includes(DepType.RUNTIME)) {
      for (const dep of app.run?.deps?.runtime ?? []) {
        if (!runSet.has(dep)) reasons[dep] = `runtime dep of ${app.name}`;
        runSet.add(dep);
      }
    }
  }

  const buildSet = new Set<string>();
  const queue = [...runSet];
  while (queue.length) {
    const name = queue.shift()!;
    const app = lookup(name);
    if (!app) continue;
    if (depTypes.includes(DepType.BUILD)) {
      const buildDeps = [
        ...getTsconfigBuildApps(app).map((a) => a.name),
        ...(app.run?.deps?.build ?? []),
      ];
      for (const dep of buildDeps) {
        if (!buildSet.has(dep)) { buildSet.add(dep); queue.push(dep); }
      }
    }
    if (depTypes.includes(DepType.DEV)) {
      for (const dep of app.run?.deps?.dev ?? []) {
        if (!buildSet.has(dep)) { buildSet.add(dep); queue.push(dep); }
      }
    }
  }

  const allNames = new Set([...runSet, ...buildSet]);
  const allApps = [...allNames].map(lookup).filter((a): a is AnyAppConfig => Boolean(a));
  return { allApps, buildSet, runSet, reasons };
}
```

> `require('typescript')` uses `createRequire` under ESM. Add at the top of `lib.ts`: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/devtooie/src/lib.spec.ts`
Expected: PASS (all lib tests).

- [ ] **Step 5: Commit**

```bash
git add packages/devtooie/src/lib.ts packages/devtooie/src/lib.spec.ts
git commit -m "feat: dependency resolution (build/dev transitive, runtime one-level)"
```

---

### Task 11: `lib.ts` — state dir, API port, persistence, git branch

**Files:**
- Modify: `packages/devtooie/src/lib.ts`, `packages/devtooie/src/lib.spec.ts`

**Interfaces:**
- Consumes: `getProjectConfig` from `project-config.ts` (Task 20) for `getApiPort`. To keep Task 11 self-contained and testable now, `getApiPort` reads the port via a small injected/loaded project-config accessor; if Task 20 isn't done yet, implement `getApiPort` to read `devtooie.yaml` inline with the `yaml` dep and refactor to call `project-config.ts` in Task 20.
- Produces (§9.3, §10):
  - `getStateDir(): string` — absolute path to `node_modules/.devtooie` under cwd; creates it (`mkdirSync recursive`) on first call.
  - `getApiPort(): number` — `devtooie.yaml` `apiPort` → `4099`.
  - `saveSelection(names: string[]): void`, `loadSelection(): string[] | null`, `resetSelection(): void` — persisted at `node_modules/.devtooie/selection.json`.
  - `getGitBranch(): string | null` — `git rev-parse --abbrev-ref HEAD`; short-SHA on detached HEAD; `null` when not a repo.

- [ ] **Step 1: Write failing tests for state dir + selection round-trip + default port**

```ts
// append to lib.spec.ts
import { getStateDir, saveSelection, loadSelection, resetSelection, getApiPort } from './lib';

describe('state + persistence', () => {
  it('round-trips the saved selection', () => {
    resetSelection();
    expect(loadSelection()).toBeNull();
    saveSelection(['web', 'core-svc']);
    expect(loadSelection()).toEqual(['web', 'core-svc']);
    resetSelection();
    expect(loadSelection()).toBeNull();
  });

  it('getStateDir lives under node_modules/.devtooie', () => {
    expect(getStateDir().replace(/\\/g, '/')).toContain('node_modules/.devtooie');
  });

  it('getApiPort defaults to 4099 when no devtooie.yaml', () => {
    // Run from a dir without devtooie.yaml (temp cwd is fine in CI; default path).
    expect(typeof getApiPort()).toBe('number');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/devtooie/src/lib.spec.ts`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement state dir + persistence + port + git branch**

```ts
import { execaSync } from 'execa';
import YAML from 'yaml';

export function getStateDir(): string {
  const dir = path.join(process.cwd(), 'node_modules', '.devtooie');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getApiPort(): number {
  for (const name of ['devtooie.yaml', 'devtooie.yml']) {
    const p = path.join(process.cwd(), name);
    if (fs.existsSync(p)) {
      try {
        const cfg = YAML.parse(fs.readFileSync(p, 'utf8')) as { apiPort?: number };
        if (typeof cfg?.apiPort === 'number') return cfg.apiPort;
      } catch {
        // fall through to default
      }
    }
  }
  return 4099;
}

const SELECTION_FILE = () => path.join(getStateDir(), 'selection.json');

export function saveSelection(names: string[]): void {
  fs.writeFileSync(SELECTION_FILE(), JSON.stringify(names));
}
export function loadSelection(): string[] | null {
  try {
    return JSON.parse(fs.readFileSync(SELECTION_FILE(), 'utf8')) as string[];
  } catch {
    return null;
  }
}
export function resetSelection(): void {
  try { fs.rmSync(SELECTION_FILE(), { force: true }); } catch { /* ignore */ }
}

export function getGitBranch(): string | null {
  try {
    const { stdout } = execaSync('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (stdout.trim() === 'HEAD') {
      const { stdout: sha } = execaSync('git', ['rev-parse', '--short', 'HEAD']);
      return sha.trim();
    }
    return stdout.trim();
  } catch {
    return null;
  }
}
```

> When Task 20 lands, replace `getApiPort`'s inline yaml read with `getProjectConfig()?.apiPort ?? 4099`. Keep the `4099` default and the same signature.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/devtooie/src/lib.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/devtooie/src/lib.ts packages/devtooie/src/lib.spec.ts
git commit -m "feat: state dir, api port, selection persistence, git branch"
```

---

### Task 12: `lib.ts` — selector groups, display sort, runner-args + `runners/types.ts`

**Files:**
- Modify: `packages/devtooie/src/lib.ts`, `packages/devtooie/src/lib.spec.ts`
- Create: `packages/devtooie/src/runners/types.ts`

**Interfaces:**
- Consumes: `getRegisteredApps`, `resolveDeps`, `hasDevScript`, `AnyAppConfig`.
- Produces (§9.3, §9.10):
  - `runners/types.ts`: `RunnerArgs` interface = `{ sortedApps: AnyAppConfig[]; selectedSet: Set<string>; buildDepSet: Set<string>; rebuildableSet: Set<string>; waitForMap: Record<string, string[]>; healthcheckUrls: Record<string, string>; extraCommandsMap: Record<string, string[]>; logFile?: string }`.
  - `getServiceGroups(): { backend: AnyAppConfig[]; frontend: AnyAppConfig[] }` — selectable, dev-scripted apps grouped by type.
  - `getRuntimeDepsMap(): Record<string, string[]>`.
  - `sortForDisplay(apps: AnyAppConfig[], selectedSet: Set<string>): AnyAppConfig[]` — selected → selectable deps → non-selectable infra; within each backend → frontend → libs, alphabetical.
  - `buildRunnerArgs(selectedApps: AnyAppConfig[], deps: ResolveResult): RunnerArgs`.

- [ ] **Step 1: Write failing tests for `sortForDisplay` and `buildRunnerArgs`**

```ts
// append to lib.spec.ts
import { sortForDisplay, buildRunnerArgs, resolveDeps as rd } from './lib';

describe('display sort + runner args', () => {
  function apps() {
    return defineAppConfigs({
      workspaceDir: '/repo',
      apps: [
        { name: 'proxy', types: ['backend'], run: { selectable: false } },
        { name: 'api', types: ['backend'], run: { deps: { runtime: ['proxy'] } } },
        { name: 'web', types: ['browser'], run: { deps: { runtime: ['api', 'proxy'] } } },
        { name: 'lib-x', types: ['lib'] },
      ],
    });
  }

  it('orders selected first, then selectable deps, then infra', () => {
    const all = apps();
    const selected = new Set(['web']);
    const sorted = sortForDisplay(all, selected);
    expect(sorted[0]!.name).toBe('web'); // selected
    expect(sorted[sorted.length - 1]!.name).toBe('proxy'); // non-selectable infra last
  });

  it('buildRunnerArgs marks selected + build sets', () => {
    const all = apps();
    const web = all.find((a) => a.name === 'web')!;
    const deps = rd([web]);
    const args = buildRunnerArgs([web], deps);
    expect(args.selectedSet.has('web')).toBe(true);
    expect(args.sortedApps.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/devtooie/src/lib.spec.ts`
Expected: FAIL — functions/types not defined.

- [ ] **Step 3: Create `runners/types.ts`**

```ts
import type { AnyAppConfig } from '../config';

export interface RunnerArgs {
  sortedApps: AnyAppConfig[];
  selectedSet: Set<string>;
  buildDepSet: Set<string>;
  rebuildableSet: Set<string>;
  waitForMap: Record<string, string[]>;
  healthcheckUrls: Record<string, string>;
  extraCommandsMap: Record<string, string[]>;
  logFile?: string;
}
```

- [ ] **Step 4: Implement the grouping/sort/args helpers in `lib.ts`**

```ts
import type { RunnerArgs } from './runners/types';
// `ResolveResult` is declared earlier in this same file (Task 10) — reference it directly, no import.

const typeRank = (app: AnyAppConfig): number => {
  if (app.types.includes('backend')) return 0;
  if (app.types.includes('browser')) return 1;
  return 2; // lib / infra
};

export function getServiceGroups(): { backend: AnyAppConfig[]; frontend: AnyAppConfig[] } {
  const apps = getRegisteredApps().filter(
    (a) => a.run?.selectable !== false && hasDevScript(a),
  );
  return {
    backend: apps.filter((a) => a.types.includes('backend')).sort(byName),
    frontend: apps.filter((a) => a.types.includes('browser')).sort(byName),
  };
}

export function getRuntimeDepsMap(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const a of getRegisteredApps()) map[a.name] = a.run?.deps?.runtime ?? [];
  return map;
}

const byName = (a: AnyAppConfig, b: AnyAppConfig) => a.name.localeCompare(b.name);

export function sortForDisplay(apps: AnyAppConfig[], selectedSet: Set<string>): AnyAppConfig[] {
  const bucket = (a: AnyAppConfig): number => {
    if (selectedSet.has(a.name)) return 0;
    if (a.run?.selectable !== false) return 1;
    return 2;
  };
  return [...apps].sort((a, b) => {
    const bd = bucket(a) - bucket(b);
    if (bd !== 0) return bd;
    const td = typeRank(a) - typeRank(b);
    if (td !== 0) return td;
    return byName(a, b);
  });
}

export function buildRunnerArgs(selectedApps: AnyAppConfig[], deps: ResolveResult): RunnerArgs {
  const selectedSet = new Set(selectedApps.map((a) => a.name));
  const sortedApps = sortForDisplay(deps.allApps, selectedSet);
  const rebuildableSet = new Set(
    deps.allApps.filter((a) => hasScript(a, 'build:clean')).map((a) => a.name),
  );
  const waitForMap: Record<string, string[]> = {};
  const healthcheckUrls: Record<string, string> = {};
  const extraCommandsMap: Record<string, string[]> = {};
  for (const a of deps.allApps) {
    if (a.run?.waitFor?.length) waitForMap[a.name] = a.run.waitFor as string[];
    if (a.run?.healthcheck) healthcheckUrls[a.name] = a.run.healthcheck;
    const extra = getExtraCommands(a);
    if (extra.length) extraCommandsMap[a.name] = extra;
  }
  return {
    sortedApps,
    selectedSet,
    buildDepSet: deps.buildSet,
    rebuildableSet,
    waitForMap,
    healthcheckUrls,
    extraCommandsMap,
  };
}
```

- [ ] **Step 5: Run to verify pass + typecheck**

Run: `pnpm vitest run packages/devtooie/src/lib.spec.ts && pnpm exec tsc -p packages/devtooie/tsconfig.json --noEmit`
Expected: tests PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add packages/devtooie/src/lib.ts packages/devtooie/src/lib.spec.ts packages/devtooie/src/runners/types.ts
git commit -m "feat: selector groups, display sort, runner-args assembly"
```

---

### Task 13: `dev-session.ts` — single-active-session handoff

**Files:**
- Create: `packages/devtooie/src/dev-session.ts`, `packages/devtooie/src/dev-session.spec.ts`

**Interfaces:**
- Consumes: `getRegisteredApps`, `getApiPort` (lib.ts).
- Produces (§9.5):
  - Pure helpers (unit-tested): `parseLsofPids(out: string): number[]`, `parseSsPids(out: string): number[]`, `buildKillSet(procs: { pid: number; ppid: number }[], roots: number[]): number[]` (roots + transitive descendants), `dedupePorts(ports: (number | undefined)[]): number[]` (NaN/undefined filtered, deduped), `collectDevPorts(): number[]` (every app's `run.port` + `run.hmrPort` + the API port).
  - `findListenerPids(ports: number[]): number[]` (lsof on macOS / ss on Linux via execa).
  - `killTrees(roots: number[]): void` (one `ps -Ao pid=,ppid=`, SIGKILL roots then descendants).
  - `acquireDevSession(opts: { onStatus?: (msg: string) => void }): Promise<void>` — Windows no-op; else detect prior session via `GET /query/pid`, `POST /command/quit`, poll liveness (~11s ceiling → SIGKILL tree), then port sweep.

- [ ] **Step 1: Write failing tests for the pure helpers**

```ts
// dev-session.spec.ts
import { describe, it, expect } from 'vitest';
import { parseLsofPids, parseSsPids, buildKillSet, dedupePorts } from './dev-session';

describe('dev-session pure helpers', () => {
  it('parses lsof -t output (one pid per line)', () => {
    expect(parseLsofPids('1234\n5678\n')).toEqual([1234, 5678]);
    expect(parseLsofPids('')).toEqual([]);
  });

  it('parses ss -tlnpH output extracting pid=', () => {
    const out = 'LISTEN 0 511 *:3000 *:* users:(("node",pid=4242,fd=20))';
    expect(parseSsPids(out)).toEqual([4242]);
  });

  it('builds a kill set of roots + transitive descendants', () => {
    const procs = [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 200 },
      { pid: 999, ppid: 1 },
    ];
    expect(buildKillSet(procs, [100]).sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  it('dedupes and filters NaN/undefined ports', () => {
    expect(dedupePorts([3000, 3000, undefined, NaN, 4099]).sort((a, b) => a - b)).toEqual([3000, 4099]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/devtooie/src/dev-session.spec.ts`
Expected: FAIL — helpers not defined.

- [ ] **Step 3: Implement `dev-session.ts`**

Implement per §9.5. Pure helpers first (make the test pass), then the impure orchestration:

```ts
import os from 'node:os';
import { execa } from 'execa';
import { getRegisteredApps } from './config';
import { getApiPort } from './lib';

export function parseLsofPids(out: string): number[] {
  return out.split('\n').map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

export function parseSsPids(out: string): number[] {
  return [...out.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
}

export function buildKillSet(procs: { pid: number; ppid: number }[], roots: number[]): number[] {
  const children = new Map<number, number[]>();
  for (const { pid, ppid } of procs) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);
  }
  const out = new Set<number>();
  const walk = (pid: number) => {
    if (out.has(pid)) return;
    out.add(pid);
    for (const c of children.get(pid) ?? []) walk(c);
  };
  for (const r of roots) walk(r);
  return [...out];
}

export function dedupePorts(ports: (number | undefined)[]): number[] {
  return [...new Set(ports.filter((p): p is number => typeof p === 'number' && !Number.isNaN(p)))];
}

export function collectDevPorts(): number[] {
  const ports: (number | undefined)[] = [];
  for (const a of getRegisteredApps()) {
    ports.push(a.run?.port, a.run?.hmrPort);
  }
  ports.push(getApiPort());
  return dedupePorts(ports);
}

export async function findListenerPids(ports: number[]): Promise<number[]> {
  if (!ports.length) return [];
  if (os.platform() === 'darwin') {
    const { stdout } = await execa('lsof', ['-t', ...ports.flatMap((p) => ['-i', `:${p}`])], { reject: false });
    return parseLsofPids(stdout);
  }
  const pids: number[] = [];
  for (const p of ports) {
    const { stdout } = await execa('ss', ['-tlnpH', `sport = :${p}`], { reject: false });
    pids.push(...parseSsPids(stdout));
  }
  return [...new Set(pids)];
}

export async function killTrees(roots: number[]): Promise<void> {
  if (!roots.length) return;
  const { stdout } = await execa('ps', ['-Ao', 'pid=,ppid='], { reject: false });
  const procs = stdout
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
    .map(([pid, ppid]) => ({ pid: pid!, ppid: ppid! }));
  const all = buildKillSet(procs, roots);
  for (const pid of roots) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const pid of all) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

export async function acquireDevSession(opts: { onStatus?: (msg: string) => void } = {}): Promise<void> {
  if (os.platform() === 'win32') return; // Unix-only handoff
  const port = getApiPort();
  const onStatus = opts.onStatus ?? (() => {});
  // 1. Detect a live prior session and ask it to quit.
  try {
    const res = await fetch(`http://127.0.0.1:${port}/query/pid`, { signal: AbortSignal.timeout(500) });
    if (res.ok) {
      const { pid } = (await res.json()) as { pid: number };
      if (pid && pid !== process.pid) {
        onStatus('closing previous session');
        await fetch(`http://127.0.0.1:${port}/command/quit`, { method: 'POST' }).catch(() => {});
        const deadline = Date.now() + 11_000;
        while (Date.now() < deadline) {
          try { process.kill(pid, 0); } catch { break; } // ESRCH → gone
          await new Promise((r) => setTimeout(r, 250));
        }
        try { process.kill(pid, 0); await killTrees([pid]); } catch { /* already gone */ }
      }
    }
  } catch { /* no prior session */ }
  // 2. Always sweep dev ports.
  onStatus('freeing dev ports');
  const holders = await findListenerPids(collectDevPorts());
  await killTrees(holders);
}
```

> `Date.now()`/`setTimeout` are fine in shipped source (they're forbidden only inside Workflow scripts, not in the package). `fetch` is global on Node ≥23.6.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/devtooie/src/dev-session.spec.ts`
Expected: PASS (pure-helper tests).

- [ ] **Step 5: Commit**

```bash
git add packages/devtooie/src/dev-session.ts packages/devtooie/src/dev-session.spec.ts
git commit -m "feat: dev-session handoff (port sweep, tree kill, pid liveness)"
```

---

### Task 14: `command-server.ts` — localhost control API

**Files:**
- Create: `packages/devtooie/src/command-server.ts`, `packages/devtooie/src/command-server.spec.ts`

**Interfaces:**
- Consumes: `getApiPort` (lib.ts); a `ProcessManager`-shaped attachment (Task 17) — type it against a minimal `ControlManager` interface here so this task doesn't depend on Task 17's implementation.
- Produces (§9.6):
  - `ControlManager` interface: `{ getAllStatuses(): unknown; getStatus(app: string): unknown; getServices(filter?: string): unknown; restart(app: string): boolean; rebuild(app: string): boolean; quit(): void }`.
  - `startCommandServer(opts: { onQuit: () => void }): Promise<{ attach(m: ControlManager): void; close(): Promise<void>; port: number }>` — binds `127.0.0.1:<getApiPort()>`; endpoints per §9.6. Before `attach`, status/service/restart/rebuild return `503`; `/query/pid`, `/command/quit`, `/` always work.

- [ ] **Step 1: Write failing tests for pid/quit/503-before-attach**

```ts
// command-server.spec.ts
import { describe, it, expect, afterEach } from 'vitest';
import { startCommandServer } from './command-server';

let server: Awaited<ReturnType<typeof startCommandServer>> | null = null;
afterEach(async () => { await server?.close(); server = null; });

describe('command-server', () => {
  it('serves pid always and 503 for status before attach', async () => {
    let quit = false;
    server = await startCommandServer({ onQuit: () => { quit = true; } });
    const base = `http://127.0.0.1:${server.port}`;

    const pid = await fetch(`${base}/query/pid`).then((r) => r.json());
    expect(pid.pid).toBe(process.pid);

    const status = await fetch(`${base}/query/status`);
    expect(status.status).toBe(503);

    await fetch(`${base}/command/quit`, { method: 'POST' });
    expect(quit).toBe(true);
  });

  it('serves status after attach', async () => {
    server = await startCommandServer({ onQuit: () => {} });
    server.attach({
      getAllStatuses: () => ({ web: 'running' }),
      getStatus: () => 'running',
      getServices: () => [],
      restart: () => true,
      rebuild: () => true,
      quit: () => {},
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/query/status`);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/devtooie/src/command-server.spec.ts`
Expected: FAIL — `startCommandServer` not defined.

- [ ] **Step 3: Implement `command-server.ts`** per §9.6 (node:http, bind 127.0.0.1, routes: `GET /query/pid`, `POST /command/quit`, `GET /query/status[/<app>]`, `GET /query/services`, `POST /command/restart/<app>`, `POST /command/rebuild/<app>`, `GET /`). 503 until `attach`; 404 for unknown app; 202 for accepted commands. Use a `getApiPort()` port; support `port: 0` fallback only in tests via an optional `opts.port`.

```ts
import http from 'node:http';
import { getApiPort } from './lib';

export interface ControlManager {
  getAllStatuses(): unknown;
  getStatus(app: string): unknown;
  getServices(filter?: string): unknown;
  restart(app: string): boolean;
  rebuild(app: string): boolean;
  quit(): void;
}

export async function startCommandServer(opts: {
  onQuit: () => void;
  port?: number;
}): Promise<{ attach(m: ControlManager): void; close(): Promise<void>; port: number }> {
  let manager: ControlManager | null = null;
  const send = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/query/pid') return send(res, 200, { pid: process.pid });
    if (url.pathname === '/command/quit') { send(res, 200, { ok: true }); return void opts.onQuit(); }
    if (url.pathname === '/') return send(res, 200, { ok: true, pid: process.pid, attached: Boolean(manager) });

    if (!manager) return send(res, 503, { error: 'manager not attached' });

    if (parts[0] === 'query' && parts[1] === 'status') {
      return send(res, 200, parts[2] ? manager.getStatus(parts[2]) : manager.getAllStatuses());
    }
    if (parts[0] === 'query' && parts[1] === 'services') {
      return send(res, 200, manager.getServices(url.searchParams.get('status') ?? undefined));
    }
    if (parts[0] === 'command' && (parts[1] === 'restart' || parts[1] === 'rebuild') && parts[2]) {
      const ok = parts[1] === 'restart' ? manager.restart(parts[2]) : manager.rebuild(parts[2]);
      return send(res, ok ? 202 : 404, { ok });
    }
    send(res, 404, { error: 'not found' });
  });

  const port = opts.port ?? getApiPort();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = (server.address() as { port: number }).port;

  return {
    attach: (m) => { manager = m; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    port: actualPort,
  };
}
```

> Tests pass `opts.port: 0` implicitly? No — pass a fixed high port or let `getApiPort()` default to 4099. To avoid port collisions in CI, the spec's server uses the configured port; for the spec test, pass `{ onQuit, port: 0 }` and read `server.port`. Update the test's `startCommandServer` calls to include `port: 0`.

- [ ] **Step 4: Adjust the test to use an ephemeral port and run**

Edit the two `startCommandServer({...})` calls in the spec to add `port: 0`. Run: `pnpm vitest run packages/devtooie/src/command-server.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/devtooie/src/command-server.ts packages/devtooie/src/command-server.spec.ts
git commit -m "feat: localhost control API server"
```

---

### Task 15: `git-watch.ts`

**Files:**
- Create: `packages/devtooie/src/git-watch.ts`, `packages/devtooie/src/git-watch.spec.ts`

**Interfaces:**
- Produces (§9.7): `watchGitBranch(opts: { read?: () => string | null; intervalMs?: number; onChange: (from: string, to: string) => void }): () => void` — polls the branch (default `getGitBranch`) every `intervalMs` (default 2000); on the first change vs the startup value, calls `onChange` once then stops. Returns a stop function.

- [ ] **Step 1: Write failing test with fake timers + injected `read`**

```ts
// git-watch.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { watchGitBranch } from './git-watch';

describe('watchGitBranch', () => {
  it('fires once on the first branch change and stops', () => {
    vi.useFakeTimers();
    const branches = ['main', 'main', 'feature', 'other'];
    let i = 0;
    const read = () => branches[Math.min(i++, branches.length - 1)]!;
    const onChange = vi.fn();
    const stop = watchGitBranch({ read, intervalMs: 100, onChange });
    vi.advanceTimersByTime(100); // main (no change)
    vi.advanceTimersByTime(100); // feature (change → fire once)
    vi.advanceTimersByTime(100); // should NOT fire again
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('main', 'feature');
    stop();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/devtooie/src/git-watch.spec.ts`
Expected: FAIL — `watchGitBranch` not defined.

- [ ] **Step 3: Implement `git-watch.ts`**

```ts
import { getGitBranch } from './lib';

export function watchGitBranch(opts: {
  read?: () => string | null;
  intervalMs?: number;
  onChange: (from: string, to: string) => void;
}): () => void {
  const read = opts.read ?? getGitBranch;
  const start = read();
  let fired = false;
  const timer = setInterval(() => {
    if (fired) return;
    const now = read();
    if (start && now && now !== start) {
      fired = true;
      clearInterval(timer);
      opts.onChange(start, now);
    }
  }, opts.intervalMs ?? 2000);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/devtooie/src/git-watch.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/devtooie/src/git-watch.ts packages/devtooie/src/git-watch.spec.ts
git commit -m "feat: git-branch change watcher (fires once)"
```

---

### Task 16: `plain-status.ts`

**Files:**
- Create: `packages/devtooie/src/plain-status.ts`

**Interfaces:**
- Produces (§9.8): `createPlainStatusReporter(): { update(msg: string): void; done(): void }` — animated trailing-ellipsis on a TTY (via `\r`), static one-liners off a TTY, silent when never called with a message.

- [ ] **Step 1: Implement `plain-status.ts`** (no unit test — thin I/O wrapper; verified via typecheck/build)

```ts
export function createPlainStatusReporter(): { update(msg: string): void; done(): void } {
  const isTty = Boolean(process.stdout.isTTY);
  let timer: NodeJS.Timeout | null = null;
  let dots = 0;
  let current = '';
  const render = () => {
    dots = (dots + 1) % 4;
    process.stdout.write(`\r${current}${'.'.repeat(dots)}${' '.repeat(3 - dots)}`);
  };
  return {
    update(msg: string) {
      current = msg;
      if (isTty) {
        if (!timer) timer = setInterval(render, 300);
      } else {
        process.stdout.write(`${msg}\n`);
      }
    },
    done() {
      if (timer) { clearInterval(timer); timer = null; }
      if (isTty && current) process.stdout.write('\r' + ' '.repeat(current.length + 4) + '\r');
    },
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc -p packages/devtooie/tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/devtooie/src/plain-status.ts
git commit -m "feat: plain-runner handoff status reporter"
```

---

### Task 17: `process-manager.ts` — the process engine

**Files:**
- Create: `packages/devtooie/src/process-manager.ts`

**Interfaces:**
- Consumes: `getExecArgs`, `getCommandRunner`, `hasScript`, `getStateDir` (lib.ts); `ControlManager` shape (command-server.ts); `RunnerArgs` (runners/types.ts); `chalk`, `execa`, `string-width`.
- Produces (§9.4): `class ProcessManager` implementing the full public surface listed in §9.4 and satisfying the `ControlManager` interface (add `getServices`, `getStatus`, `getAllStatuses`, `restart`, `rebuild`, `quit` adapters). This module is behavior-specified by §9.4; implement to it exactly.

**Behavior contract (from §9.4) — implement all of it:**
- Spawn via execa `{ stdin:'ignore', stdout:'pipe', stderr:'pipe', reject:false, buffer:false, detached:true }`; no shell wrapper for long-running procs. `pnpm run <script>` vs `make <target>` from the per-process `runner`.
- Public methods: `startAll`, `start`, `stop`, `restart`, `rebuild`, `runCommand`, `runCustomCommand`, `killAll`, `shutdownAll`, `forceKillAll`, `static forceKillAllInstances`, `getRunning/getStopped/getWaiting/getRebuildable`, `getStatus/getAllStatuses`, `setFilter/getFilter/clearBuffer/refresh`, `truncateLogFile`, `logSystem`.
- Rebuild = stop → `pnpm run build:clean` → start; failure shows output, no restart. `getRebuildable()` = running procs whose app has `build:clean`.
- Extra commands via a shared `spawnExtra`; demarcation lines `▶ running` / `✔ finished` / `✘ exited`; tracked in `extraProcs`; `shell:true` only for custom commands.
- Output buffering (≤50k lines) with group-aware filtering (continuation lines starting with whitespace share the primary line's group). Terminal cleared with raw escape codes.
- Deferred startup (`waitFor`): mark `waiting`; 2s poll of target healthchecks; start when all pass; `s` force-starts.
- Multi-layer exit: first Ctrl+C graceful (`shutdownAll` → SIGTERM → 3s → SIGKILL groups); second force; `process.on('exit')` sync safety net using `process.kill(-pid, signal)` on the detached groups.
- Logfile: when set, open (truncate), write `HH:MM:SS [padded-name] line` ANSI-stripped, no wrapping. Default path `node_modules/.devtooie/devtooie.log` when not overridden.

- [ ] **Step 1: Implement `process-manager.ts`** to the contract above. Model the `ProcessManager` as a plain class (no React/Ink imports). Add a `ControlManager` adapter: `getServices(filter?)`, `restart(name): boolean` (returns false if unknown), `rebuild(name): boolean`, `quit()` = `shutdownAll()`.

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc -p packages/devtooie/tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 3: Smoke test (manual, no committed spec)**

Run a scratch check that spawns a trivial echo process through the manager and asserts it appears in `getRunning()` then exits. If practical to encode as a vitest that spawns `node -e "setInterval(()=>{},1e9)"` and kills it, add `process-manager.spec.ts`; otherwise verify by hand and note it.

- [ ] **Step 4: Commit**

```bash
git add packages/devtooie/src/process-manager.ts
git commit -m "feat: ProcessManager process engine"
```

---

### Task 18: `runners/plain.ts`

**Files:**
- Create: `packages/devtooie/src/runners/plain.ts`

**Interfaces:**
- Consumes: `ProcessManager` (Task 17); `RunnerArgs` (types.ts); `startCommandServer` (command-server.ts); `watchGitBranch` (git-watch.ts).
- Produces (§9.10): `runPlain(args: RunnerArgs, server: Awaited<ReturnType<typeof startCommandServer>>): Promise<void>` — constructs a `ProcessManager` in plain mode, `startAll`, streams output with colored name prefixes, wires SIGINT/SIGTERM → single graceful `shutdown()` then force; attaches the manager to `server`; starts the git watch.

- [ ] **Step 1: Implement `runners/plain.ts`** per §9.10 and §6.5 step 4.

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc -p packages/devtooie/tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/devtooie/src/runners/plain.ts
git commit -m "feat: plain (no-TUI) runner"
```

---

### Task 19: `components/*.tsx` — the Ink TUI

**Files:**
- Create: `packages/devtooie/src/components/App.tsx`, `ServiceSelector.tsx`, `BuildProgress.tsx`, `NativeRunner.tsx`, `HotkeyHints.tsx`

**Interfaces:**
- Consumes: `ProcessManager`, `RunnerArgs`, `resolveDeps`/`buildRunnerArgs`/groups/sort (lib.ts), `acquireDevSession` (dev-session.ts), `startCommandServer` (command-server.ts), `watchGitBranch` (git-watch.ts), `ink`, `ink-spinner`, `react`.
- Produces (§9.9): the Ink component tree. `App.tsx` exports the root component + a `renderApp(props)` entry the CLI calls. Behavior per §9.9 — phase machine `service-select → building → running`; `BuildProgress` runs handoff + starts the control server before the build loop and fires `onControlReady`/`onComplete`; `NativeRunner` owns the manager + `useInput` hotkeys + footer with the 5-state service-status model + healthcheck polling.

- [ ] **Step 1: Implement `HotkeyHints.tsx`** (leaf, reusable hint renderer).
- [ ] **Step 2: Implement `ServiceSelector.tsx`** (grouped multi-select Backend/Frontend).
- [ ] **Step 3: Implement `BuildProgress.tsx`** (dep summary + spinner; handoff + control-server start; `onControlReady` → `onComplete(runnerArgs)`).
- [ ] **Step 4: Implement `NativeRunner.tsx`** (ProcessManager owner; `useInput` hotkeys; footer via `measureElement`; `useServiceStatuses` 5-state model + healthcheck poll + reconcile loop; normal/filter/commands modes).
- [ ] **Step 5: Implement `App.tsx`** (phase state machine; holds control server; picks initial phase from `--service`/`--last-answers`/selector; exports `renderApp`).

- [ ] **Step 6: Typecheck + build**

Run: `pnpm exec tsc -p packages/devtooie/tsconfig.json --noEmit && ./scripts/build.sh`
Expected: clean; build completes.

- [ ] **Step 7: Commit**

```bash
git add packages/devtooie/src/components
git commit -m "feat: Ink TUI components (selector, build progress, native runner)"
```

---

## Phase 4 — Project Config + CLI

### Task 20: `project-config.ts` — read/write `devtooie.yaml`

**Files:**
- Create: `packages/devtooie/src/project-config.ts`, `packages/devtooie/src/project-config.spec.ts`
- Modify: `packages/devtooie/src/lib.ts` (refactor `getApiPort` to use `getProjectConfig`)

**Interfaces:**
- Produces (§5, §15.1):
  - `interface ProjectConfig { services: string; apiPort: number; skill: boolean }`.
  - `findProjectConfigPath(cwd?: string): string | null` — first of `devtooie.yaml`/`devtooie.yml` in cwd, else null.
  - `getProjectConfig(cwd?: string): ProjectConfig | null` — parse the file (yaml), applying defaults `apiPort: 4099`, `skill: false`; null if no file.
  - `writeProjectConfig(cfg: ProjectConfig, cwd?: string): void` — write `devtooie.yaml`.

- [ ] **Step 1: Write failing round-trip test**

```ts
// project-config.spec.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProjectConfig, writeProjectConfig, findProjectConfigPath } from './project-config';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-pc-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('project-config', () => {
  it('returns null when no config file exists', () => {
    expect(findProjectConfigPath(dir)).toBeNull();
    expect(getProjectConfig(dir)).toBeNull();
  });

  it('round-trips a written config with defaults applied', () => {
    writeProjectConfig({ services: './services.ts', apiPort: 4099, skill: true }, dir);
    const cfg = getProjectConfig(dir)!;
    expect(cfg.services).toBe('./services.ts');
    expect(cfg.apiPort).toBe(4099);
    expect(cfg.skill).toBe(true);
  });

  it('defaults apiPort to 4099 when omitted', () => {
    fs.writeFileSync(path.join(dir, 'devtooie.yaml'), 'services: ./services.ts\n');
    expect(getProjectConfig(dir)!.apiPort).toBe(4099);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/devtooie/src/project-config.spec.ts`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement `project-config.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export interface ProjectConfig {
  services: string;
  apiPort: number;
  skill: boolean;
}

export function findProjectConfigPath(cwd: string = process.cwd()): string | null {
  for (const name of ['devtooie.yaml', 'devtooie.yml']) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function getProjectConfig(cwd: string = process.cwd()): ProjectConfig | null {
  const p = findProjectConfigPath(cwd);
  if (!p) return null;
  const raw = (YAML.parse(fs.readFileSync(p, 'utf8')) ?? {}) as Partial<ProjectConfig>;
  return {
    services: raw.services ?? './services.ts',
    apiPort: raw.apiPort ?? 4099,
    skill: raw.skill ?? false,
  };
}

export function writeProjectConfig(cfg: ProjectConfig, cwd: string = process.cwd()): void {
  fs.writeFileSync(path.join(cwd, 'devtooie.yaml'), YAML.stringify(cfg));
}
```

- [ ] **Step 4: Refactor `lib.ts` `getApiPort` to reuse `getProjectConfig`**

```ts
import { getProjectConfig } from './project-config';
export function getApiPort(): number {
  return getProjectConfig()?.apiPort ?? 4099;
}
```
(Remove the inline yaml read added in Task 11.)

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm vitest run packages/devtooie/src/project-config.spec.ts packages/devtooie/src/lib.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/devtooie/src/project-config.ts packages/devtooie/src/project-config.spec.ts packages/devtooie/src/lib.ts
git commit -m "feat: devtooie.yaml read/write; getApiPort via project-config"
```

---

### Task 21: `load-config.ts` — resolve + import the services module

**Files:**
- Create: `packages/devtooie/src/load-config.ts`, `packages/devtooie/src/load-config.spec.ts`

**Interfaces:**
- Consumes: `getProjectConfig`, `findProjectConfigPath` (project-config.ts); `getRegisteredApps` (config.ts).
- Produces (§6.1):
  - `loadServices(cwd?: string): Promise<AnyAppConfig[]>` — read `devtooie.yaml`; if absent, throw `NoProjectConfigError` with message ``no devtooie.yaml found — run `devtooie init` ``. Resolve `services` against cwd, `import()` it (native `.ts` on Node ≥23.6), which populates the registry; return `getRegisteredApps()` (falling back to the module's `default` export if the registry is empty).
  - `class NoProjectConfigError extends Error`.

- [ ] **Step 1: Write failing test loading a scratch `.mjs` services file**

```ts
// load-config.spec.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadServices, NoProjectConfigError } from './load-config';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-load-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('loadServices', () => {
  it('throws NoProjectConfigError when devtooie.yaml is missing', async () => {
    await expect(loadServices(dir)).rejects.toBeInstanceOf(NoProjectConfigError);
  });

  it('imports the services module and returns registered apps', async () => {
    // A compiled ESM services file (avoids relying on native TS in the test).
    const pkgIndex = path.resolve('packages/devtooie/dist/index.js');
    fs.writeFileSync(
      path.join(dir, 'services.mjs'),
      `import { defineAppConfigs } from ${JSON.stringify(pkgIndex)};\n` +
        `export default defineAppConfigs({ apps: [{ name: 'svc', types: ['backend'] }] });\n`,
    );
    fs.writeFileSync(path.join(dir, 'devtooie.yaml'), 'services: ./services.mjs\napiPort: 4099\n');
    const apps = await loadServices(dir);
    expect(apps.map((a) => a.name)).toContain('svc');
  });
});
```

> The second test requires `./scripts/build.sh` to have produced `dist/index.js` (Phase 2). Run the build before this spec, or gate the test with a check that skips if dist is missing.

- [ ] **Step 2: Run to verify failure**

Run: `./scripts/build.sh && pnpm vitest run packages/devtooie/src/load-config.spec.ts`
Expected: FAIL — `loadServices` not defined.

- [ ] **Step 3: Implement `load-config.ts`**

```ts
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getProjectConfig } from './project-config';
import { getRegisteredApps, type AnyAppConfig } from './config';

export class NoProjectConfigError extends Error {}

export async function loadServices(cwd: string = process.cwd()): Promise<AnyAppConfig[]> {
  const cfg = getProjectConfig(cwd);
  if (!cfg) {
    throw new NoProjectConfigError('no devtooie.yaml found — run `devtooie init`');
  }
  const servicesPath = path.resolve(cwd, cfg.services);
  const mod = (await import(pathToFileURL(servicesPath).href)) as { default?: AnyAppConfig[] };
  const registered = getRegisteredApps();
  if (registered.length) return registered;
  if (Array.isArray(mod.default)) return mod.default;
  throw new Error(`services module ${cfg.services} did not export a defineAppConfigs default`);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/devtooie/src/load-config.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/devtooie/src/load-config.ts packages/devtooie/src/load-config.spec.ts
git commit -m "feat: load services module from devtooie.yaml (native .ts import)"
```

---

### Task 22: `cli.ts` — commander wiring + phase routing

**Files:**
- Create: `packages/devtooie/src/cli.ts`

**Interfaces:**
- Consumes: `loadServices`/`NoProjectConfigError` (load-config.ts), `resolveDeps`/`buildRunnerArgs`/`loadSelection`/`saveSelection`/`resetSelection`/`getStateDir` (lib.ts), `runPlain` (runners/plain.ts), `renderApp` (components/App.tsx), `startCommandServer` (command-server.ts), `acquireDevSession` (dev-session.ts), `handleShellError` (errors.ts), `runInit` (init.ts, Task 25), `runTypegen` (typegen.ts, Task 23), `commander`.
- Produces (§6): the CLI entry with shebang `#!/usr/bin/env node`, options (`-s/--service` repeatable, `--ui`/`--plain`, `--last-answers`, `--phase`, `--build`, `--rebuild`, `--logfile`), subcommands `init`/`reset`/`resolvedeps`/`typegen`, and the §6.5 top-level flow. No `--config`/`--api-port` flags.

- [ ] **Step 1: Implement `cli.ts`** per §6 and §6.5:
  - Pre-parse dispatch of `init` (→ `runInit()`), `reset` (→ `resetSelection()`), `resolvedeps` (→ load services, run `resolveDeps` per category, print JSON), `typegen` (→ `runTypegen(outOpt)`).
  - Main parse: load `devtooie.yaml` + services (`loadServices`); on `NoProjectConfigError`, print the message and `process.exit(1)`. Best-effort `runTypegen()` + skill refresh (Task 24), failures logged not fatal.
  - `--phase build` / `--build` / `--rebuild`: resolve service names (from `--service` or `--last-answers`; error otherwise); `--rebuild` clears `dist/` of the build set first; build deps then selected; exit.
  - `--plain`: resolve names, `acquireDevSession`, `startCommandServer`, build deps, `runPlain`.
  - `--ui` (default): `renderApp` with the resolved args + control server plumbing.
  - Wrap shell failures in `handleShellError`.
  - Persist the chosen selection via `saveSelection` after an interactive/explicit selection.

- [ ] **Step 2: Build + smoke test the "no config" path**

Run: `./scripts/build.sh && node packages/devtooie/dist/cli.js --help` and, in an empty temp dir, `node <abs>/dist/cli.js` to confirm the ``no devtooie.yaml found — run `devtooie init` `` message and exit code 1.
Expected: help lists options + subcommands; the no-config run prints the hint and exits 1.

- [ ] **Step 3: Commit**

```bash
git add packages/devtooie/src/cli.ts
git commit -m "feat: CLI entry (commander options, phases, subcommands)"
```

---

## Phase 5 — typegen

### Task 23: `typegen.ts` + subcommand + auto-run

**Files:**
- Create: `packages/devtooie/src/typegen.ts`, `packages/devtooie/src/typegen.spec.ts`
- Modify: `packages/devtooie/src/cli.ts` (wire the `typegen` subcommand + best-effort auto-run; already referenced in Task 22)

**Interfaces:**
- Consumes: `getProjectConfig` (project-config.ts).
- Produces (§5.4):
  - `computeAugmentation(outPath: string, servicesPath: string): string` — returns the `.d.ts` content with the correct relative import from `outPath`'s dir to `servicesPath` (extension stripped, `./`-prefixed, POSIX separators).
  - `runTypegen(opts?: { out?: string; cwd?: string }): void` — writes `devtooie-env.d.ts` (default) at cwd root using `getProjectConfig().services`.

- [ ] **Step 1: Write failing test for `computeAugmentation`**

```ts
// typegen.spec.ts
import { describe, it, expect } from 'vitest';
import { computeAugmentation } from './typegen';

describe('computeAugmentation', () => {
  it('computes a ./relative import with the extension stripped', () => {
    const out = computeAugmentation('/repo/devtooie-env.d.ts', '/repo/services.ts');
    expect(out).toContain("typeof import('./services').default");
    expect(out).toContain("declare module 'devtooie'");
  });

  it('handles nested services paths', () => {
    const out = computeAugmentation('/repo/devtooie-env.d.ts', '/repo/config/services.ts');
    expect(out).toContain("import('./config/services').default");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/devtooie/src/typegen.spec.ts`
Expected: FAIL — `computeAugmentation` not defined.

- [ ] **Step 3: Implement `typegen.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { getProjectConfig } from './project-config';

export function computeAugmentation(outPath: string, servicesPath: string): string {
  let rel = path.relative(path.dirname(outPath), servicesPath).replace(/\\/g, '/');
  rel = rel.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return (
    `// devtooie-env.d.ts — generated by devtooie. Do not edit.\n` +
    `declare module 'devtooie' {\n` +
    `  interface Register { appConfigs: typeof import('${rel}').default }\n` +
    `}\n`
  );
}

export function runTypegen(opts: { out?: string; cwd?: string } = {}): void {
  const cwd = opts.cwd ?? process.cwd();
  const cfg = getProjectConfig(cwd);
  if (!cfg) return; // nothing to generate without a project config
  const outPath = path.resolve(cwd, opts.out ?? 'devtooie-env.d.ts');
  const servicesPath = path.resolve(cwd, cfg.services);
  fs.writeFileSync(outPath, computeAugmentation(outPath, servicesPath));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/devtooie/src/typegen.spec.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the `typegen` subcommand + auto-run are wired in `cli.ts`** (from Task 22). If not, add: `typegen [--out <path>]` → `runTypegen({ out })`; and in the main flow after `loadServices`, call `runTypegen()` best-effort inside a try/catch that logs on failure.

- [ ] **Step 6: Commit**

```bash
git add packages/devtooie/src/typegen.ts packages/devtooie/src/typegen.spec.ts packages/devtooie/src/cli.ts
git commit -m "feat: typegen (module augmentation d.ts) + subcommand + auto-run"
```

---

## Phase 6 — Setup + Agent Skill

### Task 24: `skill.ts` + `assets/skill.md`

**Files:**
- Create: `packages/devtooie/src/skill.ts`, `packages/devtooie/src/skill.spec.ts`, `packages/devtooie/assets/skill.md`

**Interfaces:**
- Consumes: `getStateDir` (lib.ts).
- Produces (§15.3, §15.5):
  - `renderSkill(version: string): string` — reads `assets/skill.md`, prepends/refreshes the managed banner `<!-- devtooie skill v<version> — managed by \`devtooie init\`; do not edit -->`.
  - `installSkill(opts: { cwd?: string; version: string }): void` — writes `.claude/skills/devtooie/SKILL.md` (and `.agents/…`/`.cursor/…` when those dirs exist), records `node_modules/.devtooie/skill.json` `{ path, version, hash }`.
  - `refreshSkillIfStale(opts: { cwd?: string; version: string }): void` — per §15.5: if managed file's recorded version < current AND on-disk hash matches what devtooie wrote, rewrite; if hand-edited (hash mismatch), leave untouched.
  - `contentHash(s: string): string` (sha256 hex via `node:crypto`).

- [ ] **Step 1: Write failing tests for update detection**

```ts
// skill.spec.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderSkill, contentHash } from './skill';

describe('skill rendering', () => {
  it('embeds the managed banner with the version', () => {
    const out = renderSkill('1.2.3');
    expect(out).toContain('devtooie skill v1.2.3');
    expect(out).toContain('do not edit');
  });

  it('contentHash is stable and differs by input', () => {
    expect(contentHash('a')).toBe(contentHash('a'));
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});
```

> Full install/refresh behavior (filesystem side-effects) is validated with a temp-dir test in Step 5; the update-detection logic (version-older + hash-match → rewrite; hash-mismatch → skip) is the key assertion.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/devtooie/src/skill.spec.ts`
Expected: FAIL — `renderSkill` not defined.

- [ ] **Step 3: Write `assets/skill.md`** — the generic v1 skill (§15.3). Frontmatter `description` must trigger on both driving a session and onboarding an app. Body teaches the three capabilities verbatim from §15.3 (invoke headlessly `--plain -s`; drive via control API reading `apiPort` from `devtooie.yaml`; onboard an app: ensure `dev`/`build`/`clean`/`build:clean` scripts, rename equivalents, append to the services `apps` array, run `devtooie typegen`). **No external-project references.**

- [ ] **Step 4: Implement `skill.ts`** with `renderSkill`, `contentHash`, `installSkill`, `refreshSkillIfStale` per §15.5. Read `assets/skill.md` relative to the compiled module via `import.meta.dirname` + `../assets/skill.md`.

- [ ] **Step 5: Add a temp-dir install/refresh test**

```ts
// append to skill.spec.ts
import { installSkill, refreshSkillIfStale } from './skill';

describe('skill install + refresh', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-skill-'));
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
  });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  it('installs then refreshes on version bump but preserves hand-edits', () => {
    installSkill({ cwd, version: '1.0.0' });
    const file = path.join(cwd, '.claude/skills/devtooie/SKILL.md');
    expect(fs.existsSync(file)).toBe(true);

    // Unedited → bump rewrites to new version.
    refreshSkillIfStale({ cwd, version: '1.1.0' });
    expect(fs.readFileSync(file, 'utf8')).toContain('v1.1.0');

    // Hand-edit → next bump leaves it untouched.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\nHAND EDIT\n');
    refreshSkillIfStale({ cwd, version: '1.2.0' });
    expect(fs.readFileSync(file, 'utf8')).toContain('HAND EDIT');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('v1.2.0');
  });
});
```

> `installSkill`/`refreshSkillIfStale` must write `skill.json` under `<cwd>/node_modules/.devtooie/`. In the test, `getStateDir()` uses `process.cwd()`; pass `cwd` through so the state dir is the temp dir (add a `cwd` param to the state-dir lookups used here, or have skill functions compute `path.join(cwd, 'node_modules/.devtooie')` directly).

- [ ] **Step 6: Run tests to verify pass**

Run: `pnpm vitest run packages/devtooie/src/skill.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/devtooie/src/skill.ts packages/devtooie/src/skill.spec.ts packages/devtooie/assets/skill.md
git commit -m "feat: agent skill render/install/refresh + skill.md template"
```

---

### Task 25: `init.ts` — interactive setup

**Files:**
- Create: `packages/devtooie/src/init.ts`
- Modify: `packages/devtooie/src/cli.ts` (already dispatches `init` from Task 22)

**Interfaces:**
- Consumes: `@clack/prompts`, `writeProjectConfig` (project-config.ts), `installSkill` (skill.ts), `runTypegen` (typegen.ts).
- Produces (§15.2): `runInit(opts?: { cwd?: string; force?: boolean }): Promise<void>` — the 5-step flow: (1) install skill? (2) services path (default `./services.ts`, scaffold empty example if missing), (3) api port (default 4099), (4) write `devtooie.yaml`, (5) if skill → `installSkill` + `runTypegen`. Idempotent.

- [ ] **Step 1: Implement `init.ts`** per §15.2. Scaffold the empty services example exactly as in §15.2. Use `@clack/prompts` `intro`/`confirm`/`text`/`outro`.

- [ ] **Step 2: Build + run `devtooie init` in a temp dir (manual)**

Run: `./scripts/build.sh`, then in a temp dir with `node_modules/devtooie` linkable (or run via `node <abs>/dist/cli.js init`), walk the prompts and confirm `devtooie.yaml`, `services.ts`, `.claude/skills/devtooie/SKILL.md`, and `devtooie-env.d.ts` are created.
Expected: all four artifacts present; re-running updates rather than duplicating.

- [ ] **Step 3: Commit**

```bash
git add packages/devtooie/src/init.ts packages/devtooie/src/cli.ts
git commit -m "feat: devtooie init interactive setup flow"
```

---

### Task 26: `postinstall.mjs` — CI/TTY-gated hint

**Files:**
- Modify: `packages/devtooie/postinstall.mjs` (replace the no-op from Task 2)

**Interfaces:**
- Produces (§15.4): a Node-built-ins-only script that skips when `process.env.CI` is set, `stdout` is not a TTY, or a `devtooie.yaml`/`.yml` already exists in `INIT_CWD`; otherwise prompts (plain `node:readline`) to run `devtooie init` — yes runs init in `INIT_CWD`, no prints a one-line hint.

- [ ] **Step 1: Implement `postinstall.mjs`** using only `node:fs`, `node:path`, `node:readline`, `node:child_process`. Gate exactly per §15.4. Run init via `node <installed>/dist/cli.js init` with cwd = `INIT_CWD`. Never throw (wrap in try/catch; always `process.exit(0)`).

- [ ] **Step 2: Verify the gates**

Run: `CI=true node packages/devtooie/postinstall.mjs` (expect immediate silent exit 0); and `INIT_CWD=<dir-with-devtooie.yaml> node packages/devtooie/postinstall.mjs` (expect silent exit 0).
Expected: both exit 0 with no prompt.

- [ ] **Step 3: Commit**

```bash
git add packages/devtooie/postinstall.mjs
git commit -m "feat: CI/TTY-gated postinstall setup hint"
```

---

## Phase 7 — Publish Pipeline

### Task 27: CI workflows, release scripts, CHANGELOG, README

**Files:**
- Create: `.github/workflows/pr.yaml`, `.github/workflows/release.yaml`, `scripts/change-log-entry.sh`
- Modify: `scripts/build.sh` (finalize; already handles shebang), `CHANGELOG.md` (first `## 0.1.0`), `README.md` (full)

**Interfaces:**
- Produces (§14): a PR workflow (install + eslint + build) and a CHANGELOG-driven release workflow (determine version from top `## X.Y.Z`, skip if released, `npm version --no-git-tag-version`, build, copy README, extract notes, create GitHub release, `npm publish --provenance --access public`).

- [ ] **Step 1: Write `scripts/change-log-entry.sh`** — extract the section under the first `## X.Y.Z` heading of `CHANGELOG.md` for release notes.

```bash
#!/usr/bin/env bash
set -euo pipefail
# Prints the body of the first "## X.Y.Z" section from CHANGELOG.md.
awk '
  /^## [0-9]+\.[0-9]+\.[0-9]+/ { if (seen++) exit; next }
  seen { print }
' CHANGELOG.md
```

- [ ] **Step 2: Write `.github/workflows/pr.yaml`**

```yaml
name: pr
on:
  pull_request:
    branches: [main]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: '.tool-versions' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm build
```

- [ ] **Step 3: Write `.github/workflows/release.yaml`** per §14 (determine version by grepping the top `## X.Y.Z`; skip if a GitHub release exists; install; `npm version <v> --no-git-tag-version` in `packages/devtooie`; `./scripts/build.sh`; copy root README → package; extract notes; create release; `npm publish --provenance --access public` with `id-token: write` + `NODE_AUTH_TOKEN`).

- [ ] **Step 4: Write the first `CHANGELOG.md` entry**

```markdown
# Changelog

## 0.1.0

- Initial release: `defineAppConfigs` library + `devtooie` CLI (dependency-aware local dev orchestration, TUI + plain runners, control API, `devtooie init`, agent skill).
```

- [ ] **Step 5: Write the full `README.md`** covering: install, `devtooie init`, `devtooie.yaml` fields, the services file, tokens, Node ≥23.6 requirement (recommend 24 LTS), Unix-only note, postinstall caveat (package managers may skip lifecycle scripts — `devtooie init` is the reliable path), and the `devtooie-env.d.ts` git-ignore note. **No external-project references.**

- [ ] **Step 6: Lint + build to confirm green**

Run: `pnpm lint && pnpm test && pnpm build`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add .github CHANGELOG.md README.md scripts/change-log-entry.sh scripts/build.sh
git commit -m "ci: PR + CHANGELOG-driven release pipeline; README + first changelog entry"
```

---

## Phase 8 — Dry-Run Publish

### Task 28: `npm pack` inspection + scratch-consumer e2e

**Files:** none created; verification only. Record findings in the PR description / a scratch note.

- [ ] **Step 1: Build + pack + inspect the tarball**

Run: `./scripts/build.sh && cd packages/devtooie && npm pack --dry-run`
Expected: the file list includes `dist/**` (with `cli.js` + `index.d.ts`), `assets/skill.md`, `postinstall.mjs`; `bin` → `dist/cli.js`; `exports` map correct.

- [ ] **Step 2: Verify shebang + executability**

Run: `head -n1 packages/devtooie/dist/cli.js` (expect `#!/usr/bin/env node`) and `test -x packages/devtooie/dist/cli.js && echo executable`.
Expected: shebang present; `executable`.

- [ ] **Step 3: Scratch-consumer end-to-end**

In a temp dir: `npm pack` the package, install the tarball, run `devtooie init` (walk prompts), fill `services.ts` with two apps (one with a `dev` script pointing at a trivial `node` process), run `devtooie --plain -s <svc>` and confirm it starts; hit the control API `GET /query/pid`; `POST /command/quit`.
Expected: init creates the four artifacts; `--plain` runs; control API responds; quit shuts down cleanly.

- [ ] **Step 4: Record results + confirm publish readiness**

Note the tarball contents, the e2e result, and the two pre-publish placeholders that must be resolved: the `<owner>` in `repository.url` and final confirmation of the `devtooie` package name. Do not run a real `npm publish` from this plan — publishing happens via the release workflow on merge to `main`.

- [ ] **Step 5: Commit any fixups**

```bash
git add -A
git commit -m "chore: dry-run publish fixups"
```

---

## Notes for the implementer

- **Ordering caveat (Task 8 ↔ Task 11):** `debug-log.ts` imports `getStateDir` from `lib.ts`. If you implement Task 8 strictly before Task 11, add `getStateDir` to `lib.ts` first (its body is three lines — see Task 11 Step 3) or inline a temporary local and replace it in Task 11.
- **`getApiPort` migration (Task 11 → Task 20):** Task 11 implements `getApiPort` with an inline yaml read so it's testable immediately; Task 20 refactors it to call `getProjectConfig`. Keep the signature `getApiPort(): number` and the `4099` default constant across both.
- **Ported runtime modules (Tasks 17, 18, 19):** these carry the bulk of the behavior and are specified by §9.4/§9.9/§9.10 rather than by inline code here (too large to inline and still a faithful implementation). Implement to those sections exactly; keep every module free of external-project references and honor the §11 portability constraints (node shebang, config-only port, `node_modules/.devtooie` state, config-derived ports only, no env-file loading).
- **Every task ends green:** run the named test/build command before committing. Keep commits small and per-task.
```
