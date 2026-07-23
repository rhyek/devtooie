import { type InstanceInfo, isPortListening, readRunning } from './running.js';

/**
 * A snapshot of a live devtooie session, as returned by `GET /query/status`. `logFile`,
 * `pid`, and `configPath` are always present (even before the process manager attaches);
 * `packages` and `config` are `null` until it does.
 */
export interface SessionStatus {
  pid: number;
  /** Absolute path to the `devtooie.config.*` the session was started with. */
  configPath: string;
  /** Absolute path to the logfile currently being written (rotation-aware), or null. */
  logFile: string | null;
  /** Per-package status map (`getAllStatuses()`), or null before the manager attaches. */
  packages: Record<string, unknown> | null;
  /** The resolved config, or null before the manager attaches. */
  config: unknown | null;
}

/**
 * A thin HTTP client for a running instance's localhost control API. Bind one with
 * {@link connectControlClient} (which only returns a client when an instance is actually
 * up) or {@link createControlClient} (bound to an explicit port). Reusable by any feature
 * that needs to query or drive a session.
 */
export interface ControlClient {
  readonly port: number;
  /** `GET /query/status` — full session snapshot, or null if the instance didn't answer with a valid one. */
  queryStatus(): Promise<SessionStatus | null>;
  /** `POST /command/restart/<pkg>` — true if the instance accepted it. */
  restart(pkg: string): Promise<boolean>;
  /** `POST /command/rebuild/<pkg>` — true if the instance accepted it. */
  rebuild(pkg: string): Promise<boolean>;
  /** `POST /command/quit` — best-effort graceful shutdown; resolves once the request is sent. */
  quit(): Promise<void>;
}

/** Builds a control client bound to `port`, with no liveness check (fits probing arbitrary candidates). */
export function createControlClient(port: number, timeoutMs = 500): ControlClient {
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
    async queryStatus() {
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
          logFile: typeof body.logFile === 'string' ? body.logFile : null,
          packages: (body.packages ?? null) as Record<string, unknown> | null,
          config: body.config ?? null,
        };
      } catch {
        return null;
      }
    },
    restart: (pkg) => post(`/command/restart/${encodeURIComponent(pkg)}`),
    rebuild: (pkg) => post(`/command/rebuild/${encodeURIComponent(pkg)}`),
    async quit() {
      try {
        await fetch(`${base}/command/quit`, {
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Returns a {@link ControlClient} for this workspace's running instance — reading the port
 * from `running.json` and confirming something is listening on it — or null when no instance
 * is up. The reusable entry point for querying/driving the current session.
 */
export async function connectControlClient(
  cwd: string = process.cwd(),
): Promise<ControlClient | null> {
  const running = readRunning(cwd);
  if (!running) {
    return null;
  }
  if (!(await isPortListening(running.port))) {
    return null;
  }
  return createControlClient(running.port);
}

/**
 * Queries a port's `/query/status` and reduces it to the {@link InstanceInfo} identity used
 * by the port-handoff protocol; null if it isn't a devtooie instance.
 */
export async function probeInstance(port: number, timeoutMs = 500): Promise<InstanceInfo | null> {
  const status = await createControlClient(port, timeoutMs).queryStatus();
  return status ? { pid: status.pid, configPath: status.configPath } : null;
}
