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
  sortForDisplay,
  buildRunnerArgs,
} from './lib.js';
import type { AnyPackageConfig } from './config.js';
import { defineConfig } from './config.js';

let dir: string;
function pkg(over: Partial<AnyPackageConfig> & { path: string }): AnyPackageConfig {
  return { name: 'x', types: [], relativeDir: 'x', ...over } as AnyPackageConfig;
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
  it('detects pnpm for a package.json pkg', () => {
    expect(getCommandRunner(pkg({ path: dir }))).toBe('pnpm');
    expect(getExecArgs(pkg({ path: dir }), 'dev')).toEqual(['pnpm', ['run', 'dev']]);
  });
  it('reads scripts', () => {
    expect(hasScript(pkg({ path: dir }), 'build')).toBe(true);
    expect(hasDevScript(pkg({ path: dir }))).toBe(true);
  });
  it('excludes runner-managed scripts from extra commands', () => {
    expect(getExtraCommands(pkg({ path: dir }))).toEqual(['codegen']);
  });
  it('falls back to pnpm when nothing present', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-empty-'));
    expect(getCommandRunner(pkg({ path: empty }))).toBe('pnpm');
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

describe('resolveDeps (§8)', () => {
  function setup() {
    return defineConfig({
      workspaceDir: '/repo',
      packages: [
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
    }).packages;
  }

  it('adds one level of runtime deps to runSet (NOT transitive)', () => {
    const packages = setup();
    const web = packages.find((a) => a.name === 'web')!;
    const { runSet, reasons } = resolveDeps([web], [DepType.RUNTIME]);
    // web + its direct runtime deps; core-svc's own runtime dep (reverse-proxy) is
    // already present because web lists it, but is NOT followed transitively via core-svc.
    expect([...runSet].sort()).toEqual(['core-svc', 'reverse-proxy', 'web']);
    expect(reasons['web']).toBe('selected');
    expect(reasons['core-svc']).toContain('runtime dep');
  });

  it('does not follow runtime deps of a runtime dep', () => {
    const packages = setup();
    const core = packages.find((a) => a.name === 'core-svc')!;
    // Select core-svc only → runSet is {core-svc, reverse-proxy}.
    const { runSet } = resolveDeps([core], [DepType.RUNTIME]);
    expect([...runSet].sort()).toEqual(['core-svc', 'reverse-proxy']);
  });

  it('adds dev deps to the build set transitively', () => {
    const packages = setup();
    const web = packages.find((a) => a.name === 'web')!;
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
});

describe('display sort + runner args', () => {
  function packages() {
    return defineConfig({
      workspaceDir: '/repo',
      packages: [
        { name: 'proxy', types: ['backend'], run: { selectable: false } },
        { name: 'api', types: ['backend'], run: { deps: { runtime: ['proxy'] } } },
        { name: 'web', types: ['browser'], run: { deps: { runtime: ['api', 'proxy'] } } },
        { name: 'lib-x', types: ['lib'] },
      ],
    }).packages;
  }

  it('orders selected first, then selectable deps, then non-selectable infra', () => {
    const all = packages();
    const selected = new Set(['web']);
    const sorted = sortForDisplay(all, selected);
    expect(sorted[0]!.name).toBe('web'); // selected first
    expect(sorted[sorted.length - 1]!.name).toBe('proxy'); // non-selectable infra last
  });

  it('buildRunnerArgs marks the selected set and produces sorted packages', () => {
    const all = packages();
    const web = all.find((a) => a.name === 'web')!;
    const deps = resolveDeps([web]);
    const args = buildRunnerArgs([web], deps);
    expect(args.selectedSet.has('web')).toBe(true);
    expect(args.sortedPackages.length).toBeGreaterThan(0);
    expect(args.buildDepSet).toBe(deps.buildSet);
  });
});
