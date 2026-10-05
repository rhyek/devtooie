import type { ExecOptions, ExecResult } from '../exec.js';
import { InfraProvider, type Emit, type ProviderRuntime } from '../provider.js';
import { InfraError, type Readiness, type ResolvedDockerComposeInfra } from '../types.js';

/** The fields of a `docker compose ps --format json` row that readiness is read from. */
export interface PsRow {
  Service: string;
  /** `created`, `running`, `restarting`, `exited`, `paused`, `removing` or `dead`. */
  State: string;
  /** `starting`, `healthy` or `unhealthy`; empty when the service has no healthcheck. */
  Health?: string;
  ExitCode?: number;
}

/** The parts of `docker compose config --format json` that deciding a volume's fate needs. */
export interface ComposeConfig {
  services?: Record<string, { volumes?: { type: string; source?: string; target?: string }[] }>;
  volumes?: Record<string, { name?: string; external?: unknown }>;
}

/** How many lines of a failed container's logs go into its failure report. */
const FAILURE_LOG_LINES = 20;

/**
 * `docker compose ps --format json`, parsed. Current Compose prints one object per line; older
 * releases print a single array. No containers is no output at all.
 */
export function parsePs(stdout: string): PsRow[] {
  const text = stdout.trim();
  if (!text) {
    return [];
  }
  if (text.startsWith('[')) {
    return JSON.parse(text) as PsRow[];
  }
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as PsRow);
}

function classifyContainer(row: PsRow): Readiness {
  switch (row.State) {
    case 'running':
      switch (row.Health ?? '') {
        case '':
          return { state: 'ready', detail: 'running' };
        case 'healthy':
          return { state: 'ready', detail: 'healthy' };
        case 'unhealthy':
          return { state: 'failed', detail: 'unhealthy' };
        default:
          return { state: 'pending', detail: 'waiting for healthy' };
      }
    case 'exited': {
      // A container that ran to completion is done, not broken: an init or migration service.
      const code = row.ExitCode ?? 0;
      return { state: code === 0 ? 'ready' : 'failed', detail: `exited (${String(code)})` };
    }
    case 'dead':
      return { state: 'failed', detail: 'dead' };
    default:
      return { state: 'pending', detail: row.State };
  }
}

/**
 * Whether a service is ready, from its containers' rows. Readiness is exactly what the compose
 * file's `healthcheck` says — no probe of devtooie's own. A service with several containers is
 * ready when all of them are, and failed when any one is.
 */
export function classify(rows: PsRow[]): Readiness {
  if (rows.length === 0) {
    return { state: 'pending', detail: 'creating' };
  }
  const readings = rows.map(classifyContainer);
  return (
    readings.find((r) => r.state === 'failed') ??
    readings.find((r) => r.state === 'pending') ??
    readings[0]!
  );
}

/**
 * Which named volumes go when `targets` are destroyed, by the name Compose resolved for each.
 * A volume stays if it is `external`, or if a service that is *not* being destroyed mounts it
 * too. Anonymous volumes and bind mounts aren't listed here at all: `rm --volumes` already took
 * the first, and the second is the host's.
 */
export function selectVolumes(
  config: ComposeConfig,
  targets: string[],
): { remove: string[]; kept: { name: string; reason: string }[] } {
  const services = config.services ?? {};
  const mounted = (service: string): string[] =>
    (services[service]?.volumes ?? [])
      .filter((v) => v.type === 'volume' && v.source)
      .map((v) => v.source!);

  const remove: string[] = [];
  const kept: { name: string; reason: string }[] = [];
  for (const key of new Set(targets.flatMap(mounted))) {
    const definition = config.volumes?.[key];
    const name = definition?.name ?? key;
    const others = Object.keys(services).filter(
      (service) => !targets.includes(service) && mounted(service).includes(key),
    );
    if (definition?.external) {
      kept.push({ name, reason: 'external' });
    } else if (others.length > 0) {
      kept.push({ name, reason: `also mounted by ${others.join(', ')}` });
    } else {
      remove.push(name);
    }
  }
  return { remove, kept };
}

/**
 * Infra run by Docker Compose. Every Compose detail lives here: how it is invoked, how its
 * output is read, and which resources a destroy may touch.
 */
export class DockerComposeProvider extends InfraProvider {
  readonly key = 'docker-compose';

  constructor(
    private readonly resolved: ResolvedDockerComposeInfra,
    runtime: ProviderRuntime,
  ) {
    super(runtime, resolved.services, resolved.readyTimeout);
  }

  protected override toolLabel(): string {
    return 'docker compose';
  }

  /**
   * The project name, as an environment variable rather than `-p` so that it also reaches
   * whatever a callback runs — a script that calls `docker compose` itself lands on this project.
   */
  protected override extraEnv(): Record<string, string> {
    return { COMPOSE_PROJECT_NAME: this.resolved.projectName };
  }

  /**
   * The one place a Compose command line is assembled. `--project-directory` is always given,
   * so the compose file, `.env` and relative paths in the file resolve against the workspace
   * root whatever directory the command runs in.
   */
  private composeArgs(args: string[]): string[] {
    const { file } = this.resolved;
    return [
      'compose',
      '--project-directory',
      this.runtime.workspaceDir,
      ...(file === undefined ? [] : ['-f', file]),
      ...args,
    ];
  }

