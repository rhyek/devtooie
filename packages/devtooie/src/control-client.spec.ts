import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createControlClient, connectControlClient, probeInstance } from './control-client.js';
import { writeRunning } from './running.js';

const servers: http.Server[] = [];
const tmpDirs: string[] = [];

function startServer(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  );
}

function tmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-client-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SNAPSHOT = {
  pid: 4242,
  configPath: '/ws/devtooie.config.ts',
  logFile: '/ws/node_modules/.devtooie/logs/171.log',
  packages: { web: 'running' },
  config: { packages: [] },
};

describe('createControlClient', () => {
  it('queryStatus() returns the parsed session snapshot', async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(SNAPSHOT));
    });
    const status = await createControlClient(port).queryStatus();
    expect(status).toEqual(SNAPSHOT);
  });

  it('queryStatus() returns null when the response lacks pid/configPath (old version)', async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ web: 'running' }));
    });
    expect(await createControlClient(port).queryStatus()).toBeNull();
  });

  it('queryStatus() returns null when nothing is listening', async () => {
    const port = await startServer((_req, res) => res.end('{}'));
    await new Promise<void>((r) => servers.splice(0)[0]!.close(() => r())); // free the port
    expect(await createControlClient(port, 200).queryStatus()).toBeNull();
  });

  it('restart() returns true on 202 and false on 404', async () => {
    const port = await startServer((req, res) => {
      const ok = req.url === '/command/restart/web';
      res.writeHead(ok ? 202 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok }));
    });
    const client = createControlClient(port);
    expect(await client.restart('web')).toBe(true);
    expect(await client.restart('nope')).toBe(false);
  });

  it('quit() POSTs /command/quit and returns the ok ack', async () => {
    let hit: { method?: string; url?: string } = {};
    const port = await startServer((req, res) => {
      hit = { method: req.method, url: req.url };
      res.end('{"ok":true}');
    });
    expect(await createControlClient(port).quit()).toBe(true);
    expect(hit).toEqual({ method: 'POST', url: '/command/quit' });
  });
});

describe('connectControlClient', () => {
  it('returns null when there is no running.json', async () => {
    expect(await connectControlClient(tmpWorkspace())).toBeNull();
  });

  it('returns null when the recorded port is not listening', async () => {
    const cwd = tmpWorkspace();
    const port = await startServer((_req, res) => res.end('{}'));
    await new Promise<void>((r) => servers.splice(0)[0]!.close(() => r())); // free it
    writeRunning(cwd, { port, pid: 1 });
    expect(await connectControlClient(cwd)).toBeNull();
  });

  it('returns a client bound to the live instance', async () => {
    const cwd = tmpWorkspace();
    const port = await startServer((_req, res) => res.end(JSON.stringify(SNAPSHOT)));
    writeRunning(cwd, { port, pid: SNAPSHOT.pid });
    const client = await connectControlClient(cwd);
    expect(client?.port).toBe(port);
    expect(await client!.queryStatus()).toEqual(SNAPSHOT);
  });
});

describe('probeInstance', () => {
  it('maps a live status to InstanceInfo', async () => {
    const port = await startServer((_req, res) => res.end(JSON.stringify(SNAPSHOT)));
    expect(await probeInstance(port)).toEqual({
      pid: SNAPSHOT.pid,
      configPath: SNAPSHOT.configPath,
    });
  });

  it('returns null for a non-devtooie / invalid response', async () => {
    const port = await startServer((_req, res) => res.end('not json'));
    expect(await probeInstance(port)).toBeNull();
  });
});
