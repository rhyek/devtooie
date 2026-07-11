import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execaSync } from 'execa';
import type { AnyPackageConfig } from './config.js';
import {
  getRegisteredPackages,
  getLoadedConfig,
  getDevScript,
  normalizeUrlEntry,
} from './config.js';
import { DEFAULT_ENV_FILES } from './env.js';
import type { RunnerArgs } from './runners/types.js';

const require = createRequire(import.meta.url);

export function getStateDir(): string {
  const dir = path.join(process.cwd(), 'node_modules', '.devtooie');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const RUNNER_MANAGED = new Set(['dev', 'build', 'build:clean', 'build-clean', 'clean']);

function readPackageJson(pkg: AnyPackageConfig): { scripts?: Record<string, string> } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkg.path, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function getCommandRunner(pkg: AnyPackageConfig): 'pnpm' | 'make' {
  if (fs.existsSync(path.join(pkg.path, 'package.json'))) return 'pnpm';
  if (fs.existsSync(path.join(pkg.path, 'Makefile'))) return 'make';
  return 'pnpm';
}

export function getExecArgs(pkg: AnyPackageConfig, script: string): [string, string[]] {
  return getCommandRunner(pkg) === 'make' ? ['make', [script]] : ['pnpm', ['run', script]];
}

export function hasScript(pkg: AnyPackageConfig, script: string): boolean {
  if (getCommandRunner(pkg) === 'make') return getMakeTargets(pkg).includes(script);
  return Boolean(readPackageJson(pkg)?.scripts?.[script]);
}

/**
 * Whether a package can be cleanly rebuilt. Either its dev command already clean-rebuilds on
 * start (`command.cleans`, in which case a rebuild is just a restart — see
 * {@link getRebuildCommands}), or it exposes the scripts to do it: a single `build:clean`, or
 * separate `clean` and `build` (run in sequence). Makefile packages rely on the latter, since a
 * `make` target name can't contain the `:` in `build:clean`.
 */
export function canRebuild(pkg: AnyPackageConfig): boolean {
  if (pkg.command?.cleans === true) return true;
  return hasScript(pkg, 'build:clean') || (hasScript(pkg, 'clean') && hasScript(pkg, 'build'));
}

/**
 * The command(s) a clean rebuild runs, in order: a single `build:clean` when the package
 * defines it, otherwise `clean` then `build`. Empty when there are no such scripts — either the
 * package can't rebuild, or its dev command self-cleans (`command.cleans`), in which case a
 * rebuild is just a restart (no pre-commands). See {@link canRebuild}.
 */
export function getRebuildCommands(pkg: AnyPackageConfig): [string, string[]][] {
  if (hasScript(pkg, 'build:clean')) return [getExecArgs(pkg, 'build:clean')];
  if (hasScript(pkg, 'clean') && hasScript(pkg, 'build')) {
    return [getExecArgs(pkg, 'clean'), getExecArgs(pkg, 'build')];
  }
  return [];
}

export function hasDevScript(pkg: AnyPackageConfig): boolean {
  return hasScript(pkg, getDevScript(pkg));
}

export function getMakeTargets(pkg: AnyPackageConfig): string[] {
  try {
    const mk = fs.readFileSync(path.join(pkg.path, 'Makefile'), 'utf8');
    // Exclude make's special targets (`.PHONY`, `.DEFAULT`, …) — they start with `.` and aren't
    // runnable targets, so they must not surface as commands.
    return [...mk.matchAll(/^([a-zA-Z0-9_.-]+):/gm)]
      .map((m) => m[1]!)
      .filter((t) => !t.startsWith('.'));
  } catch {
    return [];
  }
}

export function getExtraCommands(pkg: AnyPackageConfig): string[] {
  const names =
    getCommandRunner(pkg) === 'make'
      ? getMakeTargets(pkg)
      : Object.keys(readPackageJson(pkg)?.scripts ?? {});
  // Exclude runner-managed scripts and this package's configured dev command (run via s/r).
  const devScript = getDevScript(pkg);
  return names.filter((n) => !RUNNER_MANAGED.has(n) && n !== devScript);
}

export enum DepType {
  BUILD = 'build',
  DEV = 'dev',
  RUNTIME = 'runtime',
}
export const ALL_DEP_TYPES = [DepType.BUILD, DepType.DEV, DepType.RUNTIME];

function lookup(name: string): AnyPackageConfig | undefined {
  return getRegisteredPackages().find((a) => a.name === name);
}

/**
 * The tsconfig file devtooie reads for a package dir's project references, by precedence:
 * the registered package's `tsconfig` (explicit, no fallback) → `tsconfig.build.json` →
 * `tsconfig.json`. Returns `null` when none applies.
 */
function resolveRefTsconfig(dir: string, byPath: Map<string, AnyPackageConfig>): string | null {
  const custom = byPath.get(dir)?.tsconfig;
  const candidates = custom
    ? [path.join(dir, custom)]
    : [path.join(dir, 'tsconfig.build.json'), path.join(dir, 'tsconfig.json')];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

export function getTsconfigBuildPackages(pkg: AnyPackageConfig): AnyPackageConfig[] {
  // Resolve TS project references transitively (via the TS peer dep), reading each package's
  // tsconfig per `resolveRefTsconfig`'s precedence (tsconfig → tsconfig.build.json → tsconfig.json).
  let ts: typeof import('typescript');
  try {
    ts = require('typescript');
  } catch {
    return [];
  }
  const registered = getRegisteredPackages();
  const byPath = new Map(registered.map((a) => [path.resolve(a.path), a]));
  const seen = new Set<string>();
  const result: AnyPackageConfig[] = [];
  const visit = (dir: string) => {
    const resolvedDir = path.resolve(dir);
    if (seen.has(resolvedDir)) return;
    seen.add(resolvedDir);
    const cfgPath = resolveRefTsconfig(resolvedDir, byPath);
    if (!cfgPath) return;
    const parsed = ts.readConfigFile(cfgPath, ts.sys.readFile);
    const refs = (parsed.config?.references ?? []) as { path: string }[];
    for (const ref of refs) {
      const refDir = path.resolve(resolvedDir, ref.path.replace(/tsconfig.*\.json$/, ''));
      const match = byPath.get(refDir);
      if (match && !result.includes(match)) result.push(match);
      visit(refDir);
    }
  };
  visit(pkg.path);
  return result;
}

export interface ResolveResult {
  allPackages: AnyPackageConfig[];
  buildSet: Set<string>;
  runSet: Set<string>;
  reasons: Record<string, string>;
}

export function resolveDeps(
  selectedPackages: AnyPackageConfig[],
  depTypes: DepType[] = ALL_DEP_TYPES,
): ResolveResult {
  const runSet = new Set<string>();
  const reasons: Record<string, string> = {};
  for (const pkg of selectedPackages) {
    runSet.add(pkg.name);
    reasons[pkg.name] = 'selected';
    if (depTypes.includes(DepType.RUNTIME)) {
      for (const dep of pkg.deps?.runtime ?? []) {
        if (!runSet.has(dep)) reasons[dep] = `runtime dep of ${pkg.name}`;
        runSet.add(dep);
      }
    }
  }

  const buildSet = new Set<string>();
  const queue = [...runSet];
  while (queue.length) {
    const name = queue.shift()!;
    const pkg = lookup(name);
    if (!pkg) continue;
    if (depTypes.includes(DepType.BUILD)) {
      const buildDeps = [
        ...getTsconfigBuildPackages(pkg).map((a) => a.name),
        ...(pkg.deps?.build ?? []),
      ];
      for (const dep of buildDeps) {
        if (!buildSet.has(dep)) {
          buildSet.add(dep);
          queue.push(dep);
        }
      }
    }
    if (depTypes.includes(DepType.DEV)) {
      for (const dep of pkg.deps?.dev ?? []) {
        if (!buildSet.has(dep)) {
          buildSet.add(dep);
          queue.push(dep);
        }
      }
    }
  }

  const allNames = new Set([...runSet, ...buildSet]);
  const allPackages = [...allNames].map(lookup).filter((a): a is AnyPackageConfig => Boolean(a));
  return { allPackages, buildSet, runSet, reasons };
}

const selectionFile = () => path.join(getStateDir(), 'selection.json');

export function saveSelection(names: string[]): void {
  fs.writeFileSync(selectionFile(), JSON.stringify(names));
}

export function loadSelection(): string[] | null {
  try {
    return JSON.parse(fs.readFileSync(selectionFile(), 'utf8')) as string[];
  } catch {
    return null;
  }
}

export function resetSelection(): void {
  try {
    fs.rmSync(selectionFile(), { force: true });
  } catch {
    // nothing to reset
  }
}

/** Current git branch; short SHA on detached HEAD; null when not a repo. */
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

const byName = (a: AnyPackageConfig, b: AnyPackageConfig) => a.name.localeCompare(b.name);

type DepKind = 'build' | 'dev' | 'runtime';

/**
 * A package's direct deps for one kind; `build` folds in `tsconfig.build.json` project refs.
 * Always returns a fresh array — callers ({@link closureSize}) drain it in place, so it must
 * never hand back the package's own `run.deps` array.
 */
function directDeps(pkg: AnyPackageConfig, kind: DepKind): string[] {
  if (kind === 'build') {
    return [...getTsconfigBuildPackages(pkg).map((a) => a.name), ...(pkg.deps?.build ?? [])];
  }
  return [...(pkg.deps?.[kind] ?? [])];
}

/** Size of the transitive closure reachable from `pkg` following only `kind` edges. */
function closureSize(pkg: AnyPackageConfig, kind: DepKind): number {
  const seen = new Set<string>();
  const queue = directDeps(pkg, kind);
  while (queue.length) {
    const name = queue.shift()!;
    if (name === pkg.name || seen.has(name)) continue;
    seen.add(name);
    const dep = lookup(name);
    if (dep) queue.push(...directDeps(dep, kind));
  }
  return seen.size;
}

/**
 * A package's "weight": how many packages it pulls in across build, dev and runtime edges,
 * counted per edge type so a package reached via two kinds (e.g. build *and* runtime) counts
 * once per kind. Intrinsic to the dependency graph — independent of the current selection.
 */
export function depScore(pkg: AnyPackageConfig): number {
  return (['build', 'dev', 'runtime'] as const).reduce(
    (sum, kind) => sum + closureSize(pkg, kind),
    0,
  );
}

/**
 * A package's sort points: its `depScore` (dependency weight), plus one point if it was
 * explicitly selected in the picker. The selection point lifts a directly-chosen package
 * above equally-weighted deps that were only pulled in transitively.
 */
export function packagePoints(pkg: AnyPackageConfig, selectedSet?: Set<string>): number {
  return depScore(pkg) + (selectedSet?.has(pkg.name) ? 1 : 0);
}

/**
 * The one display order: most points first (`packagePoints` — dependency weight plus a point
 * for being selected), ties broken by name. Drives both the running process list and the
 * per-package URL column in the footer, and the interactive selector's list.
 */
export function sortPackages(
  packages: AnyPackageConfig[],
  selectedSet?: Set<string>,
): AnyPackageConfig[] {
  const score = new Map(packages.map((a) => [a.name, packagePoints(a, selectedSet)] as const));
  return [...packages].sort((a, b) => score.get(b.name)! - score.get(a.name)! || byName(a, b));
}

/** Selectable, dev-scripted packages for the interactive selector, in display order. */
export function getSelectablePackages(): AnyPackageConfig[] {
  return sortPackages(
    getRegisteredPackages().filter((a) => a.selectable !== false && hasDevScript(a)),
  );
}

export function getRuntimeDepsMap(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const a of getRegisteredPackages()) {
    map[a.name] = a.deps?.runtime ?? [];
  }
  return map;
}

export function buildRunnerArgs(
  selectedPackages: AnyPackageConfig[],
  deps: ResolveResult,
): RunnerArgs {
  const selectedSet = new Set(selectedPackages.map((a) => a.name));
  const sortedPackages = sortPackages(deps.allPackages, selectedSet);
  const rebuildableSet = new Set(deps.allPackages.filter(canRebuild).map((a) => a.name));
  const waitForMap: Record<string, string[]> = {};
  const healthcheckUrls: Record<string, string> = {};
  const extraCommandsMap: Record<string, string[]> = {};
  for (const a of deps.allPackages) {
    if (a.waitFor?.length) {
      waitForMap[a.name] = a.waitFor;
    }
    if (a.healthcheck) {
      healthcheckUrls[a.name] = a.healthcheck;
    }
    const extra = getExtraCommands(a);
    if (extra.length) {
      extraCommandsMap[a.name] = extra;
    }
  }
  const config = getLoadedConfig();
  return {
    sortedPackages,
    selectedSet,
    buildDepSet: deps.buildSet,
    rebuildableSet,
    waitForMap,
    healthcheckUrls,
    extraCommandsMap,
    topLevelUrls: config?.urls?.map(normalizeUrlEntry),
    envFiles: config?.envFiles ?? DEFAULT_ENV_FILES,
    cwd: process.cwd(),
  };
}
