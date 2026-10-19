import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  connectControlClient,
  connectSessionControl,
  createControlClient,
  probeInstance,
} from './control-client.js';
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

// Pinned, so a run from inside a devtooie session of another mode can't change the answers.
beforeEach(() => vi.stubEnv('DEVTOOIE_MODE', 'development'));
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SNAPSHOT = {
  pid: 4242,
  configPath: '/ws/devtooie.config.ts',
  mode: 'test',
  startedByAgent: true,
  logFile: '/ws/node_modules/.devtooie/logs/171.log',
  packages: { web: 'running' },
  infra: { db: 'running' },
  config: { packages: [] },
  devReverseProxy: {
    port: 21050,
    rootDomain: 'localhost',
    rootDomains: ['localhost'],
    routes: [{ host: 'web.localhost', package: 'web', port: 3000 }],
  },
};

describe('createControlClient', () => {
  test('query.status() returns the parsed session snapshot', async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(SNAPSHOT));
    });
    const status = await createControlClient(port).query.status();
    expect(status).toEqual(SNAPSHOT);
  });

  test('query.status() returns null when the response lacks pid/configPath (old version)', async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ web: 'running' }));
    });
    expect(await createControlClient(port).query.status()).toBeNull();
  });

  test('query.status() reads a missing startedByAgent as false (pre-0.7.0 instance)', async () => {
    const { startedByAgent: _omitted, ...oldShape } = SNAPSHOT;
    const port = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(oldShape));
    });
    expect(await createControlClient(port).query.status()).toEqual({
      ...oldShape,
      startedByAgent: false,
    });
  });

  test('query.status() reads a missing mode as development (an instance from before per-mode sessions)', async () => {
    const { mode: _omitted, ...oldShape } = SNAPSHOT;
    const port = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(oldShape));
    });
    expect(await createControlClient(port).query.status()).toEqual({ ...oldShape, mode: 'development' }); // prettier-ignore
  });

  test('query.status() returns null when nothing is listening', async () => {
    const port = await startServer((_req, res) => res.end('{}'));
    await new Promise<void>((r) => servers.splice(0)[0]!.close(() => r())); // free the port
    expect(await createControlClient(port, 200).query.status()).toBeNull();
  });

  test('command.restart() returns true on 202 and false on 404', async () => {
    const port = await startServer((req, res) => {
      const ok = req.url === '/command/restart/web';
      res.writeHead(ok ? 202 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok }));
    });
    const client = createControlClient(port);
    expect(await client.command.restart('web')).toBe(true);
    expect(await client.command.restart('nope')).toBe(false);
  });

  test('command.infra() posts the action and service, and is false for a busy or unknown one', async () => {
    const hits: string[] = [];
    const port = await startServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      const code =
        req.url === '/command/infra/reset/db' ? 202 : req.url?.endsWith('/cache') ? 404 : 409;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: code === 202 }));
    });
    const client = createControlClient(port);
    expect(await client.command.infra('reset', 'db')).toBe(true);
    expect(await client.command.infra('stop', 'db')).toBe(false);
    expect(await client.command.infra('start', 'cache')).toBe(false);
    expect(hits).toEqual([
      'POST /command/infra/reset/db',
      'POST /command/infra/stop/db',
      'POST /command/infra/start/cache',
    ]);
  });

  test('query.status() reads a missing infra as null', async () => {
    const { infra: _omitted, ...noInfra } = SNAPSHOT;
    const port = await startServer((_req, res) => res.end(JSON.stringify(noInfra)));
    expect(await createControlClient(port).query.status()).toEqual({ ...noInfra, infra: null });
  });

  test('query.status() reads a missing devReverseProxy as null', async () => {
    const { devReverseProxy: _omitted, ...noProxy } = SNAPSHOT;
    const port = await startServer((_req, res) => res.end(JSON.stringify(noProxy)));
    expect(await createControlClient(port).query.status()).toEqual({
      ...noProxy,
      devReverseProxy: null,
    });
  });

  test('command.quit() POSTs /command/quit and returns the ok ack', async () => {
    let hit: { method?: string; url?: string } = {};
    const port = await startServer((req, res) => {
      hit = { method: req.method, url: req.url };
      res.end('{"ok":true}');
    });
    expect(await createControlClient(port).command.quit()).toBe(true);
    expect(hit).toEqual({ method: 'POST', url: '/command/quit' });
  });
});

