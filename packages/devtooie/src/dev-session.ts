import os from 'node:os';
import { execa } from 'execa';
import { getRegisteredPackages } from './config.js';
import { decideControlPort, isPortListening, probeInstance } from './running.js';

export function parseLsofPids(out: string): number[] {
  return out
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function parseSsPids(out: string): number[] {
  return [...out.matchAll(/pid=(\d+)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function buildKillSet(procs: { pid: number; ppid: number }[], roots: number[]): number[] {
  const children = new Map<number, number[]>();
  for (const { pid, ppid } of procs) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);
  }
  const out = new Set<number>();
  const walk = (pid: number) => {
    if (out.has(pid)) return;
    out.add(pid);
    for (const c of children.get(pid) ?? []) walk(c);
  };
  for (const r of roots) walk(r);
  return [...out];
}

export function dedupePorts(ports: (number | undefined)[]): number[] {
  return [...new Set(ports.filter((p): p is number => typeof p === 'number' && !Number.isNaN(p)))];
}

export function collectDevPorts(): number[] {
  const ports: (number | undefined)[] = [];
  for (const a of getRegisteredPackages()) {
    ports.push(a.port, a.hmrPort);
  }
  return dedupePorts(ports);
}

export async function findListenerPids(ports: number[]): Promise<number[]> {
  if (!ports.length) return [];
  if (os.platform() === 'darwin') {
    // Only match LISTENERS on the port (mirrors Linux ss -tlnpH listening-only behavior)
    const { stdout } = await execa(
      'lsof',
      ['-t', '-sTCP:LISTEN', ...ports.flatMap((p) => ['-i', `:${p}`])],
      { reject: false },
    );
    return parseLsofPids(stdout);
  }
  const pids: number[] = [];
  for (const p of ports) {
    const { stdout } = await execa('ss', ['-tlnpH', `sport = :${p}`], { reject: false });
    pids.push(...parseSsPids(stdout));
  }
  return [...new Set(pids)];
}

export async function killTrees(roots: number[]): Promise<void> {
  if (!roots.length) return;
  const { stdout } = await execa('ps', ['-Ao', 'pid=,ppid='], { reject: false });
  const procs = stdout
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
    .map(([pid, ppid]) => ({ pid: pid!, ppid: ppid! }));
  const all = buildKillSet(procs, roots);
  for (const pid of roots) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  for (const pid of all) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

/**
 * Gracefully shuts down the devtooie instance at `port` (POST /command/quit), waits for
 * `pid` to exit, then force-kills its process tree if it's still alive (Unix best-effort).
 */
export async function shutdownInstance(port: number, pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  await fetch(`http://127.0.0.1:${port}/command/quit`, { method: 'POST' }).catch(() => {});
  const deadline = Date.now() + 11_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH → gone
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    process.kill(pid, 0);
    if (os.platform() === 'win32') process.kill(pid, 'SIGKILL');
    else await killTrees([pid]);
  } catch {
    /* already gone */
  }
}

/**
 * Prepares a dev session: decides (and records in `running.json`) the control-API port,
 * handing off or relocating around any instance already on it (see
 * {@link decideControlPort}), then sweeps orphans off this workspace's package dev ports.
 * Returns the chosen control-API port.
 */
export async function acquireDevSession(opts: {
  /** Absolute path to this session's `devtooie.config.*` — identifies this workspace. */
  configPath: string;
  /** A user-pinned `apiPort`, if any; when set, the port is fixed instead of random. */
  apiPortOverride?: number;
  onStatus?: (msg: string) => void;
}): Promise<number> {
  const onStatus = opts.onStatus ?? (() => {});
  const port = await decideControlPort({
    cwd: process.cwd(),
    configPath: opts.configPath,
    apiPortOverride: opts.apiPortOverride,
    env: { isListening: isPortListening, probe: probeInstance, shutdown: shutdownInstance },
    onStatus,
  });
  // Sweep orphans off this workspace's package dev ports (Unix-only; needs lsof/ss/ps).
  if (os.platform() !== 'win32') {
    onStatus('freeing dev ports');
    const holders = await findListenerPids(collectDevPorts());
    await killTrees(holders);
  }
  return port;
}
