import type { TokenRecord } from '../config.js';

/** How long `infra up` waits for the services to become ready, when the config doesn't say. */
export const DEFAULT_READY_TIMEOUT_MS = 300_000;

/** Options for the `compose` and `run` helpers an infra callback receives. */
export interface InfraRunOptions {
  /** Working directory; a relative path resolves against `workspaceDir`, which is the default. */
  cwd?: string;
  /** Extra variables, merged over the callback's `envs`. */
  env?: Record<string, string>;
  /** Set `false` to get the result of a failing command instead of a rejection. */
  reject?: boolean;
}

export interface InfraRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * What every infra callback receives. Unlike the config's other callbacks — synchronous, and
 * resolved once while the config loads — these are async and run when an `infra` command (or a
 * dev session's infra step) does.
 */
export interface InfraCallbackContext<T = TokenRecord> {
  /** The service this callback belongs to. */
  service: string;
  /** The active mode (`development`, `test`, …). */
  mode: string;
  /** `true` when this run is `infra up --reset`. Always `false` under `infra destroy`. */
  reset: boolean;
  /** The workspace root, absolute. */
  workspaceDir: string;
  /** The workspace-scope `.env` files for the mode, merged over the ambient environment. */
  envs: Record<string, string>;
  /** The config's top-level `tokens`, typed from what the config declares. */
  tokens: T;
  /**
   * Runs `docker compose <args>` against this project — the mode's project name, environment and
   * compose file already applied. Its output goes to devtooie's infra output, and a non-zero exit
   * rejects unless `reject: false`.
   */
  compose: (args: string[], opts?: InfraRunOptions) => Promise<InfraRunResult>;
  /** Runs any other command, the same way: output captured, a non-zero exit rejects. */
  run: (command: string, args?: string[], opts?: InfraRunOptions) => Promise<InfraRunResult>;
  /** Writes a line to devtooie's infra output. */
  log: (message: string) => void;
}

export type InfraCallback<T = TokenRecord> = (ctx: InfraCallbackContext<T>) => void | Promise<void>;

/** The callbacks a service can attach. They run around devtooie's built-in steps, never instead. */
export interface InfraServiceCallbacks<T = TokenRecord> {
  /**
   * After the service's container and volumes are removed — on `infra destroy` and on
   * `infra up --reset`. For state the provider can't see, such as a bind-mounted directory.
   */
  afterDestroy?: InfraCallback<T>;
  /** On every `infra up`, after any destroy and before the services are started. */
  beforeUp?: InfraCallback<T>;
  /**
   * On every `infra up`, once the service is ready — **including when it was already running**.
   * For migrations and seeding, so it must be idempotent.
   */
  afterReady?: InfraCallback<T>;
}

/** The `docker-compose` provider's options. `{}` is a complete config. */
export interface DockerComposeInfraInput<T = TokenRecord> {
  /**
   * The compose file, relative to `workspaceDir`. Omit it to let Compose discover the file
   * (`compose.yaml`, `docker-compose.yaml`, and any override file).
   */
  file?: string;
  /** How long `infra up` waits for the services to become ready, in ms. Defaults to 5 minutes. */
  readyTimeout?: number;
  /**
   * Callbacks, keyed by Compose service name. This does **not** choose which services run — every
   * service Compose reports for the file does.
   */
  services?: Record<string, InfraServiceCallbacks<T>>;
}

/** The top-level `infra` option: keyed by provider, and it must name at least one. */
export interface InfraInput<T = TokenRecord> {
  'docker-compose'?: DockerComposeInfraInput<T>;
}

export interface ResolvedDockerComposeInfra {
  /** Absolute path to the compose file, or `undefined` when Compose discovers it. */
  file?: string;
  /** The Compose project name in force for the active mode. */
  projectName: string;
  readyTimeout: number;
  /** The callbacks as written. Functions have no JSON form, so serializing this leaves `{}`. */
  services: Record<string, InfraServiceCallbacks>;
}

/** `infra`, resolved. The service list isn't here: producing it means running the provider. */
export interface ResolvedInfra {
  'docker-compose'?: ResolvedDockerComposeInfra;
}

// ---------------------------------------------------------------------------
// Runtime: what a run reports while it happens, and what it returns.
// ---------------------------------------------------------------------------

/** Where a service is in an `up` or `destroy` run. `ready`, `destroyed` and `failed` are final. */
export type InfraServiceStatus =
  'pending' | 'destroying' | 'starting' | 'ready' | 'destroyed' | 'failed';

/** Everything a run reports, through one callback, for whichever surface is showing it. */
export type InfraEvent =
  /** The services this run acts on, once resolved, and the provider that runs them. */
  | { type: 'targets'; provider: string; action: 'up' | 'destroy'; services: string[] }
  /** A service changed status, or the step it is on (`detail`) changed. */
  | { type: 'status'; service: string; status: InfraServiceStatus; detail?: string }
  /** A line of output: from a callback (tagged with its service) or from the provider's tool. */
  | { type: 'output'; service?: string; line: string; isError: boolean };

export interface InfraServiceResult {
  service: string;
  ok: boolean;
  /** Why it failed; may span several lines (a failed container's log tail, say). */
  error?: string;
}

export interface InfraRunSummary {
  /** True only when every target succeeded. */
  ok: boolean;
  services: InfraServiceResult[];
}

/** One reading of whether a service is ready. */
export interface Readiness {
  state: 'pending' | 'ready' | 'failed';
  /** What the provider saw, in a few words (`waiting for healthy`, `exited (1)`). */
  detail: string;
}

/** A failure with a message meant for the user as-is — printed without a stack trace. */
export class InfraError extends Error {
  override name = 'InfraError';
}

/** The error for service names that don't exist, listing the ones that do. */
export function unknownServicesError(unknown: string[], known: string[]): InfraError {
  return new InfraError(
    `unknown infra service${unknown.length > 1 ? 's' : ''} ${unknown.map((s) => `"${s}"`).join(', ')}. ` +
      `Services: ${known.join(', ') || '(none)'}`,
  );
}
