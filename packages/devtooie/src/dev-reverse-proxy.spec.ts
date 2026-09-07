import { describe, test, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import {
  startDevReverseProxy,
  routesFromConfig,
  type DevReverseProxyManager,
  type DevReverseProxyRoute,
  type DevReverseProxyServer,
} from './dev-reverse-proxy.js';
import { defineConfig } from './config.js';

// ---------------------------------------------------------------------------
// Fixtures: real upstream servers on ephemeral ports, a stub manager, and a tiny HTTP client
// that sets the Host header the way a TLS terminator forwarding `*.example.test` would.
// ---------------------------------------------------------------------------

const ROOT = 'example.test';

/** Everything opened by a test, closed in `afterEach` so a failure can't leak a listener. */
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length) {
    await cleanups.pop()!();
  }
});

interface Upstream {
  port: number;
  server: http.Server;
}

/**
 * An upstream that identifies itself: it answers every request with JSON naming itself, the
 * `Host` it saw, the path, and an `x-custom` request header, and mirrors `x-custom` back as a
 * response header. Its `upgrade` handler is a raw websocket echo.
 */
async function upstream(name: string): Promise<Upstream> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-upstream': name,
      ...(req.headers['x-custom'] ? { 'x-custom-echo': String(req.headers['x-custom']) } : {}),
    });
    res.end(
      JSON.stringify({
        upstream: name,
        host: req.headers.host,
        url: req.url,
        custom: req.headers['x-custom'] ?? null,
      }),
    );
  });
  server.on('upgrade', (_req, socket, head) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `x-upstream: ${name}\r\n\r\n`,
    );
    if (head.length) {
      socket.write(head);
    }
    socket.on('data', (chunk) => socket.write(chunk));
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  server.on('connection', (socket) => {
    cleanups.push(() => {
      socket.destroy();
    });
  });
  return { port: (server.address() as net.AddressInfo).port, server };
}

type Status = 'running' | 'stopped' | 'waiting' | 'rebuilding' | 'restarting';

interface StubManager extends DevReverseProxyManager {
  set(name: string, status: Status | null): void;
  setReady(name: string, ready: boolean): void;
  logged: string[];
}

function stubManager(initial: Record<string, Status> = {}): StubManager {
  const statuses = new Map<string, Status>(Object.entries(initial));
  const ready = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of listeners) {
      l();
    }
  };
  const logged: string[] = [];
  return {
    logged,
    getStatus: (name) => statuses.get(name) ?? null,
    isReady: (name) => ready.has(name),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    systemLog: { info: (msg: string) => void logged.push(msg) },
    set(name, status) {
      if (status === null) {
        statuses.delete(name);
      } else {
        statuses.set(name, status);
      }
      notify();
    },
    setReady(name, isReady) {
      if (isReady) {
        ready.add(name);
      } else {
        ready.delete(name);
      }
      // Deliberately no notify: the real manager's readiness changes don't wake subscribers
      // either, so the proxy has to poll for this.
    },
  };
}

async function proxyFor(
  routes: DevReverseProxyRoute[],
  opts: {
    defaultPackage?: string;
    readyTimeoutMs?: number;
    controlApiPort?: number;
    urlScheme?: 'http' | 'https';
  } = {},
): Promise<DevReverseProxyServer> {
  const proxy = await startDevReverseProxy({ port: 0, rootDomain: ROOT, routes, ...opts });
  cleanups.push(() => proxy.close());
  return proxy;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A single request through the proxy, with `host` as the Host header. */
function request(
  proxyPort: number,
  host: string,
  opts: { path?: string; headers?: Record<string, string>; method?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/',
        headers: { host, ...opts.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Opens a raw websocket-style upgrade through the proxy; resolves once the 101 arrives. */
function upgrade(
  proxyPort: number,
  host: string,
): Promise<{ socket: net.Socket; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/ws',
      headers: { host, connection: 'Upgrade', upgrade: 'websocket' },
    });
    req.on('upgrade', (res, socket) => {
      cleanups.push(() => {
        socket.destroy();
      });
      resolve({ socket, res });
    });
    req.on('response', (res) => reject(new Error(`upgrade refused: ${String(res.statusCode)}`)));
    req.on('error', reject);
    req.end();
  });
}

