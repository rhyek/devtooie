import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseLsofPids,
  parseSsPids,
  buildKillSet,
  dedupePorts,
  isProcessAlive,
  parseLsofCwd,
  isInsideWorkspace,
  resolveRealPath,
  sweepRecordedOrphans,
  parsePsGroups,
  groupMembers,
} from './dev-session.js';

describe('dev-session pure helpers', () => {
  it('parses lsof -t output (one pid per line)', () => {
    expect(parseLsofPids('1234\n5678\n')).toEqual([1234, 5678]);
    expect(parseLsofPids('')).toEqual([]);
  });

  it('parses ss -tlnpH output extracting pid=', () => {
    const out = 'LISTEN 0 511 *:3000 *:* users:(("node",pid=4242,fd=20))';
    expect(parseSsPids(out)).toEqual([4242]);
  });

  it('parseSsPids filters out pid=0', () => {
    const out = 'LISTEN 0 511 *:3000 *:* users:(("x",pid=0,fd=1)) ... pid=4242';
    expect(parseSsPids(out)).toEqual([4242]);
  });

  it('builds a kill set of roots + transitive descendants', () => {
    const procs = [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 200 },
      { pid: 999, ppid: 1 },
    ];
    expect(buildKillSet(procs, [100]).sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  it('dedupes and filters NaN/undefined ports', () => {
    expect(dedupePorts([3000, 3000, undefined, NaN, 4099]).sort((a, b) => a - b)).toEqual([
      3000, 4099,
    ]);
  });

  it('parses the cwd path out of lsof -Fn output', () => {
    expect(parseLsofCwd('p123\nfcwd\nn/work/repo/packages/api\n')).toBe('/work/repo/packages/api');
    expect(parseLsofCwd('')).toBeNull();
  });

  it('scopes paths to the workspace root', () => {
    expect(isInsideWorkspace('/work/repo', '/work/repo')).toBe(true);
    expect(isInsideWorkspace('/work/repo', '/work/repo/packages/api')).toBe(true);
    expect(isInsideWorkspace('/work/repo', '/work/other')).toBe(false);
    // The prefix-match trap: a sibling directory that merely starts with the root's name.
    expect(isInsideWorkspace('/work/repo', '/work/repo-two/pkg')).toBe(false);
  });
});

describe('sweepRecordedOrphans', () => {
  it('does nothing without a previous session', async () => {
    expect(await sweepRecordedOrphans(null)).toEqual([]);
    expect(await sweepRecordedOrphans({ port: 1, pid: 2 })).toEqual([]);
  });

  it('skips records with no live process group', async () => {
    // Pid 0 / negatives are rejected outright; nothing is signalled without a live group member.
    const swept = await sweepRecordedOrphans({
      port: 1,
      pid: 2,
      children: [
        { pid: 0, cwd: '/nope' },
        { pid: -5, cwd: '/nope' },
      ],
    });
    expect(swept).toEqual([]);
  });

  it('never sweeps its own pid, even if recorded', async () => {
    const swept = await sweepRecordedOrphans({
      port: 1,
      pid: 2,
      children: [{ pid: process.pid, cwd: process.cwd() }],
    });
    expect(swept).toEqual([]);
  });

  it('never sweeps a group this process belongs to, even when the cwd matches', async () => {
    // Guards the self-destruct case: the test runner's own group id, recorded with a directory
    // that would otherwise confirm it.
    const swept = await sweepRecordedOrphans({
      port: 1,
      pid: 2,
      children: [{ pid: process.pid, cwd: process.cwd() }],
    });
    expect(swept).not.toContain(process.pid);
  });
});

describe('process-group parsing', () => {
  it('parses ps pid/pgid output', () => {
    expect(parsePsGroups(' 100 100\n 200 100\n 300 300\n')).toEqual([
      { pid: 100, pgid: 100 },
      { pid: 200, pgid: 100 },
      { pid: 300, pgid: 300 },
    ]);
  });

  it('groups members by their process group', () => {
    const groups = groupMembers([
      { pid: 100, pgid: 100 },
      { pid: 200, pgid: 100 },
      { pid: 300, pgid: 300 },
    ]);
    expect(groups.get(100)).toEqual([100, 200]);
    expect(groups.get(300)).toEqual([300]);
  });

  it('still finds members of a group whose leader has exited', () => {
    // The wrapper-command case: the leader (a package manager / env shim) is gone, but the worker
    // it spawned is still in the group. Matching on the group is what makes it reapable.
    const groups = groupMembers([{ pid: 200, pgid: 100 }]);
    expect(groups.get(100)).toEqual([200]);
  });
});

describe('isProcessAlive', () => {
  it('sees this process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('rejects a pid that has already been reaped, and nonsense pids', async () => {
    const child = spawn('true', { stdio: 'ignore' });
    const pid = child.pid!;
    await new Promise((r) => child.on('exit', r));
    expect(isProcessAlive(pid)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});

describe('resolveRealPath', () => {
  it('resolves a symlinked directory to its real path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-real-'));
    const real = path.join(dir, 'real');
    const link = path.join(dir, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    try {
      expect(resolveRealPath(link)).toBe(resolveRealPath(real));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the path unchanged when it cannot be resolved', () => {
    expect(resolveRealPath('/definitely/not/here')).toBe('/definitely/not/here');
  });
});

describe.skipIf(os.platform() === 'win32')('sweepRecordedOrphans owner liveness', () => {
  let child: ReturnType<typeof spawn> | undefined;
  let dir: string | undefined;

  afterEach(() => {
    if (child?.pid && isProcessAlive(child.pid)) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    child = undefined;
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  /** A detached sleeper, i.e. its own process group leader, exactly like a spawned package. */
  function spawnRecordedChild(): { pid: number; cwd: string } {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-sweep-')));
    child = spawn('sleep', ['30'], { cwd: dir, detached: true, stdio: 'ignore' });
    return { pid: child.pid!, cwd: dir };
  }

  it('leaves the recorded children alone while the session that recorded them is alive', async () => {
    const record = spawnRecordedChild();
    // `decideControlPort` relocates rather than handing off when it can't identify the instance
    // holding the port, so a *live* session's records can reach the sweep. They are not orphans.
    const swept = await sweepRecordedOrphans({ port: 1, pid: process.pid, children: [record] });
    expect(swept).toEqual([]);
    expect(isProcessAlive(record.pid)).toBe(true);
  });

  it('sweeps them once that session is gone', async () => {
    const record = spawnRecordedChild();
    const dead = spawn('true', { stdio: 'ignore' });
    const deadPid = dead.pid!;
    await new Promise((r) => dead.on('exit', r));

    const swept = await sweepRecordedOrphans({ port: 1, pid: deadPid, children: [record] });
    expect(swept).toContain(record.pid);
  });
});
