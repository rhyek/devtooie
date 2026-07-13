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
  sortPackages,
  depScore,
  buildRunnerArgs,
  canRebuild,
  getRebuildCommands,
  getTsconfigBuildPackages,
  getMakeTargets,
  findAncestorPackage,
} from './lib.js';
import type { AnyPackageConfig } from './config.js';
import { defineConfig } from './config.js';

let dir: string;
function pkg(over: Partial<AnyPackageConfig> & { path: string }): AnyPackageConfig {
  return { name: 'x', relativeDir: 'x', ...over } as AnyPackageConfig;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-lib-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { dev: 'x', build: 'x', 'build:clean': 'x', codegen: 'x' } }),
  );
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('findAncestorPackage', () => {
  const root = '/repo';
  const packages = [
    pkg({ name: 'api', path: '/repo/packages/api' }),
    pkg({ name: 'web', path: '/repo/packages/web' }),
  ];

  it('matches the package dir itself', () => {
    expect(findAncestorPackage('/repo/packages/api', packages, root)?.name).toBe('api');
  });
  it('matches from a directory nested below the package', () => {
    expect(findAncestorPackage('/repo/packages/api/src/deep', packages, root)?.name).toBe('api');
  });
  it('returns null below the root but inside no package', () => {
    expect(findAncestorPackage('/repo/scripts', packages, root)).toBeNull();
    expect(findAncestorPackage('/repo', packages, root)).toBeNull();
  });
  it('picks the deepest package when packages nest', () => {
    const nested = [
      pkg({ name: 'outer', path: '/repo/a' }),
      pkg({ name: 'inner', path: '/repo/a/b' }),
    ];
    expect(findAncestorPackage('/repo/a/b/c', nested, root)?.name).toBe('inner');
    expect(findAncestorPackage('/repo/a/x', nested, root)?.name).toBe('outer');
  });
  it('matches a package rooted at the config root', () => {
    const atRoot = [pkg({ name: 'mono', path: '/repo' })];
    expect(findAncestorPackage('/repo/anywhere', atRoot, root)?.name).toBe('mono');
  });
});

