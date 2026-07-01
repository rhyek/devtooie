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
});
