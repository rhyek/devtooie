import http from 'node:http';
import { getApiPort } from './lib.js';

export interface ControlManager {
  getAllStatuses(): unknown;
  getStatus(app: string): unknown;
  getServices(filter?: string): unknown;
  restart(app: string): boolean;
  rebuild(app: string): boolean;
  quit(): void;
}

export async function startCommandServer(opts: {
  onQuit: () => void;
  port?: number;
}): Promise<{ attach(m: ControlManager): void; close(): Promise<void>; port: number }> {
  let manager: ControlManager | null = null;
  const send = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    // Localhost-only convenience API: HTTP methods are intentionally not enforced.
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const parts = pathname.split('/').filter(Boolean);
    if (pathname === '/query/pid') return send(res, 200, { pid: process.pid });
    if (pathname === '/command/quit') {
      send(res, 200, { ok: true });
      return void opts.onQuit();
    }
    if (pathname === '/')
      return send(res, 200, { ok: true, pid: process.pid, attached: Boolean(manager) });

    if (!manager) return send(res, 503, { error: 'manager not attached' });

    if (parts[0] === 'query' && parts[1] === 'status') {
      return send(res, 200, parts[2] ? manager.getStatus(parts[2]) : manager.getAllStatuses());
    }
    if (parts[0] === 'query' && parts[1] === 'services') {
      return send(res, 200, manager.getServices(url.searchParams.get('status') ?? undefined));
    }
    if (parts[0] === 'command' && (parts[1] === 'restart' || parts[1] === 'rebuild') && parts[2]) {
      const ok = parts[1] === 'restart' ? manager.restart(parts[2]) : manager.rebuild(parts[2]);
      return send(res, ok ? 202 : 404, { ok });
    }
    send(res, 404, { error: 'not found' });
  });

  const port = opts.port ?? getApiPort();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = (server.address() as { port: number }).port;

  return {
    attach: (m) => {
      manager = m;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    port: actualPort,
  };
}