const route = (
  host: string,
  pkg: string,
  port: number,
  hasHealthcheck = false,
): DevReverseProxyRoute => ({ host, package: pkg, port, hasHealthcheck });

// ---------------------------------------------------------------------------

describe('routing', () => {
  test('routes by canonical subdomain, alias, and the bare root to defaultPackage', async () => {
    const web = await upstream('web');
    const api = await upstream('api');
    const proxy = await proxyFor(
      [
        route(`web.${ROOT}`, 'web', web.port),
        route(`www.${ROOT}`, 'web', web.port),
        route(ROOT, 'web', web.port),
        route(`api.${ROOT}`, 'api', api.port),
      ],
      { defaultPackage: 'web' },
    );
    proxy.attach(stubManager({ web: 'running', api: 'running' }));

    for (const [host, expected] of [
      [`web.${ROOT}`, 'web'],
      [`www.${ROOT}`, 'web'],
      [ROOT, 'web'],
      [`api.${ROOT}`, 'api'],
    ] as const) {
      const reply = await request(proxy.port, host, { path: '/todos?x=1' });
      expect(reply.status).toBe(200);
      expect(reply.headers['x-upstream']).toBe(expected);
      expect(JSON.parse(reply.body)).toMatchObject({ upstream: expected, url: '/todos?x=1' });
    }
  });

  test('ignores a :port suffix on the Host header when routing', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.attach(stubManager({ web: 'running' }));
    const reply = await request(proxy.port, `web.${ROOT}:8443`);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body).host).toBe(`web.${ROOT}:8443`);
  });

  test('404s the bare root when there is no defaultPackage', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.attach(stubManager({ web: 'running' }));
    const reply = await request(proxy.port, ROOT);
    expect(reply.status).toBe(404);
  });

  test.each([`ghost.${ROOT}`, `a.web.${ROOT}`, 'web.other.test', 'localhost'])(
    '404s %s, listing every hostname that does exist',
    async (host) => {
      const web = await upstream('web');
      const api = await upstream('api');
      const proxy = await proxyFor(
        [
          route(`web.${ROOT}`, 'web', web.port),
          route(`www.${ROOT}`, 'web', web.port),
          route(ROOT, 'web', web.port),
          route(`api.${ROOT}`, 'api', api.port),
        ],
        { defaultPackage: 'web', urlScheme: 'http' },
      );
      proxy.attach(stubManager({ web: 'running', api: 'running' }));
      const reply = await request(proxy.port, host, { headers: { accept: 'text/html' } });
      expect(reply.status).toBe(404);
      expect(reply.headers['content-type']).toMatch(/^text\/html/);
      // Listed as the public URLs, so each one is a link that actually works.
      for (const known of [`web.${ROOT}`, `www.${ROOT}`, `api.${ROOT}`, ROOT]) {
        expect(reply.body).toContain(`href="http://${known}:${String(proxy.port)}"`);
      }
      expect(reply.body).toContain(host);
    },
  );
});

