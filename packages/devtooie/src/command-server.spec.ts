import { describe, it, expect, afterEach } from 'vitest';
import { startCommandServer, type ControlManager } from './command-server.js';

let server: Awaited<ReturnType<typeof startCommandServer>> | null = null;
afterEach(async () => {
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
    quit: () => {},
    logControl: () => {},
    ...overrides,
  };
}

describe('command-server', () => {
  it('GET /query/status serves identity with null packages/config before attach', async () => {
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
      logFile: '/ws/logs/1.log',
      packages: null,
      config: null,
    });
  });

  it('GET /query/status reflects the manager after attach (rotation-aware logFile)', async () => {
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
      logFile: '/ws/logs/2-rotated.log',
      packages: { web: 'running' },
      config: { packages: [] },
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

  it('logs mutating commands via logControl (restart/rebuild scoped, quit unscoped)', async () => {
    const logged: { message: string; pkg?: string }[] = [];
    server = await startCommandServer({ onQuit: () => server!.ackQuit(), port: 0 });
    server.attach(fakeManager({ logControl: (message, pkg) => logged.push({ message, pkg }) }));
    const base = `http://127.0.0.1:${server.port}`;
    await fetch(`${base}/command/restart/web`, { method: 'POST' });
    await fetch(`${base}/command/rebuild/api`, { method: 'POST' });
    await fetch(`${base}/command/quit`, { method: 'POST' });
    expect(logged).toEqual([
      { message: 'restart web', pkg: 'web' },
      { message: 'rebuild api', pkg: 'api' },
      { message: 'quit', pkg: undefined },
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
