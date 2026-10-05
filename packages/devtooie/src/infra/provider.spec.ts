import path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Exec, ExecOptions, ExecResult } from './exec.js';
import { InfraProvider, type ProviderRuntime } from './provider.js';
import {
  InfraError,
  type InfraCallbackContext,
  type InfraEvent,
  type InfraServiceCallbacks,
  type Readiness,
} from './types.js';

const READY: Readiness = { state: 'ready', detail: 'running' };
const WAITING: Readiness = { state: 'pending', detail: 'waiting for healthy' };

interface FakeOptions {
  services?: string[];
  callbacks?: Record<string, InfraServiceCallbacks & { enabled?: boolean }>;
  failDestroyAll?: string;
  /** Successive readings per service; the last one repeats. Defaults to ready at once. */
  readiness?: Record<string, Readiness[]>;
  readyTimeout?: number;
  exec?: Exec;
  failStart?: string;
  failDestroy?: string;
  /** Services whose data doesn't exist yet. */
  fresh?: string[];
  /** Record the freshness reading in `calls`, to assert where it falls in the order. */
  recordFresh?: boolean;
}

/** A provider whose primitives only record that they were called. */
class FakeProvider extends InfraProvider {
  readonly key = 'fake';
  readonly calls: string[] = [];
  private polls = new Map<string, number>();

