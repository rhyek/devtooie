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
  logged: [attrs: Record<string, unknown>, message: string][];
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
  const logged: [attrs: Record<string, unknown>, message: string][] = [];
  return {
    logged,
    getStatus: (name) => statuses.get(name) ?? null,
    isReady: (name) => ready.has(name),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    systemLog: {
      info: (attrs: Record<string, unknown>, message: string) => void logged.push([attrs, message]),
    },
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
    defaultService?: string;
    readyTimeoutMs?: number;
    controlApiPort?: number;
    urlScheme?: 'http' | 'https';
    rootDomainAliases?: string[];
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
): DevReverseProxyRoute => ({ kind: 'package', host, package: pkg, port, hasHealthcheck });

const serviceRoute = (host: string, service: string, port: number): DevReverseProxyRoute => ({
  kind: 'service',
  host,
  service,
  port,
});

/** A loopback port nothing listens on: bind an ephemeral one, read the number, release it. */
async function deadPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

// ---------------------------------------------------------------------------

describe('routing', () => {
  test('routes by canonical subdomain, alias, and the bare root to defaultService', async () => {
    const web = await upstream('web');
    const api = await upstream('api');
    const proxy = await proxyFor(
      [
        route(`web.${ROOT}`, 'web', web.port),
        route(`www.${ROOT}`, 'web', web.port),
        route(ROOT, 'web', web.port),
        route(`api.${ROOT}`, 'api', api.port),
      ],
      { defaultService: 'web' },
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

  test('404s the bare root when there is no defaultService', async () => {
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
        { defaultService: 'web', urlScheme: 'http' },
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

// A root-domain alias routes exactly like the canonical root, while everything the proxy reports
// (its route table, the 404 page's links) stays under the canonical one.
describe('root domain aliases', () => {
  const ALIAS = 'example.localhost';

  test('routes subdomains, subdomain aliases and the bare alias, forwarding Host unchanged', async () => {
    const web = await upstream('web');
    const api = await upstream('api');
    const proxy = await proxyFor(
      [
        route(`web.${ROOT}`, 'web', web.port),
        route(`www.${ROOT}`, 'web', web.port),
        route(ROOT, 'web', web.port),
        route(`api.${ROOT}`, 'api', api.port),
      ],
      { defaultService: 'web', rootDomainAliases: [ALIAS] },
    );
    proxy.attach(stubManager({ web: 'running', api: 'running' }));

    for (const [host, expected] of [
      [`web.${ALIAS}`, 'web'],
      [`www.${ALIAS}`, 'web'],
      [ALIAS, 'web'],
      [`api.${ALIAS}:${String(proxy.port)}`, 'api'],
      [`api.${ROOT}`, 'api'],
    ] as const) {
      const reply = await request(proxy.port, host);
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body)).toMatchObject({ upstream: expected, host });
    }
    expect(proxy.rootDomains).toEqual([ROOT, ALIAS]);
    expect(proxy.routes.map((r) => r.host)).toEqual([`web.${ROOT}`, `www.${ROOT}`, ROOT, `api.${ROOT}`]); // prettier-ignore
  });

  test('answers the status pages under the alias, naming the host asked for', async () => {
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', await deadPort())], {
      rootDomainAliases: [ALIAS],
    });
    proxy.attach(stubManager({ web: 'stopped' }));
    const reply = await request(proxy.port, `web.${ALIAS}`);
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toMatchObject({ service: 'web', status: 'stopped', host: `web.${ALIAS}` }); // prettier-ignore
  });

  test('routes an infra service under the alias once the infra is up', async () => {
    const mail = await upstream('mail');
    const proxy = await proxyFor([serviceRoute(`mail.${ROOT}`, 'mail', mail.port)], {
      rootDomainAliases: [ALIAS],
    });
    expect((await request(proxy.port, `mail.${ALIAS}`)).status).toBe(503);
    proxy.markInfraReady();
    const reply = await request(proxy.port, `mail.${ALIAS}`);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ upstream: 'mail', host: `mail.${ALIAS}` });
  });

  test('carries a websocket under the alias', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)], {
      rootDomainAliases: [ALIAS],
    });
    proxy.attach(stubManager({ web: 'running' }));
    const { socket, res } = await upgrade(proxy.port, `web.${ALIAS}`);
    expect(res.headers['x-upstream']).toBe('web');
    const echoed = new Promise<string>((resolve) => socket.once('data', (d: Buffer) => resolve(d.toString()))); // prettier-ignore
    socket.write('ping');
    expect(await echoed).toBe('ping');
  });

  test.each([`ghost.${ALIAS}`, 'web.other.test', `web.${ALIAS}.evil.test`, `web.x${ALIAS}`])(
    '404s %s, listing only the canonical links',
    async (host) => {
      const web = await upstream('web');
      const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)], {
        rootDomainAliases: [ALIAS],
        urlScheme: 'http',
      });
      proxy.attach(stubManager({ web: 'running' }));
      const reply = await request(proxy.port, host, { headers: { accept: 'text/html' } });
      expect(reply.status).toBe(404);
      expect(reply.body).toContain(`href="http://web.${ROOT}:${String(proxy.port)}"`);
      expect(reply.body).not.toContain(`href="http://web.${ALIAS}`);
      // The page names every root it answers under.
      expect(reply.body).toContain(`<code>${ROOT}</code>, <code>${ALIAS}</code>`);
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
    const port = await deadPort();
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', port)]);
    proxy.attach(stubManager({ web: 'running' }));
    const reply = await request(proxy.port, `web.${ROOT}`, { headers: { accept: 'text/html' } });
    expect(reply.status).toBe(502);
    expect(reply.headers['retry-after']).toBe('1');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.body).toContain('web');
    expect(reply.body).toContain(String(port));
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
      expect(html.body).toContain('/command/service/restart/web');
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
    expect(JSON.parse(json.body)).toMatchObject({ service: 'web', status: 'stopped' });
  });

  test('replies 503 "starting" before a manager is attached', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    const reply = await request(proxy.port, `web.${ROOT}`);
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toMatchObject({ service: 'web', status: 'starting' });
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
    expect(JSON.parse(reply.body)).toMatchObject({ service: 'web', status: 'stopped' });
  });

  test('logs one devtooie entry on attach: the listener as the message, one route per attr', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([
      route(`web.${ROOT}`, 'web', web.port),
      route(`www.${ROOT}`, 'web', web.port),
    ]);
    const manager = stubManager({ web: 'running' });
    proxy.attach(manager);
    expect(manager.logged).toHaveLength(1);
    const [attrs, message] = manager.logged[0]!;
    expect(message).toBe(`dev reverse proxy listening on 127.0.0.1:${String(proxy.port)}`);
    // Rendered by the log formatter as `  <host>: <package> :<port>` lines under the message.
    expect(attrs).toEqual({
      [`web.${ROOT}`]: `web :${String(web.port)}`,
      [`www.${ROOT}`]: `web :${String(web.port)}`,
    });
  });
});

