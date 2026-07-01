import { describe, it, expect, afterEach } from 'vitest';
import { startCommandServer } from './command-server.js';

let server: Awaited<ReturnType<typeof startCommandServer>> | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('command-server', () => {
  it('serves pid always and 503 for status before attach', async () => {
    let quit = false;
    server = await startCommandServer({
      onQuit: () => {
        quit = true;
      },
      port: 0,
    });
    const base = `http://127.0.0.1:${server.port}`;

    const pid = await fetch(`${base}/query/pid`).then((r) => r.json() as Promise<{ pid: number }>);
    expect(pid.pid).toBe(process.pid);

    const status = await fetch(`${base}/query/status`);
    expect(status.status).toBe(503);

    await fetch(`${base}/command/quit`, { method: 'POST' });
    expect(quit).toBe(true);
  });

  it('serves status after attach', async () => {
    server = await startCommandServer({ onQuit: () => {}, port: 0 });
    server.attach({
      getAllStatuses: () => ({ web: 'running' }),
      getStatus: () => 'running',
      getServices: () => [],
      restart: () => true,
      rebuild: () => true,
      quit: () => {},
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/query/status`);
    expect(res.status).toBe(200);
  });

  it('POST /command/restart/<known-app> returns 202', async () => {
    server = await startCommandServer({ onQuit: () => {}, port: 0 });
    server.attach({
      getAllStatuses: () => ({}),
      getStatus: () => null,
      getServices: () => [],
      restart: (name: string) => name === 'web',
      rebuild: () => false,
      quit: () => {},
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/command/restart/web`, {
      method: 'POST',
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('POST /command/restart/<unknown-app> returns 404', async () => {
    server = await startCommandServer({ onQuit: () => {}, port: 0 });
    server.attach({
      getAllStatuses: () => ({}),
      getStatus: () => null,
      getServices: () => [],
      restart: (name: string) => name === 'web',
      rebuild: () => false,
      quit: () => {},
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/command/restart/unknown`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it('POST /command/rebuild/<known-app> returns 202', async () => {
    server = await startCommandServer({ onQuit: () => {}, port: 0 });
    server.attach({
      getAllStatuses: () => ({}),
      getStatus: () => null,
      getServices: () => [],
      restart: () => false,
      rebuild: (name: string) => name === 'web',
      quit: () => {},
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/command/rebuild/web`, {
      method: 'POST',
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('setOnQuit swaps which handler /command/quit invokes', async () => {
    let firstCalled = false;
    let secondCalled = false;
    server = await startCommandServer({
      onQuit: () => {
        firstCalled = true;
      },
      port: 0,
    });
    server.setOnQuit(() => {
      secondCalled = true;
    });
    await fetch(`http://127.0.0.1:${server.port}/command/quit`, { method: 'POST' });
    expect(secondCalled).toBe(true);
    expect(firstCalled).toBe(false);
  });

  it('GET /query/pid/ with trailing slash returns 200', async () => {
    server = await startCommandServer({ onQuit: () => {}, port: 0 });
    const res = await fetch(`http://127.0.0.1:${server.port}/query/pid/`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pid: number };
    expect(body.pid).toBe(process.pid);
  });
});
