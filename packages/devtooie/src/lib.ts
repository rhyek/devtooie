import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { execa, execaSync, type ResultPromise } from 'execa';
import type { AnyServiceConfig, ResolvedHealthcheck } from './config.js';
import {
  getRegisteredPackages,
  getLoadedConfig,
  getDevScript,
  normalizeUrlEntry,
} from './config.js';
import { envFileNames } from './env.js';
import { getStateDir } from './log-files.js';
import type { RunnerArgs } from './runners/types.js';

export {
  getStateDir,
  getLogDir,
  getDefaultLogFile,
  displayLogFile,
  pickNewestLog,
  resolveLogFile,
} from './log-files.js';

const require = createRequire(import.meta.url);

/**
 * A duration in words for the exit line: `3 days 2 hours 3 minutes`. Units that are zero
 * are left out, and seconds appear only while the whole duration is under a minute. Rounds
 * down, so a unit never reads as the next one up.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) {
    return plural(totalSeconds, 'second');
  }
  const units: [number, string][] = [
    [Math.floor(totalSeconds / 86_400), 'day'],
    [Math.floor((totalSeconds % 86_400) / 3600), 'hour'],
    [Math.floor((totalSeconds % 3600) / 60), 'minute'],
  ];
  return units
    .filter(([count]) => count > 0)
    .map(([count, unit]) => plural(count, unit))
    .join(' ');
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** Strips ANSI SGR (color) escape sequences, so logfiles hold plain text. */
export function stripAnsi(text: string): string {
  // oxlint-disable-next-line no-control-regex -- matches ANSI SGR escape sequences
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** `YYYY-MM-DD HH:MM:SS` local-time (24-hour) stamp prefixed to each logged line. */
export function logTimestamp(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mo}-${dd} ${hh}:${mm}:${ss}`;
}

const RUNNER_MANAGED = new Set(['dev', 'build', 'build:clean', 'build-clean', 'clean']);

/**
 * The configured package whose directory is `startDir` itself or the nearest ancestor of it —
 * i.e. which package you're "inside" when running from `startDir`. Walks up until it matches a
 * package `path` or reaches `root` (the config dir), returning `null` if it reaches `root`
 * without a match (below the root but not inside any package). Deepest match wins.
 */
export function findAncestorPackage(
  startDir: string,
  packages: AnyServiceConfig[],
  root: string,
): AnyServiceConfig | null {
  const byPath = new Map(packages.map((p) => [path.resolve(p.absoluteDir), p]));
  const stop = path.resolve(root);
  let dir = path.resolve(startDir);
  for (;;) {
    const pkg = byPath.get(dir);
    if (pkg) {
      return pkg;
    }
    if (dir === stop) {
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

type PackageJson = { name?: string; version?: string; scripts?: Record<string, string> };

function readPackageJson(pkg: AnyServiceConfig): PackageJson | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(pkg.absoluteDir, 'package.json'), 'utf8'),
    ) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * The raw text of a package.json script, or null when the package has no package.json / no such
 * script (a Makefile package always returns null — its recipe isn't readable this way).
 */
export function getScriptText(pkg: AnyServiceConfig, script: string): string | null {
  return readPackageJson(pkg)?.scripts?.[script] ?? null;
}

export function getCommandRunner(pkg: AnyServiceConfig): 'sh' | 'make' {
  if (fs.existsSync(path.join(pkg.absoluteDir, 'package.json'))) {
    return 'sh';
  }
  if (fs.existsSync(path.join(pkg.absoluteDir, 'Makefile'))) {
    return 'make';
  }
  return 'sh';
}

/** How to spawn a package script or make target: the command, its args, and its environment. */
export interface ExecSpec {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** `node_modules/.bin` of `dir` and of each of its ancestors that has one, nearest first. */
function binDirs(dir: string): string[] {
  const dirs: string[] = [];
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    const bin = path.join(current, 'node_modules', '.bin');
    if (fs.statSync(bin, { throwIfNoEntry: false })?.isDirectory()) {
      dirs.push(bin);
    }
    if (path.dirname(current) === current) {
      return dirs;
    }
  }
}

/**
 * How to spawn `script` for a package, with `extraArgs` forwarded to it. Spawn the result with
 * the package's directory as cwd and with its `env` — `env` (the environment the caller would
 * otherwise spawn with) plus whatever the script needs on top.
 *
 * A `package.json` script is run as its own text through `/bin/sh`, with no package manager in
 * between. Most shells replace themselves with a script that is a single command (bash and
 * busybox do; dash stays as its parent), so the spawned process is usually the script itself —
 * which is why a fatal signal can surface either as a signal or as a 128+n exit code; see
 * {@link exitCodeOf}. The package's `node_modules/.bin` and every ancestor's go on `PATH`, and
 * the variables naming the package and script are set for it — over any inherited from a
 * package manager that started devtooie, which describe the workspace root instead.
 */
export function getExecArgs(
  pkg: AnyServiceConfig,
  script: string,
  extraArgs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): ExecSpec {
  if (getCommandRunner(pkg) === 'make') {
    // make forwards args that follow the target name straight to it.
    return { cmd: 'make', args: [script, ...extraArgs], env };
  }
  const text = getScriptText(pkg, script);
  if (text === null) {
    return {
      cmd: '/bin/sh',
      args: ['-c', 'echo "Missing script: \\"$1\\"" >&2; exit 1', 'sh', script],
      env,
    };
  }
  const packageJson = readPackageJson(pkg);
  return {
    cmd: '/bin/sh',
    // Extra args ride along as positional parameters, so the shell quotes them, not us.
    args: extraArgs.length > 0 ? ['-c', `${text} "$@"`, 'sh', ...extraArgs] : ['-c', text],
    env: {
      ...env,
      PATH: [...binDirs(pkg.absoluteDir), ...(env.PATH ? [env.PATH] : [])].join(path.delimiter),
      // An absent name/version stays `undefined`, which leaves an inherited one out of the child.
      npm_package_name: packageJson?.name,
      npm_package_version: packageJson?.version,
      npm_package_json: path.join(pkg.absoluteDir, 'package.json'),
      npm_lifecycle_event: script,
      npm_lifecycle_script: text,
      INIT_CWD: pkg.absoluteDir,
      PNPM_SCRIPT_SRC_DIR: pkg.absoluteDir,
    },
  };
}

/**
 * Runs a package script (or make target) to completion in the package's directory, with its
 * output inherited or captured. Rejects when the script fails — a non-zero exit code and a fatal
 * signal alike.
 */
export function runScript(
  pkg: AnyServiceConfig,
  script: string,
  stdio: 'inherit' | 'pipe',
): ResultPromise {
  const { cmd, args, env } = getExecArgs(pkg, script);
  return execa(cmd, args, { stdio, cwd: pkg.absoluteDir, env });
}

/**
 * The exit code of a finished child process, by shell convention: its own code when it exited,
 * 128 + the signal number when a signal killed it, and 1 when it never ran.
 */
export function exitCodeOf(result: { exitCode?: number; signal?: string }): number {
  if (result.exitCode !== undefined) {
    return result.exitCode;
  }
  const signal = os.constants.signals[result.signal as NodeJS.Signals] as number | undefined;
  return signal === undefined ? 1 : 128 + signal;
}

export function hasScript(pkg: AnyServiceConfig, script: string): boolean {
  if (getCommandRunner(pkg) === 'make') {
    return getMakeTargets(pkg).includes(script);
  }
  return Boolean(readPackageJson(pkg)?.scripts?.[script]);
}

/**
 * Whether a package can be cleanly rebuilt. Either its dev command already clean-rebuilds on
 * start (`command.cleans`, in which case a rebuild is just a restart — see
 * {@link getRebuildCommands}), or it exposes the scripts to do it: a single `build:clean`, or
 * separate `clean` and `build` (run in sequence). Makefile packages rely on the latter, since a
 * `make` target name can't contain the `:` in `build:clean`.
 */
export function canRebuild(pkg: AnyServiceConfig): boolean {
  if (pkg.command?.cleans === true) {
    return true;
  }
  return hasScript(pkg, 'build:clean') || (hasScript(pkg, 'clean') && hasScript(pkg, 'build'));
}

/**
 * The command(s) a clean rebuild runs, in order: a single `build:clean` when the package
 * defines it, otherwise `clean` then `build`. Empty when there are no such scripts — either the
 * package can't rebuild, or its dev command self-cleans (`command.cleans`), in which case a
 * rebuild is just a restart (no pre-commands). See {@link canRebuild}.
 */
export function getRebuildCommands(
  pkg: AnyServiceConfig,
  env: NodeJS.ProcessEnv = process.env,
): ExecSpec[] {
  if (hasScript(pkg, 'build:clean')) {
    return [getExecArgs(pkg, 'build:clean', [], env)];
  }
  if (hasScript(pkg, 'clean') && hasScript(pkg, 'build')) {
    return [getExecArgs(pkg, 'clean', [], env), getExecArgs(pkg, 'build', [], env)];
  }
  return [];
}

/**
 * Whether devtooie can run this package as a dev process — the single "is it startable?" check
 * (used for the picker and `ProcessManager`'s `canDev`). `command: null` opts out explicitly;
 * otherwise the package must expose its dev script/target.
 */
export function hasDevScript(pkg: AnyServiceConfig): boolean {
  return pkg.command !== null && hasScript(pkg, getDevScript(pkg));
}

export function getMakeTargets(pkg: AnyServiceConfig): string[] {
  try {
    const mk = fs.readFileSync(path.join(pkg.absoluteDir, 'Makefile'), 'utf8');
    // Exclude make's special targets (`.PHONY`, `.DEFAULT`, …) — they start with `.` and aren't
    // runnable targets, so they must not surface as commands.
    return [...mk.matchAll(/^([a-zA-Z0-9_.-]+):/gm)]
      .map((m) => m[1]!)
      .filter((t) => !t.startsWith('.'));
  } catch {
    return [];
  }
}

export function getExtraCommands(pkg: AnyServiceConfig): string[] {
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

function lookup(name: string): AnyServiceConfig | undefined {
  return getRegisteredPackages().find((a) => a.name === name);
}

/**
 * The tsconfig file devtooie reads for a package dir's project references, by precedence:
 * the registered package's `tsconfig` (explicit, no fallback) → `tsconfig.build.json` →
 * `tsconfig.json`. Returns `null` when none applies.
 */
function resolveRefTsconfig(dir: string, byPath: Map<string, AnyServiceConfig>): string | null {
  const custom = byPath.get(dir)?.tsconfig;
  const candidates = custom
    ? [path.join(dir, custom)]
    : [path.join(dir, 'tsconfig.build.json'), path.join(dir, 'tsconfig.json')];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/** A tsconfig's `references`, or none when the file can't be read or declares none. */
function readTsconfigReferences(
  jsonc: typeof import('jsonc-parser'),
  cfgPath: string,
): { path: string }[] {
  let text: string;
  try {
    text = fs.readFileSync(cfgPath, 'utf8');
  } catch {
    return [];
  }
  // Tolerant, as TypeScript's own reader is: comments, trailing commas, a leading BOM.
  const config = jsonc.parse(text.replace(/^\uFEFF/, ''), [], { allowTrailingComma: true }) as
    | { references?: unknown }
    | undefined;
  return Array.isArray(config?.references) ? (config.references as { path: string }[]) : [];
}

export function getTsconfigBuildPackages(pkg: AnyServiceConfig): AnyServiceConfig[] {
  // Resolve TS project references transitively, reading each package's tsconfig per
  // `resolveRefTsconfig`'s precedence (tsconfig → tsconfig.build.json → tsconfig.json). They
  // count only in a project that has the TS peer dep — which is looked up, never loaded: the
  // references are all that's read, so a tsconfig is parsed as the JSON-with-comments it is.
  try {
    require.resolve('typescript');
  } catch {
    return [];
  }
  const jsonc = require('jsonc-parser') as typeof import('jsonc-parser');
  const registered = getRegisteredPackages();
  const byPath = new Map(registered.map((a) => [path.resolve(a.absoluteDir), a]));
  const seen = new Set<string>();
  const result: AnyServiceConfig[] = [];
  const visit = (dir: string) => {
    const resolvedDir = path.resolve(dir);
    if (seen.has(resolvedDir)) {
      return;
    }
    seen.add(resolvedDir);
    const cfgPath = resolveRefTsconfig(resolvedDir, byPath);
    if (!cfgPath) {
      return;
    }
    const refs = readTsconfigReferences(jsonc, cfgPath);
    for (const ref of refs) {
      const refDir = path.resolve(resolvedDir, ref.path.replace(/tsconfig.*\.json$/, ''));
      const match = byPath.get(refDir);
      if (match && !result.includes(match)) {
        result.push(match);
      }
      visit(refDir);
    }
  };
  visit(pkg.absoluteDir);
  return result;
}

export interface ResolveResult {
  allPackages: AnyServiceConfig[];
  buildSet: Set<string>;
  runSet: Set<string>;
  reasons: Record<string, string>;
}

export function resolveDeps(
  selectedPackages: AnyServiceConfig[],
  depTypes: DepType[] = ALL_DEP_TYPES,
): ResolveResult {
  const runSet = new Set<string>();
  const reasons: Record<string, string> = {};
  for (const pkg of selectedPackages) {
    runSet.add(pkg.name);
    reasons[pkg.name] = 'selected';
    if (depTypes.includes(DepType.RUNTIME)) {
      for (const dep of pkg.deps?.runtime ?? []) {
        if (!runSet.has(dep)) {
          reasons[dep] = `runtime dep of ${pkg.name}`;
        }
        runSet.add(dep);
      }
    }
  }

  const buildSet = new Set<string>();
  const queue = [...runSet];
  while (queue.length) {
    const name = queue.shift()!;
    const pkg = lookup(name);
    if (!pkg) {
      continue;
    }
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
  const allPackages = [...allNames].map(lookup).filter((a): a is AnyServiceConfig => Boolean(a));
  return { allPackages, buildSet, runSet, reasons };
}

const selectionFile = () => path.join(getStateDir(), 'selection.json');

/**
 * Keeps only the names that are packages of the loaded config. A saved selection outlives
 * package renames, and a stale name must never reach the picker or `findService` (which throws
 * — inside a React render, that took the whole TUI down), nor be written back to recur on every
 * run. With no config loaded there is nothing to check against, so the names pass through.
 */
function onlyCurrentPackages(names: string[]): string[] {
  if (!getLoadedConfig()) {
    return names;
  }
  const known = new Set(getRegisteredPackages().map((p) => p.name));
  return names.filter((name) => known.has(name));
}

/** Persists the selection for `--last-answers`; a name that isn't a current package is dropped. */
export function saveSelection(names: string[]): void {
  fs.writeFileSync(selectionFile(), JSON.stringify(onlyCurrentPackages(names)));
}

/**
 * The saved selection split into the names that are still packages of the loaded config and
 * the ones that aren't (a package key was renamed or removed since); `null` when nothing was
 * ever saved. The pruned list is written back, so a stale name is gone after the first run that
 * reads it — but the caller still learns it was there, since a stale name is what sends the TUI
 * back to the picker instead of replaying the selection.
 */
export function readSelection(): { names: string[]; stale: string[] } | null {
  let saved: string[];
  try {
    saved = JSON.parse(fs.readFileSync(selectionFile(), 'utf8')) as string[];
  } catch {
    return null;
  }
  const names = onlyCurrentPackages(saved);
  const stale = saved.filter((name) => !names.includes(name));
  if (stale.length) {
    try {
      fs.writeFileSync(selectionFile(), JSON.stringify(names));
    } catch {
      // best-effort: the pruned list is still what the caller gets
    }
  }
  return { names, stale };
}

/** The saved selection's current package names (see {@link readSelection}), or `null`. */
export function loadSelection(): string[] | null {
  return readSelection()?.names ?? null;
}

/** Where the interactive session starts, from the CLI flags and the saved selection. */
export type InitialPhase =
  | { type: 'package-select'; initialSelected: string[] }
  | { type: 'building'; selectedNames: string[] };

/**
 * Picks where the TUI's phase machine starts: an explicit `--service` list goes straight to the
 * build; so does `--last-answers` with a saved selection whose every name is still a package.
 * A saved selection naming a package that no longer exists shows the picker instead, with the
 * names that survived preselected — renamed package keys must never stop devtooie from running.
 */
export function initialPhaseFor(opts: { packages: string[]; lastAnswers: boolean }): InitialPhase {
  if (opts.packages.length > 0) {
    return { type: 'building', selectedNames: opts.packages };
  }
  const saved = readSelection();
  if (opts.lastAnswers && saved && saved.names.length > 0 && saved.stale.length === 0) {
    return { type: 'building', selectedNames: saved.names };
  }
  return { type: 'package-select', initialSelected: saved?.names ?? [] };
}

/**
 * The package names for a non-interactive phase (build/plain), which — unlike the UI — has no
 * selector to fall back on: an explicit `--service` wins, then a saved `--last-answers`
 * selection, otherwise an error naming `usage`. Unknown `--service` names are the caller's to
 * validate.
 */
export function resolveSelectedNames(
  opts: { service: string[]; lastAnswers: boolean },
  usage: string,
): { names: string[] } | { error: string } {
  if (opts.service.length > 0) {
    return { names: opts.service };
  }
  if (opts.lastAnswers) {
    const saved = readSelection();
    // No picker to fall back on here, so a selection with stale names is refused outright
    // rather than run on whatever survived.
    if (saved?.stale.length) {
      return {
        error:
          `The saved selection names services that no longer exist (${saved.stale.join(', ')}) — ` +
          'run once without --last-answers to pick again.',
      };
    }
    return !saved || saved.names.length === 0
      ? { error: 'No saved selection found — run once without --last-answers first.' }
      : { names: saved.names };
  }
  return { error: `${usage} requires --service or --last-answers.` };
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
  // When recording a demo/screenshot (DEVTOOIE_DEMO_RECORDING set), force the branch to read
  // `main` regardless of the real checked-out one. The branch-change watcher then sees only
  // `main`, so it won't trip.
  if (process.env.DEVTOOIE_DEMO_RECORDING) {
    return 'main';
  }
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

const byName = (a: AnyServiceConfig, b: AnyServiceConfig) => a.name.localeCompare(b.name);

type DepKind = 'build' | 'dev' | 'runtime';

/**
 * A package's direct deps for one kind; `build` folds in `tsconfig.build.json` project refs.
 * Always returns a fresh array — callers ({@link closureSize}) drain it in place, so it must
 * never hand back the package's own `run.deps` array.
 */
function directDeps(pkg: AnyServiceConfig, kind: DepKind): string[] {
  if (kind === 'build') {
    return [...getTsconfigBuildPackages(pkg).map((a) => a.name), ...(pkg.deps?.build ?? [])];
  }
  return [...(pkg.deps?.[kind] ?? [])];
}

/** Size of the transitive closure reachable from `pkg` following only `kind` edges. */
function closureSize(pkg: AnyServiceConfig, kind: DepKind): number {
  const seen = new Set<string>();
  const queue = directDeps(pkg, kind);
  while (queue.length) {
    const name = queue.shift()!;
    if (name === pkg.name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const dep = lookup(name);
    if (dep) {
      queue.push(...directDeps(dep, kind));
    }
  }
  return seen.size;
}

/**
 * A package's "weight": how many packages it pulls in across build, dev and runtime edges,
 * counted per edge type so a package reached via two kinds (e.g. build *and* runtime) counts
 * once per kind. Intrinsic to the dependency graph — independent of the current selection.
 */
export function depScore(pkg: AnyServiceConfig): number {
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
export function packagePoints(pkg: AnyServiceConfig, selectedSet?: Set<string>): number {
  return depScore(pkg) + (selectedSet?.has(pkg.name) ? 1 : 0);
}

/**
 * The one display order: most points first (`packagePoints` — dependency weight plus a point
 * for being selected), ties broken by name. Drives both the running process list and the
 * per-package URL column in the footer, and the interactive selector's list.
 */
export function sortPackages(
  packages: AnyServiceConfig[],
  selectedSet?: Set<string>,
): AnyServiceConfig[] {
  const score = new Map(packages.map((a) => [a.name, packagePoints(a, selectedSet)] as const));
  return [...packages].sort((a, b) => score.get(b.name)! - score.get(a.name)! || byName(a, b));
}

/** Selectable, dev-scripted packages for the interactive selector, in display order. */
export function getSelectablePackages(): AnyServiceConfig[] {
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
  selectedPackages: AnyServiceConfig[],
  deps: ResolveResult,
): RunnerArgs {
  const selectedSet = new Set(selectedPackages.map((a) => a.name));
  const sortedPackages = sortPackages(deps.allPackages, selectedSet);
  const rebuildableSet = new Set(deps.allPackages.filter(canRebuild).map((a) => a.name));
  const waitForMap: Record<string, string[]> = {};
  const healthchecks: Record<string, ResolvedHealthcheck> = {};
  const extraCommandsMap: Record<string, string[]> = {};
  for (const a of deps.allPackages) {
    if (a.waitFor?.length) {
      waitForMap[a.name] = a.waitFor;
    }
    if (a.healthcheck) {
      healthchecks[a.name] = a.healthcheck;
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
    healthchecks,
    extraCommandsMap,
    topLevelUrls: config?.urls?.map(normalizeUrlEntry),
    envFiles: config?.envFiles ?? envFileNames(),
    envOverride: config?.envOverride,
    envVars: config?.envVars,
    logTimestamps: config?.logTimestamps ?? true,
    cwd: process.cwd(),
  };
}