describe('forwarding', () => {
  test('preserves the Host header and round-trips a custom header both ways', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.attach(stubManager({ web: 'running' }));
    const reply = await request(proxy.port, `web.${ROOT}`, { headers: { 'x-custom': 'abc' } });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ host: `web.${ROOT}`, custom: 'abc' });
    expect(reply.headers['x-custom-echo']).toBe('abc');
    expect(reply.headers['x-upstream']).toBe('web');
  });

  test('streams a chunked response incrementally, before the upstream ends it', async () => {
    let finish!: () => void;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first chunk\n');
      finish = () => res.end('last chunk\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    server.on('connection', (socket) => {
      cleanups.push(() => {
        socket.destroy();
      });
    });
    const port = (server.address() as net.AddressInfo).port;

    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', port)]);
    proxy.attach(stubManager({ web: 'running' }));

    const chunks: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxy.port, path: '/stream', headers: { host: `web.${ROOT}` } },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => chunks.push(chunk));
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.end();
    });
    // The first chunk must reach the client while the upstream response is still open.
    await vi.waitFor(() => expect(chunks.join('')).toContain('first chunk'));
    expect(chunks.join('')).not.toContain('last chunk');
    finish();
    await done;
    expect(chunks.join('')).toBe('first chunk\nlast chunk\n');
  });

  test('reaches an upstream that bound only the IPv6 loopback, as Vite does', async () => {
    // Vite on a modern Node listens on `[::1]` alone; a proxy pinned to 127.0.0.1 is refused.
    const server = http.createServer((_req, res) => res.end('v6'));
    const bound = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(0, '::1', () => resolve(true));
    });
    if (!bound) {
      return; // no IPv6 loopback on this machine — nothing to assert
    }
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    server.on('connection', (socket) => {
      cleanups.push(() => {
        socket.destroy();
      });
    });
    const port = (server.address() as net.AddressInfo).port;
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', port)]);
    proxy.attach(stubManager({ web: 'running' }));
    const reply = await request(proxy.port, `web.${ROOT}`);
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('v6');
  });

  test('turns an upstream refusing the connection into a 502 naming the package and port', async () => {
    // An ephemeral port that nothing listens on: bind, read the number, release it.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const deadPort = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', deadPort)]);
    proxy.attach(stubManager({ web: 'running' }));
    const reply = await request(proxy.port, `web.${ROOT}`, { headers: { accept: 'text/html' } });
    expect(reply.status).toBe(502);
    expect(reply.headers['retry-after']).toBe('1');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.body).toContain('web');
    expect(reply.body).toContain(String(deadPort));
  });
});

describe('websockets', () => {
  test('echoes through a raw upgrade on both sides', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.attach(stubManager({ web: 'running' }));
    const { socket, res } = await upgrade(proxy.port, `web.${ROOT}`);
    expect(res.statusCode).toBe(101);
    expect(res.headers['x-upstream']).toBe('web');

    const echoed = new Promise<string>((resolve) => {
      socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
    });
    socket.write('ping');
    expect(await echoed).toBe('ping');
  });

  test('destroys the socket for a package that is not running', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.attach(stubManager({ web: 'stopped' }));
    await expect(upgrade(proxy.port, `web.${ROOT}`)).rejects.toThrow();
  });

  test('closing the proxy destroys an open websocket', async () => {
    const web = await upstream('web');
    const proxy = await startDevReverseProxy({
      port: 0,
      rootDomain: ROOT,
      routes: [route(`web.${ROOT}`, 'web', web.port)],
    });
    proxy.attach(stubManager({ web: 'running' }));
    const { socket } = await upgrade(proxy.port, `web.${ROOT}`);
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await proxy.close();
    await closed;
  });
});

