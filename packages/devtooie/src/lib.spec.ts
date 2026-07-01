import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getCommandRunner,
  getExecArgs,
  hasScript,
  hasDevScript,
  getExtraCommands,
  resolveDeps,
  DepType,
  getStateDir,
  saveSelection,
  loadSelection,
  resetSelection,
  getApiPort,
} from './lib.js';
import type { AnyAppConfig } from './config.js';
import { defineAppConfigs } from './config.js';

let dir: string;
function app(over: Partial<AnyAppConfig> & { path: string }): AnyAppConfig {
  return { name: 'x', types: [], relativeDir: 'x', ...over } as AnyAppConfig;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-lib-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { dev: 'x', build: 'x', 'build:clean': 'x', codegen: 'x' } }),
  );
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('runner detection', () => {
  it('detects pnpm for a package.json app', () => {
    expect(getCommandRunner(app({ path: dir }))).toBe('pnpm');
    expect(getExecArgs(app({ path: dir }), 'dev')).toEqual(['pnpm', ['run', 'dev']]);
  });
  it('reads scripts', () => {
    expect(hasScript(app({ path: dir }), 'build')).toBe(true);
    expect(hasDevScript(app({ path: dir }))).toBe(true);
  });
  it('excludes runner-managed scripts from extra commands', () => {
    expect(getExtraCommands(app({ path: dir }))).toEqual(['codegen']);
  });
  it('falls back to pnpm when nothing present', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-empty-'));
    expect(getCommandRunner(app({ path: empty }))).toBe('pnpm');
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

describe('resolveDeps (§8)', () => {
  function setup() {
    return defineAppConfigs({
      workspaceDir: '/repo',
      apps: [
        { name: 'reverse-proxy', types: ['backend'], run: { selectable: false } },
        {
          name: 'core-svc',
          types: ['backend'],
          run: { deps: { runtime: ['reverse-proxy'] } },
        },
        {
          name: 'web',
          types: ['browser'],
          run: { deps: { runtime: ['core-svc', 'reverse-proxy'], dev: ['graphql-codegen'] } },
        },
        { name: 'graphql-codegen', types: [] },
      ],
    });
  }

  it('adds one level of runtime deps to runSet (NOT transitive)', () => {
    const apps = setup();
    const web = apps.find((a) => a.name === 'web')!;
    const { runSet, reasons } = resolveDeps([web], [DepType.RUNTIME]);
    // web + its direct runtime deps; core-svc's own runtime dep (reverse-proxy) is
    // already present because web lists it, but is NOT followed transitively via core-svc.
    expect([...runSet].sort()).toEqual(['core-svc', 'reverse-proxy', 'web']);
    expect(reasons['web']).toBe('selected');
    expect(reasons['core-svc']).toContain('runtime dep');
  });

  it('does not follow runtime deps of a runtime dep', () => {
    const apps = setup();
    const core = apps.find((a) => a.name === 'core-svc')!;
    // Select core-svc only → runSet is {core-svc, reverse-proxy}.
    const { runSet } = resolveDeps([core], [DepType.RUNTIME]);
    expect([...runSet].sort()).toEqual(['core-svc', 'reverse-proxy']);
  });

  it('adds dev deps to the build set transitively', () => {
    const apps = setup();
    const web = apps.find((a) => a.name === 'web')!;
    const { buildSet } = resolveDeps([web], [DepType.DEV]);
    expect(buildSet.has('graphql-codegen')).toBe(true);
  });
});

describe('state + persistence', () => {
  it('round-trips the saved selection', () => {
    resetSelection();
    expect(loadSelection()).toBeNull();
    saveSelection(['web', 'core-svc']);
    expect(loadSelection()).toEqual(['web', 'core-svc']);
    resetSelection();
    expect(loadSelection()).toBeNull();
  });

  it('getStateDir lives under node_modules/.devtooie', () => {
    expect(getStateDir().replace(/\\/g, '/')).toContain('node_modules/.devtooie');
  });

  it('getApiPort returns a number (default 4099 when no devtooie.yaml in cwd)', () => {
    expect(typeof getApiPort()).toBe('number');
  });
});
