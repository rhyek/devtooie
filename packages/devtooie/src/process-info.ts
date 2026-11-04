import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// What can be told about a process from outside it, with nothing a light command can't load.

const execFileAsync = promisify(execFile);

export function parseLsofCwd(out: string): string | null {
  const line = out.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

/** `true` when `target` is `root` itself or sits underneath it. */
export function isInsideWorkspace(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * `realpath`, falling back to the path as given when it can't be resolved (already gone, or not
 * ours to read). Every cwd comparison below goes through this: the kernel reports a process's cwd
 * fully resolved (`/proc/<pid>/cwd`, `lsof -d cwd`), while the paths devtooie derives from its own
 * config keep whatever symlinks the user typed — so `~/dev` and `/Volumes/Data/dev` are the same
 * directory that never compares equal.
 */
export function resolveRealPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** `true` while `pid` still exists. `EPERM` means it's alive but not ours to signal. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Working directory of a live process, or null if it's gone / can't be inspected. */
export async function processCwd(pid: number): Promise<string | null> {
  if (os.platform() === 'linux') {
    try {
      return await fs.promises.readlink(`/proc/${String(pid)}/cwd`);
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    return parseLsofCwd(stdout);
  } catch {
    return null; // gone, not ours to inspect, or no lsof
  }
}
