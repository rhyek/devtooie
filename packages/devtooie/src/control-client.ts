import fs from 'node:fs';
import { DEFAULT_MODE } from './env.js';
import type { InfraAction, InfraStatus } from './infra/control.js';
import type { PackageName } from './register.js';
import { type InstanceInfo, isPortListening, readRunning } from './running.js';
import { QUIT_REQUEST_TIMEOUT_MS } from './shutdown-timing.js';

/** A package's status on `GET /query/status`. */
export type SessionPackageStatus = 'running' | 'stopped' | 'waiting' | 'restarting' | 'rebuilding';

/**
 * A snapshot of a live devtooie session, as returned by `GET /query/status`. `logFile`,
 * `pid`, and `configPath` are always present (even before the process manager attaches);
 * `packages`, `infra` and `config` are `null` until it does.
 */
export interface SessionStatus<P extends string = PackageName> {
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
  /** Each running package's status, or null before the manager attaches. */
  packages: Partial<Record<P, SessionPackageStatus>> | null;
  /**
   * Each infra service's live state, or the action under way on it; null for a config without
   * infra, and before the manager attaches.
   */
  infra: Record<string, InfraStatus> | null;
  /** The resolved config, or null before the manager attaches. */
  config: unknown | null;
  /**
   * The session's dev reverse proxy — its port, root domains, and every public hostname it
   * routes, to a package or to an infra service — or null when the config declares none.
   */
  devReverseProxy: {
    port: number;
    rootDomain: string;
    rootDomains: string[];
    routes: ({ host: string; port: number } & ({ package: P } | { service: string }))[];
  } | null;
}

/**
 * A thin HTTP client for a running instance's localhost control API, its methods named after
 * the endpoint paths: `query.status()` is `GET /query/status`, `command.restart(name)` is
 * `POST /command/restart/<name>`. Bind one with {@link connectControlClient} (which only returns
 * a client when an instance is actually up), {@link connectSessionControl} (which also checks
 * the instance is the given config's session in the given mode) or {@link createControlClient}
 * (bound to an explicit port). Reusable by any feature that needs to query or drive a session.
 */
export interface ControlClient<P extends string = PackageName> {
  readonly port: number;
  readonly query: {
    /** `GET /query/status` — full session snapshot, or null if the instance didn't answer with a valid one. */
    status(): Promise<SessionStatus<P> | null>;
  };
  readonly command: {
    /** `POST /command/restart/<name>` — true if the instance accepted it. */
    restart(name: P): Promise<boolean>;
    /** `POST /command/rebuild/<name>` — true if the instance accepted it. */
    rebuild(name: P): Promise<boolean>;
    /**
     * `POST /command/infra/<action>/<service>` — true if the instance accepted it. False for a
     * service the session doesn't have, and while another action on that service is under way.
     * The action runs in the background: watch `infra` on `query.status()` for where it ends.
     */
    infra(action: InfraAction, service: string): Promise<boolean>;
    /**
     * `POST /command/quit` — graceful shutdown. The target **blocks** the response until its
     * packages are torn down (ports freed), so this resolves only once that's done (or the
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
  const post = async (path: string): Promise<boolean> => {
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
      return res.ok && body.ok === true;
    } catch {
      return false;
    }
  };
  return {
    port,
    query: { status: queryStatus },
    command: {
      restart: (name) => post(`/command/restart/${encodeURIComponent(name)}`),
      rebuild: (name) => post(`/command/rebuild/${encodeURIComponent(name)}`),
      infra: (action, service) =>
        post(`/command/infra/${encodeURIComponent(action)}/${encodeURIComponent(service)}`),
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
        packages: (body.packages ?? null) as SessionStatus<P>['packages'],
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
      // The target holds this response open until its packages are down, so this
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
