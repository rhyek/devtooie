import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { execa, type ResultPromise } from 'execa';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import type { AnyPackageConfig } from './config.js';
import { getDevScript, getLoadedConfig } from './config.js';
import { defaultFormatter } from './log-formatter.js';
import type { ControlManager } from './command-server.js';
import { debugLog } from './debug-log.js';
import { DEFAULT_ENV_FILES, packageEnvLayer } from './env.js';
import { watchEnvFiles, type WatchTarget } from './env-watch.js';
import {
  getDefaultLogFile,
  getExecArgs,
  getRebuildCommands,
  hasDevScript,
  logTimestamp,
  stripAnsi,
} from './lib.js';
import type { RunnerArgs } from './runners/types.js';
import { stripTitleSequences } from './terminal-title.js';

type ProcessState = 'running' | 'stopped' | 'waiting';
type Status = ProcessState | 'rebuilding' | 'restarting';

interface ManagedProcess {
  pkg: AnyPackageConfig;
  proc: ResultPromise | null;
  status: ProcessState;
  /** Colored `"[name] "` prefix rendered before every line for this package. */
  prefix: string;
  /** Lowercase `"name shortname"` string used for filter matching. */
  searchName: string;
  /** Whether this pkg has a `dev` script/target and can be started. */
  canDev: boolean;
  /** One-off commands (via `runCommand`/`runCustomCommand`) spawned for this pkg, tracked for cleanup. */
  extraProcs: Set<ResultPromise>;
}

interface BufferedLine {
  prefix: string;
  text: string;
  /** `YYYY-MM-DD HH:MM:SS` stamp captured when the line was logged (shown when timestamps are on). */
  ts: string;
  /** Whether this line's package (or the top-level default) shows the timestamp on screen. */
  showTs: boolean;
  searchName: string;
  isError: boolean;
  /** Lines sharing a groupId are shown together when any one of them matches the active filter. */
  groupId: number;
  /** Whether this line has already been written to the terminal (plain mode). */
  rendered: boolean;
  /** Memoized rendered-row count for the fullscreen viewport, and the width it was computed at. */
  rowCount?: number;
  rowCountWidth?: number;
}

/**
 * A line is a continuation of the previous log entry (e.g. an indented
 * property of a pretty-printed structured log) if, once ANSI codes are
 * stripped from its start, it begins with whitespace.
 */
