import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { ProcessManager, resolveColorSpec, packagePrefixColor } from './process-manager.js';
import type { AnyPackageConfig } from './config.js';
import type { RunnerArgs } from './runners/types.js';

let dir: string;
let logFile: string;
let manager: ProcessManager | undefined;

afterEach(() => {
  manager?.dispose();
  manager = undefined;
});

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-process-manager-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: { dev: 'node -e "setInterval(()=>{},1e9)"' },
    }),
  );
  logFile = path.join(dir, 'devlog.txt');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('package prefix colors', () => {
  const original = chalk.level;
  beforeAll(() => {
    chalk.level = 3; // force truecolor so each branch actually emits ANSI to compare
  });
  afterAll(() => {
    chalk.level = original;
  });

  const p = (color?: string): AnyPackageConfig =>
    ({ name: 'a', relativeDir: 'a', path: '/x', color }) as AnyPackageConfig;

  it('resolveColorSpec: hex (with or without #)', () => {
    expect(resolveColorSpec('#af87ff')('x')).toBe(chalk.hex('#af87ff')('x'));
    expect(resolveColorSpec('af87ff')('x')).toBe(chalk.hex('#af87ff')('x'));
  });

  it('resolveColorSpec: rgb() and ansi256()', () => {
    expect(resolveColorSpec('rgb(175, 135, 255)')('x')).toBe(chalk.rgb(175, 135, 255)('x'));
    expect(resolveColorSpec('ansi256(140)')('x')).toBe(chalk.ansi256(140)('x'));
  });

  it('resolveColorSpec: a named color', () => {
    expect(resolveColorSpec('magenta')('x')).toBe(chalk.magenta('x'));
    expect(resolveColorSpec('blueBright')('x')).toBe(chalk.blueBright('x'));
  });

  it('resolveColorSpec: unknown/unsafe specs fall back to no color (no throw)', () => {
    expect(resolveColorSpec('not-a-color')('x')).toBe('x');
    expect(resolveColorSpec('constructor')('x')).toBe('x');
    expect(resolveColorSpec('bold')('x')).toBe('x'); // a chalk modifier, not a color
  });

  it('packagePrefixColor: run.color overrides the palette', () => {
    expect(packagePrefixColor(p('#af87ff'), 0)('x')).toBe(chalk.hex('#af87ff')('x'));
  });

  it('packagePrefixColor: falls back to a distinct palette slot per index', () => {
    expect(packagePrefixColor(p(), 0)('x')).not.toBe(packagePrefixColor(p(), 1)('x'));
  });
});

function pkg(): AnyPackageConfig {
  return { name: 'fixture', relativeDir: '.', path: dir };
}

function runnerArgs(a: AnyPackageConfig): RunnerArgs {
  return {
    sortedPackages: [a],
    selectedSet: new Set([a.name]),
    buildDepSet: new Set(),
    rebuildableSet: new Set(),
    waitForMap: {},
    healthcheckUrls: {},
    extraCommandsMap: {},
    logFile,
  };
}

