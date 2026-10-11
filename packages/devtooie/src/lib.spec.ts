import { describe, it, test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import {
  exitCodeOf,
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
  resolveSelectedNames,
  readSelection,
  initialPhaseFor,
  sortPackages,
  depScore,
  buildRunnerArgs,
  canRebuild,
  getRebuildCommands,
  runScript,
  getTsconfigBuildPackages,
  getMakeTargets,
  findAncestorPackage,
  logTimestamp,
  formatDuration,
  pickNewestLog,
  resolveLogFile,
} from './lib.js';
import type { AnyPackageConfig } from './config.js';
import { defineConfig } from './config.js';

let dir: string;
function pkg(over: Partial<AnyPackageConfig> & { absoluteDir: string }): AnyPackageConfig {
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
    pkg({ name: 'api', absoluteDir: '/repo/packages/api' }),
    pkg({ name: 'web', absoluteDir: '/repo/packages/web' }),
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
      pkg({ name: 'outer', absoluteDir: '/repo/a' }),
      pkg({ name: 'inner', absoluteDir: '/repo/a/b' }),
    ];
    expect(findAncestorPackage('/repo/a/b/c', nested, root)?.name).toBe('inner');
    expect(findAncestorPackage('/repo/a/x', nested, root)?.name).toBe('outer');
  });
  it('matches a package rooted at the config root', () => {
    const atRoot = [pkg({ name: 'mono', absoluteDir: '/repo' })];
    expect(findAncestorPackage('/repo/anywhere', atRoot, root)?.name).toBe('mono');
  });
});

