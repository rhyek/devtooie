import http from 'node:http';

export interface ControlManager {
  getAllStatuses(): unknown;
  getStatus(pkg: string): unknown;
  getPackages(filter?: string): unknown;
  restart(pkg: string): boolean;
  rebuild(pkg: string): boolean;
  quit(): void;
}

export async function startCommandServer(opts: {
  onQuit: () => void;
  port: number;
  /** Absolute path to the config this session started with; surfaced on `/query/pid` for handoff. */
  configPath?: string;
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
  close(): Promise<void>;
  port: number;
}> {
  let manager: ControlManager | null = null;
  let onQuit = opts.onQuit;
  const send = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    // Localhost-only convenience API: HTTP methods are intentionally not enforced.
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const parts = pathname.split('/').filter(Boolean);
    if (pathname === '/query/pid')
      return send(res, 200, { pid: process.pid, configPath: opts.configPath });
    if (pathname === '/command/quit') {
      send(res, 200, { ok: true });
      return void onQuit();
    }
    if (pathname === '/')
      return send(res, 200, { ok: true, pid: process.pid, attached: Boolean(manager) });

    if (!manager) return send(res, 503, { error: 'manager not attached' });

    if (parts[0] === 'query' && parts[1] === 'status') {
      return send(res, 200, parts[2] ? manager.getStatus(parts[2]) : manager.getAllStatuses());
    }
    if (parts[0] === 'query' && parts[1] === 'packages') {
      return send(res, 200, manager.getPackages(url.searchParams.get('status') ?? undefined));
    }
    if (parts[0] === 'command' && (parts[1] === 'restart' || parts[1] === 'rebuild') && parts[2]) {
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    port: actualPort,
  };
}
