import http from 'node:http';
import { startedByAgent } from './agent-detection.js';
import {
  EVENTS_HEARTBEAT_MS,
  type SessionEvent,
  type SessionServiceStatus,
} from './control-client.js';
import type { DevReverseProxyServer } from './dev-reverse-proxy.js';
import { currentMode } from './env.js';
import {
  INFRA_ACTIONS,
  type InfraAction,
  type InfraRunOutcome,
  type InfraStatus,
} from './infra/control.js';
import { sessionId } from './running.js';

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
  /**
   * Calls `fn` whenever the statuses, readiness or infra states may have changed (`/events`
   * compares, so a call with nothing changed costs nothing). Returns the unsubscribe.
   */
  subscribeState(fn: () => void): () => void;
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

  // `GET /events` responses, each with what it last told its client.
  const streams = new Set<{ res: http.ServerResponse; last: LiveState }>();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let publishScheduled = false;

  const liveState = (): LiveState => {
    const services = manager ? (manager.getAllStatuses() as Record<string, string>) : null;
    const ready = manager ? manager.getAllReadiness() : null;
    const infra = manager ? manager.getInfraStatuses() : null;
    return { services, ready, infra, sessionReady: isSessionReady(services, ready, infra) };
  };
  const statusBody = () => ({
    pid: process.pid,
    sessionId: sessionId(),
    configPath: opts.configPath ?? null,
    mode: currentMode(),
    startedByAgent: startedByAgent(),
    logFile: manager ? manager.getLogFile() : (opts.logFile ?? null),
    ...liveState(),
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
  const writeEvent = (res: http.ServerResponse, event: SessionEvent) => {
    res.write(`${JSON.stringify(event)}\n`);
  };
  // Changes come in bursts (every logged line is one): one comparison per turn of the loop.
  const schedulePublish = () => {
    if (publishScheduled || streams.size === 0) {
      return;
    }
    publishScheduled = true;
    setImmediate(() => {
      publishScheduled = false;
      const next = liveState();
      for (const stream of streams) {
        for (const event of stateChanges(stream.last, next)) {
          writeEvent(stream.res, event);
        }
        stream.last = next;
      }
    });
  };
  const openStream = (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    const body = statusBody();
    const stream = { res, last: liveState() };
    streams.add(stream);
    writeEvent(res, { type: 'snapshot', ...body } as SessionEvent);
    heartbeat ??= setInterval(() => {
      for (const { res: open } of streams) {
        writeEvent(open, { type: 'heartbeat', at: Date.now() });
      }
    }, EVENTS_HEARTBEAT_MS).unref();
    req.on('close', () => {
      streams.delete(stream);
      if (streams.size === 0 && heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    });
  };
  const endStreams = () => {
    for (const { res } of streams) {
      res.end();
    }
    streams.clear();
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
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
      return send(res, 200, statusBody());
    }
    // A long-lived stream of JSON lines: the snapshot, then each change, and a heartbeat.
    if (pathname === '/events') {
      return openStream(req, res);
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
      return onQuit();
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
      unsubscribe = m.subscribeState(schedulePublish);
      schedulePublish();
    },
    setOnQuit: (fn) => {
      onQuit = fn;
    },
    ackQuit: flushQuits,
    close: () => {
      // Answer any still-held quit request before closing, so server.close()
      // never blocks waiting on an un-responded socket.
      flushQuits();
      // An open `/events` stream would hold `server.close()` for as long as its client listens.
      endStreams();
      unsubscribe?.();
      unsubscribe = null;
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
    port: actualPort,
  };
}

/** What `/events` compares between one change and the next. */
interface LiveState {
  services: Record<string, string> | null;
  ready: Record<string, boolean> | null;
  infra: Record<string, InfraStatus> | null;
  sessionReady: boolean;
}

/**
 * Whether a session is ready as a whole: attached, every infra service running, and every service
 * that isn't stopped ready.
 */
function isSessionReady(
  services: Record<string, string> | null,
  ready: Record<string, boolean> | null,
  infra: Record<string, InfraStatus> | null,
): boolean {
  if (!services) {
    return false;
  }
  if (infra && Object.values(infra).some((state) => state !== 'running')) {
    return false;
  }
  return Object.entries(services).every(
    ([name, status]) => status === 'stopped' || ready?.[name] === true,
  );
}

/** The `/events` lines that take a client from `prev` to `next`. */
function stateChanges(prev: LiveState, next: LiveState): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const [service, status] of Object.entries(next.services ?? {})) {
    const ready = next.ready?.[service] === true;
    if (prev.services?.[service] !== status || (prev.ready?.[service] === true) !== ready) {
      events.push({ type: 'service', service, status: status as SessionServiceStatus, ready });
    }
  }
  for (const [service, status] of Object.entries(next.infra ?? {})) {
    if (prev.infra?.[service] !== status) {
      events.push({ type: 'infra', service, status });
    }
  }
  if (prev.sessionReady !== next.sessionReady) {
    events.push({ type: 'session', ready: next.sessionReady });
  }
  return events;
}
