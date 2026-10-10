import { render } from 'ink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import React from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { AnyPackageConfig } from '../config.js';
import { stripAnsi } from '../lib.js';
import { ProcessManager } from '../process-manager.js';
import type { RunnerArgs } from '../runners/types.js';
import { LogPane, useLogViewport, type LogViewport } from './LogPane.js';

const h = React.createElement;

let dir: string;
let manager: ProcessManager | undefined;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-log-pane-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "fixture", "version": "1.0.0" }\n');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  manager?.killAll();
  manager?.dispose();
  manager = undefined;
});

function newManager(): ProcessManager {
  const pkg: AnyPackageConfig = {
    name: 'fixture',
    relativeDir: '.',
    absoluteDir: dir,
    tokens: {},
    command: { name: 'dev', watches: true, builds: true, cleans: false },
  };
  const args: RunnerArgs = {
    sortedPackages: [pkg],
    selectedSet: new Set([pkg.name]),
    buildDepSet: new Set(),
    rebuildableSet: new Set(),
    waitForMap: {},
    healthchecks: {},
    extraCommandsMap: {},
    logFile: path.join(dir, 'devlog.txt'),
  };
  manager = new ProcessManager({ ...args, logTimestamps: true });
  return manager;
}

/** Logs `text` and back-dates the buffered line to `ts`, as if it had been logged then. */
function logAt(mgr: ProcessManager, ts: string, text: string): void {
  mgr.logSystem(text);
  const lines = mgr.getVisibleLines();
  lines[lines.length - 1]!.ts = ts;
}

/**
 * Mounts `useLogViewport` + `LogPane` at `columns` × `height` and returns the latest frame's
 * rows (ANSI stripped) plus a handle on the viewport for driving the scroll position.
 */
function mount(mgr: ProcessManager, columns: number, height: number) {
  const frames: string[] = [];
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        frames.push(String(chunk));
        callback();
      },
    }),
    { columns },
  );
  const handle: { viewport?: LogViewport } = {};
  function Harness() {
    const viewport = useLogViewport(mgr, columns, height);
    handle.viewport = viewport;
    return h(LogPane, { rows: viewport.rows });
  }
  const instance = render(h(Harness), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
  });
  const frame = () =>
    stripAnsi(frames[frames.length - 1] ?? '')
      .split('\n')
      .filter((row) => row.trim() !== '');
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
  return {
    frame,
    viewport: () => handle.viewport!,
    settle,
    unmount: () => instance.unmount(),
  };
}

const DATE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[/;
const TIME = /^\d{2}:\d{2}:\d{2} \[/;

describe('useLogViewport timestamp layout', () => {
  test('shows only the time while every stamp on screen is from the same day', () => {
    const mgr = newManager();
    logAt(mgr, '2026-09-06 08:00:00', 'one');
    logAt(mgr, '2026-09-06 09:00:00', 'two');
    const view = mount(mgr, 120, 10);
    try {
      const rows = view.frame();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatch(TIME);
        expect(row).not.toMatch(DATE);
      }
      expect(view.viewport().tsMode).toBe('time');
    } finally {
      view.unmount();
    }
  });

  test('shows the full date as soon as two days are visible together', () => {
    const mgr = newManager();
    logAt(mgr, '2026-09-05 23:59:59', 'yesterday');
    logAt(mgr, '2026-09-06 00:00:01', 'today');
    const view = mount(mgr, 120, 10);
    try {
      const rows = view.frame();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatch(/^2026-09-05 23:59:59 \[/);
      expect(rows[1]).toMatch(/^2026-09-06 00:00:01 \[/);
      expect(view.viewport().tsMode).toBe('date');
    } finally {
      view.unmount();
    }
  });

  test('judges only the lines on screen, not the whole buffer', () => {
    const mgr = newManager();
    logAt(mgr, '2026-09-05 23:59:59', 'yesterday');
    for (let i = 0; i < 5; i++) {
      logAt(mgr, `2026-09-06 00:00:0${String(i)}`, `today ${String(i)}`);
    }
    // A 3-row pane following the tail shows only today's lines.
    const view = mount(mgr, 120, 3);
    try {
      expect(view.viewport().tsMode).toBe('time');
      expect(view.frame().every((row) => TIME.test(row))).toBe(true);
    } finally {
      view.unmount();
    }
  });

  test('scrolling back across midnight brings the date column in, and forward drops it again', async () => {
    const mgr = newManager();
    logAt(mgr, '2026-09-05 23:59:59', 'yesterday');
    for (let i = 0; i < 3; i++) {
      logAt(mgr, `2026-09-06 00:00:0${String(i)}`, `today ${String(i)}`);
    }
    const view = mount(mgr, 120, 3);
    try {
      expect(view.viewport().tsMode).toBe('time');
      view.viewport().scrollLines(1);
      await view.settle();
      // The window now starts at yesterday's line: full dates, and exactly one row hidden below.
      expect(view.viewport().tsMode).toBe('date');
      expect(view.viewport().hiddenBelow).toBe(1);
      const rows = view.frame();
      expect(rows[0]).toContain('yesterday');
      expect(rows[rows.length - 1]).toContain('today 1');
      view.viewport().scrollLines(-1);
      await view.settle();
      expect(view.viewport().tsMode).toBe('time');
      expect(view.viewport().following).toBe(true);
      expect(view.frame()[2]).toContain('today 2');
      // Home lands on the very top whichever layout is rendered.
      view.viewport().scrollToTop();
      await view.settle();
      expect(view.viewport().hiddenAbove).toBe(0);
      expect(view.viewport().following).toBe(false);
      expect(view.frame()[0]).toContain('yesterday');
    } finally {
      view.unmount();
    }
  });

  test('keeps the same bottom edge when the date column reflows a wrapped line', async () => {
    const mgr = newManager();
    const columns = 60;
    logAt(mgr, '2026-09-05 23:59:59', 'yesterday');
    // With the `[devtooie] [INFO] ` prefix this takes 3 rows beside the date column and 2 without.
    logAt(mgr, '2026-09-06 00:00:00', 'w'.repeat(53));
    logAt(mgr, '2026-09-06 00:00:01', 'today 1');
    logAt(mgr, '2026-09-06 00:00:02', 'today 2');
    const lines = mgr.getVisibleLines();
    const wrapped = lines[1]!;
    expect(mgr.countRows(wrapped, columns, 'date')).toBeGreaterThan(
      mgr.countRows(wrapped, columns, 'time'),
    );
    const view = mount(mgr, columns, 4);
    try {
      expect(view.viewport().tsMode).toBe('time');
      // Scroll up until yesterday's line is in view: the layout flips to dates, and the row at the
      // bottom edge must still be the one the scroll landed on — not shifted by the extra row the
      // wrapped line now takes.
      view.viewport().scrollLines(1);
      await view.settle();
      expect(view.viewport().hiddenBelow).toBe(1);
      expect(view.frame().at(-1)).toContain('today 1');
      view.viewport().scrollLines(1);
      await view.settle();
      expect(view.viewport().hiddenBelow).toBe(2);
      expect(view.frame().at(-1)).toMatch(/w+$/);
      expect(view.viewport().tsMode).toBe('date');
    } finally {
      view.unmount();
    }
  });
});