describe('runner detection', () => {
  test('runs a package.json script as its own text, through /bin/sh', () => {
    expect(getCommandRunner(pkg({ absoluteDir: dir }))).toBe('sh');
    expect(getExecArgs(pkg({ absoluteDir: dir }), 'dev')).toMatchObject({
      cmd: '/bin/sh',
      args: ['-c', 'x'],
    });
  });
  test('hands extra args to the shell as positional parameters, appended to the script', () => {
    expect(getExecArgs(pkg({ absoluteDir: dir }), 'build', ['--bank-key=x', 'foo'])).toMatchObject({
      cmd: '/bin/sh',
      args: ['-c', 'x "$@"', 'sh', '--bank-key=x', 'foo'],
    });
  });
  it('reads scripts', () => {
    expect(hasScript(pkg({ absoluteDir: dir }), 'build')).toBe(true);
    expect(hasDevScript(pkg({ absoluteDir: dir }))).toBe(true);
  });
  it('hasDevScript is false for `command: null` even when a dev script exists', () => {
    expect(hasDevScript(pkg({ absoluteDir: dir, command: null }))).toBe(false);
  });
  it('excludes runner-managed scripts from extra commands', () => {
    expect(getExtraCommands(pkg({ absoluteDir: dir }))).toEqual(['codegen']);
  });
  test('falls back to sh when nothing present', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-empty-'));
    expect(getCommandRunner(pkg({ absoluteDir: empty }))).toBe('sh');
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

describe('package script spawn spec', () => {
  let ws: string;
  let app: string; // named + versioned, with its own node_modules/.bin
  let bare: string; // no name, no version, no node_modules
  const run = (p: AnyPackageConfig, script: string, args: string[] = [], env = process.env) => {
    const spec = getExecArgs(p, script, args, env);
    return execa(spec.cmd, spec.args, { cwd: p.absoluteDir, env: spec.env, reject: false });
  };
  const PRINT_ARGV = 'node -e "console.log(JSON.stringify(process.argv.slice(1)))" x';

  beforeAll(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-spawn-')));
    app = path.join(ws, 'packages', 'app');
    bare = path.join(ws, 'packages', 'bare');
    fs.mkdirSync(path.join(ws, 'node_modules', '.bin'), { recursive: true });
    fs.mkdirSync(path.join(app, 'node_modules', '.bin'), { recursive: true });
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(
      path.join(app, 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.2.3',
        scripts: {
          argv: PRINT_ARGV,
          fail: 'exit 7',
          version: 'node -e "console.log(String(process.env.npm_package_version))"',
        },
      }),
    );
    fs.writeFileSync(
      path.join(bare, 'package.json'),
      JSON.stringify({
        scripts: { version: 'node -e "console.log(String(process.env.npm_package_version))"' },
      }),
    );
  });
  afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

  test("puts each ancestor's node_modules/.bin on PATH, nearest first, ahead of the given PATH", () => {
    const { env } = getExecArgs(pkg({ absoluteDir: app }), 'argv', [], { PATH: '/usr/bin:/bin' });
    const entries = env.PATH!.split(':');
    expect(entries.slice(0, 2)).toEqual([
      path.join(app, 'node_modules', '.bin'),
      path.join(ws, 'node_modules', '.bin'),
    ]);
    expect(entries.slice(-2)).toEqual(['/usr/bin', '/bin']);
  });

  test('leaves out ancestors that have no node_modules/.bin', () => {
    const { env } = getExecArgs(pkg({ absoluteDir: bare }), 'version', [], { PATH: '/usr/bin' });
    expect(env.PATH!.split(':')[0]).toBe(path.join(ws, 'node_modules', '.bin'));
  });

  test('keeps the given environment, without modifying it', () => {
    const given = { PATH: '/usr/bin', FOO: 'bar' };
    const { env } = getExecArgs(pkg({ absoluteDir: app }), 'argv', [], given);
    expect(env.FOO).toBe('bar');
    expect(given).toEqual({ PATH: '/usr/bin', FOO: 'bar' });
  });

  test('describes the package and script being run', () => {
    const { env } = getExecArgs(pkg({ absoluteDir: app }), 'fail', [], {});
    expect(env).toMatchObject({
      npm_package_name: 'app',
      npm_package_version: '1.2.3',
      npm_package_json: path.join(app, 'package.json'),
      npm_lifecycle_event: 'fail',
      npm_lifecycle_script: 'exit 7',
      INIT_CWD: app,
      PNPM_SCRIPT_SRC_DIR: app,
    });
  });

  test("does not let another package's version reach a script whose package has none", async () => {
    const result = await run(pkg({ absoluteDir: bare }), 'version', [], {
      ...process.env,
      npm_package_version: '9.9.9',
    });
    expect(result.stdout).toBe('undefined');
  });

  test('extra args reach the script intact, whatever shell syntax they contain', async () => {
    const args = ['a b', '--c=$HOME', "it's", '*', '"q"', ''];
    const result = await run(pkg({ absoluteDir: app }), 'argv', args);
    expect(JSON.parse(result.stdout)).toEqual(['x', ...args]);
  });

  test("the script's exit code is the spawned command's exit code", async () => {
    expect((await run(pkg({ absoluteDir: app }), 'fail')).exitCode).toBe(7);
  });

  test('a script that does not exist fails with exit code 1, naming it', async () => {
    const result = await run(pkg({ absoluteDir: app }), 'nope');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('Missing script: "nope"');
  });

  test('a make target gets the given environment unchanged', () => {
    const mkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-spawn-mk-'));
    fs.writeFileSync(path.join(mkdir, 'Makefile'), 'start:\n\t@true\n');
    const given = { PATH: '/usr/bin', FOO: 'bar' };
    expect(getExecArgs(pkg({ absoluteDir: mkdir }), 'start', [], given).env).toEqual(given);
    fs.rmSync(mkdir, { recursive: true, force: true });
  });
});

describe('runScript', () => {
  let ws: string;
  let app: string;

  beforeAll(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-runscript-')));
    app = path.join(ws, 'packages', 'app');
    for (const [dir, name] of [
      [app, 'appbin'],
      [ws, 'rootbin'],
    ] as const) {
      const bin = path.join(dir, 'node_modules', '.bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho ${name}-OK\n`, { mode: 0o755 });
    }
    fs.writeFileSync(
      path.join(app, 'package.json'),
      JSON.stringify({
        scripts: {
          build: 'appbin && rootbin && node -e "console.log(process.cwd())"',
          fail: 'exit 2',
          kill: 'node -e "process.kill(process.pid,\'SIGKILL\')"',
        },
      }),
    );
  });
  afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

  test("runs the script in the package directory, with the package's and the workspace root's node_modules/.bin on PATH", async () => {
    const result = await runScript(pkg({ absoluteDir: app }), 'build', 'pipe');
    expect(String(result.stdout).split('\n')).toEqual(['appbin-OK', 'rootbin-OK', app]);
  });

  test('rejects when the script exits with a non-zero code', async () => {
    await expect(runScript(pkg({ absoluteDir: app }), 'fail', 'pipe')).rejects.toMatchObject({
      exitCode: 2,
    });
  });

  test('rejects when a signal kills the script', async () => {
    await expect(runScript(pkg({ absoluteDir: app }), 'kill', 'pipe')).rejects.toThrow();
  });
});

describe('exitCodeOf', () => {
  test("is the process's own exit code when it exited", () => {
    expect(exitCodeOf({ exitCode: 0 })).toBe(0);
    expect(exitCodeOf({ exitCode: 7 })).toBe(7);
  });

  test('is 128 + the signal number when a signal killed it', () => {
    expect(exitCodeOf({ signal: 'SIGKILL' })).toBe(137);
    expect(exitCodeOf({ signal: 'SIGTERM' })).toBe(143);
  });

  test('is 1 when the process never ran', () => {
    expect(exitCodeOf({})).toBe(1);
  });
});

describe('resolveDeps (§8)', () => {
  function setup() {
    return Object.values(
      defineConfig({
        packageRootDir: 'packages',
        workspaceDir: '/repo',
        packages: {
          'reverse-proxy': { selectable: false },
          'core-svc': {
            deps: { runtime: ['reverse-proxy'] },
          },
          web: {
            deps: { runtime: ['core-svc', 'reverse-proxy'], dev: ['graphql-codegen'] },
          },
          'graphql-codegen': {},
        },
      }).packages,
    );
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
    const packages = Object.values(
      defineConfig({
        packageRootDir: 'packages',
        workspaceDir: ws,
        packages: { 'lib-a': {}, 'lib-b': {}, 'app-json': {} },
      }).packages,
    );
    const app = packages.find((p) => p.name === 'app-json')!;
    expect(getTsconfigBuildPackages(app).map((p) => p.name)).toEqual(['lib-a']);
  });

  it('prefers tsconfig.build.json over tsconfig.json', () => {
    const packages = Object.values(
      defineConfig({
        packageRootDir: 'packages',
        workspaceDir: ws,
        packages: { 'lib-a': {}, 'lib-b': {}, 'app-both': {} },
      }).packages,
    );
    const app = packages.find((p) => p.name === 'app-both')!;
    expect(getTsconfigBuildPackages(app).map((p) => p.name)).toEqual(['lib-b']);
  });

  it('prefers run.tsconfig over tsconfig.build.json', () => {
    const packages = Object.values(
      defineConfig({
        packageRootDir: 'packages',
        workspaceDir: ws,
        packages: {
          'lib-a': {},
          'lib-b': {},
          'app-custom': { tsconfig: 'tsconfig.app.json' },
        },
      }).packages,
    );
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
    expect(getMakeTargets(pkg({ absoluteDir: mkdir }))).toEqual(['start']);
  });

  it('getExecArgs uses `make <target>` and forwards extra args', () => {
    expect(getExecArgs(pkg({ absoluteDir: mkdir }), 'start')).toMatchObject({
      cmd: 'make',
      args: ['start'],
    });
    expect(getExecArgs(pkg({ absoluteDir: mkdir }), 'start', ['--bank-key=x'])).toMatchObject({
      cmd: 'make',
      args: ['start', '--bank-key=x'],
    });
  });

  it('getExtraCommands does not surface .PHONY (nor the configured dev target)', () => {
    const p = pkg({
      absoluteDir: mkdir,
      command: { name: 'start', watches: false, builds: true, cleans: true },
    });
    expect(getExtraCommands(p)).toEqual([]);
  });
});

