import path from 'node:path';
import type { TokenRecord } from '../config.js';
import type { Exec, ExecOptions, ExecResult, SpawnInherit } from './exec.js';
import {
  InfraError,
  type InfraCallbackContext,
  type InfraEvent,
  type InfraRunOptions,
  type InfraRunResult,
  type InfraRunSummary,
  type InfraServiceCallbacks,
  type InfraServiceResult,
  type InfraServiceStatus,
  type Readiness,
} from './types.js';

/** How often `up` re-reads the services' readiness, when the runtime doesn't say. */
const DEFAULT_POLL_INTERVAL_MS = 500;

/** What a provider needs from the session it runs in. */
export interface ProviderRuntime {
  /** The workspace root, absolute. */
  workspaceDir: string;
  mode: string;
  /** The workspace-scope `.env` files for the mode, merged over the ambient environment. */
  envs: Record<string, string>;
  /** The config's top-level `tokens`. */
  tokens: TokenRecord;
  exec: Exec;
  spawnInherit: SpawnInherit;
  pollIntervalMs?: number;
}

export interface InfraRunRequest {
  /** The services to act on. Omitted or empty means all of them. */
  services?: string[];
  /** Destroy the targets before starting them. */
  reset?: boolean;
  onEvent?: (event: InfraEvent) => void;
}

export type Emit = (event: InfraEvent) => void;

type CallbackName = keyof InfraServiceCallbacks;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `90000` → `90s`, `300000` → `5m`. */
function formatTimeout(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0
    ? `${String(ms / 60_000)}m`
    : `${String(Math.round(ms / 100) / 10)}s`;
}

/**
 * One way of running infrastructure. This base class owns the **lifecycle** — the order of
 * destroy, callbacks, start, the readiness wait and `afterReady`, the timeout, and what gets
 * reported — and a subclass supplies only the primitives, with nothing to say about ordering.
 */
export abstract class InfraProvider {
  /** The provider's key under `infra` in the config (and its passthrough subcommand). */
  abstract readonly key: string;

  protected constructor(
    protected readonly runtime: ProviderRuntime,
    /** The config's callbacks, keyed by service name. */
    protected readonly callbacks: Record<string, InfraServiceCallbacks>,
    protected readonly readyTimeout: number,
  ) {}

  /** The services this provider can run. */
  abstract listServices(): Promise<string[]>;
  /** Stops and removes the services, keeping their data. Resolves with the tool's exit code. */
  abstract down(services: string[]): Promise<number>;
  /** Runs the provider's own tool with `args`, in `invocationCwd`, the terminal handed over. */
  abstract passthrough(args: string[], invocationCwd: string): Promise<number>;

  /** Removes the named services' containers and data — and nothing belonging to another service. */
  protected abstract destroyServices(targets: string[], emit: Emit): Promise<void>;
  /** Removes everything the provider created for the project. */
  protected abstract destroyAll(emit: Emit): Promise<void>;
  /** Starts the services, without waiting for them to become ready. */
  protected abstract startServices(targets: string[], emit: Emit): Promise<void>;
  /** One readiness reading per target. */
  protected abstract readStatuses(targets: string[]): Promise<Map<string, Readiness>>;
  /** Text explaining why a service failed (its log tail, say); empty when there is none. */
  protected abstract failureDetail(service: string): Promise<string>;
  /** Runs the provider's tool for a callback's `compose` helper. */
  protected abstract runTool(args: string[], opts: ExecOptions): Promise<ExecResult>;

  /** How the provider's tool is named in a message about a command that failed. */
  protected toolLabel(): string {
    return this.key;
  }

  /** Variables the provider adds to what callbacks see and to the commands they run. */
  protected extraEnv(): Record<string, string> {
    return {};
  }

  /**
   * Brings the targets up and waits until each is ready: (with `reset`) destroy and
   * `afterDestroy`, then `beforeUp`, one start for all of them, a readiness poll, and each
   * service's `afterReady` the moment *it* is ready.
   *
   * A failure before the services are started aborts the run and fails every target. After
   * that, each service runs to its own result. Rejects only for a request that can't be run
   * at all (an unknown service); everything else is in the summary.
   */
  async up(req: InfraRunRequest = {}): Promise<InfraRunSummary> {
    const emit = req.onEvent ?? (() => {});
    const reset = req.reset ?? false;
    const { targets, everything } = await this.resolveTargets(req.services);
    const run = new Run(targets, emit);
    emit({ type: 'targets', action: 'up', services: targets });
    run.setAll('pending');

    try {
      if (reset) {
        run.setAll('destroying');
        await (everything ? this.destroyAll(emit) : this.destroyServices(targets, emit));
        if (!(await this.runPhase('afterDestroy', run, reset))) {
          return run.summary();
        }
      }
      run.setAll('starting');
      if (!(await this.runPhase('beforeUp', run, reset))) {
        return run.summary();
      }
      await this.startServices(targets, emit);
    } catch (err) {
      run.failAll(errorMessage(err));
      return run.summary();
    }

    await this.awaitReady(run, reset);
    return run.summary();
  }

