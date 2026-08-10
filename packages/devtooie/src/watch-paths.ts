import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { AnyPackageConfig } from './config.js';

const require = createRequire(import.meta.url);

/**
 * Why this module exists.
 *
 * `node --watch` registers a **recursive** watch on the directory of every file the process
 * loads. Node's `FilesWatcher#filterFile` calls `watchPath(dirname(file))` with `recursive: true`
 * and applies no ignore list, so `node_modules` is included wholesale — a service with a real
 * dependency tree ends up holding thousands of watch roots it never asked for. On macOS those are
 * FSEvents-backed, and a large watch surface combined with a burst of file events (a build step
 * rewriting an entire `dist` just before the watcher starts, say) can fail the whole FSEvents
 * stream with `EMFILE`.
 *
 * The fix is to name the directories explicitly with `--watch-path`, which keeps the restarts that
 * matter (your own build output) and drops the dependency-tree churn. Doing that by hand means
 * hard-coding a path list per service and keeping it in sync; devtooie already knows each
 * package's TypeScript project graph, so it derives the list instead.
 */

/** A package's own directory-of-interest plus each transitive project reference's. */
export interface WatchPathDerivation {
  paths: string[];
  /** True when TypeScript wasn't resolvable, so nothing could be derived. */
  unavailable: boolean;
}

/**
 * `true` when `script` runs `node --watch` without scoping it.
 *
 * Deliberately narrow: only Node's own watcher has this behavior, so `tsx watch`, `nodemon` and
 * friends are left alone. A script that already passes `--watch-path`, or that interpolates
 * {@link WATCH_PATHS_ENV}, is considered scoped and produces no warning.
 */
