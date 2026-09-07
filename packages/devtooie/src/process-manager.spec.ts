import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { ProcessManager, resolveColorSpec, packagePrefixColor } from './process-manager.js';
import { createFormatter } from './log-formatter.js';
import {
  classifyLine,
  rowWidth,
  selectionCopyText,
  valueRun,
  type RowMeta,
  type Selection,
} from './selection.js';
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
  return { name: 'fixture', relativeDir: '.', absoluteDir: dir };
}

function runnerArgs(a: AnyPackageConfig): RunnerArgs {
  return {
    sortedPackages: [a],
    selectedSet: new Set([a.name]),
    buildDepSet: new Set(),
    rebuildableSet: new Set(),
    waitForMap: {},
    healthchecks: {},
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
    const p: AnyPackageConfig = { name: 'fixture', relativeDir: '.', absoluteDir: dir, logs: { timestamps: true } }; // prettier-ignore
    manager = new ProcessManager({ ...runnerArgs(p), logTimestamps: false });
    manager.logControl('hi', { package: 'fixture' });
    expect(lastRow(manager)).toMatch(TS);
  });

  it("a package's logs.timestamps: false overrides a top-level default of true", () => {
    const p: AnyPackageConfig = { name: 'fixture', relativeDir: '.', absoluteDir: dir, logs: { timestamps: false } }; // prettier-ignore
    manager = new ProcessManager({ ...runnerArgs(p), logTimestamps: true });
    manager.logControl('hi', { package: 'fixture' });
    expect(lastRow(manager)).not.toMatch(TS);
  });

  it('a package without logs.timestamps inherits the top-level default', () => {
    manager = new ProcessManager({ ...runnerArgs(pkg()), logTimestamps: true });
    manager.logControl('hi', { package: 'fixture' });
    expect(lastRow(manager)).toMatch(TS);
  });
});

