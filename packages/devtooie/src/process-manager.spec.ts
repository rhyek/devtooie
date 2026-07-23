import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { ProcessManager, resolveColorSpec, packagePrefixColor } from './process-manager.js';
import { createFormatter } from './log-formatter.js';
import { stripAnsi } from './lib.js';
import type { AnyPackageConfig } from './config.js';
import type { RunnerArgs } from './runners/types.js';

let dir: string;
let logFile: string;
let manager: ProcessManager | undefined;

/**
 * Test teardown for a manager: SIGKILL any child process groups it still owns,
 * THEN release its handles. `dispose()` on its own only removes the
 * `process.on('exit')` safety net and the instance-registry entry — by contract
 * it does NOT kill children — so a test that leaves a dev process running (e.g.
 * a `start` with no matching `stop`) would otherwise orphan a detached process
 * group. The fixtures idle on `setInterval`, so an orphan never exits and piles
 * up across runs. Always kill before disposing in tests.
 */
function disposeManager(m: ProcessManager | undefined): void {
  m?.killAll();
  m?.dispose();
}

afterEach(() => {
  disposeManager(manager);
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

describe('on-screen log timestamps', () => {
  const TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[/;

  function lastRow(mgr: ProcessManager): string {
    const lines = mgr.getVisibleLines();
    const line = lines[lines.length - 1]!;
    return stripAnsi(mgr.wrapLine(line, 200)[0]!);
  }

  it('prefixes rows with a `YYYY-MM-DD HH:MM:SS` timestamp when logs.timestamps is enabled', () => {
    manager = new ProcessManager({ ...runnerArgs(pkg()), logTimestamps: true });
    manager.logSystem('hello world');
    const row = lastRow(manager);
    expect(row).toMatch(TS);
    expect(row).toContain('hello world');
  });

  it('leaves rows un-timestamped by default', () => {
    manager = new ProcessManager(runnerArgs(pkg()));
    manager.logSystem('hello world');
    const row = lastRow(manager);
    expect(row).not.toMatch(TS);
    expect(row).toContain('hello world');
  });

  it('always timestamps the on-disk log file, even with the on-screen option off', () => {
    manager = new ProcessManager(runnerArgs(pkg()));
    manager.logSystem('to disk');
    expect(fs.readFileSync(logFile, 'utf8')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[/m);
  });

  // A control line tagged with a package's name shares that package's timestamp resolution,
  // so it's a spawn-free way to observe the per-package override.
  it("a package's logs.timestamps: true overrides a top-level default of false", () => {
    const p: AnyPackageConfig = { name: 'fixture', relativeDir: '.', path: dir, logs: { timestamps: true } }; // prettier-ignore
    manager = new ProcessManager({ ...runnerArgs(p), logTimestamps: false });
    manager.logControl('hi', 'fixture');
    expect(lastRow(manager)).toMatch(TS);
  });

  it("a package's logs.timestamps: false overrides a top-level default of true", () => {
    const p: AnyPackageConfig = { name: 'fixture', relativeDir: '.', path: dir, logs: { timestamps: false } }; // prettier-ignore
    manager = new ProcessManager({ ...runnerArgs(p), logTimestamps: true });
    manager.logControl('hi', 'fixture');
    expect(lastRow(manager)).not.toMatch(TS);
  });

  it('a package without logs.timestamps inherits the top-level default', () => {
    manager = new ProcessManager({ ...runnerArgs(pkg()), logTimestamps: true });
    manager.logControl('hi', 'fixture');
    expect(lastRow(manager)).toMatch(TS);
  });
});

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

  it('startAll skips an autostart:false package but a manual start still works', async () => {
    manager = new ProcessManager(runnerArgs({ ...pkg(), autostart: false }), { plain: true });
    manager.startAll();
    await new Promise((resolve) => setTimeout(resolve, 800));
    // Left stopped by auto-start (not 'waiting').
    expect(manager.getStatus('fixture')).toBe('stopped');

    // The `s` hotkey / control-API path still starts it.
    manager.start('fixture');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(manager.getStatus('fixture')).toBe('running');
  }, 10_000);

  it('ControlManager adapter: restart/rebuild return false for an unknown package', () => {
    manager = new ProcessManager(runnerArgs(pkg()), { plain: true });
    expect(manager.restart('does-not-exist')).toBe(false);
    expect(manager.rebuild('does-not-exist')).toBe(false);
    expect(manager.getStatus('does-not-exist')).toBeNull();
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

describe('ProcessManager filter replay batching', () => {
  // A filter switch clears the screen and replays the buffer through the new
  // filter. That replay must go out as ONE terminal write, not one-per-line:
  // an interactive host patches `console.*` and erases+repaints its footer on
  // every call, so per-line emits turn the switch into a visible, one-by-one
  // re-stream instead of an instant swap.

  it('replays the whole matching buffer in a single write on filter change', () => {
    manager = new ProcessManager(runnerArgs(pkg()), { plain: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const N = 25;
      for (let i = 0; i < N; i++) {
        manager.logSystem(`payload-${i}`);
      }
      logSpy.mockClear();
      errSpy.mockClear();

      manager.setFilter(['payload']); // matches every seeded line

      // One write for the entire replayed batch.
      expect(logSpy.mock.calls.length + errSpy.mock.calls.length).toBe(1);
      // ...carrying every line, in buffer order.
      const emitted = String(logSpy.mock.calls[0]?.[0] ?? '');
      for (let i = 0; i < N; i++) {
        expect(emitted).toContain(`payload-${i}`);
      }
      expect(emitted.indexOf('payload-0')).toBeLessThan(emitted.indexOf(`payload-${N - 1}`));
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('emits nothing when the new filter matches no buffered line', () => {
    manager = new ProcessManager(runnerArgs(pkg()), { plain: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (let i = 0; i < 10; i++) {
        manager.logSystem(`item-${i}`);
      }
      logSpy.mockClear();

      manager.setFilter(['does-not-match-anything']);

      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('replays the full buffer in a single write when the filter is cleared', () => {
    manager = new ProcessManager(runnerArgs(pkg()), { plain: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let i = 0; i < 15; i++) {
        manager.logSystem(`row-${i}`);
      }
      manager.setFilter(['row-1']); // narrow down first
      logSpy.mockClear();
      errSpy.mockClear();

      manager.setFilter([]); // clear the filter -> replay everything

      expect(logSpy.mock.calls.length + errSpy.mock.calls.length).toBe(1);
      const emitted = String(logSpy.mock.calls[0]?.[0] ?? '');
      expect(emitted).toContain('row-0');
      expect(emitted).toContain('row-14');
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('ProcessManager filter: case- and accent-insensitive', () => {
  // Matching normalizes both the log text and the typed terms (lowercase + diacritic
  // strip), so accents never hide a match: a typed `gonzalez` finds a logged `González`,
  // and vice-versa.
  function seedAndFilter(line: string, terms: string[]): string {
    manager = new ProcessManager(runnerArgs(pkg()), { plain: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      manager.logSystem(line);
      logSpy.mockClear();
      manager.setFilter(terms);
      return logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    } finally {
      logSpy.mockRestore();
    }
  }

  it('matches an accented log line from an unaccented term', () => {
    expect(seedAndFilter('Añadido González', ['anadido'])).toContain('Añadido González');
    expect(seedAndFilter('Añadido González', ['gonzalez'])).toContain('González');
  });

  it('matches an unaccented log line from an accented term', () => {
    expect(seedAndFilter('Added Gonzalez', ['gonzález'])).toContain('Added Gonzalez');
  });

  it('is case-insensitive', () => {
    expect(seedAndFilter('Added TODO item', ['added', 'todo'])).toContain('Added TODO item');
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
    disposeManager(mgr);
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
    disposeManager(mgr);
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

// A spawned child must inherit the parent's NODE_ENV verbatim — devtooie never injects or
// overrides it (packageEnv is `{ ...process.env, ...envLayer }`, and the env layer carries only
// PORT + resolved `.env` vars). This matters because the Ink TUI forces React into its
// production build by pinning NODE_ENV=production only while React loads, then restoring it
// (see render-app-production.ts); this test guards the other half of that contract — that the
// restored, shell-provided value is exactly what children are spawned with.
describe('ProcessManager child NODE_ENV inheritance', () => {
  let dir: string;
  let log: string;
  let mgr: ProcessManager | undefined;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-pm-nodeenv-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'nodeenvfix',
        version: '1.0.0',
        scripts: {
          // Print the child's NODE_ENV bracketed so an unset value is visible as `[]`. The
          // bracketed literal value (e.g. `[development]`) never appears in pnpm's echo of the
          // script *source*, so `toContain` can't match the wrong line.
          dev: "node -e \"console.log('NODE_ENV=['+(process.env.NODE_ENV||'')+']');setInterval(()=>{},1e9)\"",
        },
      }),
    );
    log = path.join(dir, 'devlog.txt');
  });
  afterEach(() => {
    disposeManager(mgr);
    mgr = undefined;
  });
  afterAll(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeManager(): ProcessManager {
    const a: AnyPackageConfig = { name: 'nodeenvfix', relativeDir: '.', path: dir };
    return new ProcessManager(
      {
        sortedPackages: [a],
        selectedSet: new Set([a.name]),
        buildDepSet: new Set(),
        rebuildableSet: new Set(),
        waitForMap: {},
        healthcheckUrls: {},
        extraCommandsMap: {},
        logFile: log,
        cwd: dir,
      },
      { plain: true },
    );
  }

  async function runAndReadLog(): Promise<string> {
    fs.writeFileSync(log, '');
    mgr = makeManager();
    mgr.start('nodeenvfix');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await mgr.stop('nodeenvfix');
    return fs.readFileSync(log, 'utf8');
  }

  for (const value of ['development', 'test', 'production'] as const) {
    it(`spawns the child with the parent's NODE_ENV=${value}`, async () => {
      process.env.NODE_ENV = value;
      expect(await runAndReadLog()).toContain(`NODE_ENV=[${value}]`);
    }, 10_000);
  }

  it('spawns the child with NODE_ENV unset when the parent has none', async () => {
    delete process.env.NODE_ENV;
    expect(await runAndReadLog()).toContain('NODE_ENV=[]');
  }, 10_000);
});

// The complement of the block above: a package's own `.env` file supplies NODE_ENV. Because the
// env layer is applied over `process.env` (with dotenvx `overload: true`), a `.env.development`
// that sets NODE_ENV wins — so the child sees it even when the shell had NODE_ENV unset. This is
// what makes `devtooie` (Ink UI included) usable without exporting NODE_ENV in the shell.
describe('ProcessManager NODE_ENV from a .env file', () => {
  let dir: string;
  let log: string;
  let mgr: ProcessManager | undefined;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-pm-nodeenv-dotenv-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'nodeenvdotenv',
        version: '1.0.0',
        scripts: {
          dev: "node -e \"console.log('NODE_ENV=['+(process.env.NODE_ENV||'')+']');setInterval(()=>{},1e9)\"",
        },
      }),
    );
    fs.writeFileSync(path.join(dir, '.env.development'), 'NODE_ENV=development\n');
    log = path.join(dir, 'devlog.txt');
  });
  afterEach(() => {
    disposeManager(mgr);
    mgr = undefined;
  });
  afterAll(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("uses the package's .env.development NODE_ENV even when the shell leaves it unset", async () => {
    delete process.env.NODE_ENV; // shell has no NODE_ENV
    const a: AnyPackageConfig = { name: 'nodeenvdotenv', relativeDir: '.', path: dir };
    mgr = new ProcessManager(
      {
        sortedPackages: [a],
        selectedSet: new Set([a.name]),
        buildDepSet: new Set(),
        rebuildableSet: new Set(),
        waitForMap: {},
        healthcheckUrls: {},
        extraCommandsMap: {},
        logFile: log,
        envFiles: ['.env.development'],
        cwd: dir,
      },
      { plain: true },
    );

    mgr.start('nodeenvdotenv');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await mgr.stop('nodeenvdotenv');

    expect(fs.readFileSync(log, 'utf8')).toContain('NODE_ENV=[development]');
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
    disposeManager(m);
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

describe('ProcessManager logs.formatter', () => {
  let fmtDir: string;
  let fmtLog: string;
  let mgr: ProcessManager | undefined;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Emits one structured (JSON) log line, then a plain non-JSON line, then idles.
  beforeAll(() => {
    fmtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-pm-fmt-'));
    fs.writeFileSync(
      path.join(fmtDir, 'package.json'),
      JSON.stringify({
        name: 'fmtfix',
        version: '1.0.0',
        scripts: {
          dev: `node -e "console.log(JSON.stringify({level:'INFO',msg:'hello world',n:1}));console.log('plain non-json line');setInterval(()=>{},1e9)"`,
        },
      }),
    );
    fmtLog = path.join(fmtDir, 'devlog.txt');
  });
  afterAll(() => {
    disposeManager(mgr);
    fs.rmSync(fmtDir, { recursive: true, force: true });
  });

  function argsWith(formatter?: (line: string) => string): RunnerArgs {
    const a: AnyPackageConfig = {
      name: 'fmtfix',
      relativeDir: '.',
      path: fmtDir,
      ...(formatter ? { logs: { formatter } } : {}),
    };
    return {
      sortedPackages: [a],
      selectedSet: new Set([a.name]),
      buildDepSet: new Set(),
      rebuildableSet: new Set(),
      waitForMap: {},
      healthcheckUrls: {},
      extraCommandsMap: {},
      logFile: fmtLog,
      cwd: fmtDir,
    };
  }

  it('formats structured lines and passes non-structured output through', async () => {
    const formatter = (line: string): string => {
      try {
        const o = JSON.parse(line) as { level?: unknown; msg?: unknown };
        if (typeof o.level === 'string' && typeof o.msg === 'string') {
          return `${o.level} ${o.msg}`;
        }
      } catch {
        /* not json — fall through */
      }
      return line;
    };
    mgr = new ProcessManager(argsWith(formatter), { plain: true });
    mgr.start('fmtfix');
    await wait(1500);
    await mgr.stop('fmtfix');

    const contents = fs.readFileSync(fmtLog, 'utf8');
    expect(contents).toContain('INFO hello world'); // structured line reshaped
    expect(contents).not.toContain('{"level"'); // raw JSON not written
    expect(contents).toContain('plain non-json line'); // non-structured passed through
    disposeManager(mgr);
    mgr = undefined;
  }, 10_000);

  it('applies the default formatter when a package has no logs.formatter', async () => {
    mgr = new ProcessManager(argsWith(), { plain: true }); // no per-package formatter
    mgr.start('fmtfix');
    await wait(1500);
    await mgr.stop('fmtfix');

    // The default formatter runs automatically: the JSON line is formatted, the plain one isn't.
    const contents = fs.readFileSync(fmtLog, 'utf8');
    expect(contents).toMatch(/\[fmtfix\] \[INFO\] hello world$/m);
    expect(contents).toContain('plain non-json line');
    disposeManager(mgr);
    mgr = undefined;
  }, 10_000);

  it('splits a multi-line formatter result (createFormatter) into separate, prefixed lines', async () => {
    mgr = new ProcessManager(argsWith(createFormatter()), { plain: true });
    mgr.start('fmtfix');
    await wait(1500);
    await mgr.stop('fmtfix');

    // The header and the indented property each land on their own prefixed logfile line.
    const contents = fs.readFileSync(fmtLog, 'utf8');
    expect(contents).toMatch(/\[fmtfix\] \[INFO\] hello world$/m);
    expect(contents).toMatch(/\[fmtfix\] {3}n: 1$/m);
    expect(contents).toContain('plain non-json line'); // non-JSON still passes through
    disposeManager(mgr);
    mgr = undefined;
  }, 10_000);

  it('falls back to the raw line when the formatter throws', async () => {
    mgr = new ProcessManager(
      argsWith(() => {
        throw new Error('boom');
      }),
      { plain: true },
    );
    mgr.start('fmtfix');
    await wait(1500);
    await mgr.stop('fmtfix');

    // A throwing formatter must not drop output — the raw line survives.
    const contents = fs.readFileSync(fmtLog, 'utf8');
    expect(contents).toContain('hello world');
    disposeManager(mgr);
    mgr = undefined;
  }, 10_000);
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
    disposeManager(mgr);
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
      if (fs.readFileSync(rbLog, 'utf8') === 'CB' && mgr.getStatus('rbfix') === 'running') {
        break;
      }
      await wait(200);
    }
    expect(fs.readFileSync(rbLog, 'utf8')).toBe('CB'); // clean (C) before build (B)
    expect(mgr.getStatus('rbfix')).toBe('running'); // restarted after the rebuild

    await mgr.stop('rbfix');
  }, 15_000);
});