describe('connectControlClient', () => {
  test('returns null when there is no running.json', async () => {
    expect(await connectControlClient(tmpWorkspace())).toBeNull();
  });

  test('returns null when the recorded port is not listening', async () => {
    const cwd = tmpWorkspace();
    const port = await startServer((_req, res) => res.end('{}'));
    await new Promise<void>((r) => servers.splice(0)[0]!.close(() => r())); // free it
    writeRunning(cwd, { port, pid: 1 });
    expect(await connectControlClient(cwd)).toBeNull();
  });

  test('returns a client bound to the live instance', async () => {
    const cwd = tmpWorkspace();
    const port = await startServer((_req, res) => res.end(JSON.stringify(SNAPSHOT)));
    writeRunning(cwd, { port, pid: SNAPSHOT.pid });
    const client = await connectControlClient(cwd);
    expect(client?.port).toBe(port);
    expect(await client!.query.status()).toEqual(SNAPSHOT);
  });

  test("finds the given mode's session, not another mode's", async () => {
    const cwd = tmpWorkspace();
    const port = await startServer((_req, res) => res.end(JSON.stringify(SNAPSHOT)));
    writeRunning(cwd, { port, pid: SNAPSHOT.pid }, 'test');
    expect(await connectControlClient(cwd)).toBeNull();
    expect((await connectControlClient(cwd, 'test'))?.port).toBe(port);
  });
});

describe('connectSessionControl', () => {
  /** A workspace whose `running.test.json` points at a live server answering `status`. */
  async function session(status: Record<string, unknown>, record: { pid: number } = SNAPSHOT) {
    const workspaceDir = tmpWorkspace();
    const configPath = path.join(workspaceDir, 'devtooie.config.ts');
    fs.writeFileSync(configPath, '');
    const port = await startServer((_req, res) =>
      res.end(JSON.stringify({ ...SNAPSHOT, configPath, ...status })),
    );
    writeRunning(workspaceDir, { port, pid: record.pid }, 'test');
    return { workspaceDir, configPath, port };
  }

  test("binds to this config's session in this mode", async () => {
    const { workspaceDir, configPath, port } = await session({});
    const client = await connectSessionControl({ workspaceDir, configPath, mode: 'test' });
    expect(client?.port).toBe(port);
  });

  test("leaves another project's session alone, though it answers on the recorded port", async () => {
    const { workspaceDir, configPath } = await session({
      configPath: '/elsewhere/devtooie.config.ts',
    });
    expect(await connectSessionControl({ workspaceDir, configPath, mode: 'test' })).toBeUndefined();
  });

  test('leaves a session of another mode alone', async () => {
    const { workspaceDir, configPath } = await session({ mode: 'development' });
    expect(await connectSessionControl({ workspaceDir, configPath, mode: 'test' })).toBeUndefined();
  });

  test('is undefined when the session answering is not the one recorded', async () => {
    const { workspaceDir, configPath } = await session({}, { pid: 1 });
    expect(await connectSessionControl({ workspaceDir, configPath, mode: 'test' })).toBeUndefined();
  });

  test('is undefined with no record, or a record whose port is dead', async () => {
    const workspaceDir = tmpWorkspace();
    const configPath = path.join(workspaceDir, 'devtooie.config.ts');
    expect(await connectSessionControl({ workspaceDir, configPath, mode: 'test' })).toBeUndefined();
    const port = await startServer((_req, res) => res.end('{}'));
    await new Promise<void>((r) => servers.splice(0)[0]!.close(() => r())); // free it
    writeRunning(workspaceDir, { port, pid: SNAPSHOT.pid }, 'test');
    expect(await connectSessionControl({ workspaceDir, configPath, mode: 'test' })).toBeUndefined();
  });

  test('matches the config path through a symlink', async () => {
    const { workspaceDir, configPath } = await session({});
    const link = path.join(tmpWorkspace(), 'ws');
    fs.symlinkSync(workspaceDir, link);
    const viaLink = path.join(link, 'devtooie.config.ts');
    expect(
      await connectSessionControl({ workspaceDir, configPath: viaLink, mode: 'test' }),
    ).toBeDefined();
    expect(configPath).not.toBe(viaLink);
  });

  test("goes by the config's apiPort when it pins one", async () => {
    const { workspaceDir, configPath, port } = await session({});
    const other = tmpWorkspace(); // no record at all
    expect(
      (
        await connectSessionControl({
          workspaceDir: other,
          configPath,
          mode: 'test',
          apiPort: port,
        })
      )?.port,
    ).toBe(port);
    expect(await connectSessionControl({ workspaceDir, configPath, mode: 'test' })).toBeDefined();
  });
});

describe('probeInstance', () => {
  test('maps a live status to InstanceInfo', async () => {
    const port = await startServer((_req, res) => res.end(JSON.stringify(SNAPSHOT)));
    expect(await probeInstance(port)).toEqual({
      pid: SNAPSHOT.pid,
      configPath: SNAPSHOT.configPath,
      mode: 'test',
    });
  });

  test('returns null for a non-devtooie / invalid response', async () => {
    const port = await startServer((_req, res) => res.end('not json'));
    expect(await probeInstance(port)).toBeNull();
  });
});
