import http from 'node:http';
import { startedByAgent } from './agent-detection.js';
import type { DevReverseProxyServer } from './dev-reverse-proxy.js';
import { currentMode } from './env.js';
import {
  INFRA_ACTIONS,
  type InfraAction,
  type InfraRunOutcome,
  type InfraStatus,
} from './infra/control.js';

/** What `POST /command/service/<action>/<name>` can do to an application service. */
export type ServiceAction = 'start' | 'stop' | 'restart' | 'rebuild';

export const SERVICE_ACTIONS: readonly ServiceAction[] = ['start', 'stop', 'restart', 'rebuild'];

/**
 * How a service action went: `done` (a start or stop, finished), `accepted` (a restart or
 * rebuild, under way), `unknown` (no such service in the session), `busy` (a restart or rebuild
 * is under way), `unavailable` (a start with no dev command, a rebuild with no clean build),
 * `failed` (a start that added the service to the session, but a build it needed failed).
 */
export type ServiceRunOutcome = 'done' | 'accepted' | 'unknown' | 'busy' | 'unavailable' | 'failed';

export interface ControlManager {
  getAllStatuses(): unknown;
  /** Whether each service is running and passing its healthcheck (see `/query/status` `ready`). */
  getAllReadiness(): Record<string, boolean>;
  /** The whole resolved config (defaults applied), included in `/query/status` once attached. */
  getConfig(): unknown;
  /** Absolute path to the logfile currently being written (rotation-aware). */
  getLogFile(): string;
  /** Runs an action on an application service; a `stop` resolves once its process has exited. */
  runPackage(pkg: string, action: ServiceAction): Promise<ServiceRunOutcome>;
  /** Every infra service's status, or `null` for a session without infra. */
  getInfraStatuses(): Record<string, InfraStatus> | null;
  /** Starts an action on an infra service; returns at once (see `InfraControl.run`). */
  runInfra(service: string, action: InfraAction): InfraRunOutcome;
  quit(): void;
  /**
   * Emit a `[dt:control]` log line noting a mutating command arrived over the control API (as
   * opposed to the same action triggered by a UI hotkey). `attrs` carries the variables the
   * command was called with (e.g. `{ service: 'web' }`), rendered as indented properties; an
   * `attrs.service` naming a known service also scopes the line to it for output filtering.
   */
  logControl(command: string, attrs?: Record<string, unknown>): void;
}

