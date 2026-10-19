import type { PortResolver, ProxyInput, ResolvedProxy, TokenRecord } from '../config.js';
import type { Envs, Mode } from '../env.js';

/** How long `infra up` waits for the services to become ready, when the config doesn't say. */
export const DEFAULT_READY_TIMEOUT_MS = 300_000;

/** Options for the `compose` and `run` helpers an infra callback receives. */
export interface InfraRunOptions {
  /** Working directory; a relative path resolves against `workspaceDir`, which is the default. */
  cwd?: string;
  /** Extra variables for this one command, merged over the callback's `envs`. */
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
  /** The active mode: `development` unless `--mode` says otherwise, or any name you pass it. */
  mode: Mode;
  /** `true` when this run is `infra up --reset`. Always `false` under `infra destroy`. */
  reset: boolean;
  /** The workspace root, absolute. */
  workspaceDir: string;
  /**
   * This mode's environment: the workspace-scope `.env` files and the ambient environment —
   * the ambient environment wins over the files, except for the variables `env.override` names —
   * plus whatever the provider adds (`COMPOSE_PROJECT_NAME`). It includes `DEVTOOIE_MODE`.
   *
   * It is the whole environment {@link run} and {@link compose} give their commands. Workspace
   * scope only: a package's own `.env` files, and the `PORT`/`PUBLIC_ORIGIN` devtooie injects
   * into a package's process, aren't in it.
   */
  envs: Envs;
  /** The config's top-level `tokens`, typed from what the config declares. */
  tokens: T;
  /**
   * Runs `docker compose <args>` against this project — the compose file and the mode's project
   * name already applied, and {@link envs} as its environment (an `env` option is merged on top,
   * but can't change the project). Its output goes to devtooie's infra output, and a non-zero
   * exit rejects unless `reject: false`.
   */
  compose: (args: string[], opts?: InfraRunOptions) => Promise<InfraRunResult>;
  /**
   * Runs any other command with {@link envs} as its environment (an `env` option is merged on
   * top) — so a migration or seed script gets the mode's variables and `DEVTOOIE_MODE` with
   * nothing passed by hand. Output captured; a non-zero exit rejects unless `reject: false`.
   */
  run: (command: string, args?: string[], opts?: InfraRunOptions) => Promise<InfraRunResult>;
  /** Writes a line to devtooie's infra output. */
  log: (message: string) => void;
}

export type InfraCallback<T = TokenRecord> = (ctx: InfraCallbackContext<T>) => void | Promise<void>;

/** What `afterReady` receives: the common context, plus what is only known once a service is up. */
export interface InfraReadyContext<T = TokenRecord> extends InfraCallbackContext<T> {
  /**
   * `true` when **this run created the service's data** — the first time it ever ran, and after
   * a destroy or a reset. The moment to seed: `if (fresh) await run('pnpm', ['seed'])`.
   *
   * It goes by the service's named volumes: fresh means none of them existed before this run
   * started it. So stopping a service and starting it again (`infra down`, then `up`) is not
   * fresh — the container is new, the data isn't. A service with no named volume keeps its data
   * in the container, and is fresh when it had none.
   *
   * It describes this run only. If `afterReady` fails on the run where it is `true`, it is
   * `false` on the next one; `infra up --reset <service>` gives the service a clean start.
   */
  fresh: boolean;
}

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
   * For migrations, so it must be idempotent; seed behind its `fresh` flag.
   */
  afterReady?: (ctx: InfraReadyContext<T>) => void | Promise<void>;
}

/**
 * What an `enabled` callback receives. Like the config's other load-time callbacks it is
 * synchronous and resolved once, while the config loads — so there is no service to act on yet,
 * only what decides whether there will be one.
 */
export interface InfraEnabledContext<T = TokenRecord> {
  /** The active mode: `development` unless `--mode` says otherwise, or any name you pass it. */
  mode: Mode;
  /**
   * The workspace-scope `.env` files for the mode and the ambient environment; the ambient
   * environment wins over the files, except for the variables `env.override` names.
   */
  envs: Envs;
  /** The config's top-level `tokens`. */
  tokens: T;
}