describe('infra services', () => {
  /** An upstream that drains the request body and reports what it received. */
  async function bodyCounter(): Promise<number> {
    const server = http.createServer((req, res) => {
      let received = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (received += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ host: req.headers.host, method: req.method, received }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return (server.address() as net.AddressInfo).port;
  }

  test('replies 503 "starting" until the infra step has finished, manager or not', async () => {
    const store = await upstream('store');
    const proxy = await proxyFor([serviceRoute(`s3.${ROOT}`, 'store', store.port)]);
    const before = await request(proxy.port, `s3.${ROOT}`, { headers: { accept: 'application/json' } }); // prettier-ignore
    expect(before.status).toBe(503);
    expect(JSON.parse(before.body)).toMatchObject({ infraService: 'store', status: 'starting' });
    // The process manager attaching is not the signal: packages may be up while infra isn't.
    proxy.attach(stubManager());
    const html = await request(proxy.port, `s3.${ROOT}`, { headers: { accept: 'text/html' } });
    expect(html.status).toBe(503);
    expect(html.headers['retry-after']).toBe('2');
    expect(html.headers['cache-control']).toBe('no-store');
    expect(html.body).toContain('store');
    expect(html.body).toContain('starting');
    // …and no restart hint: there is no package to restart.
    expect(html.body).not.toContain('/command/service/restart');
  });

  test('drops a websocket upgrade until the infra step has finished', async () => {
    const store = await upstream('store');
    const proxy = await proxyFor([serviceRoute(`s3.${ROOT}`, 'store', store.port)]);
    proxy.attach(stubManager());
    await expect(upgrade(proxy.port, `s3.${ROOT}`)).rejects.toThrow();
  });

  test('forwards once the infra step has finished, keeping the Host and custom headers', async () => {
    const store = await upstream('store');
    const proxy = await proxyFor([serviceRoute(`s3.${ROOT}`, 'store', store.port)]);
    proxy.markInfraReady();
    const reply = await request(proxy.port, `s3.${ROOT}`, {
      path: '/bucket/key?X-Amz-Signature=abc',
      headers: { 'x-custom': 'signed' },
    });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({
      upstream: 'store',
      host: `s3.${ROOT}`,
      url: '/bucket/key?X-Amz-Signature=abc',
      custom: 'signed',
    });
    expect(reply.headers['x-custom-echo']).toBe('signed');
  });

  test('streams a request body through to the service, as an upload form needs', async () => {
    const port = await bodyCounter();
    const proxy = await proxyFor([serviceRoute(`s3.${ROOT}`, 'store', port)]);
    proxy.markInfraReady();
    const body = 'x'.repeat(256 * 1024);
    const reply = await new Promise<Reply>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          method: 'POST',
          path: '/bucket',
          headers: { host: `s3.${ROOT}`, 'content-type': 'multipart/form-data; boundary=b' },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text })); // prettier-ignore
        },
      );
      req.on('error', reject);
      // Written in pieces, so it reaches the proxy chunked rather than as one buffer.
      for (let i = 0; i < body.length; i += 16 * 1024) {
        req.write(body.slice(i, i + 16 * 1024));
      }
      req.end();
    });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ host: `s3.${ROOT}`, method: 'POST', received: body });
  });

  test('echoes a websocket upgrade once the infra step has finished', async () => {
    const mail = await upstream('mail');
    const proxy = await proxyFor([serviceRoute(`mail.${ROOT}`, 'mail', mail.port)]);
    proxy.markInfraReady();
    const { socket, res } = await upgrade(proxy.port, `mail.${ROOT}`);
    expect(res.statusCode).toBe(101);
    const echoed = new Promise<string>((resolve) => {
      socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
    });
    socket.write('ping');
    expect(await echoed).toBe('ping');
  });

  test('turns a refused connection into a 502 naming the service and its port', async () => {
    const port = await deadPort();
    const proxy = await proxyFor([serviceRoute(`s3.${ROOT}`, 'store', port)]);
    proxy.markInfraReady();
    const html = await request(proxy.port, `s3.${ROOT}`, { headers: { accept: 'text/html' } });
    expect(html.status).toBe(502);
    expect(html.headers['retry-after']).toBe('1');
    expect(html.body).toContain('infra service store');
    expect(html.body).toContain(String(port));
    const json = await request(proxy.port, `s3.${ROOT}`, { headers: { accept: 'application/json' } }); // prettier-ignore
    expect(JSON.parse(json.body)).toMatchObject({
      infraService: 'store',
      port,
      code: 'ECONNREFUSED',
    });
  });

  test('turns a reset connection into the same 502', async () => {
    const server = net.createServer((socket) => socket.resetAndDestroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;
    const proxy = await proxyFor([serviceRoute(`s3.${ROOT}`, 'store', port)]);
    proxy.markInfraReady();
    const json = await request(proxy.port, `s3.${ROOT}`, { headers: { accept: 'application/json' } }); // prettier-ignore
    expect(json.status).toBe(502);
    expect(JSON.parse(json.body)).toMatchObject({ infraService: 'store', port });
    // A reset that lands while the request is still being written surfaces as EPIPE instead.
    expect(['ECONNRESET', 'EPIPE']).toContain(JSON.parse(json.body).code);
  });

  test("never consults a package's status, even one sharing the service's name", async () => {
    const service = await upstream('service');
    const proxy = await proxyFor([serviceRoute(`api-db.${ROOT}`, 'api', service.port)]);
    proxy.attach(stubManager({ api: 'stopped' }));
    proxy.markInfraReady();
    const reply = await request(proxy.port, `api-db.${ROOT}`);
    expect(reply.status).toBe(200);
    expect(reply.headers['x-upstream']).toBe('service');
  });

  test('lists the service hostnames on the 404 page and in the attach log', async () => {
    const web = await upstream('web');
    const store = await upstream('store');
    const proxy = await proxyFor(
      [route(`web.${ROOT}`, 'web', web.port), serviceRoute(`s3.${ROOT}`, 'store', store.port)],
      { urlScheme: 'https' },
    );
    const manager = stubManager({ web: 'running' });
    proxy.attach(manager);
    const reply = await request(proxy.port, `ghost.${ROOT}`, { headers: { accept: 'text/html' } });
    expect(reply.status).toBe(404);
    expect(reply.body).toContain(`href="https://s3.${ROOT}"`);
    expect(reply.body).toContain(`href="https://web.${ROOT}"`);
    expect(manager.logged[0]![0]).toEqual({
      [`web.${ROOT}`]: `web :${String(web.port)}`,
      [`s3.${ROOT}`]: `infra service store :${String(store.port)}`,
    });
  });
});

