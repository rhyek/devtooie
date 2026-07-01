import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execaSync } from 'execa';
import type { AnyAppConfig } from './config.js';
import { getRegisteredApps } from './config.js';
import { getProjectConfig } from './project-config.js';
import type { RunnerArgs } from './runners/types.js';

const require = createRequire(import.meta.url);

export function getStateDir(): string {
  const dir = path.join(process.cwd(), 'node_modules', '.devtooie');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

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

export function resolveDeps(
  selectedApps: AnyAppConfig[],
  depTypes: DepType[] = ALL_DEP_TYPES,
): ResolveResult {
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
        if (!buildSet.has(dep)) {
          buildSet.add(dep);
          queue.push(dep);
        }
      }
    }
    if (depTypes.includes(DepType.DEV)) {
      for (const dep of app.run?.deps?.dev ?? []) {
        if (!buildSet.has(dep)) {
          buildSet.add(dep);
          queue.push(dep);
        }
      }
    }
  }

  const allNames = new Set([...runSet, ...buildSet]);
  const allApps = [...allNames].map(lookup).filter((a): a is AnyAppConfig => Boolean(a));
  return { allApps, buildSet, runSet, reasons };
}

/**
 * Control-API port from `devtooie.yaml` (`apiPort`), defaulting to 4099.
 */
export function getApiPort(): number {
  return getProjectConfig()?.apiPort ?? 4099;
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

const typeRank = (app: AnyAppConfig): number => {
  if (app.types.includes('backend')) return 0;
  if (app.types.includes('browser')) return 1;
  return 2; // lib / infra
};

const byName = (a: AnyAppConfig, b: AnyAppConfig) => a.name.localeCompare(b.name);

/** Selectable, dev-scripted apps grouped for the interactive selector. */
export function getServiceGroups(): { backend: AnyAppConfig[]; frontend: AnyAppConfig[] } {
  const apps = getRegisteredApps().filter((a) => a.run?.selectable !== false && hasDevScript(a));
  return {
    backend: apps.filter((a) => a.types.includes('backend')).sort(byName),
    frontend: apps.filter((a) => a.types.includes('browser')).sort(byName),
  };
}

export function getRuntimeDepsMap(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const a of getRegisteredApps()) {
    map[a.name] = a.run?.deps?.runtime ?? [];
  }
  return map;
}

/**
 * Display order: selected → selectable deps → non-selectable infra; within each,
 * backend → frontend → libs, then alphabetical.
 */
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
    sortedApps,
    selectedSet,
    buildDepSet: deps.buildSet,
    rebuildableSet,
    waitForMap,
    healthcheckUrls,
    extraCommandsMap,
  };
}