export function usesUnscopedNodeWatch(script: string): boolean {
  // `--watch` not followed by `-` or a word char, so `--watch-path` doesn't count as a match.
  const runsNodeWatch = /(?:^|[\s;&|(])node\b[^\n;&|]*?--watch(?![\w-])/.test(script);
  if (!runsNodeWatch) {
    return false;
  }
  const alreadyScoped =
    /--watch-path\b/.test(script) || new RegExp(`\\$\\{?${WATCH_PATHS_ENV}\\b`).test(script);
  return !alreadyScoped;
}

/** Env var devtooie injects into every child, holding ready-made `--watch-path=` flags. */
export const WATCH_PATHS_ENV = 'DEVTOOIE_WATCH_PATHS';

/** Renders derived directories as the flag string a dev script can splice straight into `node`. */
export function formatWatchPathFlags(paths: string[]): string {
  return paths.map((p) => `--watch-path=${p}`).join(' ');
}

interface TsLike {
  sys: unknown;
  getParsedCommandLineOfConfigFile: (
    configPath: string,
    options: undefined,
    host: unknown,
  ) =>
    | {
        options: { outDir?: string; rootDir?: string; noEmit?: boolean };
        projectReferences?: { path: string }[];
      }
    | undefined;
}

function loadTypeScript(): TsLike | null {
  try {
    return require('typescript') as TsLike;
  } catch {
    // TypeScript is an optional peer dep — a JS-only workspace simply gets no derivation.
    return null;
  }
}

/**
 * The tsconfig devtooie reads for a directory, by the same precedence as build-dep resolution:
 * an explicit `tsconfig` on the package → `tsconfig.build.json` → `tsconfig.json`.
 */
function resolveTsconfig(dir: string, explicit?: string): string | null {
  const candidates = explicit
    ? [path.join(dir, explicit)]
    : [path.join(dir, 'tsconfig.build.json'), path.join(dir, 'tsconfig.json')];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/**
 * The directory a package *runs from*, for the package devtooie is starting:
 *
 * - it emits (`outDir`, not `noEmit`) → its output directory, the transpile-then-run shape;
 * - otherwise its `rootDir` or a conventional `src/` — running TypeScript through Node directly,
 *   where the source *is* what's loaded.
 *
 * Only one of the two is ever returned. Watching both would double every restart in the
 * transpiling case: once for the source edit, once for the emit it triggers.
 */
function ownWatchDir(
  options: { outDir?: string; rootDir?: string; noEmit?: boolean },
  dir: string,
): string | null {
  if (options.outDir && !options.noEmit) {
    return options.outDir;
  }
  if (options.rootDir) {
    return options.rootDir;
  }
  const src = path.join(dir, 'src');
  return fs.existsSync(src) ? src : null;
}

/** The first concrete file path in an `exports` subtree, preferring runtime conditions. */
function pickExportPath(node: unknown, depth = 0): string | null {
  if (typeof node === 'string') {
    return node;
  }
  if (depth > 8 || typeof node !== 'object' || node === null || Array.isArray(node)) {
    return null;
  }
  const conditions = node as Record<string, unknown>;
  // `types` last: it can point at a `.d.ts` beside a `dist` the runtime never loads, whereas
  // `import`/`default` name what actually gets executed.
  for (const key of ['import', 'module', 'require', 'default', 'node', '.', 'types']) {
    if (key in conditions) {
      const found = pickExportPath(conditions[key], depth + 1);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

interface DepPackageJson {
  exports?: unknown;
  main?: string;
  module?: string;
  types?: string;
  dependencies?: Record<string, string>;
}

/**
 * The directory a *dependency* is actually loaded from, read off its `exports` (or `main`).
 *
 * This is the field that distinguishes the two shapes, and it's why the answer can't be inferred
 * from the dependency's tsconfig alone. A source-consumption library points `exports` at
 * `./src/index.ts` and is type-stripped by the consumer at runtime — watching a `dist` it may also
 * emit would miss every edit. A compiled library points at `./dist/index.js`, where watching `src`
 * would fire before the rebuild that matters. Reading `exports` gets both right for free.
 */
function dependencyWatchDir(depDir: string, json: DepPackageJson): string | null {
  const entry = pickExportPath(json.exports) ?? json.module ?? json.main ?? json.types;
  if (!entry) {
    const src = path.join(depDir, 'src');
    return fs.existsSync(src) ? src : null;
  }
  const dir = path.dirname(path.resolve(depDir, entry));
  // An entry at the package root would pull the whole package in, `node_modules` included —
  // prefer a conventional `src/` when there is one.
  if (path.resolve(dir) === path.resolve(depDir)) {
    const src = path.join(depDir, 'src');
    return fs.existsSync(src) ? src : dir;
  }
  return dir;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Workspace dependencies of `dir`, resolved through its `node_modules` symlinks and followed
 * transitively. A real third-party dependency resolves inside a `node_modules` store and is
 * skipped — those are what `--watch-path` exists to exclude in the first place.
 */
function collectWorkspaceDeps(
  dir: string,
  out: Map<string, DepPackageJson>,
  seen: Set<string>,
): void {
  const json = readJson<DepPackageJson>(path.join(dir, 'package.json'));
  if (!json) {
    return;
  }
  for (const name of Object.keys(json.dependencies ?? {})) {
    let depDir: string;
    try {
      depDir = fs.realpathSync(path.join(dir, 'node_modules', name));
    } catch {
      continue; // not installed / not linked here
    }
    if (depDir.includes(`${path.sep}node_modules${path.sep}`) || seen.has(depDir)) {
      continue; // a store-backed third-party package, or already visited
    }
    seen.add(depDir);
    const depJson = readJson<DepPackageJson>(path.join(depDir, 'package.json'));
    if (depJson) {
      out.set(depDir, depJson);
      collectWorkspaceDeps(depDir, out, seen);
    }
  }
}

/**
 * Derives the directories a package's `node --watch` should be scoped to: its own, plus every
 * transitive TypeScript project reference's. Mirrors how devtooie already infers build-time deps,
 * so the list stays correct as the project graph changes instead of being hand-maintained.
 *
 * Only existing directories are returned — `--watch-path` fails on a missing path, and a
 * reference's `dist` legitimately doesn't exist until it's been built once.
 */
export function deriveWatchPaths(pkg: AnyPackageConfig): WatchPathDerivation {
  const paths: string[] = [];
  const add = (dir: string | null): void => {
    if (dir && fs.existsSync(dir) && !paths.includes(dir)) {
      paths.push(dir);
    }
  };

  // 1. The package itself, from its tsconfig: `dist` when it transpiles, `src` when Node runs its
  //    TypeScript directly.
  const ts = loadTypeScript();
  const host = ts ? { ...(ts.sys as object), onUnRecoverableConfigFileDiagnostic: () => {} } : null;
  const parseConfig = (dir: string, explicit?: string) => {
    const cfgPath = ts && resolveTsconfig(dir, explicit);
    if (!ts || !cfgPath) {
      return null;
    }
    try {
      return ts.getParsedCommandLineOfConfigFile(cfgPath, undefined, host) ?? null;
    } catch {
      return null; // an unparseable tsconfig shouldn't stop the session
    }
  };

  const ownDir = path.resolve(pkg.path);
  const own = parseConfig(ownDir, pkg.tsconfig);
  add(own ? ownWatchDir(own.options, ownDir) : path.join(ownDir, 'src'));

  // 2. Each workspace dependency, at the directory its `exports` actually resolves into. This is
  //    what makes both shapes work without configuration.
  const deps = new Map<string, DepPackageJson>();
  collectWorkspaceDeps(ownDir, deps, new Set([ownDir]));
  for (const [depDir, depJson] of deps) {
    add(dependencyWatchDir(depDir, depJson));
  }

  // 3. Transitive TypeScript project references, for build-only deps that aren't package.json
  //    dependencies (nothing imports them at runtime, but their emit still feeds the build).
  const seenProjects = new Set<string>();
  const visitRefs = (dir: string, explicit?: string): void => {
    const resolvedDir = path.resolve(dir);
    if (seenProjects.has(resolvedDir)) {
      return;
    }
    seenProjects.add(resolvedDir);
    const parsed = parseConfig(resolvedDir, explicit);
    if (!parsed) {
      return;
    }
    if (resolvedDir !== ownDir) {
      add(ownWatchDir(parsed.options, resolvedDir));
    }
    for (const ref of parsed.projectReferences ?? []) {
      // A reference may point at a directory or directly at a tsconfig file.
      const refPath = path.resolve(resolvedDir, ref.path);
      const refIsFile = refPath.endsWith('.json');
      visitRefs(
        refIsFile ? path.dirname(refPath) : refPath,
        refIsFile ? path.basename(refPath) : undefined,
      );
    }
  };
  visitRefs(ownDir, pkg.tsconfig);

  return { paths, unavailable: !ts };
}
