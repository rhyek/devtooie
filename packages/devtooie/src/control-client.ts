import fs from 'node:fs';
import type { ServiceAction } from './command-server.js';
import { DEFAULT_MODE } from './env.js';
import type { InfraAction, InfraStatus } from './infra/control.js';
import type { ServiceName } from './register.js';
import { type InstanceInfo, isPortListening, readRunning } from './running.js';
import {
  QUIT_REQUEST_TIMEOUT_MS,
  SERVICE_START_REQUEST_TIMEOUT_MS,
  SERVICE_STOP_REQUEST_TIMEOUT_MS,
} from './shutdown-timing.js';

/** An application service's status on `GET /query/status`. */
export type SessionServiceStatus = 'running' | 'stopped' | 'waiting' | 'restarting' | 'rebuilding';

/**
 * A snapshot of a live devtooie session, as returned by `GET /query/status`. `logFile`,
 * `pid`, and `configPath` are always present (even before the process manager attaches);
 * `services`, `infra` and `config` are `null` until it does.
 */
export interface SessionStatus<P extends string = ServiceName> {
  pid: number;
  /** Absolute path to the `devtooie.config.*` the session was started with. */
  configPath: string;
  /**
   * The mode the session runs in. An instance that doesn't report one predates per-mode
   * sessions, when there was one session per workspace, and reads as the default mode.
   */
  mode: string;
  /**
   * Whether that session was started by a coding agent rather than by a person. Absent from
   * instances older than 0.7.0, which read as `false` — so a new session never auto-quits one
   * it can't ask about.
   */
  startedByAgent: boolean;
  /** Absolute path to the logfile currently being written (rotation-aware), or null. */
  logFile: string | null;
  /** Each application service's status, or null before the manager attaches. */
  services: Partial<Record<P, SessionServiceStatus>> | null;
  /**
   * Whether each service is ready: running, and passing its healthcheck when it has one. Same
   * keys as `services`, and null when it is.
   */
  ready: Partial<Record<P, boolean>> | null;
  /**
   * Each infra service's live state, or the action under way on it; null for a config without
   * infra, and before the manager attaches.
   */
  infra: Record<string, InfraStatus> | null;
  /** The resolved config, or null before the manager attaches. */
  config: unknown;
  /**
   * The session's dev reverse proxy — its port, root domains, and every public hostname it
   * routes, to an application service or to an infra service — or null when the config declares none.
   */
  devReverseProxy: {
    port: number;
    rootDomain: string;
    rootDomains: string[];
    routes: ({ host: string; port: number } & ({ service: P } | { infraService: string }))[];
  } | null;
}

/**
 * A thin HTTP client for a running instance's localhost control API, its methods named after
 * the endpoint paths: `query.status()` is `GET /query/status`, `command.service.restart(name)`
 * is `POST /command/service/restart/<name>`. Bind one with {@link connectControlClient} (which only returns
 * a client when an instance is actually up), {@link connectSessionControl} (which also checks
 * the instance is the given config's session in the given mode) or {@link createControlClient}
 * (bound to an explicit port). Reusable by any feature that needs to query or drive a session.
 */
export interface ControlClient<P extends string = ServiceName> {
  readonly port: number;
  readonly query: {
    /** `GET /query/status` — full session snapshot, or null if the instance didn't answer with a valid one. */
    status(): Promise<SessionStatus<P> | null>;
  };
  readonly command: {
    /**
     * `POST /command/service/<action>/<name>`, one method per action — true if the instance
     * accepted it. False for a service the session doesn't have, for a `rebuild` of one with no
     * clean build, and for a `start` or `stop` while a restart or rebuild of it is under way.
     */
    readonly service: {
      /** Starts a stopped service, or one still waiting on its `waitFor`. True when it already runs. */
      start(name: P): Promise<boolean>;
      /** Stops a service, resolving once its process has exited. True when it is already stopped. */
      stop(name: P): Promise<boolean>;
      /** Restarts a service (and starts a stopped one). Runs on in the background. */
      restart(name: P): Promise<boolean>;
      /** Stops a service, clean-builds it, then starts it. Runs on in the background. */
      rebuild(name: P): Promise<boolean>;
    };
    /**
     * `POST /command/infra/<action>/<service>`, one method per action — true if the instance
     * accepted it. False for a service the session doesn't have, and while another action on
     * that service is under way. The action runs in the background: watch `infra` on
     * `query.status()` for where it ends.
     */
    readonly infra: {
      /** Starts a stopped service. */
      start(service: string): Promise<boolean>;
      /** Stops a service, keeping its data. */
      stop(service: string): Promise<boolean>;
      /** Recreates the service's container, keeping its data: `down`, then `up`. */
      restart(service: string): Promise<boolean>;
      /** Removes the service and its data, then brings it up again, as `infra up --reset` does. */
      reset(service: string): Promise<boolean>;
    };
    /**
     * `POST /command/quit` — graceful shutdown. The target **blocks** the response until its
     * services are torn down (ports freed), so this resolves only once that's done (or the
     * request times out / the target vanishes). Returns `true` if the target acked `ok`.
     */
    quit(): Promise<boolean>;
  };
}

