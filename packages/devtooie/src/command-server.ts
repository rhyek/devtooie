import http from 'node:http';

export interface ControlManager {
  getAllStatuses(): unknown;
  /** The whole resolved config (defaults applied), included in `/query/status` once attached. */
  getConfig(): unknown;
  /** Absolute path to the logfile currently being written (rotation-aware). */
  getLogFile(): string;
  restart(pkg: string): boolean;
  rebuild(pkg: string): boolean;
  quit(): void;
  /**
   * Emit a `[dt:control]` log line noting a mutating command arrived over the
   * control API (as opposed to the same action triggered by a UI hotkey).
   * `pkg`, when given, scopes the line to that package for output filtering.
   */
  logControl(message: string, pkg?: string): void;
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
   * shutdown path calls this once packages are torn down; a no-op when nothing
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
    // The single consolidated query endpoint. `pid`/`configPath`/`logFile` are available even
    // before the process manager attaches (from the server's own opts); `packages`/`config`
    // — and the rotation-aware `logFile` — come from the manager once it does.
    if (pathname === '/query/status') {
      return send(res, 200, {
        pid: process.pid,
        configPath: opts.configPath ?? null,
        logFile: manager ? manager.getLogFile() : (opts.logFile ?? null),
        packages: manager ? manager.getAllStatuses() : null,
        config: manager ? manager.getConfig() : null,
      });
    }
    if (pathname === '/command/quit') {
      manager?.logControl('quit');
      // Blocking quit: hold the response open and let the graceful shutdown path
      // ack it (via ackQuit) once packages are torn down and their ports freed —
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

    if (parts[0] === 'command' && (parts[1] === 'restart' || parts[1] === 'rebuild') && parts[2]) {
      manager.logControl(`${parts[1]} ${parts[2]}`, parts[2]);
      const ok = parts[1] === 'restart' ? manager.restart(parts[2]) : manager.rebuild(parts[2]);
      return send(res, ok ? 202 : 404, { ok });
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
