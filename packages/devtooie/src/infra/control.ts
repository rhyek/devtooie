import chalk from 'chalk';
import { execa, type ResultPromise } from 'execa';
import { stripTitleSequences } from '../terminal-title.js';
import type { InfraWatch } from './provider.js';
import type { InfraServiceState } from './types.js';

/** What a session can do to one of its infra services, from a hotkey or the control API. */
export type InfraAction = 'start' | 'stop' | 'restart' | 'reset';

export const INFRA_ACTIONS: readonly InfraAction[] = ['start', 'stop', 'restart', 'reset'];

/** A service's live state, or the action under way on it. */
export type InfraStatus = InfraServiceState | 'stopping' | 'restarting' | 'resetting';

/** How a service reads while an action is under way on it. */
const IN_PROGRESS: Record<InfraAction, InfraStatus> = {
  start: 'starting',
  stop: 'stopping',
  restart: 'restarting',
  reset: 'resetting',
};

/**
 * The `devtooie infra …` invocations an action runs, in order; a step that fails ends it.
 * `restart` is `down` then `up`: the container is recreated — picking up a changed compose file
 * — and its data kept. `reset` destroys the service and its data first.
 */
export function infraCliSteps(action: InfraAction, service: string): string[][] {
  switch (action) {
    case 'start':
      return [['infra', 'up', service]];
    case 'stop':
      return [['infra', 'down', service]];
    case 'restart':
      return [
        ['infra', 'down', service],
        ['infra', 'up', service],
      ];
    case 'reset':
      return [['infra', 'up', '--reset', service]];
  }
}

/** Why {@link InfraControl.run} did or didn't take an action on. */
export type InfraRunOutcome = 'accepted' | 'unknown' | 'busy';

export interface InfraControlOptions {
  /** The session's services, by name. */
  services: string[];
  /** Starts the live watch of their states (see `SessionInfra.watch`); absent, nothing watches. */
  watch?: (onStates: (states: Map<string, InfraServiceState>) => void) => InfraWatch;
  /** The command that runs the devtooie CLI: `[node, cli.js]`. */
  cli: string[];
  /** The session's mode, handed to every `infra` command it runs. */
  mode: string;
  /** The workspace root, where the commands run. */
  cwd: string;
  /** Receives every line an action prints, and the lines marking where it starts and ends. */
  log: (service: string, text: string, isError: boolean) => void;
  /** Called with each child spawned, for the session record's orphan sweep. */
  track?: (proc: ResultPromise, cwd: string) => void;
}

/**
 * A session's hold on its infra services: their live states, and the actions run on them.
 *
 * An action runs the `devtooie infra` command itself, as a child with its output piped into the
 * session log — the same command a terminal would run, and no provider output drawn over the
 * TUI. Every service is taken to be running until the watch first reports: the session only
 * starts once its infra is ready.
 */
export class InfraControl {
  private readonly states = new Map<string, InfraServiceState>();
  private readonly busy = new Map<string, InfraAction>();
  private readonly procs = new Set<ResultPromise>();
  private readonly listeners = new Set<() => void>();
  private watch: InfraWatch | null = null;

  constructor(private readonly opts: InfraControlOptions) {
    for (const service of opts.services) {
      this.states.set(service, 'running');
    }
  }

  /** The services, in the order the session lists them. */
  get services(): string[] {
    return this.opts.services;
  }

  /** Starts watching the services' states. A second call is a no-op. */
  start(): void {
    if (this.watch || !this.opts.watch) {
      return;
    }
    this.watch = this.opts.watch((states) => {
      let changed = false;
      for (const [name, state] of states) {
        if (this.states.has(name) && this.states.get(name) !== state) {
          this.states.set(name, state);
          changed = true;
        }
      }
      if (changed) {
        this.emit();
      }
    });
  }

  /** Stops watching. The actions under way are the caller's to kill (see {@link takeLiving}). */
  stop(): void {
    this.watch?.stop();
    this.watch = null;
  }

  /** Calls `fn` whenever a service's status changes; returns the unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** A service's status — the action under way, else its live state — or `undefined` for none. */
  status(service: string): InfraStatus | undefined {
    const action = this.busy.get(service);
    return action ? IN_PROGRESS[action] : this.states.get(service);
  }

  /** Every service's status, keyed by name: what `/query/status` reports under `infra`. */
  statuses(): Record<string, InfraStatus> {
    return Object.fromEntries(this.opts.services.map((s) => [s, this.status(s)!]));
  }

  /** Whether an action is under way on the service. */
  isBusy(service: string): boolean {
    return this.busy.has(service);
  }

  /**
   * Starts an action on a service, returning at once: `unknown` for a name the session doesn't
   * have, `busy` while another action on it is under way.
   */
  run(service: string, action: InfraAction): InfraRunOutcome {
    if (!this.states.has(service)) {
      return 'unknown';
    }
    if (this.busy.has(service)) {
      return 'busy';
    }
    this.busy.set(service, action);
    this.emit();
    void (async () => {
      try {
        for (const step of infraCliSteps(action, service)) {
          if (!(await this.runStep(service, step))) {
            break;
          }
        }
      } finally {
        this.busy.delete(service);
        this.emit();
        this.watch?.refresh();
      }
    })();
    return 'accepted';
  }

  /** Hands over the commands still running, for a shutdown to kill and wait on. */
  takeLiving(): ResultPromise[] {
    const living = [...this.procs];
    this.procs.clear();
    return living;
  }

  /** Signals every command still running, by process group. */
  kill(signal: NodeJS.Signals): void {
    for (const proc of this.procs) {
      try {
        if (proc.pid) {
          process.kill(-proc.pid, signal);
        }
      } catch {
        /* already gone */
      }
    }
  }

  private emit(): void {
    for (const fn of this.listeners) {
      fn();
    }
  }

  /** Runs one `devtooie infra …` command to its exit; resolves with whether it succeeded. */
  private async runStep(service: string, args: string[]): Promise<boolean> {
    const { cli, cwd, log, mode, track } = this.opts;
    const label = `devtooie ${args.join(' ')}`;
    log(service, chalk.cyan(`▶ running: ${label}`), false);
    const [command, ...prefix] = cli;
    const proc = execa(command!, [...prefix, ...args, '--mode', mode], {
      cwd,
      // The child's output is piped, so it would print without color; keep the session's.
      env: chalk.level > 0 ? { ...process.env, FORCE_COLOR: String(chalk.level) } : process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      reject: false,
      buffer: false,
      // Its own process group, so a shutdown can take down whatever it spawned with it.
      detached: true,
    });
    this.procs.add(proc);
    track?.(proc, cwd);
    const pipe = (stream: NodeJS.ReadableStream | null, isError: boolean) => {
      let pending = '';
      stream?.on('data', (chunk: Buffer) => {
        pending += stripTitleSequences(chunk.toString());
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) {
            log(service, line.replace(/\r$/, ''), isError);
          }
        }
      });
      stream?.on('end', () => {
        if (pending.trim()) {
          log(service, pending, isError);
        }
      });
    };
    pipe(proc.stdout, false);
    pipe(proc.stderr, true);
    const result = await proc;
    this.procs.delete(proc);
    const ok = result.exitCode === 0;
    log(
      service,
      ok
        ? chalk.green(`✔ ${label} finished`)
        : chalk.red(`✘ ${label} exited with code ${String(result.exitCode ?? 1)}`),
      !ok,
    );
    return ok;
  }
}