describe('state + persistence', () => {
  it('round-trips the saved selection', () => {
    defineConfig({ packageRootDir: 'packages', packages: { web: {}, 'core-svc': {} } });
    resetSelection();
    expect(loadSelection()).toBeNull();
    saveSelection(['web', 'core-svc']);
    expect(loadSelection()).toEqual(['web', 'core-svc']);
    resetSelection();
    expect(loadSelection()).toBeNull();
  });

  // A saved selection outlives package renames. A name that no longer exists must never reach
  // the picker or `findPackage` (which throws), and must never be written back.
  test('drops saved names that are not current packages, keeping the valid ones', () => {
    defineConfig({ packageRootDir: 'packages', packages: { web: {}, api: {} } });
    fs.writeFileSync(
      path.join(getStateDir(), 'selection.json'),
      JSON.stringify(['@old/name', 'web']),
    );
    expect(loadSelection()).toEqual(['web']);
    // and the file itself is pruned, so the stale name doesn't linger until the next save
    expect(JSON.parse(fs.readFileSync(path.join(getStateDir(), 'selection.json'), 'utf8'))).toEqual(
      ['web'],
    );
    resetSelection();
  });

  test('never saves a name that is not a current package', () => {
    defineConfig({ packageRootDir: 'packages', packages: { web: {}, api: {} } });
    saveSelection(['web', 'api']);
    // The config renames `api` → `backend`; the next run saves what it ran with.
    defineConfig({ packageRootDir: 'packages', packages: { web: {}, backend: {} } });
    saveSelection(loadSelection() ?? []);
    expect(JSON.parse(fs.readFileSync(path.join(getStateDir(), 'selection.json'), 'utf8'))).toEqual(['web']); // prettier-ignore
    saveSelection(['web', 'api']);
    expect(loadSelection()).toEqual(['web']);
    resetSelection();
  });

  test('readSelection separates current names from stale ones, pruning the file', () => {
    defineConfig({ packageRootDir: 'packages', packages: { web: {}, api: {} } });
    fs.writeFileSync(
      path.join(getStateDir(), 'selection.json'),
      JSON.stringify(['@old/name', 'web', '@gone/too']),
    );
    expect(readSelection()).toEqual({ names: ['web'], stale: ['@old/name', '@gone/too'] });
    expect(loadSelection()).toEqual(['web']);
    resetSelection();
    expect(readSelection()).toBeNull();
  });

  // Renamed package keys must never stop devtooie from running: a stale saved name sends the
  // TUI back to the picker (known names preselected) instead of skipping it on --last-answers.
  test('a stale saved name forces the picker even with --last-answers, preselecting the rest', () => {
    defineConfig({ packageRootDir: 'packages', packages: { web: {}, api: {} } });
    fs.writeFileSync(path.join(getStateDir(), 'selection.json'), JSON.stringify(['@old/name', 'web'])); // prettier-ignore
    expect(initialPhaseFor({ packages: [], lastAnswers: true })).toEqual({
      type: 'package-select',
      initialSelected: ['web'],
    });
    fs.writeFileSync(path.join(getStateDir(), 'selection.json'), JSON.stringify(['web']));
    expect(initialPhaseFor({ packages: [], lastAnswers: true })).toEqual({
      type: 'building',
      selectedNames: ['web'],
    });
    expect(initialPhaseFor({ packages: ['api'], lastAnswers: true })).toEqual({
      type: 'building',
      selectedNames: ['api'],
    });
    resetSelection();
    expect(initialPhaseFor({ packages: [], lastAnswers: true })).toEqual({
      type: 'package-select',
      initialSelected: [],
    });
  });

  test('--last-answers without a picker refuses a selection with stale names, naming them', () => {
    defineConfig({ packageRootDir: 'packages', packages: { web: {} } });
    fs.writeFileSync(path.join(getStateDir(), 'selection.json'), JSON.stringify(['@old/name', 'web'])); // prettier-ignore
    expect(resolveSelectedNames({ package: [], lastAnswers: true }, '--plain')).toEqual({
      error:
        'The saved selection names packages that no longer exist (@old/name) — run once without --last-answers to pick again.',
    });
    fs.writeFileSync(path.join(getStateDir(), 'selection.json'), JSON.stringify(['@old/name']));
    expect(resolveSelectedNames({ package: [], lastAnswers: true }, '--plain')).toEqual({
      error:
        'The saved selection names packages that no longer exist (@old/name) — run once without --last-answers to pick again.',
    });
    fs.writeFileSync(path.join(getStateDir(), 'selection.json'), JSON.stringify(['web']));
    expect(resolveSelectedNames({ package: [], lastAnswers: true }, '--plain')).toEqual({
      names: ['web'],
    });
    resetSelection();
    expect(resolveSelectedNames({ package: [], lastAnswers: true }, '--plain')).toEqual({
      error: 'No saved selection found — run once without --last-answers first.',
    });
  });

  it('getStateDir lives under node_modules/.devtooie', () => {
    expect(getStateDir().replace(/\\/g, '/')).toContain('node_modules/.devtooie');
  });
});