export async function startCommandServer(opts: {
  onQuit: () => void;
  port: number;
  /** Absolute path to the config this session started with; surfaced on `/query/status` for handoff. */
  configPath?: string;
  /**
   * This session's initial logfile, surfaced on `/query/status` before the process manager
   * attaches. Once attached, the manager's rotation-aware `getLogFile()` supersedes it.
   */
  logFile?: string;
  /**
   * The session's dev reverse proxy, if the config declares one — surfaced on `/query/status`
   * so a client can learn the public hostnames without parsing the config.
   */
  devReverseProxy?: Pick<
    DevReverseProxyServer,
    'port' | 'rootDomain' | 'rootDomains' | 'routes'
  > | null;
}): Promise<{
  attach(m: ControlManager): void;
  /**
   * Swaps the handler invoked by `/command/quit`. The server is typically created
   * before the process manager exists (so it can be reached mid-build), then a
   * later phase that owns graceful shutdown takes over quit-routing by calling
   * this — without it, a quit request during that phase would still hit the
   * original (e.g. hard-exit) handler it was constructed with.
   */
  setOnQuit(fn: () => void): void;
  /**
   * Send `200 { ok: true }` to any `POST /command/quit` request currently being
   * held open (see the handler), releasing a blocked caller. The graceful
   * shutdown path calls this once services are torn down; a no-op when nothing
   * is waiting (e.g. a Ctrl+C quit, which never went through the HTTP handler).
   */
  ackQuit(): void;
  close(): Promise<void>;
  port: number;
}> {
  let manager: ControlManager | null = null;
  let onQuit = opts.onQuit;
  const send = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  // `POST /command/quit` responses held open until the graceful shutdown path
  // acks them (see the handler and ackQuit). Usually 0 or 1 entry.
  let pendingQuits: http.ServerResponse[] = [];
  const flushQuits = () => {
    const held = pendingQuits;
    pendingQuits = [];
    for (const res of held) {
      try {
        send(res, 200, { ok: true });
      } catch {
        /* socket already gone */
      }
    }
  };

  const server = http.createServer((req, res) => {
    // Localhost-only convenience API: HTTP methods are intentionally not enforced.
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const parts = pathname.split('/').filter(Boolean);
    // The single consolidated query endpoint. `pid`/`configPath`/`logFile`/`startedByAgent`
    // are available even before the process manager attaches (from the server's own opts, or
    // from this process's own environment); `services`/`config` — and the rotation-aware
    // `logFile` — come from the manager once it does.
    if (pathname === '/query/status') {
      return send(res, 200, {
        pid: process.pid,
        configPath: opts.configPath ?? null,
        mode: currentMode(),
        startedByAgent: startedByAgent(),
        logFile: manager ? manager.getLogFile() : (opts.logFile ?? null),
        services: manager ? manager.getAllStatuses() : null,
        ready: manager ? manager.getAllReadiness() : null,
        infra: manager ? manager.getInfraStatuses() : null,
        config: manager ? manager.getConfig() : null,
        devReverseProxy: opts.devReverseProxy
          ? {
              port: opts.devReverseProxy.port,
              rootDomain: opts.devReverseProxy.rootDomain,
              rootDomains: opts.devReverseProxy.rootDomains,
              // An application service route names its `service`, an infra service route its `infraService`.
              routes: opts.devReverseProxy.routes.map((route) =>
                route.kind === 'package'
                  ? { host: route.host, service: route.package, port: route.port }
                  : { host: route.host, infraService: route.service, port: route.port },
              ),
            }
          : null,
      });
    }
    if (pathname === '/command/quit') {
      manager?.logControl('quit');
      // Blocking quit: hold the response open and let the graceful shutdown path
      // ack it (via ackQuit) once services are torn down and their ports freed —
      // so a caller (notably a newer session handing off) knows the ports are
      // clear before it starts. `Connection: close` lets close() reclaim the
      // socket the moment we finally respond. A shutdown that hard-exits before
      // acking (e.g. no manager attached yet) just drops the held request; the
      // caller falls back to polling this pid.
      res.setHeader('Connection', 'close');
      pendingQuits.push(res);
      return void onQuit();
    }
    if (pathname === '/') {
      return send(res, 200, { ok: true, pid: process.pid, attached: Boolean(manager) });
    }

    if (!manager) {
      return send(res, 503, { error: 'manager not attached' });
    }

    // `/command/service/<action>/<name>`: a restart or rebuild is accepted at once and runs on;
    // a start or stop answers once it's done, so a caller that stops a service knows its process
    // has exited.
    if (parts[0] === 'command' && parts[1] === 'service' && parts[2] && parts[3]) {
      const action = parts[2] as ServiceAction;
      const name = parts[3];
      if (!SERVICE_ACTIONS.includes(action)) {
        return send(res, 404, { ok: false, error: `unknown service action "${parts[2]}"` });
      }
      manager.logControl(action, { service: name });
      void manager.runPackage(name, action).then(
        (outcome) => {
          switch (outcome) {
            case 'done':
              return send(res, 200, { ok: true });
            case 'accepted':
              return send(res, 202, { ok: true });
            case 'busy':
              return send(res, 409, {
                ok: false,
                error: `service "${name}" is restarting or rebuilding`,
              });
            case 'unavailable':
              return send(res, 409, {
                ok: false,
                error:
                  action === 'rebuild'
                    ? `service "${name}" has no clean rebuild`
                    : `service "${name}" has no dev command`,
              });
            case 'failed':
              return send(res, 500, {
                ok: false,
                error: `service "${name}" could not be added: a build failed (see the session log)`,
              });
            case 'unknown':
              return send(res, 404, { ok: false, error: `no service "${name}" in this session` });
          }
        },
        (err: unknown) =>
          send(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
      return;
    }
    // `/command/infra/<action>/<service>`: accepted at once, like a service restart — the
    // service's status on `/query/status` shows the action under way, then where it ended.
    if (parts[0] === 'command' && parts[1] === 'infra' && parts[2] && parts[3]) {
      const action = parts[2] as InfraAction;
      if (!INFRA_ACTIONS.includes(action)) {
        return send(res, 404, { error: `unknown infra action "${parts[2]}"` });
      }
      manager.logControl(`infra ${action}`, { infraService: parts[3] });
      const outcome = manager.runInfra(parts[3], action);
      return outcome === 'accepted'
        ? send(res, 202, { ok: true })
        : outcome === 'busy'
          ? send(res, 409, { ok: false, error: `infra service "${parts[3]}" is busy` })
          : send(res, 404, { ok: false, error: `no infra service "${parts[3]}" in this session` });
    }
    send(res, 404, { error: 'not found' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', resolve);
  });
  const actualPort = (server.address() as { port: number }).port;

  return {
    attach: (m) => {
      manager = m;
    },
    setOnQuit: (fn) => {
      onQuit = fn;
    },
    ackQuit: flushQuits,
    close: () => {
      // Answer any still-held quit request before closing, so server.close()
      // never blocks waiting on an un-responded socket.
      flushQuits();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
    port: actualPort,
  };
}