/**
 * What a service can be given under `services`: its callbacks, whether it runs at all, and how
 * the dev reverse proxy reaches it. Shared by every provider.
 */
export interface InfraServiceInput<T = TokenRecord> extends InfraServiceCallbacks<T> {
  /**
   * Whether devtooie runs this service (default `true`). A literal, or a callback over the mode
   * and environment — `({ mode }) => mode !== 'test'`, `({ envs }) => Boolean(envs.API_KEY)`.
   * A disabled service is left out of `infra up` and of a dev session, and its callbacks don't
   * run. (Compose still starts it if an enabled service `depends_on` it.)
   */
  enabled?: boolean | ((ctx: InfraEnabledContext<T>) => boolean);
  /**
   * The port the service answers on at `localhost` — the host side of its port mapping, which
   * devtooie doesn't read from the provider's own file. A literal, or a callback over the
   * workspace context `{ envs, tokens }` resolved once at load, like a package's `port`:
   * `port: ({ envs }) => Number(envs.MAIL_UI_PORT)`. Required with `proxy`. Not resolved for a
   * disabled service. It must differ from every package's port and from the dev reverse
   * proxy's.
   */
  port?: number | PortResolver<T>;
  /**
   * Route `<subdomain>.<rootDomain>` to this service's `port` through the dev reverse proxy,
   * as for a package. `subdomain: true` is the service's key. Needs `port`. See {@link ProxyInput}.
   */
  proxy?: ProxyInput;
}

/** A service's config, resolved: `enabled` decided, `port` and `proxy` settled, the callbacks as written. */
export interface ResolvedInfraService extends InfraServiceCallbacks {
  enabled: boolean;
  /** The service's port on `localhost`, with any callback resolved; never set for a disabled service. */
  port?: number;
  /** How the dev reverse proxy routes to the service, `subdomain: true` already replaced by its key. */
  proxy?: ResolvedProxy;
  /**
   * The service's public origin under the dev reverse proxy —
   * `<urlScheme>://<canonical subdomain>.<rootDomain>[:<port>]` — or `undefined` when the config
   * has no `devReverseProxy`, the service declares no `proxy`, or it is disabled.
   */
  publicOrigin?: string;
}

/** The `docker-compose` provider's options. `{}` — or `true` in its place — is a complete config. */
export interface DockerComposeInfraInput<T = TokenRecord> {
  /**
   * The compose file, relative to `workspaceDir`. Omit it to let Compose discover the file
   * (`compose.yaml`, `docker-compose.yaml`, and any override file).
   */
  file?: string;
  /** How long `infra up` waits for the services to become ready, in ms. Defaults to 5 minutes. */
  readyTimeout?: number;
  /**
   * Per-service options, keyed by Compose service name. Every service Compose reports for the
   * file runs, listed here or not — unless its `enabled` says otherwise.
   */
  services?: Record<string, InfraServiceInput<T>>;
}

/** The top-level `infra` option: keyed by provider, and it must name at least one. */
export interface InfraInput<T = TokenRecord> {
  /** Docker Compose. `true` for a compose file that needs nothing configured — the same as `{}`. */
  'docker-compose'?: true | DockerComposeInfraInput<T>;
}

export interface ResolvedDockerComposeInfra {
  /** Absolute path to the compose file, or `undefined` when Compose discovers it. */
  file?: string;
  /** The Compose project name in force for the active mode. */
  projectName: string;
  readyTimeout: number;
  /**
   * The services the config names, with `enabled`, `port` and `proxy` resolved and the callbacks
   * as written. Functions have no JSON form, so serializing one leaves the rest.
   */
  services: Record<string, ResolvedInfraService>;
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
/**
 * How a service stands right now, for a live display: `running` (ready, by its healthcheck when
 * it has one), `starting` (up but not ready yet), or `stopped` (no container, or one that exited
 * with an error or is unhealthy).
 */
export type InfraServiceState = 'running' | 'starting' | 'stopped';

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
