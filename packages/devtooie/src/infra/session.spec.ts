import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { defineConfig } from '../config.js';
import type { Exec } from './exec.js';
import { InfraFailedError, runSessionInfra } from './session.js';

let ws: string;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-infra-session-'));
});
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

/** A Docker with a `db` service in whatever state `dbState` says. */
function docker(dbState: { State: string; ExitCode?: number }): Exec {
  return async (_command, args) => {
    const sub = args.slice(3).join(' ');
    if (sub === 'config --services') {
      return { exitCode: 0, stdout: 'db\n', stderr: '' };
    }
    if (sub.startsWith('ps ')) {
      return { exitCode: 0, stdout: JSON.stringify({ Service: 'db', ...dbState }), stderr: '' };
    }
    if (sub.startsWith('logs ')) {
      return { exitCode: 0, stdout: 'FATAL: bad config\n', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

describe('runSessionInfra', () => {
  test('is undefined when the config declares no infra', async () => {
    defineConfig({ workspaceDir: ws, packageRootDir: 'packages', packages: { web: {} } });
    expect(await runSessionInfra()).toBeUndefined();
  });

  test('brings everything up and returns the services and the log of what was printed', async () => {
    defineConfig({
      workspaceDir: ws,
      packageRootDir: 'packages',
      infra: {
        'docker-compose': {
          services: { db: { afterReady: ({ log }) => log('2 migrations applied') } },
        },
      },
      packages: { web: {} },
    });
    const seen: string[] = [];
    const infra = await runSessionInfra((e) => seen.push(e.type), {
      exec: docker({ State: 'running' }),
    });
    expect(infra).toEqual({
      services: [{ provider: 'docker-compose', name: 'db' }],
      log: [
        { service: 'db', text: '2 migrations applied', isError: false },
        { service: 'db', text: 'ready', isError: false },
      ],
    });
    expect(seen).toContain('targets');
  });

  test('throws when a service does not come up, naming it and why', async () => {
    defineConfig({
      workspaceDir: ws,
      packageRootDir: 'packages',
      infra: { 'docker-compose': {} },
      packages: { web: {} },
    });
    const failure = await runSessionInfra(undefined, {
      exec: docker({ State: 'exited', ExitCode: 1 }),
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(InfraFailedError);
    expect((failure as InfraFailedError).message).toBe('db: exited (1)\nFATAL: bad config');
  });
});
