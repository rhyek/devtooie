import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { defineConfig } from '../config.js';
import type { Exec } from './exec.js';
import { InfraManager } from './manager.js';
import { InfraError } from './types.js';

let ws: string;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-infra-manager-'));
});
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

/** A Docker that knows two services, which are running as soon as they are asked about. */
function scriptedDocker() {
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  const exec: Exec = async (_command, args, opts) => {
    calls.push({ args, env: opts.env });
    const sub = args.slice(3).join(' ');
    if (sub === 'config --services') {
      return { exitCode: 0, stdout: 'db\nredis\n', stderr: '' };
    }
    if (sub.startsWith('ps ')) {
      const rows = args.slice(7).map((Service) => JSON.stringify({ Service, State: 'running' }));
      return { exitCode: 0, stdout: rows.join('\n'), stderr: '' };
    }
    if (sub === 'config --format json') {
      return { exitCode: 0, stdout: '{}', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

const configWith = (infra: Parameters<typeof defineConfig>[0]['infra']) =>
  defineConfig({
    workspaceDir: ws,
    serviceRootDir: 'packages',
    tokens: { region: 'eu' },
    infra,
    services: { web: {} },
  });

describe('InfraManager', () => {
  test('is null for a config with no infra', () => {
    const config = defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      services: { web: {} },
    });
    expect(InfraManager.fromConfig(config)).toBeNull();
  });

  test("runs Compose with the mode's workspace env and the mode's project name", async () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'DB_PORT=21051\n');
    const { exec, calls } = scriptedDocker();
    const manager = InfraManager.fromConfig(configWith({ 'docker-compose': {} }), { exec })!;
    expect((await manager.up()).ok).toBe(true);
    expect(calls[0]!.env).toMatchObject({
      DB_PORT: '21051',
      COMPOSE_PROJECT_NAME: `${path.basename(ws).toLowerCase()}-development`,
    });
  });

  test("runs Compose with the config's own vars, under the workspace env files", async () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'DB_PORT=21051\nDATA_DIR=from-file\n');
    const { exec, calls } = scriptedDocker();
    const config = defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      env: { vars: { DATA_DIR: '/srv/data', CACHE_DIR: '/srv/cache' } },
      infra: { 'docker-compose': {} },
      services: { web: {} },
    });
    const manager = InfraManager.fromConfig(config, { exec })!;
    expect((await manager.up()).ok).toBe(true);
    expect(calls[0]!.env).toMatchObject({
      DB_PORT: '21051',
      DATA_DIR: 'from-file',
      CACHE_DIR: '/srv/cache',
    });
  });

  test('hands callbacks the config tokens, and brings up only the services named', async () => {
    const { exec, calls } = scriptedDocker();
    let seen: unknown;
    const manager = InfraManager.fromConfig(
      configWith({
        'docker-compose': {
          services: {
            db: {
              afterReady: ({ tokens, mode }) => {
                seen = { tokens, mode };
              },
            },
          },
        },
      }),
      { exec },
    )!;
    const summary = await manager.up({ services: ['db'] });
    expect(summary).toEqual({ ok: true, services: [{ service: 'db', ok: true }] });
    expect(seen).toEqual({ tokens: { region: 'eu' }, mode: 'development' });
    expect(calls.map((c) => c.args.slice(3).join(' '))).toContain(
      'up --detach --remove-orphans --quiet-pull db',
    );
  });

  test('rejects a service no provider has, listing the real ones', async () => {
    const { exec } = scriptedDocker();
    const manager = InfraManager.fromConfig(configWith({ 'docker-compose': {} }), { exec })!;
    await expect(manager.up({ services: ['cache'] })).rejects.toThrow(InfraError);
    await expect(manager.destroy({ services: ['cache'] })).rejects.toThrow(
      /"cache"[\s\S]*db, redis/,
    );
    await expect(manager.down(['cache'])).rejects.toThrow(/"cache"/);
  });

  test('down goes to the provider with the names, and reports its exit code', async () => {
    const { exec } = scriptedDocker();
    const inherited: string[][] = [];
    const manager = InfraManager.fromConfig(configWith({ 'docker-compose': {} }), {
      exec,
      spawnInherit: async (_command, args) => {
        inherited.push(args.slice(3));
        return 3;
      },
    })!;
    expect(await manager.down(['db'])).toBe(3);
    expect(await manager.down()).toBe(3);
    expect(inherited).toEqual([['down', 'db'], ['down']]);
  });

  test('the passthrough rejects a provider the config does not declare', async () => {
    const manager = InfraManager.fromConfig(
      configWith({ 'docker-compose': {} }),
      scriptedDocker(),
    )!;
    await expect(manager.passthrough('podman', ['ps'], ws)).rejects.toThrow(/no `podman` provider/);
  });
});