describe('routesFromConfig', () => {
  test('lists every hostname of every routable package, bare root last for defaultService', () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000, rootDomain: ROOT, defaultService: 'web' },
      services: {
        web: {
          port: 3000,
          proxy: { subdomain: ['web', 'www'] },
          healthcheck: 'http://localhost:3000/',
        },
        api: { port: 3001, proxy: { subdomain: 'api' } },
        worker: { port: 3002 },
        lib: {},
      },
    });
    expect(routesFromConfig(config)).toEqual([
      { kind: 'package', host: `web.${ROOT}`, package: 'web', port: 3000, hasHealthcheck: true },
      { kind: 'package', host: `www.${ROOT}`, package: 'web', port: 3000, hasHealthcheck: true },
      { kind: 'package', host: ROOT, package: 'web', port: 3000, hasHealthcheck: true },
      { kind: 'package', host: `api.${ROOT}`, package: 'api', port: 3001, hasHealthcheck: false },
    ]);
  });

  test('adds every enabled infra service with a proxy, aliases included, after the packages', () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000, rootDomain: ROOT, defaultService: 'web' },
      infra: {
        'docker-compose': {
          services: {
            store: { port: 9000, proxy: { subdomain: ['s3', 'files'] } },
            mail: { port: 8025, proxy: { subdomain: true } },
            // switched off for the mode: not routed (and its port callback never runs)
            console: {
              enabled: false,
              port: () => Number(undefined),
              proxy: { subdomain: 'console' },
            },
            // a port but no proxy: simply not routed
            db: { port: 5432 },
            cache: {},
          },
        },
      },
      services: { web: { port: 3000, proxy: { subdomain: 'web' } } },
    });
    expect(routesFromConfig(config)).toEqual([
      { kind: 'package', host: `web.${ROOT}`, package: 'web', port: 3000, hasHealthcheck: false },
      { kind: 'package', host: ROOT, package: 'web', port: 3000, hasHealthcheck: false },
      { kind: 'service', host: `s3.${ROOT}`, service: 'store', port: 9000 },
      { kind: 'service', host: `files.${ROOT}`, service: 'store', port: 9000 },
      { kind: 'service', host: `mail.${ROOT}`, service: 'mail', port: 8025 },
    ]);
  });

  test('routes the bare root to a defaultService that declares no proxy, and nothing else', () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000, rootDomain: ROOT, defaultService: 'landing' },
      services: { landing: { port: 3000 }, worker: { port: 3001 } },
    });
    expect(routesFromConfig(config)).toEqual([
      { kind: 'package', host: ROOT, package: 'landing', port: 3000, hasHealthcheck: false },
    ]);
  });

  test('is empty without a proxy block', () => {
    expect(
      routesFromConfig(
        defineConfig({ serviceRootDir: 'packages', services: { web: { port: 3000 } } }),
      ),
    ).toEqual([]);
  });
});