  /**
   * Removes the targets and their data, then calls `afterDestroy({ reset: false })`. With no
   * services named it removes the whole project.
   */
  async destroy(req: Omit<InfraRunRequest, 'reset'> = {}): Promise<InfraRunSummary> {
    const emit = req.onEvent ?? (() => {});
    const { targets, everything } = await this.resolveTargets(req.services);
    const run = new Run(targets, emit);
    emit({ type: 'targets', action: 'destroy', services: targets });
    run.setAll('destroying');
    try {
      await (everything ? this.destroyAll(emit) : this.destroyServices(targets, emit));
    } catch (err) {
      run.failAll(errorMessage(err));
      return run.summary();
    }
    const failures = await this.runCallbacks('afterDestroy', targets, false, emit);
    for (const service of targets) {
      const error = failures.get(service);
      if (error === undefined) {
        run.succeed(service, 'destroyed');
      } else {
        run.fail(service, error);
      }
    }
    return run.summary();
  }

  /**
   * The services a request acts on, validated: a name the provider doesn't have is an error
   * listing the real ones — for a service named on the command line and for a key under the
   * config's `services` alike, before anything is touched.
   */
  private async resolveTargets(
    named: string[] | undefined,
  ): Promise<{ targets: string[]; everything: boolean }> {
    const all = await this.listServices();
    const known = `Services: ${all.join(', ') || '(none)'}`;
    const strays = Object.keys(this.callbacks).filter((name) => !all.includes(name));
    if (strays.length > 0) {
      throw new InfraError(
        `infra: the config's \`${this.key}\` services name ${strays.map((s) => `"${s}"`).join(', ')}, ` +
          `which ${strays.length > 1 ? 'are not services' : 'is not a service'} the provider has. ${known}`,
      );
    }
    if (!named || named.length === 0) {
      return { targets: all, everything: true };
    }
    const unknown = named.filter((name) => !all.includes(name));
    if (unknown.length > 0) {
      throw new InfraError(
        `unknown infra service${unknown.length > 1 ? 's' : ''} ${unknown.map((s) => `"${s}"`).join(', ')}. ${known}`,
      );
    }
    return { targets: [...new Set(named)], everything: false };
  }

  /**
   * Runs one callback for every target that has it, and decides the run: `true` to carry on.
   * If any failed, that service fails with its own error and the rest fail as not started —
   * these phases come before the single start, so there is no partial way forward.
   */
  private async runPhase(name: CallbackName, run: Run, reset: boolean): Promise<boolean> {
    const failures = await this.runCallbacks(name, run.targets, reset, run.emit);
    if (failures.size === 0) {
      return true;
    }
    const culprits = [...failures.keys()].join(', ');
    for (const service of run.targets) {
      run.fail(service, failures.get(service) ?? `not started: ${culprits} failed in ${name}`);
    }
    return false;
  }

  /** Runs `name` for each target that has it, in parallel. Returns the failures, by service. */
  private async runCallbacks(
    name: CallbackName,
    targets: string[],
    reset: boolean,
    emit: Emit,
  ): Promise<Map<string, string>> {
    const failures = new Map<string, string>();
    await Promise.all(
      targets.map(async (service) => {
        const callback = this.callbacks[service]?.[name];
        if (!callback) {
          return;
        }
        try {
          await callback(this.context(service, reset, emit));
        } catch (err) {
          failures.set(service, `${name} failed: ${errorMessage(err)}`);
        }
      }),
    );
    return failures;
  }