describe('ProcessManager', () => {
  it('starts a package, tracks it as running, then stops it cleanly', async () => {
    manager = new ProcessManager(runnerArgs(pkg()), { plain: true });

    manager.start('fixture');
    // Give execa (via the package manager) time to actually spawn the child.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(manager.getRunning()).toContain('fixture');
    expect(manager.getStatus('fixture')).toBe('running');

    await manager.stop('fixture');
    expect(manager.getStopped()).toContain('fixture');
    expect(manager.getStatus('fixture')).toBe('stopped');
  }, 10_000);

  it('ControlManager adapter: restart/rebuild return false for an unknown package', () => {
    manager = new ProcessManager(runnerArgs(pkg()), { plain: true });
    expect(manager.restart('does-not-exist')).toBe(false);
    expect(manager.rebuild('does-not-exist')).toBe(false);
    expect(manager.getStatus('does-not-exist')).toBeNull();
  });

  it('getPackages filters by status', () => {
    manager = new ProcessManager(runnerArgs(pkg()), { plain: true });
    expect(manager.getPackages()).toEqual([
      { name: 'fixture', shortName: undefined, status: 'stopped' },
    ]);
    expect(manager.getPackages('running')).toEqual([]);
  });

  it('logControl writes a [dt:control] line to the logfile', () => {
    manager = new ProcessManager(runnerArgs(pkg()), { plain: true });
    manager.logControl('restart fixture', 'fixture');
    manager.logControl('quit');
    const contents = fs.readFileSync(logFile, 'utf8');
    expect(contents).toContain('[dt:control] restart fixture');
    expect(contents).toContain('[dt:control] quit');
  });

  it('logControl pads the [dt:control] label to align with the widest service name', () => {
    const wide: AnyPackageConfig = {
      name: 'whatsapp-bridge',
      relativeDir: '.',
      path: dir,
    };
    manager = new ProcessManager(runnerArgs(wide), { plain: true });
    manager.logControl('restart whatsapp-bridge', 'whatsapp-bridge');
    const contents = fs.readFileSync(logFile, 'utf8');
    // "dt:control" (10) padded to "whatsapp-bridge" width (15) → 5 trailing spaces.
    expect(contents).toContain('[dt:control     ] restart whatsapp-bridge');
  });
});

describe('ProcessManager env injection', () => {
  let envDir: string;
  let envLog: string;
  let mgr: ProcessManager | undefined;

  beforeAll(() => {
    envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-pm-env-'));
    fs.writeFileSync(
      path.join(envDir, 'package.json'),
      JSON.stringify({
        name: 'envfixture',
        version: '1.0.0',
        scripts: {
          dev: 'node -e "console.log(\'VAL=\'+process.env.MY_ENV_VAR);setInterval(()=>{},1e9)"',
        },
      }),
    );
    fs.writeFileSync(path.join(envDir, '.env.local'), 'MY_ENV_VAR=injected123\n');
    envLog = path.join(envDir, 'devlog.txt');
  });
  afterAll(() => {
    mgr?.dispose();
    fs.rmSync(envDir, { recursive: true, force: true });
  });

  it('injects resolved .env vars into the spawned dev process', async () => {
    const a: AnyPackageConfig = { name: 'envfixture', relativeDir: '.', path: envDir };
    mgr = new ProcessManager(
      {
        sortedPackages: [a],
        selectedSet: new Set([a.name]),
        buildDepSet: new Set(),
        rebuildableSet: new Set(),
        waitForMap: {},
        healthcheckUrls: {},
        extraCommandsMap: {},
        logFile: envLog,
        envFiles: ['.env.local'],
        cwd: envDir,
      },
      { plain: true },
    );

    mgr.start('envfixture');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await mgr.stop('envfixture');

    expect(fs.readFileSync(envLog, 'utf8')).toContain('VAL=injected123');
  }, 10_000);
});

describe('ProcessManager PORT injection', () => {
  let portDir: string;
  let portLog: string;
  let mgr: ProcessManager | undefined;

  beforeAll(() => {
    portDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-pm-port-'));
    fs.writeFileSync(
      path.join(portDir, 'package.json'),
      JSON.stringify({
        name: 'portfix',
        version: '1.0.0',
        scripts: {
          dev: 'node -e "console.log(\'PORT=\'+process.env.PORT);setInterval(()=>{},1e9)"',
        },
      }),
    );
    portLog = path.join(portDir, 'devlog.txt');
  });
  afterAll(() => {
    mgr?.dispose();
    fs.rmSync(portDir, { recursive: true, force: true });
  });

  it("injects a package's run.port as the PORT env var", async () => {
    const a: AnyPackageConfig = {
      name: 'portfix',
      relativeDir: '.',
      path: portDir,
      port: 4321,
      command: { name: 'dev', watches: true, builds: true },
    };
    mgr = new ProcessManager(
      {
        sortedPackages: [a],
        selectedSet: new Set([a.name]),
        buildDepSet: new Set(),
        rebuildableSet: new Set(),
        waitForMap: {},
        healthcheckUrls: {},
        extraCommandsMap: {},
        logFile: portLog,
        cwd: portDir,
      },
      { plain: true },
    );

    mgr.start('portfix');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await mgr.stop('portfix');

    expect(fs.readFileSync(portLog, 'utf8')).toContain('PORT=4321');
  }, 10_000);
});

