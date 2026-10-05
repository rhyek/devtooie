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

  test("a failed callback's error carries what the callback printed, so the reason is visible", async () => {
    defineConfig({
      workspaceDir: ws,
      packageRootDir: 'packages',
      infra: {
        'docker-compose': {
          services: {
            db: {
              afterReady: ({ log }) => {
                log('applying 0002_add_index');
                log('ERROR: relation "todos" does not exist');
                throw new Error('`migrate` exited with code 1');
              },
            },
          },
        },
      },
      packages: { web: {} },
    });
    const failure = await runSessionInfra(undefined, { exec: docker({ State: 'running' }) }).catch(
      (err: unknown) => err,
    );
    expect((failure as InfraFailedError).message).toBe(
      [
        'db: afterReady failed: `migrate` exited with code 1',
        '    applying 0002_add_index',
        '    ERROR: relation "todos" does not exist',
      ].join('\n'),
    );
  });

  test('keeps only the tail of a long output', async () => {
    defineConfig({
      workspaceDir: ws,
      packageRootDir: 'packages',
      infra: {
        'docker-compose': {
          services: {
            db: {
              afterReady: ({ log }) => {
                for (let i = 1; i <= 40; i++) {
                  log(`line ${String(i)}`);
                }
                throw new Error('boom');
              },
            },
          },
        },
      },
      packages: { web: {} },
    });
    const failure = await runSessionInfra(undefined, { exec: docker({ State: 'running' }) }).catch(
      (err: unknown) => err,
    );
    const lines = (failure as InfraFailedError).message.split('\n');
    expect(lines).toHaveLength(1 + 15);
    expect(lines[1]).toBe('    line 26');
    expect(lines.at(-1)).toBe('    line 40');
  });
});
