import { describe, it, expect, afterEach, test, vi } from 'vitest';
import { startCommandServer, type ControlManager } from './command-server.js';

let server: Awaited<ReturnType<typeof startCommandServer>> | null = null;
afterEach(async () => {
  vi.unstubAllEnvs();
  await server?.close();
  server = null;
});

function fakeManager(overrides: Partial<ControlManager> = {}): ControlManager {
  return {
    getAllStatuses: () => ({}),
    getConfig: () => null,
    getLogFile: () => '/manager/current.log',
    restart: () => true,
    rebuild: () => true,
    getInfraStatuses: () => null,
    runInfra: () => 'accepted',
    quit: () => {},
    logControl: () => {},
    ...overrides,
  };
}

describe('command-server', () => {
  it('GET /query/status serves identity with null packages/config before attach', async () => {
    vi.stubEnv('DEVTOOIE_MODE', 'test');
    server = await startCommandServer({
      onQuit: () => {},
      port: 0,
      configPath: '/ws/devtooie.config.ts',
      logFile: '/ws/logs/1.log',
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/query/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pid: process.pid,
      configPath: '/ws/devtooie.config.ts',
      mode: 'test',
      startedByAgent: expect.any(Boolean),
      logFile: '/ws/logs/1.log',
      packages: null,
      infra: null,
      config: null,
      devReverseProxy: null,
    });
  });

  test('GET /query/status reports the dev reverse proxy routes from the start', async () => {
    server = await startCommandServer({
      onQuit: () => {},
      port: 0,
      devReverseProxy: {
        port: 4000,
        rootDomain: 'example.test',
        rootDomains: ['example.test', 'example.localhost'],
        routes: [
          { kind: 'package', host: 'web.example.test', package: 'web', port: 3000, hasHealthcheck: true }, // prettier-ignore
          {
            kind: 'package',
            host: 'example.test',
            package: 'web',
            port: 3000,
            hasHealthcheck: true,
          },
          { kind: 'service', host: 'mail.example.test', service: 'mail', port: 8025 },
        ],
      },
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/query/status`);
    expect(res.status).toBe(200);
    // Present before any manager attaches, and only the routing-relevant fields of a route.
    const body = (await res.json()) as { devReverseProxy: unknown };
    expect(body.devReverseProxy).toEqual({
      port: 4000,
      rootDomain: 'example.test',
      rootDomains: ['example.test', 'example.localhost'],
      routes: [
        { host: 'web.example.test', package: 'web', port: 3000 },
        { host: 'example.test', package: 'web', port: 3000 },
        // a service route names its `service` instead
        { host: 'mail.example.test', service: 'mail', port: 8025 },
      ],
    });
  });

  it('GET /query/status reflects the manager after attach (rotation-aware logFile)', async () => {
    vi.stubEnv('DEVTOOIE_MODE', '');
    server = await startCommandServer({
      onQuit: () => {},
      port: 0,
      configPath: '/ws/devtooie.config.ts',
      logFile: '/ws/logs/1.log',
    });
    server.attach(
      fakeManager({
        getAllStatuses: () => ({ web: 'running' }),
        getConfig: () => ({ packages: [] }),
        getLogFile: () => '/ws/logs/2-rotated.log',
      }),
    );
    const res = await fetch(`http://127.0.0.1:${server.port}/query/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pid: process.pid,
      configPath: '/ws/devtooie.config.ts',
      mode: 'development',
      startedByAgent: expect.any(Boolean),
      logFile: '/ws/logs/2-rotated.log',
      packages: { web: 'running' },
      infra: null,
      config: { packages: [] },
      devReverseProxy: null,
    });
  });

  it('trailing slash on /query/status still resolves', async () => {
    server = await startCommandServer({ onQuit: () => {}, port: 0, configPath: '/ws/c.ts' });
    const res = await fetch(`http://127.0.0.1:${server.port}/query/status/`);
    expect(res.status).toBe(200);
  });

  it('removed query subpaths return 404', async () => {
    server = await startCommandServer({ onQuit: () => {}, port: 0, configPath: '/ws/c.ts' });
    server.attach(fakeManager());
    const base = `http://127.0.0.1:${server.port}`;
    for (const p of ['/query/pid', '/query/config', '/query/packages', '/query/status/web']) {
      expect((await fetch(`${base}${p}`)).status, p).toBe(404);
    }
  });

  it('POST /command/restart/<known-pkg> returns 202, unknown returns 404', async () => {
    server = await startCommandServer({ onQuit: () => {}, port: 0 });
    server.attach(fakeManager({ restart: (name) => name === 'web' }));
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/command/restart/web`, { method: 'POST' })).status).toBe(202);
    expect((await fetch(`${base}/command/restart/nope`, { method: 'POST' })).status).toBe(404);
  });

  test('GET /query/status reports the infra services, and POST /command/infra/<action>/<service> runs one', async () => {
    server = await startCommandServer({ onQuit: () => {}, port: 0 });
    const runs: string[] = [];
    const logged: unknown[] = [];
    server.attach(
      fakeManager({
        getInfraStatuses: () => ({ db: 'running', cache: 'restarting' }),
        runInfra: (service, action) => {
          runs.push(`${action} ${service}`);
          return service === 'db' ? 'accepted' : service === 'cache' ? 'busy' : 'unknown';
        },
        logControl: (command, attrs) => logged.push({ command, attrs }),
      }),
    );
    const base = `http://127.0.0.1:${server.port}`;
    const status = (await (await fetch(`${base}/query/status`)).json()) as { infra: unknown };
    expect(status.infra).toEqual({ db: 'running', cache: 'restarting' });
    const post = (p: string) => fetch(`${base}${p}`, { method: 'POST' });
    expect((await post('/command/infra/reset/db')).status).toBe(202);
    expect((await post('/command/infra/stop/cache')).status).toBe(409);
    expect((await post('/command/infra/start/mail')).status).toBe(404);
    expect((await post('/command/infra/explode/db')).status).toBe(404);
    expect(runs).toEqual(['reset db', 'stop cache', 'start mail']);
    expect(logged[0]).toEqual({ command: 'infra reset', attrs: { service: 'db' } });
  });

  it('POST /command/rebuild/<known-pkg> returns 202', async () => {
    server = await startCommandServer({ onQuit: () => {}, port: 0 });
    server.attach(fakeManager({ rebuild: (name) => name === 'web' }));
    const res = await fetch(`http://127.0.0.1:${server.port}/command/rebuild/web`, {
      method: 'POST',
    });
    expect(res.status).toBe(202);
  });

  it('mutating commands 503 before the manager attaches', async () => {
    server = await startCommandServer({ onQuit: () => {}, port: 0 });
    const res = await fetch(`http://127.0.0.1:${server.port}/command/restart/web`, {
      method: 'POST',
    });
    expect(res.status).toBe(503);
  });

  it('quit works before attach and acks once shutdown releases it', async () => {
    let quit = false;
    // The real shutdown path acks after tearing packages down; a test stub acks inline.
    server = await startCommandServer({
      onQuit: () => {
        quit = true;
        server!.ackQuit();
      },
      port: 0,
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/command/quit`, { method: 'POST' });
    expect(quit).toBe(true);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('holds the /command/quit response open until ackQuit (blocking shutdown)', async () => {
    // onQuit does NOT ack, so the request must stay pending until we ack explicitly.
    server = await startCommandServer({ onQuit: () => {}, port: 0 });
    const s = server;
    const quitP = fetch(`http://127.0.0.1:${s.port}/command/quit`, { method: 'POST' }).then((r) =>
      r.json(),
    );
    const settledEarly = await Promise.race([
      quitP.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 150)),
    ]);
    expect(settledEarly).toBe(false); // still blocked on the ack
    s.ackQuit();
    expect(await quitP).toEqual({ ok: true });
  });

  it('logs each mutating command with its variables as attrs', async () => {
    const logged: { command: string; attrs?: Record<string, unknown> }[] = [];
    server = await startCommandServer({ onQuit: () => server!.ackQuit(), port: 0 });
    server.attach(fakeManager({ logControl: (command, attrs) => logged.push({ command, attrs }) }));
    const base = `http://127.0.0.1:${server.port}`;
    await fetch(`${base}/command/restart/web`, { method: 'POST' });
    await fetch(`${base}/command/rebuild/api`, { method: 'POST' });
    await fetch(`${base}/command/quit`, { method: 'POST' });
    expect(logged).toEqual([
      { command: 'restart', attrs: { package: 'web' } },
      { command: 'rebuild', attrs: { package: 'api' } },
      { command: 'quit', attrs: undefined },
    ]);
  });

  it('setOnQuit swaps which handler /command/quit invokes', async () => {
    let firstCalled = false;
    let secondCalled = false;
    server = await startCommandServer({ onQuit: () => (firstCalled = true), port: 0 });
    server.setOnQuit(() => {
      secondCalled = true;
      server!.ackQuit();
    });
    await fetch(`http://127.0.0.1:${server.port}/command/quit`, { method: 'POST' });
    expect(secondCalled).toBe(true);
    expect(firstCalled).toBe(false);
  });
});