/** Builds a control client bound to `port`, with no liveness check (fits probing arbitrary candidates). */
export function createControlClient<P extends string = string>(
  port: number,
  timeoutMs = 500,
): ControlClient<P> {
  const base = `http://127.0.0.1:${port}`;
  const post = async (path: string, timeout = timeoutMs): Promise<boolean> => {
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeout),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
      return res.ok && body.ok === true;
    } catch {
      return false;
    }
  };
  const serviceAction = (action: ServiceAction, name: string, timeout?: number) =>
    post(`/command/service/${action}/${encodeURIComponent(name)}`, timeout);
  const infraAction = (action: InfraAction) => (service: string) =>
    post(`/command/infra/${action}/${encodeURIComponent(service)}`);
  return {
    port,
    query: { status: queryStatus },
    command: {
      service: {
        // Adding a service to the session builds what it lacks first: that can take minutes.
        start: (name) => serviceAction('start', name, SERVICE_START_REQUEST_TIMEOUT_MS),
        // The target answers once the process has exited, which can take its whole grace period.
        stop: (name) => serviceAction('stop', name, SERVICE_STOP_REQUEST_TIMEOUT_MS),
        restart: (name) => serviceAction('restart', name),
        rebuild: (name) => serviceAction('rebuild', name),
      },
      infra: {
        start: infraAction('start'),
        stop: infraAction('stop'),
        restart: infraAction('restart'),
        reset: infraAction('reset'),
      },
      quit,
    },
  };

  async function queryStatus(): Promise<SessionStatus<P> | null> {
    try {
      const res = await fetch(`${base}/query/status`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        return null;
      }
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body.pid !== 'number' || typeof body.configPath !== 'string') {
        return null;
      }
      return {
        pid: body.pid,
        configPath: body.configPath,
        mode: typeof body.mode === 'string' ? body.mode : DEFAULT_MODE,
        startedByAgent: body.startedByAgent === true,
        logFile: typeof body.logFile === 'string' ? body.logFile : null,
        services: (body.services ?? null) as SessionStatus<P>['services'],
        ready: (body.ready ?? null) as SessionStatus<P>['ready'],
        infra: (body.infra ?? null) as SessionStatus<P>['infra'],
        config: body.config ?? null,
        devReverseProxy: (body.devReverseProxy ?? null) as SessionStatus<P>['devReverseProxy'],
      };
    } catch {
      return null;
    }
  }

  async function quit(): Promise<boolean> {
    try {
      // The target holds this response open until its services are down, so this
      // request can take much longer than a probe — use the blocking-quit timeout,
      // not the short default. Returns true only on an explicit `ok` ack.
      const res = await fetch(`${base}/command/quit`, {
        method: 'POST',
        signal: AbortSignal.timeout(QUIT_REQUEST_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
      return res.ok && body.ok === true;
    } catch {
      return false; // timed out, or the target hard-exited before acking
    }
  }
}

/**
 * Returns a {@link ControlClient} for this workspace's running session in `mode` (the active
 * one unless given) — reading the port from its `running.<mode>.json` and confirming something
 * is listening on it — or null when no such session is up. The reusable entry point for
 * querying/driving the current session.
 */
export async function connectControlClient(
  cwd: string = process.cwd(),
  mode?: string,
): Promise<ControlClient | null> {
  const running = readRunning(cwd, mode);
  if (!running) {
    return null;
  }
  if (!(await isPortListening(running.port))) {
    return null;
  }
  return createControlClient(running.port);
}

/** A path with its symlinks resolved, or as given when it doesn't exist. */
function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * A {@link ControlClient} for the running session of **this** config in **this** mode, or
 * `undefined` when there is none. The port comes from the config's `apiPort` when it pins one,
 * else from the mode's `running.<mode>.json` — and since that record outlives its session, and
 * every project's control port comes from the same range, whatever answers there is only bound
 * when its `/query/status` names the same config file and mode (and, from a record, the
 * recorded pid). Anything else — nothing listening, another project's session, a stale record —
 * is `undefined`, never a client that could drive the wrong session.
 */
export async function connectSessionControl(opts: {
  workspaceDir: string;
  /** Absolute path to the config the caller loaded. */
  configPath: string;
  mode: string;
  /** The config's `apiPort`, when it pins one. */
  apiPort?: number;
}): Promise<ControlClient | undefined> {
  const running = opts.apiPort === undefined ? readRunning(opts.workspaceDir, opts.mode) : null;
  const port = opts.apiPort ?? running?.port;
  if (port === undefined || !(await isPortListening(port))) {
    return undefined;
  }
  const client = createControlClient(port);
  const status = await client.query.status();
  if (
    !status ||
    status.mode !== opts.mode ||
    realPath(status.configPath) !== realPath(opts.configPath) ||
    (running !== null && status.pid !== running.pid)
  ) {
    return undefined;
  }
  return client;
}

/**
 * Queries a port's `/query/status` and reduces it to the {@link InstanceInfo} identity used
 * by the port-handoff protocol; null if it isn't a devtooie instance.
 */
export async function probeInstance(port: number, timeoutMs = 500): Promise<InstanceInfo | null> {
  const status = await createControlClient(port, timeoutMs).query.status();
  return status ? { pid: status.pid, configPath: status.configPath, mode: status.mode } : null;
}