  /**
   * Polls until every target is ready or failed, or the timeout elapses. Each service's
   * `afterReady` starts as soon as that service is ready, so a slow one doesn't hold up
   * another's migrations.
   */
  private async awaitReady(run: Run, reset: boolean): Promise<void> {
    const pending = new Set(run.targets);
    const settling: Promise<void>[] = [];
    const lastDetail = new Map<string, string>();
    const deadline = Date.now() + this.readyTimeout;
    const interval = this.runtime.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    while (pending.size > 0) {
      let readings: Map<string, Readiness>;
      try {
        readings = await this.readStatuses([...pending]);
      } catch (err) {
        for (const service of pending) {
          run.fail(service, errorMessage(err));
        }
        break;
      }
      for (const service of [...pending]) {
        const reading = readings.get(service) ?? { state: 'pending', detail: 'creating' };
        if (reading.state === 'ready') {
          pending.delete(service);
          settling.push(this.settleReady(service, run, reset));
        } else if (reading.state === 'failed') {
          pending.delete(service);
          settling.push(this.settleFailed(service, reading.detail, run));
        } else if (lastDetail.get(service) !== reading.detail) {
          lastDetail.set(service, reading.detail);
          run.set(service, 'starting', reading.detail);
        }
      }
      if (pending.size === 0) {
        break;
      }
      if (Date.now() >= deadline) {
        for (const service of pending) {
          const saw = lastDetail.get(service);
          run.fail(
            service,
            `${service} was not ready after ${formatTimeout(this.readyTimeout)}${saw ? ` (${saw})` : ''}`,
          );
        }
        break;
      }
      await sleep(interval);
    }
    await Promise.all(settling);
  }

  private async settleReady(service: string, run: Run, reset: boolean): Promise<void> {
    const callback = this.callbacks[service]?.afterReady;
    if (callback) {
      run.set(service, 'starting', 'afterReady');
      try {
        await callback(this.context(service, reset, run.emit));
      } catch (err) {
        run.fail(service, `afterReady failed: ${errorMessage(err)}`);
        return;
      }
    }
    run.succeed(service, 'ready');
  }

  private async settleFailed(service: string, detail: string, run: Run): Promise<void> {
    let why = '';
    try {
      why = (await this.failureDetail(service)).trim();
    } catch {
      /* the reading already says it failed; the explanation is a bonus */
    }
    run.fail(service, why ? `${detail}\n${why}` : detail);
  }

  /** What a callback for `service` receives. */
  private context(service: string, reset: boolean, emit: Emit): InfraCallbackContext {
    const { workspaceDir, mode, tokens, exec } = this.runtime;
    const envs = { ...this.runtime.envs, ...this.extraEnv() };
    const output = (line: string, isError: boolean) =>
      emit({ type: 'output', service, line, isError });
    const execOptions = (opts: InfraRunOptions | undefined): ExecOptions => ({
      cwd: path.resolve(workspaceDir, opts?.cwd ?? '.'),
      env: { ...envs, ...opts?.env },
      onLine: output,
    });
    const settle = (
      label: string,
      result: ExecResult,
      opts: InfraRunOptions | undefined,
    ): InfraRunResult => {
      if (result.exitCode !== 0 && opts?.reject !== false) {
        throw new Error(`\`${label}\` exited with code ${String(result.exitCode)}`);
      }
      return result;
    };
    return {
      service,
      mode,
      reset,
      workspaceDir,
      envs,
      tokens,
      compose: async (args, opts) =>
        settle(
          [this.toolLabel(), ...args].join(' '),
          await this.runTool(args, execOptions(opts)),
          opts,
        ),
      run: async (command, args = [], opts) =>
        settle([command, ...args].join(' '), await exec(command, args, execOptions(opts)), opts),
      log: (message) => {
        for (const line of message.split('\n')) {
          output(line, false);
        }
      },
    };
  }
}

/** The bookkeeping of one `up` or `destroy`: each target's result, reported as it changes. */
class Run {
  private readonly results = new Map<string, InfraServiceResult>();

  constructor(
    readonly targets: string[],
    readonly emit: Emit,
  ) {}

  set(service: string, status: InfraServiceStatus, detail?: string): void {
    this.emit(
      detail === undefined
        ? { type: 'status', service, status }
        : { type: 'status', service, status, detail },
    );
  }

  setAll(status: InfraServiceStatus): void {
    for (const service of this.targets) {
      this.set(service, status);
    }
  }

  succeed(service: string, status: 'ready' | 'destroyed'): void {
    this.results.set(service, { service, ok: true });
    this.set(service, status);
  }

  fail(service: string, error: string): void {
    this.results.set(service, { service, ok: false, error });
    this.set(service, 'failed', error);
  }

  failAll(error: string): void {
    for (const service of this.targets) {
      this.fail(service, error);
    }
  }

  summary(): InfraRunSummary {
    const services = this.targets.map(
      (service) => this.results.get(service) ?? { service, ok: false, error: 'did not finish' },
    );
    return { ok: services.every((s) => s.ok), services };
  }
}