  private env(): Record<string, string> {
    return { ...this.runtime.envs, ...this.extraEnv() };
  }

  /** Runs `docker compose <args>` captured; a failure is an {@link InfraError} with its stderr. */
  private async compose(args: string[], onLine?: ExecOptions['onLine']): Promise<ExecResult> {
    const result = await this.runtime.exec('docker', this.composeArgs(args), {
      cwd: this.runtime.workspaceDir,
      env: this.env(),
      onLine,
    });
    if (result.exitCode === 127) {
      throw new InfraError(
        "infra: couldn't run `docker compose` — is Docker installed and on your PATH?\n" +
          result.stderr.trim(),
      );
    }
    if (result.exitCode !== 0) {
      throw new InfraError(
        `\`docker compose ${args.join(' ')}\` failed (exit ${String(result.exitCode)}):\n` +
          result.stderr.trim(),
      );
    }
    return result;
  }

  /**
   * Forwards Compose's progress (`Container … Started`, image pulls) as plain output. Compose
   * writes all of it to stderr, so the stream says nothing about whether a line is an error.
   */
  private progress(emit: Emit): ExecOptions['onLine'] {
    return (line) => {
      const text = line.trim();
      if (text) {
        emit({ type: 'output', line: text, isError: false });
      }
    };
  }

  async listServices(): Promise<string[]> {
    const { stdout } = await this.compose(['config', '--services']);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /**
   * One `up` for every target, never one per service: concurrent `up` calls on a fresh project
   * race to create the network. `--remove-orphans` takes only containers whose service is gone
   * from the compose file.
   */
  protected async startServices(targets: string[], emit: Emit): Promise<void> {
    await this.compose(['up', '--detach', '--remove-orphans', ...targets], this.progress(emit));
  }

  protected async readStatuses(targets: string[]): Promise<Map<string, Readiness>> {
    const { stdout } = await this.compose(['ps', '--all', '--format', 'json', ...targets]);
    const rows = parsePs(stdout);
    return new Map(
      targets.map((service) => [service, classify(rows.filter((row) => row.Service === service))]),
    );
  }

  protected async failureDetail(service: string): Promise<string> {
    const { stdout, stderr } = await this.compose([
      'logs',
      '--no-color',
      '--tail',
      String(FAILURE_LOG_LINES),
      service,
    ]);
    return `${stdout}${stderr}`.trim();
  }

  /**
   * The whole project, by Compose's own teardown: containers, networks, the named volumes the
   * file declares, anonymous volumes, and orphan containers.
   */
  protected async destroyAll(emit: Emit): Promise<void> {
    await this.compose(['down', '--volumes', '--remove-orphans'], this.progress(emit));
  }

  /**
   * Only the named services. **Never `down <service> --volumes`**: that also deletes the volumes
   * of every other service whose container doesn't currently exist. So the containers go first
   * (with their anonymous volumes), and then exactly the named volumes those services own.
   */
  protected async destroyServices(targets: string[], emit: Emit): Promise<void> {
    await this.compose(['rm', '--stop', '--force', '--volumes', ...targets], this.progress(emit));
    const { stdout } = await this.compose(['config', '--format', 'json']);
    const { remove, kept } = selectVolumes(JSON.parse(stdout) as ComposeConfig, targets);
    const say = (line: string) => emit({ type: 'output', line, isError: false });
    for (const { name, reason } of kept) {
      say(`kept volume ${name}: ${reason}`);
    }
    for (const name of remove) {
      const result = await this.runtime.exec('docker', ['volume', 'rm', name], {
        cwd: this.runtime.workspaceDir,
        env: this.env(),
      });
      if (result.exitCode === 0) {
        say(`removed volume ${name}`);
      } else if (/no such volume/i.test(result.stderr)) {
        // Never created — the service was never started. Nothing to remove.
      } else if (/in use/i.test(result.stderr)) {
        // Held by a container outside the file's active services (another profile, say).
        say(`kept volume ${name}: in use by another container`);
      } else {
        throw new InfraError(`couldn't remove volume ${name}:\n${result.stderr.trim()}`);
      }
    }
  }

  /** `docker compose down`, with Compose's own output. Never `--volumes`: the data stays. */
  async down(services: string[]): Promise<number> {
    return this.runtime.spawnInherit('docker', this.composeArgs(['down', ...services]), {
      cwd: this.runtime.workspaceDir,
      env: this.env(),
    });
  }

  /** Compose itself, in the directory the user is standing in, with their arguments untouched. */
  async passthrough(args: string[], invocationCwd: string): Promise<number> {
    return this.runtime.spawnInherit('docker', this.composeArgs(args), {
      cwd: invocationCwd,
      env: this.env(),
    });
  }

  protected async runTool(args: string[], opts: ExecOptions): Promise<ExecResult> {
    return this.runtime.exec('docker', this.composeArgs(args), {
      ...opts,
      env: { ...opts.env, ...this.extraEnv() },
    });
  }
}
