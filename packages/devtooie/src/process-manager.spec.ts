import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessManager } from './process-manager.js';
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

function pkg(): AnyPackageConfig {
  return { name: 'fixture', types: [], relativeDir: '.', path: dir };
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
});
