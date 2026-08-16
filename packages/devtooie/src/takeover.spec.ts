import { describe, it, expect } from 'vitest';

import type { SessionStatus } from './control-client.js';
import { preflightTakeover, resolveTakeover, type PreflightDeps } from './takeover.js';

const CONFIG = '/ws/devtooie.config.ts';

function status(over: Partial<SessionStatus> = {}): SessionStatus {
  return {
    pid: 4242,
    configPath: CONFIG,
    startedByAgent: false,
    logFile: null,
    packages: null,
    config: null,
    ...over,
  };
}

describe('resolveTakeover', () => {
  it('kills whenever --kill-others is passed, whoever is involved', () => {
    for (const runningStartedByAgent of [true, false]) {
      for (const selfStartedByAgent of [true, false]) {
        for (const isInteractive of [true, false]) {
          expect(
            resolveTakeover({
              killOthers: true,
              runningStartedByAgent,
              selfStartedByAgent,
              isInteractive,
            }),
          ).toBe('kill');
        }
      }
    }
  });

  it('kills silently when an agent replaces a session an agent started', () => {
    expect(
      resolveTakeover({
        killOthers: false,
        runningStartedByAgent: true,
        selfStartedByAgent: true,
        isInteractive: false,
      }),
    ).toBe('kill');
  });

  it('will not let an agent take over a session a person started', () => {
    expect(
      resolveTakeover({
        killOthers: false,
        runningStartedByAgent: false,
        selfStartedByAgent: true,
        isInteractive: false,
      }),
    ).toBe('error');
  });

  it('will not let a person silently take over an agent session without a terminal', () => {
    expect(
      resolveTakeover({
        killOthers: false,
        runningStartedByAgent: true,
        selfStartedByAgent: false,
        isInteractive: false,
      }),
    ).toBe('error');
  });

  it('asks when there is a terminal to ask in', () => {
    for (const runningStartedByAgent of [true, false]) {
      expect(
        resolveTakeover({
          killOthers: false,
          runningStartedByAgent,
          selfStartedByAgent: false,
          isInteractive: true,
        }),
      ).toBe('prompt');
    }
  });
});

describe('preflightTakeover', () => {
  function deps(over: Partial<PreflightDeps> = {}): Partial<PreflightDeps> {
    return {
      queryRunning: async () => status(),
      askToQuit: async () => true,
      isInteractive: () => true,
      selfStartedByAgent: () => false,
      ...over,
    };
  }

  it('proceeds when no instance answers', async () => {
    const result = await preflightTakeover({
      configPath: CONFIG,
      killOthers: false,
      deps: deps({
        queryRunning: async () => null,
        isInteractive: () => false,
        askToQuit: async () => {
          throw new Error('must not prompt');
        },
      }),
    });
    expect(result).toEqual({ ok: true });
  });

  it('proceeds without asking when the running instance is a different project', async () => {
    const result = await preflightTakeover({
      configPath: CONFIG,
      killOthers: false,
      deps: deps({
        queryRunning: async () => status({ configPath: '/other/devtooie.config.ts' }),
        isInteractive: () => false,
        askToQuit: async () => {
          throw new Error('must not prompt');
        },
      }),
    });
    expect(result).toEqual({ ok: true });
  });

  it('proceeds when the prompt is accepted', async () => {
    expect(
      await preflightTakeover({
        configPath: CONFIG,
        killOthers: false,
        deps: deps({ askToQuit: async () => true }),
      }),
    ).toEqual({ ok: true });
  });

  it('stops when the prompt is declined', async () => {
    const result = await preflightTakeover({
      configPath: CONFIG,
      killOthers: false,
      deps: deps({ askToQuit: async () => false }),
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/left the running/i);
  });

  it('names --kill-others and warns agents off it when there is no terminal', async () => {
    const result = await preflightTakeover({
      configPath: CONFIG,
      killOthers: false,
      deps: deps({ isInteractive: () => false, selfStartedByAgent: () => true }),
    });
    expect(result.ok).toBe(false);
    const message = result.ok === false ? result.message : '';
    expect(message).toContain('--kill-others');
    expect(message).toContain('4242');
    expect(message).toMatch(/ask the user/i);
    expect(message).toMatch(/not started by a coding agent/i);
  });

  it('lets an agent take over another agent session with no terminal and no flag', async () => {
    expect(
      await preflightTakeover({
        configPath: CONFIG,
        killOthers: false,
        deps: deps({
          queryRunning: async () => status({ startedByAgent: true }),
          isInteractive: () => false,
          selfStartedByAgent: () => true,
          askToQuit: async () => {
            throw new Error('must not prompt');
          },
        }),
      }),
    ).toEqual({ ok: true });
  });

  it('treats a pre-0.7.0 instance (no startedByAgent) as human-started', async () => {
    const result = await preflightTakeover({
      configPath: CONFIG,
      killOthers: false,
      deps: deps({
        queryRunning: async () => status({ startedByAgent: false }),
        isInteractive: () => false,
        selfStartedByAgent: () => true,
      }),
    });
    expect(result.ok).toBe(false);
  });

  it('skips the question entirely with --kill-others', async () => {
    expect(
      await preflightTakeover({
        configPath: CONFIG,
        killOthers: true,
        deps: deps({
          isInteractive: () => false,
          askToQuit: async () => {
            throw new Error('must not prompt');
          },
        }),
      }),
    ).toEqual({ ok: true });
  });

  it('probes the configured apiPort when one is pinned', async () => {
    const seen: Array<number | undefined> = [];
    await preflightTakeover({
      configPath: CONFIG,
      killOthers: true,
      apiPortOverride: 14099,
      deps: deps({
        queryRunning: async (_cwd, port) => {
          seen.push(port);
          return null;
        },
      }),
    });
    expect(seen).toEqual([14099]);
  });
});