describe('wrapping a line too wide for the terminal', () => {
  const COLS = 80;
  // A single-line value long enough to wrap several times, with no spaces — the shape that
  // exposed this: one very long token, not a value containing newlines.
  const LONG = 'https://cdn.example.com/assets/' + 'ABCDEFGHIJ'.repeat(12) + '?v=9-4&sig=6A8B4178';

  /** Rendered rows of the last buffered line, ANSI stripped. */
  function rows(mgr: ProcessManager): string[] {
    const lines = mgr.getVisibleLines();
    const line = lines[lines.length - 1]!;
    return mgr.wrapLine(line, COLS).map(stripAnsi);
  }

  function longAttrRows(opts?: { timestamps?: boolean }): string[] {
    manager = new ProcessManager({
      ...runnerArgs(pkg()),
      logTimestamps: opts?.timestamps ?? false,
    });
    manager.logControl('asset-fetch', { content_url: LONG });
    return rows(manager);
  }

  it('keeps the property key aligned with unwrapped keys (the indent survives wrapping)', () => {
    const wrapped = longAttrRows();
    expect(wrapped.length).toBeGreaterThan(1);
    // The formatter indents every property by two spaces; wrapping must not eat them, or this
    // key renders two columns left of every key short enough to avoid the wrap.
    expect(wrapped[0]).toContain('  content_url: ');
  });

  it('repeats the prefix on every wrapped row', () => {
    for (const row of longAttrRows()) {
      expect(row).toMatch(/^\[dt:control\] /);
    }
  });

  it('repeats the timestamp on every wrapped row when timestamps are on', () => {
    for (const row of longAttrRows({ timestamps: true })) {
      expect(row).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[dt:control\] /);
    }
  });

  it('aligns continuation rows under the value, like a multi-line value', () => {
    const wrapped = longAttrRows();
    const gutter = wrapped[0]!.indexOf('  content_url: ');
    // `  content_url: ` is 15 columns; continuations start under the value, not under the key.
    const valueCol = gutter + '  content_url: '.length;
    for (const row of wrapped.slice(1)) {
      expect(row.slice(gutter, valueCol)).toBe(' '.repeat(valueCol - gutter));
      expect(row[valueCol]).not.toBe(' ');
    }
  });

  it('loses no text and never exceeds the terminal width', () => {
    const wrapped = longAttrRows();
    for (const row of wrapped) {
      expect(row.length).toBeLessThanOrEqual(COLS);
    }
    // Strip the gutter (and, on continuations, the hanging indent) back off and the original
    // value must reassemble exactly — wrapping may not drop or duplicate a character.
    const gutter = wrapped[0]!.indexOf('  content_url: ');
    const indent = '  content_url: '.length;
    const joined = wrapped
      .map((row, i) => (i === 0 ? row.slice(gutter) : row.slice(gutter + indent)))
      .join('');
    expect(joined).toBe(`  content_url: ${LONG}`);
  });

  // End-to-end over the real wrapping: build the row metadata exactly as `useLogViewport` does,
  // then simulate pressing at the value and dragging to the end of its last row.
  it('value-scoped selection reassembles the original value, gutters and indent stripped', () => {
    manager = new ProcessManager({ ...runnerArgs(pkg()), logTimestamps: true });
    manager.logControl('asset-fetch', { content_url: LONG });
    const lines = manager.getVisibleLines();
    const meta: RowMeta[] = lines.flatMap((line, lineIndex) => {
      const { kind, valueStart } = classifyLine(line.text);
      return manager!.wrapLineRows(line, COLS).map((row, r) => ({
        text: row.text,
        contentStart: row.contentStart,
        valueStart: r === 0 ? row.contentStart + valueStart : row.contentStart,
        lineIndex,
        kind,
      }));
    });

    const press = meta.findIndex((m) => m.kind === 'keyed' && m.text.includes('content_url'));
    expect(press).toBeGreaterThanOrEqual(0);
    const run = valueRun(press, (r) => meta[r] ?? null, meta.length);
    expect(run.end).toBeGreaterThan(run.start); // it really did wrap

    const selection: Selection = {
      anchor: { flatRow: press, col: meta[press]!.valueStart },
      focus: { flatRow: run.end, col: rowWidth(meta[run.end]!.text) },
      mode: 'value',
      run,
    };
    expect(selectionCopyText(selection, (r) => meta[r] ?? null)).toBe(LONG);
  });

  // Whether word-wrap pushes the value to its own row depends on arithmetic between the width,
  // the key length and the token length, so one fixture proves nothing — sweep the widths.
  it('never strands the key on a blank row, at any terminal width', () => {
    manager = new ProcessManager({ ...runnerArgs(pkg()), logTimestamps: true });
    manager.logControl('asset-fetch', { content_url: LONG });
    const lines = manager.getVisibleLines();
    const line = lines[lines.length - 1]!;
    for (let cols = 60; cols <= 140; cols++) {
      const wrapped = manager.wrapLine(line, cols).map(stripAnsi);
      if (wrapped.length < 2) {
        continue; // didn't wrap at this width
      }
      expect(wrapped[0], `cols=${cols}`).toContain(LONG.slice(0, 5));
    }
  });

  it('still breaks a prose value on word boundaries', () => {
    manager = new ProcessManager(runnerArgs(pkg()));
    const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor';
    manager.logControl('note', { text: `${words} ${words}` });
    const wrapped = rows(manager);
    expect(wrapped.length).toBeGreaterThan(1);
    // no row ends mid-word: each row boundary falls on a space in the original text
    for (const row of wrapped.slice(0, -1)) {
      expect(row.trimEnd().endsWith('-')).toBe(false);
      const lastWord = row.trimEnd().split(' ').pop()!;
      expect(`${words} ${words}`.split(' ')).toContain(lastWord);
    }
  });

  it('still wraps a plain line with no property key, aligned at the gutter', () => {
    manager = new ProcessManager(runnerArgs(pkg()));
    manager.logSystem('x'.repeat(300));
    const wrapped = rows(manager);
    expect(wrapped.length).toBeGreaterThan(1);
    for (const row of wrapped) {
      expect(row).toMatch(/^\[devtooie\s*\] /);
      expect(row.length).toBeLessThanOrEqual(COLS);
    }
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

  it('logControl writes the command as a [dt:control] line with its variables beneath', () => {
    manager = new ProcessManager(runnerArgs(pkg()), { plain: true });
    manager.logControl('restart', { package: 'fixture' });
    manager.logControl('quit');
    const contents = fs.readFileSync(logFile, 'utf8');
    expect(contents).toContain('[dt:control] [INFO] restart');
    // the command's variables render as indented properties on their own prefixed line
    expect(contents).toContain('[dt:control]   package: fixture');
    expect(contents).toContain('[dt:control] [INFO] quit');
    // the routing field never leaks into the output
    expect(contents).not.toContain('component');
  });

  it('logControl pads the [dt:control] label to align with the widest service name', () => {
    const wide: AnyPackageConfig = {
      name: 'payments-worker',
      relativeDir: '.',
      absoluteDir: dir,
    };
    manager = new ProcessManager(runnerArgs(wide), { plain: true });
    manager.logControl('restart', { package: 'payments-worker' });
    const contents = fs.readFileSync(logFile, 'utf8');
    // "dt:control" (10) padded to "payments-worker" width (15) → 5 trailing spaces.
    expect(contents).toContain('[dt:control     ] [INFO] restart');
  });

  it('renders system lines under a labelled [devtooie] prefix with a level tag', () => {
    manager = new ProcessManager(runnerArgs(pkg()), { plain: true });
    manager.systemLog.warn('shutting down...');
    manager.logSystem('just so');
    const contents = fs.readFileSync(logFile, 'utf8');
    expect(contents).toContain('[devtooie] [WARN] shutting down...');
    expect(contents).toContain('[devtooie] [INFO] just so');
  });

  it('colors the system prefix gold instead of leaving the slot empty', () => {
    const prev = chalk.level;
    chalk.level = 3; // force truecolor so the hex actually lands in the prefix
    try {
      manager = new ProcessManager(runnerArgs(pkg()), { plain: true });
      manager.logSystem('x');
      const line = manager.getVisibleLines().at(-1)!;
      expect(stripAnsi(line.prefix)).toBe('[devtooie] ');
      expect(line.prefix).toBe(chalk.hex('#d7af5f')('[devtooie]') + ' ');
    } finally {
      chalk.level = prev;
    }
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
  // strip), so accents never hide a match: a typed `malaga` finds a logged `Málaga`,
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
    expect(seedAndFilter('Café Málaga', ['cafe'])).toContain('Café Málaga');
    expect(seedAndFilter('Café Málaga', ['malaga'])).toContain('Málaga');
  });

  it('matches an unaccented log line from an accented term', () => {
    expect(seedAndFilter('Added Malaga', ['málaga'])).toContain('Added Malaga');
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
    const a: AnyPackageConfig = { name: 'envfixture', relativeDir: '.', absoluteDir: envDir };
    mgr = new ProcessManager(
      {
        sortedPackages: [a],
        selectedSet: new Set([a.name]),
        buildDepSet: new Set(),
        rebuildableSet: new Set(),
        waitForMap: {},
        healthchecks: {},
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
      absoluteDir: portDir,
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
        healthchecks: {},
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
    const a: AnyPackageConfig = { name: 'nodeenvfix', relativeDir: '.', absoluteDir: dir };
    return new ProcessManager(
      {
        sortedPackages: [a],
        selectedSet: new Set([a.name]),
        buildDepSet: new Set(),
        rebuildableSet: new Set(),
        waitForMap: {},
        healthchecks: {},
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
    const a: AnyPackageConfig = { name: 'nodeenvdotenv', relativeDir: '.', absoluteDir: dir };
    mgr = new ProcessManager(
      {
        sortedPackages: [a],
        selectedSet: new Set([a.name]),
        buildDepSet: new Set(),
        rebuildableSet: new Set(),
        waitForMap: {},
        healthchecks: {},
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
    const a: AnyPackageConfig = { name: 'wfixture', relativeDir: '.', absoluteDir: d };
    m = new ProcessManager(
      {
        sortedPackages: [a],
        selectedSet: new Set([a.name]),
        buildDepSet: new Set(),
        rebuildableSet: new Set(),
        waitForMap: {},
        healthchecks: {},
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
      absoluteDir: fmtDir,
      ...(formatter ? { logs: { formatter } } : {}),
    };
    return {
      sortedPackages: [a],
      selectedSet: new Set([a.name]),
      buildDepSet: new Set(),
      rebuildableSet: new Set(),
      waitForMap: {},
      healthchecks: {},
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

  // Grouping for a formatted entry is known at the split, not inferred from how it looks: a
  // formatter is free to return multi-line output without indenting it, and those lines must
  // still filter and replay as one entry.
  it('groups every line of one formatted entry, even when the formatter does not indent', async () => {
    const formatter = (line: string): string => {
      try {
        const o = JSON.parse(line) as { msg?: unknown };
        return `HEAD ${String(o.msg)}\nsecond line\nthird line`; // deliberately flush-left
      } catch {
        return line;
      }
    };
    mgr = new ProcessManager(argsWith(formatter), { plain: true });
    mgr.start('fmtfix');
    await wait(1500);
    await mgr.stop('fmtfix');

    const lines = mgr.getVisibleLines();
    const head = lines.find((l) => l.text.includes('HEAD hello world'));
    const second = lines.find((l) => l.text === 'second line');
    const third = lines.find((l) => l.text === 'third line');
    expect(head && second && third).toBeTruthy();
    expect(second!.groupId).toBe(head!.groupId);
    expect(third!.groupId).toBe(head!.groupId);
    // ...and an unrelated later line is NOT swept into that group.
    const plain = lines.find((l) => l.text.includes('plain non-json line'));
    expect(plain!.groupId).not.toBe(head!.groupId);
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

// A formatter owns the presentation of lines it actually rewrites — not of the ones it
// hands back untouched. A non-structured stderr line is devtooie's to render, so it must
// stay red whether the package configures a formatter or falls back to the default. These
// pin the two paths to the same result: configuring `logs.formatter` must not silently
// wash the red out of stderr.
describe('ProcessManager stderr color through a formatter', () => {
  let errDir: string;
  let errLog: string;
  let mgr: ProcessManager | undefined;
  const originalLevel = chalk.level;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(() => {
    chalk.level = 3; // force truecolor so the red is actually emitted
    errDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-pm-err-'));
    fs.writeFileSync(
      path.join(errDir, 'package.json'),
      JSON.stringify({
        name: 'errfix',
        version: '1.0.0',
        scripts: {
          dev: `node -e "console.error('plain stderr line');setInterval(()=>{},1e9)"`,
        },
      }),
    );
    errLog = path.join(errDir, 'devlog.txt');
  });
  afterAll(() => {
    chalk.level = originalLevel;
    disposeManager(mgr);
    fs.rmSync(errDir, { recursive: true, force: true });
  });

  function argsFor(formatter?: (line: string) => string): RunnerArgs {
    const a: AnyPackageConfig = {
      name: 'errfix',
      relativeDir: '.',
      absoluteDir: errDir,
      ...(formatter ? { logs: { formatter } } : {}),
    };
    return {
      sortedPackages: [a],
      selectedSet: new Set([a.name]),
      buildDepSet: new Set(),
      rebuildableSet: new Set(),
      waitForMap: {},
      healthchecks: {},
      extraCommandsMap: {},
      logFile: errLog,
      cwd: errDir,
    };
  }

  /** Run the fixture once and return the buffered (ANSI-carrying) stderr line. */
  async function bufferedStderrLine(formatter?: (line: string) => string) {
    mgr = new ProcessManager(argsFor(formatter), { plain: true });
    mgr.start('errfix');
    await wait(1500);
    await mgr.stop('errfix');
    const line = mgr.getVisibleLines().find((l) => stripAnsi(l.text) === 'plain stderr line');
    disposeManager(mgr);
    mgr = undefined;
    return line;
  }

  it('reddens a passed-through stderr line under the default formatter', async () => {
    const line = await bufferedStderrLine();
    expect(line?.text).toBe(chalk.red('plain stderr line'));
  }, 10_000);

  it('reddens a passed-through stderr line under an explicitly configured formatter', async () => {
    // `createFormatter()` is what `logging.formatter(...)` builds — it passes non-JSON
    // through unchanged, so this line is untouched and must be reddened exactly as above.
    const line = await bufferedStderrLine(createFormatter());
    expect(line?.text).toBe(chalk.red('plain stderr line'));
  }, 10_000);
});

describe('ProcessManager healthcheck probing', () => {
  let hcDir: string;
  let mgr: ProcessManager | undefined;
  let server: HealthServer | undefined;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  interface HealthServer {
    url: string;
    /** Wall-clock ms at which each request reached the server, in order. */
    starts: number[];
    close: () => Promise<void>;
  }

  /** A healthcheck endpoint on an ephemeral port that logs when each request arrives. */
  async function startHealthServer({ delay = 0 } = {}): Promise<HealthServer> {
    const starts: number[] = [];
    const srv = http.createServer((_req, res) => {
      starts.push(Date.now());
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      }, delay);
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const { port } = srv.address() as { port: number };
    return {
      url: `http://127.0.0.1:${port}/health`,
      starts,
      close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
    };
  }

  /** A manager over `names`, all backed by the same idle fixture package. */
  function makeManager(
    names: string[],
    extra: Partial<RunnerArgs>,
    opts: { plain?: boolean } = {},
  ): ProcessManager {
    const packages: AnyPackageConfig[] = names.map((name) => ({
      name,
      relativeDir: '.',
      absoluteDir: hcDir,
    }));
    return new ProcessManager(
      {
        sortedPackages: packages,
        selectedSet: new Set(names),
        buildDepSet: new Set(),
        rebuildableSet: new Set(),
        waitForMap: {},
        healthchecks: {},
        extraCommandsMap: {},
        logFile: path.join(hcDir, 'devlog.txt'),
        cwd: hcDir,
        ...extra,
      },
      opts,
    );
  }

  beforeAll(() => {
    hcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-pm-health-'));
    fs.writeFileSync(
      path.join(hcDir, 'package.json'),
      JSON.stringify({
        name: 'hcfix',
        version: '1.0.0',
        scripts: { dev: 'node -e "setInterval(()=>{},1e9)"' },
      }),
    );
  });

  afterEach(async () => {
    // Kill first, then let each child's exit handler log before `dispose()` closes the
    // logfile — these tests leave packages running, so the two would otherwise race.
    mgr?.killAll();
    await wait(300);
    mgr?.dispose();
    mgr = undefined;
    await server?.close();
    server = undefined;
  });

  afterAll(() => {
    fs.rmSync(hcDir, { recursive: true, force: true });
  });

  it('gives up on a probe once the configured timeout passes', async () => {
    server = await startHealthServer({ delay: 400 });
    mgr = makeManager(['api'], { healthchecks: { api: { url: server.url, timeout: 100 } } });
    mgr.startAll();
    await wait(1200);
    expect(server.starts.length).toBeGreaterThan(0); // it did probe...
    expect(mgr.isReady('api')).toBe(false); // ...and abandoned each probe at 100ms
  }, 10_000);

  it('waits out a slow response when the timeout allows it', async () => {
    server = await startHealthServer({ delay: 400 });
    mgr = makeManager(['api'], { healthchecks: { api: { url: server.url, timeout: 3000 } } });
    mgr.startAll();
    await wait(1200);
    expect(mgr.isReady('api')).toBe(true);
  }, 10_000);

  it('probes a package once per cycle however many packages wait on it', async () => {
    server = await startHealthServer();
    mgr = makeManager(['api', 'web', 'worker'], {
      healthchecks: { api: { url: server.url, timeout: 1500 } },
      waitForMap: { web: ['api'], worker: ['api'] },
    });
    mgr.startAll();
    await wait(4600);
    // One loop at a 2s floor: probes at ~0/2000/4000 — not two pollers' worth, and not one
    // per waiter.
    expect(server.starts.length).toBeLessThanOrEqual(3);
    expect(server.starts.length).toBeGreaterThanOrEqual(2);
    // Both waiters were released by the readiness that loop maintains.
    expect(mgr.getStatus('web')).toBe('running');
    expect(mgr.getStatus('worker')).toBe('running');
  }, 15_000);

  // Headless (plain) sessions display no readiness, so a package is probed there only while a
  // `waitFor` gate is blocked on it — the branch that replaced the gate's own fetch.
  it('releases a waitFor gate in a plain (headless) session', async () => {
    server = await startHealthServer();
    mgr = makeManager(
      ['api', 'web'],
      {
        healthchecks: { api: { url: server.url, timeout: 1500 } },
        waitForMap: { web: ['api'] },
      },
      { plain: true },
    );
    mgr.startAll();
    expect(mgr.getStatus('web')).toBe('waiting');

    await wait(3000);
    expect(server.starts.length).toBeGreaterThan(0); // the dep was probed on the gate's behalf
    expect(mgr.getStatus('web')).toBe('running');
  }, 15_000);

  it('re-probes immediately when a probe outruns the 2s floor', async () => {
    server = await startHealthServer({ delay: 2400 });
    mgr = makeManager(['api'], { healthchecks: { api: { url: server.url, timeout: 5000 } } });
    mgr.startAll();
    await wait(5000);
    expect(server.starts.length).toBeGreaterThanOrEqual(2);
    // The 2s floor is measured from the previous probe's start, so a 2.4s probe is followed
    // straight away rather than after another 2s of idling.
    const gap = server.starts[1]! - server.starts[0]!;
    expect(gap).toBeGreaterThanOrEqual(2300);
    expect(gap).toBeLessThan(3200);
  }, 15_000);

  it('drops readiness when the package stops', async () => {
    server = await startHealthServer();
    mgr = makeManager(['api'], { healthchecks: { api: { url: server.url, timeout: 1500 } } });
    mgr.startAll();
    await wait(1000);
    expect(mgr.isReady('api')).toBe(true);

    await mgr.stop('api');
    // A waiter must never release against a dependency that has since stopped.
    expect(mgr.isReady('api')).toBe(false);
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
    disposeManager(mgr);
    fs.rmSync(rbDir, { recursive: true, force: true });
  });

  it('runs clean then build (in order) and restarts when there is no build:clean', async () => {
    const a: AnyPackageConfig = { name: 'rbfix', relativeDir: '.', absoluteDir: rbDir };
    mgr = new ProcessManager(
      {
        sortedPackages: [a],
        selectedSet: new Set([a.name]),
        buildDepSet: new Set(),
        rebuildableSet: new Set([a.name]),
        waitForMap: {},
        healthchecks: {},
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
