import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execaSync } from 'execa';
import type { AnyPackageConfig } from './config.js';
import { getRegisteredPackages, getLoadedConfig } from './config.js';
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
 * Whether a package can be cleanly rebuilt: it has a single `build:clean` script/target,
 * or separate `clean` and `build` ones (run in sequence). Makefile packages rely on the
 * latter, since a `make` target name can't contain the `:` in `build:clean`.
 */
export function canRebuild(pkg: AnyPackageConfig): boolean {
  return hasScript(pkg, 'build:clean') || (hasScript(pkg, 'clean') && hasScript(pkg, 'build'));
}

/**
 * The command(s) a clean rebuild runs, in order: a single `build:clean` when the package
 * defines it, otherwise `clean` then `build`. Empty when the package can't rebuild (see
 * {@link canRebuild}).
 */
export function getRebuildCommands(pkg: AnyPackageConfig): [string, string[]][] {
  if (hasScript(pkg, 'build:clean')) return [getExecArgs(pkg, 'build:clean')];
  if (hasScript(pkg, 'clean') && hasScript(pkg, 'build')) {
    return [getExecArgs(pkg, 'clean'), getExecArgs(pkg, 'build')];
  }
  return [];
}

export function hasDevScript(pkg: AnyPackageConfig): boolean {
  return hasScript(pkg, 'dev');
}

export function getMakeTargets(pkg: AnyPackageConfig): string[] {
  try {
    const mk = fs.readFileSync(path.join(pkg.path, 'Makefile'), 'utf8');
    return [...mk.matchAll(/^([a-zA-Z0-9_.-]+):/gm)].map((m) => m[1]!);
  } catch {
    return [];
  }
}

export function getExtraCommands(pkg: AnyPackageConfig): string[] {
  const names =
    getCommandRunner(pkg) === 'make'
      ? getMakeTargets(pkg)
      : Object.keys(readPackageJson(pkg)?.scripts ?? {});
  return names.filter((n) => !RUNNER_MANAGED.has(n));
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

export function getTsconfigBuildPackages(pkg: AnyPackageConfig): AnyPackageConfig[] {
  // Resolve tsconfig.build.json project references transitively via the TS peer dep.
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
      for (const dep of pkg.run?.deps?.runtime ?? []) {
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
        ...(pkg.run?.deps?.build ?? []),
      ];
      for (const dep of buildDeps) {
        if (!buildSet.has(dep)) {
          buildSet.add(dep);
          queue.push(dep);
        }
      }
    }
    if (depTypes.includes(DepType.DEV)) {
      for (const dep of pkg.run?.deps?.dev ?? []) {
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

const typeRank = (pkg: AnyPackageConfig): number => {
  if (pkg.types.includes('backend')) return 0;
  if (pkg.types.includes('browser')) return 1;
  return 2; // lib / infra
};

const byName = (a: AnyPackageConfig, b: AnyPackageConfig) => a.name.localeCompare(b.name);

/** Selectable, dev-scripted packages grouped for the interactive selector. */
export function getPackageGroups(): { backend: AnyPackageConfig[]; frontend: AnyPackageConfig[] } {
  const packages = getRegisteredPackages().filter(
    (a) => a.run?.selectable !== false && hasDevScript(a),
  );
  return {
    backend: packages.filter((a) => a.types.includes('backend')).sort(byName),
    frontend: packages.filter((a) => a.types.includes('browser')).sort(byName),
  };
}

export function getRuntimeDepsMap(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const a of getRegisteredPackages()) {
    map[a.name] = a.run?.deps?.runtime ?? [];
  }
  return map;
}

/**
 * Display order: selected → selectable deps → non-selectable infra; within each,
 * backend → frontend → libs, then alphabetical.
 */
export function sortForDisplay(
  packages: AnyPackageConfig[],
  selectedSet: Set<string>,
): AnyPackageConfig[] {
  const bucket = (a: AnyPackageConfig): number => {
    if (selectedSet.has(a.name)) return 0;
    if (a.run?.selectable !== false) return 1;
    return 2;
  };
  return [...packages].sort((a, b) => {
    const bd = bucket(a) - bucket(b);
    if (bd !== 0) return bd;
    const td = typeRank(a) - typeRank(b);
    if (td !== 0) return td;
    return byName(a, b);
  });
}

export function buildRunnerArgs(
  selectedPackages: AnyPackageConfig[],
  deps: ResolveResult,
): RunnerArgs {
  const selectedSet = new Set(selectedPackages.map((a) => a.name));
  const sortedPackages = sortForDisplay(deps.allPackages, selectedSet);
  const rebuildableSet = new Set(deps.allPackages.filter(canRebuild).map((a) => a.name));
  const waitForMap: Record<string, string[]> = {};
  const healthcheckUrls: Record<string, string> = {};
  const extraCommandsMap: Record<string, string[]> = {};
  for (const a of deps.allPackages) {
    if (a.run?.waitFor?.length) {
      waitForMap[a.name] = a.run.waitFor;
    }
    if (a.run?.healthcheck) {
      healthcheckUrls[a.name] = a.run.healthcheck;
    }
    const extra = getExtraCommands(a);
    if (extra.length) {
      extraCommandsMap[a.name] = extra;
    }
  }
  return {
    sortedPackages,
    selectedSet,
    buildDepSet: deps.buildSet,
    rebuildableSet,
    waitForMap,
    healthcheckUrls,
    extraCommandsMap,
    envFiles: getLoadedConfig()?.envFiles ?? DEFAULT_ENV_FILES,
    cwd: process.cwd(),
  };
}