describe('status-aware responses', () => {
  test.each(['stopped', 'waiting', 'rebuilding', 'restarting'] as const)(
    'replies 503 for a %s package, as HTML when the request accepts it',
    async (status) => {
      const web = await upstream('web');
      const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)], {
        controlApiPort: 14001,
      });
      proxy.attach(stubManager({ web: status }));
      const html = await request(proxy.port, `web.${ROOT}`, {
        headers: { accept: 'text/html,application/xhtml+xml' },
      });
      expect(html.status).toBe(503);
      expect(html.headers['retry-after']).toBe('2');
      expect(html.headers['cache-control']).toBe('no-store');
      expect(html.headers['content-type']).toMatch(/^text\/html/);
      expect(html.body).toContain('web');
      expect(html.body).toContain(status);
      expect(html.body).toContain('/command/restart/web');
      expect(html.body).toContain('14001');
    },
  );

  test('replies 503 as JSON when the request does not accept HTML', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.attach(stubManager({ web: 'stopped' }));
    const json = await request(proxy.port, `web.${ROOT}`, {
      headers: { accept: 'application/json' },
    });
    expect(json.status).toBe(503);
    expect(json.headers['content-type']).toMatch(/^application\/json/);
    expect(JSON.parse(json.body)).toMatchObject({ package: 'web', status: 'stopped' });
  });

  test('replies 503 "starting" before a manager is attached', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    const reply = await request(proxy.port, `web.${ROOT}`);
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toMatchObject({ package: 'web', status: 'starting' });
  });

  test('proxies straight through a running package with no healthcheck', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port, false)]);
    const manager = stubManager({ web: 'running' });
    proxy.attach(manager);
    expect((await request(proxy.port, `web.${ROOT}`)).status).toBe(200);
  });

  test('holds a request to a running-but-not-ready package, then serves it once ready', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port, true)]);
    const manager = stubManager({ web: 'running' });
    proxy.attach(manager);

    let settled = false;
    const pending = request(proxy.port, `web.${ROOT}`).then((reply) => {
      settled = true;
      return reply;
    });
    // Still held after a moment: nothing has said the package is ready.
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);

    manager.setReady('web', true);
    const reply = await pending;
    expect(reply.status).toBe(200);
    expect(reply.headers['x-upstream']).toBe('web');
  });

  test('gives up the hold after the deadline with a 503 "starting"', async () => {
    const web = await upstream('web');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port, true)]);
    const manager = stubManager({ web: 'running' });
    // The proxy subscribes to the manager the moment it starts holding a request — that's the
    // signal the request has arrived (real I/O) and the deadline timer (faked) is registered.
    const held = new Promise<void>((resolve) => {
      const subscribe = manager.subscribe.bind(manager);
      manager.subscribe = (listener) => {
        resolve();
        return subscribe(listener);
      };
    });
    proxy.attach(manager);

    const pending = request(proxy.port, `web.${ROOT}`, { headers: { accept: 'text/html' } });
    await held;
    await vi.advanceTimersByTimeAsync(15_000);
    vi.useRealTimers();

    const reply = await pending;
    expect(reply.status).toBe(503);
    expect(reply.headers['retry-after']).toBe('2');
    expect(reply.body).toContain('starting');
  });

  test('re-checks the status after the hold: a package stopped meanwhile gets the 503', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port, true)]);
    const manager = stubManager({ web: 'running' });
    proxy.attach(manager);
    const pending = request(proxy.port, `web.${ROOT}`, { headers: { accept: 'application/json' } });
    await new Promise((r) => setTimeout(r, 100));
    manager.set('web', 'stopped');
    const reply = await pending;
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toMatchObject({ package: 'web', status: 'stopped' });
  });

  test('logs one devtooie line naming the port, root domain, and every route on attach', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([
      route(`web.${ROOT}`, 'web', web.port),
      route(`www.${ROOT}`, 'web', web.port),
    ]);
    const manager = stubManager({ web: 'running' });
    proxy.attach(manager);
    expect(manager.logged).toHaveLength(1);
    const line = manager.logged[0]!;
    expect(line).toContain(String(proxy.port));
    expect(line).toContain(ROOT);
    expect(line).toContain(`web.${ROOT} → web :${String(web.port)}`);
    expect(line).toContain(`www.${ROOT} → web :${String(web.port)}`);
  });
});

describe('routesFromConfig', () => {
  test('lists every hostname of every routable package, bare root last for defaultPackage', () => {
    const config = defineConfig({
      packageRootDir: 'packages',
      devReverseProxy: { port: 4000, rootDomain: ROOT, defaultPackage: 'web' },
      packages: {
        web: { port: 3000, subdomain: ['web', 'www'], healthcheck: 'http://localhost:3000/' },
        api: { port: 3001, subdomain: 'api' },
        worker: { port: 3002 },
        lib: {},
      },
    });
    expect(routesFromConfig(config)).toEqual([
      { host: `web.${ROOT}`, package: 'web', port: 3000, hasHealthcheck: true },
      { host: `www.${ROOT}`, package: 'web', port: 3000, hasHealthcheck: true },
      { host: ROOT, package: 'web', port: 3000, hasHealthcheck: true },
      { host: `api.${ROOT}`, package: 'api', port: 3001, hasHealthcheck: false },
    ]);
  });

  test('is empty without a proxy block', () => {
    expect(
      routesFromConfig(
        defineConfig({ packageRootDir: 'packages', packages: { web: { port: 3000 } } }),
      ),
    ).toEqual([]);
  });
});