  constructor(private readonly o: FakeOptions = {}) {
    const runtime: ProviderRuntime = {
      workspaceDir: '/ws',
      mode: 'test',
      envs: { FROM_ENV: 'yes' },
      tokens: { domain: 'example.test' },
      exec: o.exec ?? (async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      spawnInherit: async () => 0,
      pollIntervalMs: 1,
    };
    super(runtime, o.callbacks ?? {}, o.readyTimeout ?? 1000);
  }

  async listServices() {
    return this.o.services ?? ['db', 'redis'];
  }
  async down() {
    return 0;
  }
  async passthrough() {
    return 0;
  }
  protected override extraEnv() {
    return { TOOL_PROJECT: 'ws-test' };
  }
  protected async destroyServices(targets: string[]) {
    this.calls.push(`destroyServices:${targets.join(',')}`);
    if (this.o.failDestroy) {
      throw new InfraError(this.o.failDestroy);
    }
  }
  protected async destroyAll() {
    this.calls.push('destroyAll');
    if (this.o.failDestroyAll) {
      throw new InfraError(this.o.failDestroyAll);
    }
  }
  protected async readFresh(targets: string[]) {
    if (this.o.recordFresh) {
      this.calls.push(`readFresh:${targets.join(',')}`);
    }
    return new Set(this.o.fresh ?? []);
  }
  protected async startServices(targets: string[]) {
    this.calls.push(`start:${targets.join(',')}`);
    if (this.o.failStart) {
      throw new InfraError(this.o.failStart);
    }
  }
  protected async readStatuses(targets: string[]) {
    const out = new Map<string, Readiness>();
    for (const service of targets) {
      const readings = this.o.readiness?.[service] ?? [READY];
      const n = this.polls.get(service) ?? 0;
      this.polls.set(service, n + 1);
      out.set(service, readings[Math.min(n, readings.length - 1)]!);
    }
    return out;
  }
  protected async failureDetail(service: string) {
    return `log tail of ${service}`;
  }
  protected async runTool(args: string[], opts: ExecOptions): Promise<ExecResult> {
    this.calls.push(`tool:${args.join(' ')}@${opts.cwd}`);
    return { exitCode: args[0] === 'boom' ? 2 : 0, stdout: 'tool-out', stderr: '' };
  }
}

/** Callbacks for `service` that record their name and the `reset` they saw into `calls`. */
function recording(calls: string[], service: string): InfraServiceCallbacks {
  const record = (name: string) => async (ctx: InfraCallbackContext) => {
    calls.push(`${name}:${service}:reset=${String(ctx.reset)}`);
  };
  return {
    afterDestroy: record('afterDestroy'),
    beforeUp: record('beforeUp'),
    afterReady: record('afterReady'),
  };
}

describe('InfraProvider.up', () => {
  test('runs beforeUp, starts every service in one call, then afterReady', async () => {
    const provider = new FakeProvider();
    Object.assign(provider['serviceConfig'], { db: recording(provider.calls, 'db') });
    const summary = await provider.up({});
    expect(provider.calls).toEqual([
      'beforeUp:db:reset=false',
      'start:db,redis',
      'afterReady:db:reset=false',
    ]);
    expect(summary).toEqual({
      ok: true,
      services: [
        { service: 'db', ok: true },
        { service: 'redis', ok: true },
      ],
    });
  });

  test('--reset destroys the services it is about to start, then calls afterDestroy', async () => {
    const provider = new FakeProvider();
    Object.assign(provider['serviceConfig'], { db: recording(provider.calls, 'db') });
    await provider.up({ reset: true });
    expect(provider.calls).toEqual([
      'destroyServices:db,redis',
      'afterDestroy:db:reset=true',
      'beforeUp:db:reset=true',
      'start:db,redis',
      'afterReady:db:reset=true',
    ]);
  });

  test('--reset with services named destroys only those', async () => {
    const provider = new FakeProvider();
    await provider.up({ reset: true, services: ['redis'] });
    expect(provider.calls).toEqual(['destroyServices:redis', 'start:redis']);
  });

  test('a beforeUp failure starts nothing and fails every target', async () => {
    const provider = new FakeProvider({
      callbacks: {
        db: {
          beforeUp: async () => {
            throw new Error('disk full');
          },
        },
      },
    });
    const summary = await provider.up({});
    expect(provider.calls).toEqual([]);
    expect(summary.ok).toBe(false);
    expect(summary.services[0]).toEqual({
      service: 'db',
      ok: false,
      error: 'beforeUp failed: disk full',
    });
    expect(summary.services[1]).toMatchObject({ service: 'redis', ok: false });
    expect(summary.services[1]!.error).toMatch(/not started.*db.*beforeUp/);
  });

  test('a failed start fails every target with the provider message', async () => {
    const provider = new FakeProvider({ failStart: 'cannot connect to the Docker daemon' });
    const summary = await provider.up({});
    expect(summary.services.map((s) => s.error)).toEqual([
      'cannot connect to the Docker daemon',
      'cannot connect to the Docker daemon',
    ]);
  });

  test('a failed destroy aborts before anything starts', async () => {
    const provider = new FakeProvider({ failDestroy: 'rm failed' });
    const summary = await provider.up({ reset: true, services: ['db'] });
    expect(provider.calls).toEqual(['destroyServices:db']);
    expect(summary).toEqual({
      ok: false,
      services: [{ service: 'db', ok: false, error: 'rm failed' }],
    });
  });

  test('one service failing does not stop another from finishing', async () => {
    const calls: string[] = [];
    const provider = new FakeProvider({
      callbacks: { redis: recording(calls, 'redis') },
      readiness: { db: [WAITING, { state: 'failed', detail: 'exited (1)' }] },
    });
    const summary = await provider.up({});
    expect(calls).toContain('afterReady:redis:reset=false');
    expect(summary).toEqual({
      ok: false,
      services: [
        { service: 'db', ok: false, error: 'exited (1)\nlog tail of db' },
        { service: 'redis', ok: true },
      ],
    });
  });

  test('an afterReady that throws fails only its own service', async () => {
    const provider = new FakeProvider({
      callbacks: {
        db: {
          afterReady: async () => {
            throw new Error('migration 0002 failed');
          },
        },
      },
    });
    const summary = await provider.up({});
    expect(summary.services).toEqual([
      { service: 'db', ok: false, error: 'afterReady failed: migration 0002 failed' },
      { service: 'redis', ok: true },
    ]);
  });

  test('waits through pending readings, then times out naming the service and what it saw', async () => {
    const slow = new FakeProvider({ readiness: { db: [WAITING, WAITING, READY] } });
    expect((await slow.up({})).ok).toBe(true);

    const stuck = new FakeProvider({ readiness: { db: [WAITING] }, readyTimeout: 20 });
    const summary = await stuck.up({});
    expect(summary.services[0]!.ok).toBe(false);
    expect(summary.services[0]!.error).toBe('not ready after 0s (waiting for healthy)');
    expect(summary.services[1]).toEqual({ service: 'redis', ok: true });
  });

  test('rejects a named service, or a callback key, the provider does not have', async () => {
    await expect(new FakeProvider().up({ services: ['cache'] })).rejects.toThrow(
      /unknown infra service "cache"[\s\S]*db, redis/,
    );
    const misconfigured = new FakeProvider({ callbacks: { postgres: {} } });
    await expect(misconfigured.up({})).rejects.toThrow(InfraError);
    await expect(misconfigured.up({})).rejects.toThrow(/"postgres"[\s\S]*db, redis/);
    expect(misconfigured.calls).toEqual([]);
  });

  test('reports the targets, each status change, and the final status', async () => {
    const events: InfraEvent[] = [];
    await new FakeProvider({ services: ['db'], readiness: { db: [WAITING, READY] } }).up({
      onEvent: (e) => events.push(e),
    });
    expect(events).toEqual([
      { type: 'targets', provider: 'fake', action: 'up', services: ['db'] },
      { type: 'status', service: 'db', status: 'pending' },
      { type: 'status', service: 'db', status: 'starting' },
      { type: 'status', service: 'db', status: 'starting', detail: 'waiting for healthy' },
      { type: 'status', service: 'db', status: 'ready' },
    ]);
  });
});

describe('fresh', () => {
  test('afterReady is told whether this run created its service’s data', async () => {
    const seen: Record<string, boolean> = {};
    const note = (ctx: { service: string; fresh: boolean }) => {
      seen[ctx.service] = ctx.fresh;
    };
    await new FakeProvider({
      fresh: ['db'],
      callbacks: { db: { afterReady: note }, redis: { afterReady: note } },
    }).up({});
    expect(seen).toEqual({ db: true, redis: false });
  });

  test('is read after any destroy and before the start — a reset makes a service fresh', async () => {
    const provider = new FakeProvider({ recordFresh: true });
    await provider.up({ reset: true, services: ['db'] });
    expect(provider.calls).toEqual(['destroyServices:db', 'readFresh:db', 'start:db']);
  });
});

describe('InfraProvider callback context', () => {
  test('carries the service, mode, workspace, tokens and the provider-extended env', async () => {
    let seen: InfraCallbackContext | undefined;
    await new FakeProvider({
      callbacks: {
        db: {
          afterReady: (ctx) => {
            seen = ctx;
          },
        },
      },
    }).up({});
    expect(seen).toMatchObject({
      service: 'db',
      mode: 'test',
      reset: false,
      workspaceDir: '/ws',
      tokens: { domain: 'example.test' },
      envs: { FROM_ENV: 'yes', TOOL_PROJECT: 'ws-test' },
    });
  });

  test('run resolves cwd against the workspace, merges env, and streams output as events', async () => {
    const seen: { command: string; args: string[]; cwd: string; env: Record<string, string> }[] =
      [];
    const exec: Exec = async (command, args, opts) => {
      seen.push({ command, args, cwd: opts.cwd, env: opts.env });
      opts.onLine?.('2 migrations applied', false);
      return { exitCode: 0, stdout: '2 migrations applied\n', stderr: '' };
    };
    const events: InfraEvent[] = [];
    await new FakeProvider({
      exec,
      callbacks: {
        db: {
          afterReady: async ({ run, log }) => {
            const result = await run('migrate', ['deploy'], {
              cwd: 'packages/db',
              env: { A: '1' },
            });
            await run('seed');
            log(`got: ${result.stdout.trim()}`);
          },
        },
      },
    }).up({ onEvent: (e) => events.push(e) });
    expect(seen).toEqual([
      {
        command: 'migrate',
        args: ['deploy'],
        cwd: path.resolve('/ws', 'packages/db'),
        env: { FROM_ENV: 'yes', TOOL_PROJECT: 'ws-test', A: '1' },
      },
      { command: 'seed', args: [], cwd: '/ws', env: { FROM_ENV: 'yes', TOOL_PROJECT: 'ws-test' } },
    ]);
    expect(events.filter((e) => e.type === 'output')).toEqual([
      { type: 'output', service: 'db', line: '2 migrations applied', isError: false },
      { type: 'output', service: 'db', line: '2 migrations applied', isError: false },
      { type: 'output', service: 'db', line: 'got: 2 migrations applied', isError: false },
    ]);
  });

  test('a failing command rejects with the command and its exit code, unless reject is false', async () => {
    const exec: Exec = async () => ({ exitCode: 4, stdout: '', stderr: 'nope' });
    let tolerated: number | undefined;
    const summary = await new FakeProvider({
      exec,
      callbacks: {
        db: {
          afterReady: async ({ run }) => {
            tolerated = (await run('probe', [], { reject: false })).exitCode;
            await run('migrate', ['deploy']);
          },
        },
      },
    }).up({});
    expect(tolerated).toBe(4);
    expect(summary.services[0]).toEqual({
      service: 'db',
      ok: false,
      error: 'afterReady failed: `migrate deploy` exited with code 4',
    });
    expect(summary.services[1]!.ok).toBe(true);
  });

  test("compose runs the provider's tool, and rejects on a non-zero exit too", async () => {
    const provider = new FakeProvider({
      callbacks: {
        db: {
          afterReady: async ({ compose }) => {
            expect((await compose(['exec', 'db', 'true'])).stdout).toBe('tool-out');
            await compose(['boom']);
          },
        },
      },
    });
    const summary = await provider.up({});
    expect(provider.calls).toContain('tool:exec db true@/ws');
    expect(summary.services[0]!.error).toMatch(/afterReady failed: `.*boom` exited with code 2/);
  });
});

describe('InfraProvider.destroy', () => {
  test('with no services destroys everything; afterDestroy sees reset: false', async () => {
    const provider = new FakeProvider();
    Object.assign(provider['serviceConfig'], { db: recording(provider.calls, 'db') });
    const events: InfraEvent[] = [];
    const summary = await provider.destroy({ onEvent: (e) => events.push(e) });
    expect(provider.calls).toEqual(['destroyAll', 'afterDestroy:db:reset=false']);
    expect(summary.ok).toBe(true);
    expect(events[0]).toEqual({
      type: 'targets',
      provider: 'fake',
      action: 'destroy',
      services: ['db', 'redis'],
    });
    expect(events.at(-1)).toEqual({ type: 'status', service: 'redis', status: 'destroyed' });
  });

  test('with services named destroys only those', async () => {
    const provider = new FakeProvider();
    await provider.destroy({ services: ['db'] });
    expect(provider.calls).toEqual(['destroyServices:db']);
  });

  test('an afterDestroy that throws fails its service', async () => {
    const summary = await new FakeProvider({
      callbacks: {
        db: {
          afterDestroy: async () => {
            throw new Error('rm: permission denied');
          },
        },
      },
    }).destroy({});
    expect(summary).toEqual({
      ok: false,
      services: [
        { service: 'db', ok: false, error: 'afterDestroy failed: rm: permission denied' },
        { service: 'redis', ok: true },
      ],
    });
  });
});

describe('a disabled service', () => {
  const withDisabledRedis = (calls: string[] = []) =>
    new FakeProvider({
      callbacks: { redis: { ...recording(calls, 'redis'), enabled: false } },
    });

  test('is left out of "all services": not started, and its callbacks do not run', async () => {
    const calls: string[] = [];
    const provider = withDisabledRedis(calls);
    const summary = await provider.up({});
    expect(provider.calls).toEqual(['start:db']);
    expect(calls).toEqual([]);
    expect(summary).toEqual({ ok: true, services: [{ service: 'db', ok: true }] });
  });

  test('cannot be brought up by name: the error says it is disabled, and for which mode', async () => {
    const provider = withDisabledRedis();
    await expect(provider.up({ services: ['redis'] })).rejects.toThrow(InfraError);
    await expect(provider.up({ services: ['redis'] })).rejects.toThrow(
      /"redis"[\s\S]*disabled[\s\S]*"test"[\s\S]*enabled/,
    );
    expect(provider.calls).toEqual([]);
  });

  test('can still be destroyed by name, to clean up after a mode where it ran', async () => {
    const provider = withDisabledRedis();
    expect((await provider.destroy({ services: ['redis'] })).ok).toBe(true);
    expect(provider.calls).toEqual(['destroyServices:redis']);
  });

  test('is not touched by `up --reset`, which destroys only what it is about to start', async () => {
    const provider = withDisabledRedis();
    expect((await provider.up({ reset: true })).ok).toBe(true);
    expect(provider.calls).toEqual(['destroyServices:db', 'start:db']);
  });

  test('a full destroy takes the whole project but runs afterDestroy only for enabled services', async () => {
    const calls: string[] = [];
    const provider = withDisabledRedis(calls);
    const summary = await provider.destroy({});
    expect(provider.calls).toEqual(['destroyAll']);
    expect(calls).toEqual([]);
    expect(summary.services).toEqual([{ service: 'db', ok: true }]);
  });
});

describe('no services to act on', () => {
  const allDisabled = (o: { failDestroyAll?: string } = {}) =>
    new FakeProvider({ services: ['db'], callbacks: { db: { enabled: false } }, ...o });

  test('up starts nothing — and with --reset destroys nothing — and succeeds', async () => {
    const provider = allDisabled();
    const events: InfraEvent[] = [];
    expect(await provider.up({ onEvent: (e) => events.push(e) })).toEqual({
      ok: true,
      services: [],
    });
    expect(await provider.up({ reset: true })).toEqual({ ok: true, services: [] });
    expect(provider.calls).toEqual([]);
    expect(events).toEqual([{ type: 'targets', provider: 'fake', action: 'up', services: [] }]);
  });

  test('a failure with no service to report it on is not swallowed', async () => {
    const provider = allDisabled({ failDestroyAll: 'cannot connect to the Docker daemon' });
    await expect(provider.destroy({})).rejects.toThrow(/cannot connect to the Docker daemon/);
  });
});