describe('runner detection', () => {
  it('detects pnpm for a package.json pkg', () => {
    expect(getCommandRunner(pkg({ path: dir }))).toBe('pnpm');
    expect(getExecArgs(pkg({ path: dir }), 'dev')).toEqual(['pnpm', ['run', 'dev']]);
  });
  it('forwards extra args after the script/target name (no `--` separator)', () => {
    expect(getExecArgs(pkg({ path: dir }), 'start', ['--bank-key=x', 'foo'])).toEqual([
      'pnpm',
      ['run', 'start', '--bank-key=x', 'foo'],
    ]);
  });
  it('reads scripts', () => {
    expect(hasScript(pkg({ path: dir }), 'build')).toBe(true);
    expect(hasDevScript(pkg({ path: dir }))).toBe(true);
  });
  it('hasDevScript is false for `command: null` even when a dev script exists', () => {
    expect(hasDevScript(pkg({ path: dir, command: null }))).toBe(false);
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
        { name: 'reverse-proxy', selectable: false },
        {
          name: 'core-svc',
          deps: { runtime: ['reverse-proxy'] },
        },
        {
          name: 'web',
          deps: { runtime: ['core-svc', 'reverse-proxy'], dev: ['graphql-codegen'] },
        },
        { name: 'graphql-codegen' },
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

describe('tsconfig project-reference inference', () => {
  let ws: string;
  const write = (rel: string, content: object) => {
    const p = path.join(ws, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(content));
  };
  beforeAll(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-tsref-'));
    fs.mkdirSync(path.join(ws, 'packages/lib-a'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'packages/lib-b'), { recursive: true });
    // app-json: references live only in tsconfig.json (no tsconfig.build.json).
    write('packages/app-json/tsconfig.json', { references: [{ path: '../lib-a' }] });
    // app-both: a build variant (refs lib-b) AND a plain tsconfig.json (refs lib-a).
    write('packages/app-both/tsconfig.build.json', { references: [{ path: '../lib-b' }] });
    write('packages/app-both/tsconfig.json', { references: [{ path: '../lib-a' }] });
    // app-custom: a build variant (refs lib-b) AND a custom-named config (refs lib-a).
    write('packages/app-custom/tsconfig.build.json', { references: [{ path: '../lib-b' }] });
    write('packages/app-custom/tsconfig.app.json', { references: [{ path: '../lib-a' }] });
  });
  afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

  it('falls back to tsconfig.json when no tsconfig.build.json exists', () => {
    const packages = defineConfig({
      workspaceDir: ws,
      packages: [{ name: 'lib-a' }, { name: 'lib-b' }, { name: 'app-json' }],
    }).packages;
    const app = packages.find((p) => p.name === 'app-json')!;
    expect(getTsconfigBuildPackages(app).map((p) => p.name)).toEqual(['lib-a']);
  });

  it('prefers tsconfig.build.json over tsconfig.json', () => {
    const packages = defineConfig({
      workspaceDir: ws,
      packages: [{ name: 'lib-a' }, { name: 'lib-b' }, { name: 'app-both' }],
    }).packages;
    const app = packages.find((p) => p.name === 'app-both')!;
    expect(getTsconfigBuildPackages(app).map((p) => p.name)).toEqual(['lib-b']);
  });

  it('prefers run.tsconfig over tsconfig.build.json', () => {
    const packages = defineConfig({
      workspaceDir: ws,
      packages: [
        { name: 'lib-a' },
        { name: 'lib-b' },
        { name: 'app-custom', tsconfig: 'tsconfig.app.json' },
      ],
    }).packages;
    const app = packages.find((p) => p.name === 'app-custom')!;
    expect(getTsconfigBuildPackages(app).map((p) => p.name)).toEqual(['lib-a']);
  });
});

describe('make targets', () => {
  let mkdir: string;
  beforeAll(() => {
    mkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-phony-'));
    fs.writeFileSync(path.join(mkdir, 'Makefile'), '.PHONY: start\nstart:\n\t@go run .\n');
  });
  afterAll(() => fs.rmSync(mkdir, { recursive: true, force: true }));

  it('excludes make special targets like .PHONY', () => {
    expect(getMakeTargets(pkg({ path: mkdir }))).toEqual(['start']);
  });

  it('getExecArgs uses `make <target>` and forwards extra args', () => {
    expect(getExecArgs(pkg({ path: mkdir }), 'start')).toEqual(['make', ['start']]);
    expect(getExecArgs(pkg({ path: mkdir }), 'start', ['--bank-key=x'])).toEqual([
      'make',
      ['start', '--bank-key=x'],
    ]);
  });

  it('getExtraCommands does not surface .PHONY (nor the configured dev target)', () => {
    const p = pkg({
      path: mkdir,
      command: { name: 'start', watches: false, builds: true, cleans: true },
    });
    expect(getExtraCommands(p)).toEqual([]);
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
        { name: 'proxy', selectable: false },
        { name: 'api', deps: { runtime: ['proxy'] } },
        { name: 'web', deps: { runtime: ['api', 'proxy'] } },
        { name: 'lib-x' },
      ],
    }).packages;
  }

  it('orders by dependency weight (heaviest first), ties broken by name', () => {
    const all = packages();
    const sorted = sortPackages(all).map((a) => a.name);
    // web pulls in api + proxy (2), api pulls in proxy (1), proxy & lib-x pull in nothing (0).
    // Zero-weight packages fall to the bottom, alphabetical among themselves.
    expect(sorted).toEqual(['web', 'api', 'lib-x', 'proxy']);
  });

  it('depScore counts a dep reached via two kinds once per kind', () => {
    const [both] = defineConfig({
      workspaceDir: '/repo',
      packages: [{ name: 'both', deps: { build: ['leaf'], runtime: ['leaf'] } }, { name: 'leaf' }],
    }).packages;
    // `leaf` is a build dep AND a runtime dep of `both`, so it counts twice.
    expect(depScore(both!)).toBe(2);
  });

  it('depScore is pure — repeated calls do not drain the package deps', () => {
    const web = packages().find((a) => a.name === 'web')!;
    const before = [...(web.deps!.runtime ?? [])];
    expect(depScore(web)).toBe(2);
    expect(depScore(web)).toBe(2); // stable, not 1
    expect(web.deps!.runtime).toEqual(before); // config array untouched
  });

  it('gives a selected package one extra point, lifting it above equal-weight deps', () => {
    const all = packages();
    // proxy (selectable:false, weight 0) selected; lib-x (weight 0) not.
    const sorted = sortPackages(all, new Set(['proxy'])).map((a) => a.name);
    // web(2) > api(1) > proxy(0+1=1) > lib-x(0). The selection point lifts proxy over lib-x.
    expect(sorted).toEqual(['web', 'api', 'proxy', 'lib-x']);
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

  it('buildRunnerArgs surfaces top-level urls as normalized lines from the loaded config', () => {
    const all = defineConfig({
      workspaceDir: '/repo',
      urls: [
        'https://dashboard.internal',
        { label: 'Grafana', url: 'https://grafana.internal' },
        ['https://logs.internal', { label: 'Traces', url: 'https://traces.internal' }],
      ],
      packages: [{ name: 'web' }],
    }).packages;
    const web = all.find((a) => a.name === 'web')!;
    const args = buildRunnerArgs([web], resolveDeps([web]));
    // Each entry becomes one line (an array of links); an array entry is a multi-link line.
    expect(args.topLevelUrls).toEqual([
      [{ url: 'https://dashboard.internal' }],
      [{ label: 'Grafana', url: 'https://grafana.internal' }],
      [{ url: 'https://logs.internal' }, { label: 'Traces', url: 'https://traces.internal' }],
    ]);
  });

  it('buildRunnerArgs leaves topLevelUrls undefined when the config declares none', () => {
    const all = packages();
    const web = all.find((a) => a.name === 'web')!;
    const args = buildRunnerArgs([web], resolveDeps([web]));
    expect(args.topLevelUrls).toBeUndefined();
  });
});

describe('rebuild resolution', () => {
  let bc: string; // has build:clean (+ build, clean)
  let cb: string; // has separate clean + build, no build:clean
  let bonly: string; // only build
  let mk: string; // Makefile with build + clean
  let startonly: string; // only a `start` script — no build/clean (relies on command.cleans)
  beforeAll(() => {
    bc = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-bc-'));
    fs.writeFileSync(
      path.join(bc, 'package.json'),
      JSON.stringify({ scripts: { build: 'x', clean: 'x', 'build:clean': 'x' } }),
    );
    cb = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-cb-'));
    fs.writeFileSync(
      path.join(cb, 'package.json'),
      JSON.stringify({ scripts: { build: 'x', clean: 'x' } }),
    );
    bonly = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-bo-'));
    fs.writeFileSync(path.join(bonly, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }));
    mk = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-mk-'));
    fs.writeFileSync(
      path.join(mk, 'Makefile'),
      'dev:\n\t@go run .\nbuild:\n\t@go build\nclean:\n\t@rm -rf bin\n',
    );
    startonly = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-start-'));
    fs.writeFileSync(path.join(startonly, 'package.json'), JSON.stringify({ scripts: { start: 'x' } })); // prettier-ignore
  });
  afterAll(() => {
    for (const d of [bc, cb, bonly, mk, startonly]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('canRebuild: true when the command cleans on start, even without clean/build scripts', () => {
    const p = pkg({
      path: startonly,
      command: { name: 'start', watches: false, builds: true, cleans: true },
    });
    expect(canRebuild(p)).toBe(true);
    // Nothing to run — a rebuild is just a restart of the (self-cleaning) dev command.
    expect(getRebuildCommands(p)).toEqual([]);
  });

  it('canRebuild: false for cleans:false with no clean/build scripts', () => {
    const p = pkg({
      path: startonly,
      command: { name: 'start', watches: false, builds: true, cleans: false },
    });
    expect(canRebuild(p)).toBe(false);
  });

  it('canRebuild: build:clean OR (clean AND build); false otherwise', () => {
    expect(canRebuild(pkg({ path: bc }))).toBe(true);
    expect(canRebuild(pkg({ path: cb }))).toBe(true);
    expect(canRebuild(pkg({ path: bonly }))).toBe(false);
  });

  it('getRebuildCommands: a single build:clean when the package defines it', () => {
    expect(getRebuildCommands(pkg({ path: bc }))).toEqual([['pnpm', ['run', 'build:clean']]]);
  });

  it('getRebuildCommands: clean then build when there is no build:clean', () => {
    expect(getRebuildCommands(pkg({ path: cb }))).toEqual([
      ['pnpm', ['run', 'clean']],
      ['pnpm', ['run', 'build']],
    ]);
  });

  it('getRebuildCommands: empty when the package cannot rebuild', () => {
    expect(getRebuildCommands(pkg({ path: bonly }))).toEqual([]);
  });

  it('getRebuildCommands: make clean then make build for a Makefile package', () => {
    expect(canRebuild(pkg({ path: mk }))).toBe(true);
    expect(getRebuildCommands(pkg({ path: mk }))).toEqual([
      ['make', ['clean']],
      ['make', ['build']],
    ]);
  });
});
