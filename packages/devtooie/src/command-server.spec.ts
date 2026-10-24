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
    getAllReadiness: () => ({}),
    getConfig: () => null,
    getLogFile: () => '/manager/current.log',
    runPackage: () => Promise.resolve('accepted'),
    getInfraStatuses: () => null,
    runInfra: () => 'accepted',
    quit: () => {},
    logControl: () => {},
    ...overrides,
  };
}

describe('command-server', () => {
  it('GET /query/status serves identity with null services/config before attach', async () => {
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
      services: null,
      ready: null,
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
        { host: 'web.example.test', service: 'web', port: 3000 },
        { host: 'example.test', service: 'web', port: 3000 },
        // an infra service route names its `infraService` instead
        { host: 'mail.example.test', infraService: 'mail', port: 8025 },
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
        getAllReadiness: () => ({ web: true }),
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
      services: { web: 'running' },
      ready: { web: true },
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

  test('POST /command/service/<action>/<name> answers by how the action went', async () => {
    server = await startCommandServer({ onQuit: () => {}, port: 0 });
    const runs: string[] = [];
    server.attach(
      fakeManager({
        runPackage: (name, action) => {
          runs.push(`${action} ${name}`);
          if (name !== 'web' && name !== 'api') {
            return Promise.resolve('unknown');
          }
          if (name === 'api') {
            return Promise.resolve(action === 'rebuild' ? 'unavailable' : 'busy');
          }
          return Promise.resolve(action === 'start' || action === 'stop' ? 'done' : 'accepted');
        },
      }),
    );
    const base = `http://127.0.0.1:${server.port}`;
    const post = async (p: string) => {
      const res = await fetch(`${base}${p}`, { method: 'POST' });
      return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string } };
    };
    expect(await post('/command/service/restart/web')).toEqual({ status: 202, body: { ok: true } });
    expect(await post('/command/service/rebuild/web')).toEqual({ status: 202, body: { ok: true } });
    expect(await post('/command/service/stop/web')).toEqual({ status: 200, body: { ok: true } });
    expect(await post('/command/service/start/web')).toEqual({ status: 200, body: { ok: true } });
    expect(await post('/command/service/stop/api')).toEqual({
      status: 409,
      body: { ok: false, error: 'service "api" is restarting or rebuilding' },
    });
    expect(await post('/command/service/rebuild/api')).toEqual({
      status: 409,
      body: { ok: false, error: 'service "api" has no clean rebuild' },
    });
    expect((await post('/command/service/start/nope')).status).toBe(404);
    expect((await post('/command/service/explode/web')).status).toBe(404);
    expect(runs).toEqual([
      'restart web',
      'rebuild web',
      'stop web',
      'start web',
      'stop api',
      'rebuild api',
      'start nope',
    ]);
  });

  test('POST /command/service/start/<name> answers 500 when adding the service failed its build', async () => {
    server = await startCommandServer({ onQuit: () => {}, port: 0 });
    server.attach(fakeManager({ runPackage: () => Promise.resolve('failed') }));
    const res = await fetch(`http://127.0.0.1:${server.port}/command/service/start/api`, {
      method: 'POST',
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'service "api" could not be added: a build failed (see the session log)',
    });
  });

  test('POST /command/service/stop/<name> answers only once the stop is done', async () => {
    server = await startCommandServer({ onQuit: () => {}, port: 0 });
    let finish!: () => void;
    server.attach(
      fakeManager({
        runPackage: () =>
          new Promise((resolve) => {
            finish = () => resolve('done');
          }),
      }),
    );
    const answer = fetch(`http://127.0.0.1:${server.port}/command/service/stop/web`, {
      method: 'POST',
    }).then((r) => r.status);
    const early = await Promise.race([
      answer.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 150)),
    ]);
    expect(early).toBe(false);
    finish();
    expect(await answer).toBe(200);
  });

  test('the old /command/restart and /command/rebuild routes are gone', async () => {
    server = await startCommandServer({ onQuit: () => {}, port: 0 });
    server.attach(fakeManager());
    const base = `http://127.0.0.1:${server.port}`;
    for (const p of ['/command/restart/web', '/command/rebuild/web']) {
      expect((await fetch(`${base}${p}`, { method: 'POST' })).status, p).toBe(404);
    }
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
    expect(logged[0]).toEqual({ command: 'infra reset', attrs: { infraService: 'db' } });
  });

  it('mutating commands 503 before the manager attaches', async () => {
    server = await startCommandServer({ onQuit: () => {}, port: 0 });
    const res = await fetch(`http://127.0.0.1:${server.port}/command/service/restart/web`, {
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
    await fetch(`${base}/command/service/restart/web`, { method: 'POST' });
    await fetch(`${base}/command/service/stop/api`, { method: 'POST' });
    await fetch(`${base}/command/quit`, { method: 'POST' });
    expect(logged).toEqual([
      { command: 'restart', attrs: { service: 'web' } },
      { command: 'stop', attrs: { service: 'api' } },
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