function isContinuationLine(text: string): boolean {
  // eslint-disable-next-line no-control-regex -- strips leading ANSI SGR sequences before inspecting the first character
  const stripped = text.replace(/^(\x1b\[[0-9;]*m)*/, '');
  return stripped.length > 0 && (stripped.startsWith(' ') || stripped.startsWith('\t'));
}

/**
 * Normalize text for filter matching: lowercase and strip diacritics (NFD decomposition
 * drops combining accent marks). Applied to both the log haystack and the typed terms, so
 * matching is case- and accent-insensitive — a typed `gonzalez` finds a logged `González`.
 */
function normalizeForFilter(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

// Package-identity colors for log prefixes: a vivid, full-spectrum palette ordered so adjacent
// packages land far apart on the color wheel. These are bright truecolor shades — distinct from
// the dull basic-ANSI colors the status text/dots use (green/cyan/yellow/red) — and skip
// pink/pastels.
const PALETTE = [
  chalk.hex('#4C9AFF'), // blue
  chalk.hex('#FF9636'), // orange
  chalk.hex('#3FCF7F'), // emerald
  chalk.hex('#A56EFF'), // purple
  chalk.hex('#FFC53D'), // gold
  chalk.hex('#22C3C3'), // teal
  chalk.hex('#FF6B57'), // coral
  chalk.hex('#6C79FF'), // indigo
  chalk.hex('#A8D93C'), // lime
  chalk.hex('#C77DFF'), // violet
];

// The chalk foreground color names accepted by `run.color` (a subset guard, so a stray
// `run.color: 'bold'`/`'constructor'` can't reach into non-color chalk members).
const NAMED_COLORS = new Set([
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray', 'grey',
  'blackBright', 'redBright', 'greenBright', 'yellowBright', 'blueBright', 'magentaBright',
  'cyanBright', 'whiteBright',
]); // prettier-ignore

/**
 * Resolve a `run.color` spec — hex (`#af87ff`), `rgb(r,g,b)`, `ansi256(n)`, or a chalk/Ink color
 * name (`magenta`, `blueBright`) — to a chalk formatter. Unrecognized specs fall back to no color
 * rather than throwing, so a typo degrades gracefully.
 */
export function resolveColorSpec(spec: string): (s: string) => string {
  const s = spec.trim();
  if (/^#?[0-9a-f]{6}$/i.test(s) || /^#?[0-9a-f]{3}$/i.test(s)) {
    return chalk.hex(s.startsWith('#') ? s : `#${s}`);
  }
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(s);
  if (rgb) return chalk.rgb(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  const ansi = /^ansi256\(\s*(\d{1,3})\s*\)$/i.exec(s);
  if (ansi) return chalk.ansi256(Number(ansi[1]));
  if (NAMED_COLORS.has(s)) return chalk[s as keyof typeof chalk] as (t: string) => string;
  return (t: string) => t;
}

/**
 * The color function for a package's log prefix: its `run.color` override when set, else the
 * palette slot for its position `index` in the run.
 */
export function packagePrefixColor(pkg: AnyPackageConfig, index: number): (s: string) => string {
  return pkg.color ? resolveColorSpec(pkg.color) : PALETTE[index % PALETTE.length]!;
}

const MAX_BUFFER_LINES = 50_000;
/** Rendered width of a displayed timestamp gutter: `"YYYY-MM-DD HH:MM:SS "` (19 chars + a space). */
const TIMESTAMP_GUTTER_WIDTH = 20;
const SHUTDOWN_GRACE_MS = 3000;
const WAIT_FOR_POLL_MS = 2000;

/**
 * Owns the lifecycle of every package's dev process: spawning, streaming and
 * filtering their output, tracking status, and tearing everything down
 * cleanly on exit. Framework-agnostic — the interactive (Ink) and plain
 * runners both drive it the same way.
 */
export class ProcessManager implements ControlManager {
  private static instances = new Set<ProcessManager>();

  private processes = new Map<string, ManagedProcess>();
  /** Rendered width of `"[name] "`, used to align wrapped continuation lines. */
  private prefixWidth: number;
  /** Default on-screen timestamp visibility (top-level `logs.timestamps`); a package can override. */
  private defaultShowTimestamps: boolean;
  /** Per-package resolved on-screen timestamp visibility, keyed by the line's `searchName`. */
  private showTsBySearchName = new Map<string, boolean>();
  private filterTerms: string[] = [];
  private buffer: BufferedLine[] = [];
  private rebuildableSet: Set<string>;
  /** App name -> names of packages whose healthchecks must pass before it starts. */
  private waitForMap: Record<string, string[]>;
  /** App name -> its resolved healthcheck URL. */
  private healthcheckUrls: Record<string, string>;
  private waitingPollTimer: ReturnType<typeof setInterval> | null = null;
  private waitingPollInFlight = false;
  /** Names mid restart/rebuild, reported as a transitional status. */
  private transitions = new Map<string, 'rebuilding' | 'restarting'>();
  /** Count of currently-visible (filter-matching) rows, used to decide when to clear scrollback. */
  private visibleLineCount = 0;
  /** Rows reserved for a host UI's footer, kept out of the clearable region. */
  private footerHeight = 3;
  /** Skip terminal clearing/scrollback tricks when there's no interactive UI on top. */
  private plain: boolean;
  private systemPrefix: string;
  /** Colored `"[dt:control] "` prefix for control-API command notices. */
  private controlPrefix: string;
  private nextGroupId = 0;
  private lastGroupId = new Map<string, number>();
  private logFd: number;
  private logFilePath: string;
  /** `.env` filenames resolved (per package) and injected into each spawned child. */
  private envFiles: string[];
  /** Workspace root that package `relativeDir`s resolve against for `.env` loading. */
  private cwd: string;
  /** Tears down the `.env` file watchers; null until `startAll` wires them up. */
  private envWatchDispose: (() => void) | null = null;
  /** Bound `process.on('exit')` handler, kept so `dispose()` can remove it. */
  private exitHandler: () => void;
  private disposed = false;
  /** Fullscreen (Ink) subscribers, notified when the buffer changes. */
  private listeners = new Set<() => void>();
  /** Monotonic buffer version, used as the useSyncExternalStore snapshot. */
  private version = 0;
  private notifyScheduled = false;
  /** Memoized group-aware filter result, keyed by {@link version}. */
  private visibleCache: { version: number; lines: readonly BufferedLine[] } | null = null;

  constructor(
    {
      sortedPackages,
      rebuildableSet,
      waitForMap,
      healthcheckUrls,
      logFile,
      envFiles,
      cwd,
      logTimestamps = false,
    }: RunnerArgs,
    { plain = false }: { plain?: boolean } = {},
  ) {
    this.plain = plain;
    this.defaultShowTimestamps = logTimestamps;
    this.rebuildableSet = rebuildableSet;
    this.waitForMap = waitForMap;
    this.healthcheckUrls = healthcheckUrls;
    this.envFiles = envFiles ?? DEFAULT_ENV_FILES;
    this.cwd = cwd ?? process.cwd();

    const displayName = (a: AnyPackageConfig) => a.shortName ?? a.name;
    const maxNameLen = sortedPackages.reduce((m, a) => Math.max(m, displayName(a).length), 0);
    this.prefixWidth = maxNameLen + 3; // "[" + padded name + "]" + " "

    for (let i = 0; i < sortedPackages.length; i++) {
      const pkg = sortedPackages[i]!;
      const color = packagePrefixColor(pkg, i);
      const label = displayName(pkg);
      const padded = label + ' '.repeat(maxNameLen - label.length);
      const shortName = pkg.shortName;
      const searchName = (shortName ? `${pkg.name} ${shortName}` : pkg.name).toLowerCase();
      // Effective on-screen timestamp visibility: the package's own `logs.timestamps` if set,
      // else the top-level default. Keyed by searchName so every line for this package (output,
      // status, and control lines) renders the same.
      this.showTsBySearchName.set(searchName, pkg.logs?.timestamps ?? this.defaultShowTimestamps);
      this.processes.set(pkg.name, {
        pkg,
        proc: null,
        status: 'stopped',
        prefix: color(`[${padded}]`) + ' ',
        searchName,
        canDev: hasDevScript(pkg),
        extraProcs: new Set(),
      });
    }

    this.systemPrefix = chalk.dim(`[${' '.repeat(maxNameLen)}]`) + ' ';
    // Pad the label to the widest service name so the closing bracket lines up
    // with every package prefix (e.g. `[dt:control     ]` beside `[whatsapp-bridge]`).
    this.controlPrefix = chalk.dim(`[${'dt:control'.padEnd(maxNameLen)}]`) + ' ';

    ProcessManager.instances.add(this);
    this.exitHandler = () => {
      this.killAll();
    };
    process.on('exit', this.exitHandler);

    this.logFilePath = logFile ?? getDefaultLogFile();
    this.logFd = fs.openSync(this.logFilePath, 'w');
  }

  // ---------------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------------

  startAll(): void {
    debugLog(`startAll: starting ${this.processes.size} processes`);
    for (const [name, managed] of this.processes) {
      if (managed.pkg.autostart === false) {
        // Opted out of auto-start: leave it stopped (not waiting) for a manual start via the
        // `s` hotkey or a control-API `restart`.
        continue;
      }
      const waitFor = this.waitForMap[name];
      if (waitFor && waitFor.length > 0 && managed.canDev) {
        managed.status = 'waiting';
        this.addLine(
          managed.prefix,
          chalk.cyan(`waiting for ${waitFor.join(', ')}...`),
          managed.searchName,
          false,
        );
      } else {
        this.start(name);
      }
    }
    if ([...this.processes.values()].some((m) => m.status === 'waiting')) {
      this.startWaitingPoll();
    }
    this.startEnvWatchers();
    debugLog(`startAll: done, buffer.length=${this.buffer.length}`);
  }

  private startWaitingPoll(): void {
    this.waitingPollTimer = setInterval(() => {
      if (this.waitingPollInFlight) {
        return;
      }
      this.waitingPollInFlight = true;
      void this.pollWaitingPackages().finally(() => {
        this.waitingPollInFlight = false;
      });
    }, WAIT_FOR_POLL_MS);
  }

  private async pollWaitingPackages(): Promise<void> {
    for (const [name, managed] of this.processes) {
      if (managed.status !== 'waiting') {
        continue;
      }
      const waitFor = this.waitForMap[name];
      if (!waitFor) {
        continue;
      }

      const results = await Promise.all(
        waitFor.map(async (depName) => {
          const url = this.healthcheckUrls[depName];
          if (!url) {
            return true; // no healthcheck configured for this dep = assume ready
          }
          try {
            const res = await fetch(url);
            return res.ok;
          } catch {
            return false;
          }
        }),
      );

      if (results.every(Boolean)) {
        this.addLine(
          managed.prefix,
          chalk.green(`${waitFor.join(', ')} ready, starting...`),
          managed.searchName,
          false,
        );
        this.start(name);
      }
    }

    const stillWaiting = [...this.processes.values()].some((m) => m.status === 'waiting');
    if (!stillWaiting && this.waitingPollTimer) {
      clearInterval(this.waitingPollTimer);
      this.waitingPollTimer = null;
    }
  }

  start(name: string): void {
    const managed = this.processes.get(name);
    if (!managed || managed.status === 'running' || !managed.canDev) {
      return;
    }

    const pfx = managed.prefix;
    const [cmd, args] = getExecArgs(managed.pkg, getDevScript(managed.pkg));
    const proc = execa(cmd, args, {
      cwd: managed.pkg.path,
      env: this.packageEnv(managed.pkg),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      reject: false,
      buffer: false,
      detached: true,
    });

    managed.proc = proc;
    managed.status = 'running';

    const { searchName } = managed;

    if (proc.stdout) {
      proc.stdout.on('data', (data: Buffer) => {
        for (const line of stripTitleSequences(data.toString()).split('\n')) {
          if (line) {
            this.addOutput(managed, line, false);
          }
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        for (const line of stripTitleSequences(data.toString()).split('\n')) {
          if (line) {
            this.addOutput(managed, line, true);
          }
        }
      });
    }

    void proc.then((result) => {
      const m = this.processes.get(name);
      if (m?.proc === proc) {
        m.status = 'stopped';
        m.proc = null;
        this.addLine(pfx, `exited with code ${String(result.exitCode)}`, searchName, false);
      }
    });

    this.addLine(pfx, chalk.green('started'), searchName, false);
  }

  /**
   * Environment for a package's child processes: the current `process.env`, then the
   * package's configured `run.port` as `PORT`, then its resolved `.env` files (later files /
   * package scope win). So `PORT` defaults to the config port but an explicit `.env` `PORT`
   * still wins. Re-resolved on every spawn so a restart picks up edited `.env` values. Never
   * mutates `process.env`.
   */
  private packageEnv(pkg: AnyPackageConfig): NodeJS.ProcessEnv {
    return Object.assign(
      {},
      process.env,
      packageEnvLayer(pkg, { cwd: this.cwd, files: this.envFiles }),
    );
  }

  /**
   * Watches every package's `.env` candidate files (workspace-shared and package-local)
   * and restarts affected running packages when one changes or appears. Idempotent.
   */
  private startEnvWatchers(): void {
    if (this.envWatchDispose) return;
    const workspaceDir = path.resolve(this.cwd);
    const targets: WatchTarget[] = [
      // Workspace-scope files are shared: a change restarts every running package.
      {
        dir: workspaceDir,
        filenames: this.envFiles,
        onChange: () => {
          for (const name of this.processes.keys()) this.restartForEnvChange(name);
        },
      },
    ];
    // Package-scope files restart only their own package.
    for (const [name, managed] of this.processes) {
      const pkgDir = path.resolve(this.cwd, managed.pkg.relativeDir);
      if (pkgDir === workspaceDir) continue; // already covered by the workspace watcher
      targets.push({
        dir: pkgDir,
        filenames: this.envFiles,
        onChange: () => this.restartForEnvChange(name),
      });
    }
    this.envWatchDispose = watchEnvFiles({ targets });
  }

  /** Restart a package in response to an `.env` change, but only if it's currently running. */
  private restartForEnvChange(name: string): void {
    if (this.getStatus(name) !== 'running') return;
    const managed = this.processes.get(name);
    if (managed) {
      this.addLine(
        managed.prefix,
        chalk.cyan('.env changed, restarting...'),
        managed.searchName,
        false,
      );
    }
    this.restart(name);
  }

  // ---------------------------------------------------------------------------
  // Stop / restart / rebuild
  // ---------------------------------------------------------------------------

  async stop(name: string): Promise<void> {
    const managed = this.processes.get(name);
    if (!managed?.proc) {
      return;
    }
    const proc = managed.proc;
    managed.proc = null;
    managed.status = 'stopped';
    this.addLine(managed.prefix, chalk.yellow('stopping...'), managed.searchName, false);
    this.killTree(proc);

    const forceKill = setTimeout(() => {
      try {
        if (proc.pid) {
          process.kill(-proc.pid, 'SIGKILL');
        }
      } catch {
        /* already gone */
      }
    }, SHUTDOWN_GRACE_MS);

    await proc;
    clearTimeout(forceKill);
    this.addLine(managed.prefix, chalk.red('stopped'), managed.searchName, false);
  }

  /** ControlManager + hotkey entry point: restarts a package. `false` if unknown. */
  restart(name: string): boolean {
    if (this.transitions.has(name)) {
      // Already mid restart/rebuild — accept without starting a second transition.
      return true;
    }
    const managed = this.processes.get(name);
    if (!managed) {
      return false;
    }
    void this.performRestart(name, managed);
    return true;
  }

  private async performRestart(name: string, managed: ManagedProcess): Promise<void> {
    this.transitions.set(name, 'restarting');
    try {
      await this.stop(name);
      this.start(name);
      this.addLine(managed.prefix, chalk.green('restarted'), managed.searchName, false);
    } finally {
      this.transitions.delete(name);
    }
  }

  /**
   * ControlManager + hotkey entry point: stop -> clean rebuild -> start, where the clean
   * rebuild is `build:clean` (or `clean` then `build` when there's no combined script).
   * `false` if unknown, or if the package isn't rebuildable. A failing build leaves the
   * package stopped (no restart).
   */
  rebuild(name: string): boolean {
    if (this.transitions.has(name)) {
      // Already mid restart/rebuild — accept without starting a second transition.
      return true;
    }
    const managed = this.processes.get(name);
    if (!managed || !this.rebuildableSet.has(name)) {
      return false;
    }
    void this.performRebuild(name, managed);
    return true;
  }

  private async performRebuild(name: string, managed: ManagedProcess): Promise<void> {
    this.transitions.set(name, 'rebuilding');
    try {
      await this.stop(name);
      this.addLine(managed.prefix, chalk.yellow('rebuilding...'), managed.searchName, false);
      // A clean rebuild is `build:clean`, or `clean` then `build` sequentially when the
      // package has no combined script/target — resolved identically for pnpm and make.
      for (const [cmd, args] of getRebuildCommands(managed.pkg)) {
        const buildProc = execa(cmd, args, {
          cwd: managed.pkg.path,
          env: this.packageEnv(managed.pkg),
          stdin: 'ignore',
          reject: false,
          detached: true,
        });
        // Tracked in extraProcs for the duration of the build so killAll /
        // shutdownAll / forceKillAll can reach (and kill the group of) this
        // child even though it isn't the package's own long-running `proc`.
        managed.extraProcs.add(buildProc);
        let result;
        try {
          result = await buildProc;
        } finally {
          managed.extraProcs.delete(buildProc);
        }
        if (result.exitCode !== 0) {
          this.addLine(
            managed.prefix,
            chalk.red(`rebuild failed (exit ${String(result.exitCode)})`),
            managed.searchName,
            true,
          );
          if (result.stderr) {
            for (const line of result.stderr.split('\n')) {
              if (line) {
                this.addLine(managed.prefix, chalk.red(line), managed.searchName, true);
              }
            }
          }
          return;
        }
      }
      this.addLine(managed.prefix, chalk.green('rebuild complete'), managed.searchName, false);
      this.start(name);
    } finally {
      this.transitions.delete(name);
    }
  }

  // ---------------------------------------------------------------------------
  // One-off commands
  // ---------------------------------------------------------------------------

  /** Run a named script/target for a package as a tracked one-off child process. */
  runCommand(name: string, scriptName: string): void {
    const managed = this.processes.get(name);
    if (!managed) {
      return;
    }
    const [cmd, args] = getExecArgs(managed.pkg, scriptName);
    this.spawnExtra(managed, cmd, args, scriptName, false);
  }

  /** Run an arbitrary shell command string for a package (pipes/redirects allowed). */
  runCustomCommand(name: string, commandString: string): void {
    const managed = this.processes.get(name);
    if (!managed) {
      return;
    }
    this.spawnExtra(managed, commandString, [], commandString, true);
  }

  /**
   * Shared spawning path for one-off "extra" commands used by both
   * `runCommand` and `runCustomCommand`. Output interleaves with the
   * package's regular logs (same prefix/searchName/filtering); demarcated
   * with `▶ running:` / `✔ finished` / `✘ exited` lines. Tracked in
   * `extraProcs` so shutdown can clean it up. Only custom commands run
   * through a shell — named scripts avoid it to sidestep the extra process
   * (and potential EMFILE pressure) a shell wrapper adds.
   */
  private spawnExtra(
    managed: ManagedProcess,
    cmd: string,
    args: string[],
    displayLabel: string,
    useShell: boolean,
  ): void {
    const pfx = managed.prefix;
    const { searchName } = managed;

    this.addLine(pfx, chalk.cyan(`▶ running: ${displayLabel}`), searchName, false);

    const proc = execa(cmd, args, {
      cwd: managed.pkg.path,
      env: this.packageEnv(managed.pkg),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      reject: false,
      buffer: false,
      detached: true,
      shell: useShell,
    });

    managed.extraProcs.add(proc);

    if (proc.stdout) {
      proc.stdout.on('data', (data: Buffer) => {
        for (const line of stripTitleSequences(data.toString()).split('\n')) {
          if (line) {
            this.addOutput(managed, line, false);
          }
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        for (const line of stripTitleSequences(data.toString()).split('\n')) {
          if (line) {
            this.addOutput(managed, line, true);
          }
        }
      });
    }

    void proc.then((result) => {
      managed.extraProcs.delete(proc);
      const ok = result.exitCode === 0;
      this.addLine(
        pfx,
        ok
          ? chalk.green(`✔ ${displayLabel} finished`)
          : chalk.red(`✘ ${displayLabel} exited with code ${String(result.exitCode)}`),
        searchName,
        !ok,
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  /** ControlManager entry point: graceful shutdown (equivalent to a first Ctrl+C). */
  quit(): void {
    void this.shutdownAll();
  }

  /** Immediate, synchronous SIGKILL of every tracked process group. No waiting. */
  killAll(): void {
    if (this.waitingPollTimer) {
      clearInterval(this.waitingPollTimer);
      this.waitingPollTimer = null;
    }
    for (const [, managed] of this.processes) {
      if (managed.proc) {
        this.killTree(managed.proc, 'SIGKILL');
      }
      for (const extra of managed.extraProcs) {
        this.killTree(extra, 'SIGKILL');
      }
    }
  }

  /** Graceful shutdown: SIGTERM everything, wait up to 3s, then SIGKILL stragglers. */
  async shutdownAll(): Promise<void> {
    if (this.waitingPollTimer) {
      clearInterval(this.waitingPollTimer);
      this.waitingPollTimer = null;
    }

    // Detach living processes from managed state up front so each process's
    // own `.then()` handler (still pending) doesn't log a spurious "exited"
    // line once we've already reported the shutdown here.
    const living: { proc: ResultPromise }[] = [];
    for (const [, m] of this.processes) {
      if (m.proc !== null) {
        living.push({ proc: m.proc });
        m.proc = null;
      }
      for (const extra of m.extraProcs) {
        living.push({ proc: extra });
      }
      m.extraProcs.clear();
      m.status = 'stopped';
    }

    if (living.length === 0) {
      return;
    }

    this.addLine(this.systemPrefix, chalk.yellow('shutting down...'), 'system', false);

    for (const { proc } of living) {
      this.killTree(proc);
    }

    await Promise.allSettled(
      living.map(({ proc }) =>
        Promise.race([
          proc,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), SHUTDOWN_GRACE_MS),
          ),
        ]),
      ),
    );

    // A direct child (e.g. the package manager) may exit quickly while its
    // own children linger in the same detached group — SIGKILL the whole
    // group to be sure.
    for (const { proc } of living) {
      try {
        if (proc.pid) {
          process.kill(-proc.pid, 'SIGKILL');
        }
      } catch {
        /* already gone */
      }
    }
  }

  /** Immediate SIGKILL of every process group, no waiting (second Ctrl+C / hard exit). */
  forceKillAll(): void {
    for (const [, managed] of this.processes) {
      if (managed.proc?.pid) {
        try {
          process.kill(-managed.proc.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      for (const extra of managed.extraProcs) {
        if (extra.pid) {
          try {
            process.kill(-extra.pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }
    }
  }

  /** SIGKILL every process group across every live `ProcessManager` instance. */
  static forceKillAllInstances(): void {
    for (const instance of ProcessManager.instances) {
      instance.forceKillAll();
    }
  }

  /**
   * Releases everything this instance holds outside its own object graph:
   * the `process.on('exit')` listener, its entry in the shared instance
   * registry, and the open logfile descriptor. Safe to call more than once.
   * Does not touch any running child processes — call `killAll()` /
   * `shutdownAll()` first if that's also needed.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.envWatchDispose) {
      this.envWatchDispose();
      this.envWatchDispose = null;
    }
    process.off('exit', this.exitHandler);
    ProcessManager.instances.delete(this);
    try {
      fs.closeSync(this.logFd);
    } catch {
      /* already closed */
    }
  }

  private killTree(proc: ResultPromise, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (proc.pid) {
      try {
        process.kill(-proc.pid, signal);
      } catch {
        proc.kill(signal);
      }
    } else {
      proc.kill(signal);
    }
  }

  // ---------------------------------------------------------------------------
  // Status queries
  // ---------------------------------------------------------------------------

  getRunning(): string[] {
    return [...this.processes.entries()]
      .filter(([n, m]) => this.effectiveStatus(n, m) === 'running')
      .map(([n]) => n)
      .sort();
  }

  getStopped(): string[] {
    return [...this.processes.entries()]
      .filter(([n, m]) => this.effectiveStatus(n, m) === 'stopped')
      .map(([n]) => n)
      .sort();
  }

  getWaiting(): string[] {
    return [...this.processes.entries()]
      .filter(([n, m]) => this.effectiveStatus(n, m) === 'waiting')
      .map(([n]) => n)
      .sort();
  }

  getRebuildable(): string[] {
    return [...this.processes.entries()]
      .filter(([n, m]) => m.status === 'running' && this.rebuildableSet.has(n))
      .map(([n]) => n)
      .sort();
  }

  /**
   * Status for a single package. `null` means it isn't part of this session
   * at all; otherwise its process state, or a transitional
   * `rebuilding`/`restarting` while one of those is in flight.
   */
  getStatus(name: string): Status | null {
    const managed = this.processes.get(name);
    if (!managed) {
      return null;
    }
    return this.effectiveStatus(name, managed);
  }

  /** `managed.status`, overlaid with a transitional `rebuilding`/`restarting` if one is in flight. */
  private effectiveStatus(name: string, managed: ManagedProcess): Status {
    return this.transitions.get(name) ?? managed.status;
  }

  getAllStatuses(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of this.processes.keys()) {
      out[name] = this.getStatus(name) ?? 'stopped';
    }
    return out;
  }

  /** ControlManager entry point: the whole resolved config (defaults applied) served by `/query/config`. */
  getConfig(): unknown {
    return getLoadedConfig();
  }

  /** ControlManager entry point: package list, optionally filtered by exact status. */
  getPackages(filter?: string): { name: string; shortName?: string; status: string }[] {
    const out: { name: string; shortName?: string; status: string }[] = [];
    for (const [name, managed] of this.processes) {
      const status = this.getStatus(name) ?? 'stopped';
      if (filter && status !== filter) {
        continue;
      }
      out.push({ name, shortName: managed.pkg.shortName, status });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------------------------------------------------------------------------
  // Output buffering & filtering
  // ---------------------------------------------------------------------------

  setFilter(terms: string[]): void {
    this.filterTerms = terms.map(normalizeForFilter);
    if (this.plain) {
      this.replayBuffer();
    }
    this.notify();
  }

  getFilter(): string[] {
    return this.filterTerms;
  }

  // ---------------------------------------------------------------------------
  // Fullscreen (Ink) subscription + buffer queries
  // ---------------------------------------------------------------------------

  /** Subscribe to buffer changes (for useSyncExternalStore). Returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot token for useSyncExternalStore; changes whenever the buffer does. */
  getVersion(): number {
    return this.version;
  }

  /** Bump the version and notify subscribers, coalescing a burst into a single flush. */
  private notify(): void {
    this.version++;
    if (this.notifyScheduled) {
      return;
    }
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      for (const listener of this.listeners) {
        listener();
      }
    });
  }

  /**
   * The lines currently visible under the active filter, in order. Group-aware:
   * if any line in a group matches, the whole group is shown so multi-line log
   * entries stay intact. Memoized per buffer version.
   */
  getVisibleLines(): readonly BufferedLine[] {
    if (this.visibleCache && this.visibleCache.version === this.version) {
      return this.visibleCache.lines;
    }
    let lines: readonly BufferedLine[];
    if (this.filterTerms.length === 0) {
      lines = this.buffer;
    } else {
      const matchingGroups = new Set<number>();
      for (const line of this.buffer) {
        if (this.matchesFilter(line.searchName, line.text)) {
          matchingGroups.add(line.groupId);
        }
      }
      lines = this.buffer.filter((line) => matchingGroups.has(line.groupId));
    }
    this.visibleCache = { version: this.version, lines };
    return lines;
  }

  /** Rendered-row count of a line at the given terminal width (memoized on the line). */
  countRows(line: BufferedLine, cols: number): number {
    if (line.rowCountWidth === cols && line.rowCount !== undefined) {
      return line.rowCount;
    }
    const rows = this.wrapLine(line, cols).length;
    line.rowCount = rows;
    line.rowCountWidth = cols;
    return rows;
  }

  /** Dimmed `"YYYY-MM-DD HH:MM:SS "` gutter for a line, or `''` when its timestamp is hidden. */
  private tsPrefix(line: BufferedLine): string {
    return line.showTs ? `${chalk.dim(line.ts)} ` : '';
  }

  /** Left-gutter width for a line: the `[name]` prefix, plus the timestamp column when shown. */
  private gutterWidth(line: BufferedLine): number {
    return this.prefixWidth + (line.showTs ? TIMESTAMP_GUTTER_WIDTH : 0);
  }

  /** Rendered rows (timestamp + prefix + wrapped, continuation-padded text) of a line at `cols` width. */
  wrapLine(line: BufferedLine, cols: number): string[] {
    const ts = this.tsPrefix(line);
    const contentWidth = cols - this.gutterWidth(line);
    if (contentWidth <= 20 || stringWidth(line.text) <= contentWidth) {
      return [`${ts}${line.prefix}${line.text}`];
    }
    const pad = ' '.repeat(this.gutterWidth(line));
    return wrapAnsi(line.text, contentWidth, { hard: true })
      .split('\n')
      .map((row, i) => (i === 0 ? `${ts}${line.prefix}${row}` : `${pad}${row}`));
  }

  /** Re-clear the screen and replay the buffer through the active filter. */
  refresh(): void {
    debugLog(`refresh: buffer.length=${this.buffer.length}`);
    this.replayBuffer();
  }

  /** Drop all buffered output and clear the screen. */
  clearBuffer(): void {
    debugLog('clearBuffer');
    this.buffer = [];
    this.lastGroupId.clear();
    this.visibleLineCount = 0;
    if (this.plain) {
      this.resetScreen();
    }
    this.notify();
  }

  /** Emit a system-level line (e.g. shutdown notices), interleaved like any package's output. */
  logSystem(message: string): void {
    this.addLine(this.systemPrefix, message, 'system', false);
  }

  /**
   * Emit a `[dt:control]` line noting a mutating command received over the
   * control API. When `pkg` names a known package, the line is tagged with that
   * package's search name so it shows/hides with the package under an active
   * filter; otherwise it's tagged `dt:control`.
   */
  logControl(message: string, pkg?: string): void {
    const searchName = (pkg && this.processes.get(pkg)?.searchName) ?? 'dt:control';
    this.addLine(this.controlPrefix, message, searchName, false);
  }

  /**
   * Reserve `height` rows for a host UI's footer, kept out of the clearable
   * region. Called on every render by an interactive runner that measures its
   * own footer, so the manager's scrollback-clearing logic never treats
   * footer rows as clearable output.
   */
  setFooterHeight(height: number): void {
    this.footerHeight = height;
  }

  /**
   * Rotate the logfile: stop writing to the current file and start a fresh,
   * timestamped one in the same directory. The previous file is left intact on
   * disk. Returns the new logfile path.
   */
  rotateLogFile(): string {
    fs.closeSync(this.logFd);
    this.logFilePath = getDefaultLogFile(path.dirname(this.logFilePath));
    this.logFd = fs.openSync(this.logFilePath, 'w');
    return this.logFilePath;
  }

  /**
   * Render one raw output line from a package's child process for display/logging. A package's own
   * `logs.formatter` (when set) fully owns presentation — its string result is used verbatim, and
   * if it throws or returns a non-string we fall back to the default rendering (red stderr / plain
   * stdout). With no custom formatter, devtooie's {@link defaultFormatter} runs: lines it leaves
   * unchanged (non-structured output) keep the default rendering, and structured logs it formats
   * are used verbatim. Only real process output goes through here; devtooie's own status lines
   * (`started`, `stopping…`, …) never do.
   */
  private formatOutput(managed: ManagedProcess, line: string, isError: boolean): string {
    const custom = managed.pkg.logs?.formatter;
    if (custom) {
      try {
        const out = custom(line);
        if (typeof out === 'string') return out;
      } catch {
        /* fall back to the default rendering below */
      }
      return isError ? chalk.red(line) : line;
    }
    let out = line;
    try {
      const formatted = defaultFormatter(line);
      if (typeof formatted === 'string') out = formatted;
    } catch {
      /* keep the raw line */
    }
    // The default formatter passes non-structured output through unchanged; keep the plain/red
    // rendering for those, and use the formatted string for logs it recognized.
    return out === line ? (isError ? chalk.red(line) : line) : out;
  }

  /**
   * Format one raw output line for a package and buffer the result. A formatter may return
   * multiple display lines (e.g. a structured log rendered as a header plus indented property
   * lines); each becomes its own buffer line, so the indented ones group as continuations and
   * every line gets its own prefix in the logfile. Empty lines are dropped.
   */
  private addOutput(managed: ManagedProcess, rawLine: string, isError: boolean): void {
    const formatted = this.formatOutput(managed, rawLine, isError);
    for (const out of formatted.split('\n')) {
      if (out) this.addLine(managed.prefix, out, managed.searchName, isError);
    }
  }

  private addLine(prefix: string, text: string, searchName: string, isError: boolean): void {
    // Consecutive lines from the same package are grouped: a continuation
    // line shares the group of the entry it belongs to, so filtering and
    // replay keep multi-line log entries intact.
    let groupId: number;
    const prevGroup = this.lastGroupId.get(searchName);
    if (isContinuationLine(text) && prevGroup !== undefined) {
      groupId = prevGroup;
    } else {
      groupId = this.nextGroupId++;
      this.lastGroupId.set(searchName, groupId);
    }

    // Capture the timestamp once so the on-disk log file and the on-screen
    // (timestamped) view show the exact same time for a line. Whether it's shown on
    // screen is resolved per package (falling back to the top-level default).
    const ts = logTimestamp();
    const showTs = this.showTsBySearchName.get(searchName) ?? this.defaultShowTimestamps;
    this.buffer.push({ prefix, text, ts, showTs, searchName, isError, groupId, rendered: false });
    if (this.buffer.length > MAX_BUFFER_LINES) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER_LINES);
    }

    const plainLine = `${ts} ${stripAnsi(prefix)}${stripAnsi(text)}\n`;
    fs.writeSync(this.logFd, plainLine);

    debugLog(`addLine: visibleLineCount=${this.visibleLineCount} searchName="${searchName}"`);
    // Plain mode streams each line straight to stdout; the interactive
    // (fullscreen Ink) UI re-renders from the buffer when notified instead.
    if (this.plain) {
      this.renderNewLine();
    }
    this.notify();
  }

  /** Render the line just appended (and any unrendered group siblings) if it matches the filter. */
  private renderNewLine(): void {
    const latest = this.buffer[this.buffer.length - 1]!;

    if (this.filterTerms.length === 0) {
      latest.rendered = true;
      this.emitLine(latest);
      return;
    }

    if (!this.matchesFilter(latest.searchName, latest.text)) {
      return;
    }

    // The line matches - flush every not-yet-rendered sibling in its group so
    // the whole log entry (primary line + continuations) appears together.
    // Group members are always recent, so scan backwards from the tail.
    const { groupId } = latest;
    const pending: BufferedLine[] = [];
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const line = this.buffer[i]!;
      if (line.groupId === groupId && !line.rendered) {
        pending.push(line);
      } else if (pending.length > 0 && line.searchName === latest.searchName) {
        break; // passed all of this group's members
      }
    }
    for (let i = pending.length - 1; i >= 0; i--) {
      pending[i]!.rendered = true;
      this.emitLine(pending[i]!);
    }
  }

  private emitLine(line: BufferedLine): void {
    const rowsUsed = this.outputLine(line);
    this.visibleLineCount += rowsUsed;

    // While content hasn't filled the viewport yet, repeated writes can push
    // lines into scrollback; clear it so the terminal isn't scrollable past
    // real content. Skipped in plain mode, where scrollback is expected.
    if (!this.plain) {
      const rows = process.stdout.rows || 24;
      if (this.visibleLineCount < rows - this.footerHeight) {
        process.stdout.write('\x1b[3J');
      }
    }
  }

  /**
   * Emit many buffered lines with a SINGLE terminal write. This is what keeps a
   * filter switch / replay instant: an interactive host patches `console.*` and,
   * on every call, erases its footer, writes the line, then repaints the footer.
   * Emitting one line at a time therefore repaints the footer once per line, so
   * replaying the buffer visibly re-streams it. Routing the whole batch through
   * one `console.log` collapses that to a single footer erase+repaint.
   *
   * Everything (including error lines) goes through the one stdout write so
   * ordering is preserved in a single atomic emit — the red color of error
   * lines is already baked into their text, and in an interactive session
   * stdout and stderr are the same terminal.
   */
  private emitBatch(lines: BufferedLine[]): void {
    if (lines.length > 0) {
      const parts: string[] = [];
      let rowCount = 0;
      for (const line of lines) {
        const { rendered, rows } = this.formatLine(line);
        parts.push(rendered);
        rowCount += rows;
      }
      this.visibleLineCount += rowCount;
      console.log(parts.join('\n'));
    }

    // Same not-yet-filled-viewport scrollback guard as emitLine, applied once
    // for the whole batch: while the visible content is shorter than the
    // viewport, drop any scrollback so the terminal can't scroll past it. Once
    // the content overflows, scrollback is left intact so it stays reachable.
    if (!this.plain) {
      const viewportRows = process.stdout.rows || 24;
      if (this.visibleLineCount < viewportRows - this.footerHeight) {
        process.stdout.write('\x1b[3J');
      }
    }
  }

  /**
   * Clear the screen and replay the buffer through the current filter.
   * Group-aware: if any line in a group matches, the whole group is shown.
   */
  private replayBuffer(): void {
    this.resetScreen();

    if (this.filterTerms.length === 0) {
      for (const line of this.buffer) {
        line.rendered = true;
      }
      this.emitBatch(this.buffer);
      return;
    }

    const matchingGroups = new Set<number>();
    for (const line of this.buffer) {
      line.rendered = false;
      if (this.matchesFilter(line.searchName, line.text)) {
        matchingGroups.add(line.groupId);
      }
    }

    const visible: BufferedLine[] = [];
    for (const line of this.buffer) {
      if (matchingGroups.has(line.groupId)) {
        line.rendered = true;
        visible.push(line);
      }
    }
    this.emitBatch(visible);
  }

  /**
   * Clear the screen and scrollback, positioning the cursor just above the
   * reserved footer rows. Public so an interactive runner can reposition the
   * cursor once at startup (before its first `startAll()`), avoiding a spurious
   * scrollback gap on initial paint; used internally by
   * `clearBuffer()`/`replayBuffer()` for the same reason on every subsequent
   * clear.
   *
   * The escape codes MUST go through a single `console.log`, not
   * `process.stdout.write`. `console.log` passes through Ink's patched console
   * (erase the previous render -> write these codes -> re-render the footer at
   * the new cursor row), which keeps Ink's tracked cursor position in sync with
   * the terminal. A raw `process.stdout.write` bypasses that pipeline: Ink's
   * tracked position goes stale and the next render positions the footer wrong —
   * a gap opens below the real content instead of the footer sitting flush at
   * the bottom of the viewport on first paint.
   */
  resetScreen(): void {
    if (this.plain) {
      this.visibleLineCount = 0;
      return;
    }
    const rows = process.stdout.rows || 24;
    const targetRow = Math.max(1, rows - this.footerHeight);
    debugLog(`resetScreen: rows=${rows} targetRow=${targetRow}`);
    console.log(`\x1b[2J\x1b[H\x1b[3J\x1b[${targetRow};1H`);
    // Clear any scrollback the patched console's restore cycle may re-create.
    process.stdout.write('\x1b[3J');
    this.visibleLineCount = 0;
  }

  private matchesFilter(searchName: string, text: string): boolean {
    if (this.filterTerms.length === 0) {
      return true;
    }
    const haystack = normalizeForFilter(`${searchName} ${text}`);
    return this.filterTerms.every((term) => haystack.includes(term));
  }

  /**
   * Render one line to its terminal string — the timestamp (when enabled) and
   * prefix followed by the text, hard-wrapped to the content width with wrapped
   * rows aligned under the prefix. Returns the string (no trailing newline) and
   * the number of terminal rows it occupies. Pure (writes nothing), so the live
   * single-line path and the batched replay path produce byte-identical layout.
   */
  private formatLine(line: BufferedLine): { rendered: string; rows: number } {
    const { prefix, text } = line;
    const ts = this.tsPrefix(line);
    const cols = process.stdout.columns || 120;
    const contentWidth = cols - this.gutterWidth(line);

    if (contentWidth <= 20 || stringWidth(text) <= contentWidth) {
      return { rendered: `${ts}${prefix}${text}`, rows: 1 };
    }

    const pad = ' '.repeat(this.gutterWidth(line));
    const wrapped = wrapAnsi(text, contentWidth, { hard: true });
    const lines = wrapped.split('\n');
    const rendered = lines
      .map((row, i) => (i === 0 ? `${ts}${prefix}${row}` : `${pad}${row}`))
      .join('\n');
    return { rendered, rows: lines.length };
  }

  /** Print one line, wrapping to the terminal width. Returns the number of rows it consumed. */
  private outputLine(line: BufferedLine): number {
    const { rendered, rows } = this.formatLine(line);
    (line.isError ? console.error : console.log)(rendered);
    return rows;
  }
}