describe('ProcessManager env-change restart', () => {
  let d: string;
  let log: string;
  let m: ProcessManager | undefined;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(() => {
    d = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-pm-envwatch-'));
    fs.writeFileSync(
      path.join(d, 'package.json'),
      JSON.stringify({
        name: 'wfixture',
        version: '1.0.0',
        scripts: {
          dev: 'node -e "console.log(\'VAL=\'+process.env.WVAR);setInterval(()=>{},1e9)"',
        },
      }),
    );
    fs.writeFileSync(path.join(d, '.env.local'), 'WVAR=v1\n');
    log = path.join(d, 'devlog.txt');
  });
  afterAll(() => {
    m?.dispose();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('restarts a running package when its .env changes, picking up the new value', async () => {
    const a: AnyPackageConfig = { name: 'wfixture', relativeDir: '.', path: d };
    m = new ProcessManager(
      {
        sortedPackages: [a],
        selectedSet: new Set([a.name]),
        buildDepSet: new Set(),
        rebuildableSet: new Set(),
        waitForMap: {},
        healthcheckUrls: {},
        extraCommandsMap: {},
        logFile: log,
        envFiles: ['.env.local'],
        cwd: d,
      },
      { plain: true },
    );

    m.startAll();
    await wait(1500);
    expect(fs.readFileSync(log, 'utf8')).toContain('VAL=v1');

    fs.writeFileSync(path.join(d, '.env.local'), 'WVAR=v2\n');
    await wait(3500); // debounce + stop + respawn
    expect(fs.readFileSync(log, 'utf8')).toContain('VAL=v2');

    await m.stop('wfixture');
  }, 15_000);
});

describe('ProcessManager rebuild (clean + build)', () => {
  let rbDir: string;
  let rbLog: string;
  let mgr: ProcessManager | undefined;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(() => {
    rbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-pm-rebuild-'));
    rbLog = path.join(rbDir, 'seq.log');
    fs.writeFileSync(rbLog, '');
    // No `build:clean` — only separate `clean` and `build`, which append ordered markers.
    fs.writeFileSync(
      path.join(rbDir, 'package.json'),
      JSON.stringify({
        name: 'rbfix',
        version: '1.0.0',
        scripts: {
          dev: 'node -e "setInterval(()=>{},1e9)"',
          clean: `node -e "require('fs').appendFileSync('${rbLog}','C')"`,
          build: `node -e "require('fs').appendFileSync('${rbLog}','B')"`,
        },
      }),
    );
  });
  afterAll(() => {
    mgr?.dispose();
    fs.rmSync(rbDir, { recursive: true, force: true });
  });

  it('runs clean then build (in order) and restarts when there is no build:clean', async () => {
    const a: AnyPackageConfig = { name: 'rbfix', relativeDir: '.', path: rbDir };
    mgr = new ProcessManager(
      {
        sortedPackages: [a],
        selectedSet: new Set([a.name]),
        buildDepSet: new Set(),
        rebuildableSet: new Set([a.name]),
        waitForMap: {},
        healthcheckUrls: {},
        extraCommandsMap: {},
        logFile: path.join(rbDir, 'devlog.txt'),
        cwd: rbDir,
      },
      { plain: true },
    );

    mgr.start('rbfix');
    await wait(1200);
    expect(mgr.getStatus('rbfix')).toBe('running');

    expect(mgr.rebuild('rbfix')).toBe(true);
    for (let i = 0; i < 40; i++) {
      if (fs.readFileSync(rbLog, 'utf8') === 'CB' && mgr.getStatus('rbfix') === 'running') break;
      await wait(200);
    }
    expect(fs.readFileSync(rbLog, 'utf8')).toBe('CB'); // clean (C) before build (B)
    expect(mgr.getStatus('rbfix')).toBe('running'); // restarted after the rebuild

    await mgr.stop('rbfix');
  }, 15_000);
});