describe('display sort + runner args', () => {
  function packages() {
    return Object.values(
      defineConfig({
        packageRootDir: 'packages',
        workspaceDir: '/repo',
        packages: {
          proxy: { selectable: false },
          api: { deps: { runtime: ['proxy'] } },
          web: { deps: { runtime: ['api', 'proxy'] } },
          'lib-x': {},
        },
      }).packages,
    );
  }

  it('orders by dependency weight (heaviest first), ties broken by name', () => {
    const all = packages();
    const sorted = sortPackages(all).map((a) => a.name);
    // web pulls in api + proxy (2), api pulls in proxy (1), proxy & lib-x pull in nothing (0).
    // Zero-weight packages fall to the bottom, alphabetical among themselves.
    expect(sorted).toEqual(['web', 'api', 'lib-x', 'proxy']);
  });

  it('depScore counts a dep reached via two kinds once per kind', () => {
    const [both] = Object.values(
      defineConfig({
        packageRootDir: 'packages',
        workspaceDir: '/repo',
        packages: { both: { deps: { build: ['leaf'], runtime: ['leaf'] } }, leaf: {} },
      }).packages,
    );
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

  test("buildRunnerArgs carries the loaded config's own env vars", () => {
    const all = Object.values(
      defineConfig({
        packageRootDir: 'packages',
        workspaceDir: '/repo',
        env: { vars: { DATA_DIR: '/srv/data' } },
        packages: { web: {} },
      }).packages,
    );
    const web = all.find((a) => a.name === 'web')!;
    expect(buildRunnerArgs([web], resolveDeps([web])).envVars).toEqual({ DATA_DIR: '/srv/data' });
  });

  it('buildRunnerArgs surfaces top-level urls as normalized lines from the loaded config', () => {
    const all = Object.values(
      defineConfig({
        packageRootDir: 'packages',
        workspaceDir: '/repo',
        urls: [
          'https://dashboard.internal',
          { label: 'Grafana', url: 'https://grafana.internal' },
          ['https://logs.internal', { label: 'Traces', url: 'https://traces.internal' }],
        ],
        packages: { web: {} },
      }).packages,
    );
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

  it('buildRunnerArgs carries logTimestamps from the loaded config (default true)', () => {
    const on = Object.values(
      defineConfig({ packageRootDir: 'packages', workspaceDir: '/repo', packages: { web: {} } })
        .packages,
    );
    const web = on.find((a) => a.name === 'web')!;
    expect(buildRunnerArgs([web], resolveDeps([web])).logTimestamps).toBe(true);

    const off = Object.values(
      defineConfig({
        packageRootDir: 'packages',
        workspaceDir: '/repo',
        logs: { timestamps: false },
        packages: { web: {} },
      }).packages,
    );
    const web2 = off.find((a) => a.name === 'web')!;
    expect(buildRunnerArgs([web2], resolveDeps([web2])).logTimestamps).toBe(false);
  });
});

describe('logTimestamp', () => {
  it('formats as `YYYY-MM-DD HH:MM:SS` (24-hour, with date)', () => {
    expect(logTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('formatDuration', () => {
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  test('spells out days, hours and minutes', () => {
    expect(formatDuration(3 * DAY + 2 * HOUR + 3 * MINUTE)).toBe('3 days 2 hours 3 minutes');
  });

  test('uses the singular for a unit of one', () => {
    expect(formatDuration(DAY + HOUR + MINUTE)).toBe('1 day 1 hour 1 minute');
    expect(formatDuration(SECOND)).toBe('1 second');
  });

  test('leaves out a unit that is zero', () => {
    expect(formatDuration(DAY + 5 * MINUTE)).toBe('1 day 5 minutes');
    expect(formatDuration(HOUR)).toBe('1 hour');
    expect(formatDuration(2 * DAY)).toBe('2 days');
  });

  test('shows seconds only while the whole duration is under a minute', () => {
    expect(formatDuration(42_300)).toBe('42 seconds');
    expect(formatDuration(MINUTE)).toBe('1 minute');
    expect(formatDuration(MINUTE + SECOND)).toBe('1 minute');
    expect(formatDuration(HOUR + 59 * SECOND)).toBe('1 hour');
  });

  test('rounds down, never up into the next unit', () => {
    expect(formatDuration(59 * MINUTE + 59_900)).toBe('59 minutes');
    expect(formatDuration(59_999)).toBe('59 seconds');
  });

  test('reports anything under a second as 0 seconds', () => {
    expect(formatDuration(0)).toBe('0 seconds');
    expect(formatDuration(999)).toBe('0 seconds');
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
    for (const d of [bc, cb, bonly, mk, startonly]) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('canRebuild: true when the command cleans on start, even without clean/build scripts', () => {
    const p = pkg({
      absoluteDir: startonly,
      command: { name: 'start', watches: false, builds: true, cleans: true },
    });
    expect(canRebuild(p)).toBe(true);
    // Nothing to run — a rebuild is just a restart of the (self-cleaning) dev command.
    expect(getRebuildCommands(p)).toEqual([]);
  });

  it('canRebuild: false for cleans:false with no clean/build scripts', () => {
    const p = pkg({
      absoluteDir: startonly,
      command: { name: 'start', watches: false, builds: true, cleans: false },
    });
    expect(canRebuild(p)).toBe(false);
  });

  it('canRebuild: build:clean OR (clean AND build); false otherwise', () => {
    expect(canRebuild(pkg({ absoluteDir: bc }))).toBe(true);
    expect(canRebuild(pkg({ absoluteDir: cb }))).toBe(true);
    expect(canRebuild(pkg({ absoluteDir: bonly }))).toBe(false);
  });

  it('getRebuildCommands: a single build:clean when the package defines it', () => {
    expect(getRebuildCommands(pkg({ absoluteDir: bc }))).toMatchObject([
      { cmd: '/bin/sh', args: ['-c', 'x'], env: { npm_lifecycle_event: 'build:clean' } },
    ]);
  });

  it('getRebuildCommands: clean then build when there is no build:clean', () => {
    expect(getRebuildCommands(pkg({ absoluteDir: cb }))).toMatchObject([
      { cmd: '/bin/sh', args: ['-c', 'x'], env: { npm_lifecycle_event: 'clean' } },
      { cmd: '/bin/sh', args: ['-c', 'x'], env: { npm_lifecycle_event: 'build' } },
    ]);
  });

  it('getRebuildCommands: empty when the package cannot rebuild', () => {
    expect(getRebuildCommands(pkg({ absoluteDir: bonly }))).toEqual([]);
  });

  it('getRebuildCommands: make clean then make build for a Makefile package', () => {
    expect(canRebuild(pkg({ absoluteDir: mk }))).toBe(true);
    expect(getRebuildCommands(pkg({ absoluteDir: mk }))).toMatchObject([
      { cmd: 'make', args: ['clean'] },
      { cmd: 'make', args: ['build'] },
    ]);
  });
});

describe('pickNewestLog', () => {
  let logs: string;
  beforeAll(() => {
    logs = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-logs-'));
  });
  afterAll(() => fs.rmSync(logs, { recursive: true, force: true }));

  it('returns the most recently modified *.log by mtime', () => {
    const older = path.join(logs, '1.log');
    const newer = path.join(logs, '2.log');
    fs.writeFileSync(older, 'a');
    fs.writeFileSync(newer, 'b');
    fs.utimesSync(older, new Date(1_000), new Date(1_000));
    fs.utimesSync(newer, new Date(2_000), new Date(2_000));
    expect(pickNewestLog(logs)).toBe(newer);
  });

  it('ignores non-.log files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-logs-'));
    fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
    expect(pickNewestLog(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for a missing directory', () => {
    expect(pickNewestLog(path.join(logs, 'does-not-exist'))).toBeNull();
  });
});

describe('resolveLogFile', () => {
  it('prefers the live instance logfile when available', async () => {
    const file = await resolveLogFile({
      liveLogFile: async () => '/live/current.log',
      fallbackDir: '/logs',
      newestLog: () => '/logs/fallback.log',
    });
    expect(file).toBe('/live/current.log');
  });

  it('prefers the recorded running.json logFile (when it exists) over scanning the dir', async () => {
    const file = await resolveLogFile({
      liveLogFile: async () => null,
      recordedLogFile: '/logs/recorded.log',
      fallbackDir: '/logs',
      newestLog: () => '/logs/newest.log',
      exists: () => true,
    });
    expect(file).toBe('/logs/recorded.log');
  });

  it('skips the recorded logFile when it no longer exists, falling back to newest in dir', async () => {
    const file = await resolveLogFile({
      liveLogFile: async () => null,
      recordedLogFile: '/logs/gone.log',
      fallbackDir: '/logs',
      newestLog: () => '/logs/newest.log',
      exists: () => false,
    });
    expect(file).toBe('/logs/newest.log');
  });

  it('falls back to the newest logfile in the dir when no live answer', async () => {
    const file = await resolveLogFile({
      liveLogFile: async () => null,
      fallbackDir: '/logs',
      newestLog: (dir) => `${dir}/newest.log`,
    });
    expect(file).toBe('/logs/newest.log');
  });

  it('returns null when neither the instance nor the dir yields a logfile', async () => {
    const file = await resolveLogFile({
      liveLogFile: async () => null,
      fallbackDir: '/logs',
      newestLog: () => null,
    });
    expect(file).toBeNull();
  });
});
