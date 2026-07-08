import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { execa, type ResultPromise } from 'execa';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import type { AnyPackageConfig } from './config.js';
import { getDevScript, getLoadedConfig } from './config.js';
import type { ControlManager } from './command-server.js';
import { debugLog } from './debug-log.js';
import { DEFAULT_ENV_FILES, resolveEnv } from './env.js';
import { watchEnvFiles, type WatchTarget } from './env-watch.js';
import { getExecArgs, getRebuildCommands, getStateDir, hasScript } from './lib.js';
import type { RunnerArgs } from './runners/types.js';

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
  searchName: string;
  isError: boolean;
  /** Lines sharing a groupId are shown together when any one of them matches the active filter. */
  groupId: number;
  /** Whether this line has already been written to the terminal. */
  rendered: boolean;
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

/** Strip ANSI (SGR) escape sequences from a string. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- matches ANSI SGR escape sequences
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Local `HH:MM:SS` (24h) timestamp used to prefix logfile lines. */
function logTimestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

const PALETTE = [
  chalk.cyan,
  chalk.yellow,
  chalk.green,
  chalk.magenta,
  chalk.hex('#FF8C00'),
  chalk.blue,
  chalk.red,
  chalk.hex('#00CED1'),
  chalk.hex('#DA70D6'),
  chalk.hex('#32CD32'),
];

const MAX_BUFFER_LINES = 50_000;
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
  private continuationPad: string;
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

  constructor(
    {
      sortedPackages,
      rebuildableSet,
      waitForMap,
      healthcheckUrls,
      logFile,
      envFiles,
      cwd,
    }: RunnerArgs,
    { plain = false }: { plain?: boolean } = {},
  ) {
    this.plain = plain;
    this.rebuildableSet = rebuildableSet;
    this.waitForMap = waitForMap;
    this.healthcheckUrls = healthcheckUrls;
    this.envFiles = envFiles ?? DEFAULT_ENV_FILES;
    this.cwd = cwd ?? process.cwd();

    const displayName = (a: AnyPackageConfig) => a.run?.shortName ?? a.name;
    const maxNameLen = sortedPackages.reduce((m, a) => Math.max(m, displayName(a).length), 0);
    this.prefixWidth = maxNameLen + 3; // "[" + padded name + "]" + " "
    this.continuationPad = ' '.repeat(this.prefixWidth);

    for (let i = 0; i < sortedPackages.length; i++) {
      const pkg = sortedPackages[i]!;
      const color = PALETTE[i % PALETTE.length]!;
      const label = displayName(pkg);
      const padded = label + ' '.repeat(maxNameLen - label.length);
      const shortName = pkg.run?.shortName;
      this.processes.set(pkg.name, {
        pkg,
        proc: null,
        status: 'stopped',
        prefix: color(`[${padded}]`) + ' ',
        searchName: (shortName ? `${pkg.name} ${shortName}` : pkg.name).toLowerCase(),
        canDev: hasScript(pkg, getDevScript(pkg)),
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

    this.logFilePath = logFile ?? path.join(getStateDir(), 'devlog.txt');
    this.logFd = fs.openSync(this.logFilePath, 'w');
  }

  // ---------------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------------

  startAll(): void {
    debugLog(`startAll: starting ${this.processes.size} processes`);
    for (const [name, managed] of this.processes) {
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
        for (const line of data.toString().split('\n')) {
          if (line) {
            this.addLine(pfx, line, searchName, false);
          }
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        for (const line of data.toString().split('\n')) {
          if (line) {
            this.addLine(pfx, chalk.red(line), searchName, true);
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
    const { env } = resolveEnv({
      cwd: this.cwd,
      relativeDir: pkg.relativeDir,
      files: this.envFiles,
    });
    const port = pkg.run?.port;
    return Object.assign({}, process.env, port !== undefined ? { PORT: String(port) } : {}, env);
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
        for (const line of data.toString().split('\n')) {
          if (line) {
            this.addLine(pfx, line, searchName, false);
          }
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        for (const line of data.toString().split('\n')) {
          if (line) {
            this.addLine(pfx, chalk.red(line), searchName, true);
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
      out.push({ name, shortName: managed.pkg.run?.shortName, status });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------------------------------------------------------------------------
  // Output buffering & filtering
  // ---------------------------------------------------------------------------

  setFilter(terms: string[]): void {
    this.filterTerms = terms.map((t) => t.toLowerCase());
    this.replayBuffer();
  }

  getFilter(): string[] {
    return this.filterTerms;
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
    this.resetScreen();
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

  /** Truncate the logfile in place (close + reopen). */
  truncateLogFile(): void {
    fs.closeSync(this.logFd);
    this.logFd = fs.openSync(this.logFilePath, 'w');
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

    this.buffer.push({ prefix, text, searchName, isError, groupId, rendered: false });
    if (this.buffer.length > MAX_BUFFER_LINES) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER_LINES);
    }

    const plainLine = `${logTimestamp()} ${stripAnsi(prefix)}${stripAnsi(text)}\n`;
    fs.writeSync(this.logFd, plainLine);

    debugLog(`addLine: visibleLineCount=${this.visibleLineCount} searchName="${searchName}"`);
    this.renderNewLine();
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
    const rowsUsed = this.outputLine(line.prefix, line.text, line.isError);
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
   * Clear the screen and replay the buffer through the current filter.
   * Group-aware: if any line in a group matches, the whole group is shown.
   */
  private replayBuffer(): void {
    this.resetScreen();

    if (this.filterTerms.length === 0) {
      for (const line of this.buffer) {
        line.rendered = true;
        this.emitLine(line);
      }
      return;
    }

    const matchingGroups = new Set<number>();
    for (const line of this.buffer) {
      line.rendered = false;
      if (this.matchesFilter(line.searchName, line.text)) {
        matchingGroups.add(line.groupId);
      }
    }

    for (const line of this.buffer) {
      if (matchingGroups.has(line.groupId)) {
        line.rendered = true;
        this.emitLine(line);
      }
    }
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
    const haystack = `${searchName} ${text}`.toLowerCase();
    return this.filterTerms.every((term) => haystack.includes(term));
  }

  /** Print one line, wrapping to the terminal width. Returns the number of rows it consumed. */
  private outputLine(prefix: string, text: string, isError: boolean): number {
    const logger = isError ? console.error : console.log;
    const cols = process.stdout.columns || 120;
    const contentWidth = cols - this.prefixWidth;

    if (contentWidth <= 20 || stringWidth(text) <= contentWidth) {
      logger(`${prefix}${text}`);
      return 1;
    }

    const wrapped = wrapAnsi(text, contentWidth, { hard: true });
    const lines = wrapped.split('\n');
    for (let i = 0; i < lines.length; i++) {
      logger(i === 0 ? `${prefix}${lines[i]}` : `${this.continuationPad}${lines[i]}`);
    }
    return lines.length;
  }
}
