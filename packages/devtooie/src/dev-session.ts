import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { getLoadedConfig, getRegisteredPackages, getWorkspaceDir } from './config.js';
import { createControlClient, probeInstance } from './control-client.js';
import {
  routesFromConfig,
  startDevReverseProxy,
  type DevReverseProxyServer,
} from './dev-reverse-proxy.js';
import { decideControlPort, isPortListening, readRunning, type RunningState } from './running.js';
import { HANDOFF_FORCE_KILL_MS } from './shutdown-timing.js';

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
    if (!children.has(ppid)) {
      children.set(ppid, []);
    }
    children.get(ppid)!.push(pid);
  }
  const out = new Set<number>();
  const walk = (pid: number) => {
    if (out.has(pid)) {
      return;
    }
    out.add(pid);
    for (const c of children.get(pid) ?? []) {
      walk(c);
    }
  };
  for (const r of roots) {
    walk(r);
  }
  return [...out];
}

export function dedupePorts(ports: (number | undefined)[]): number[] {
  return [...new Set(ports.filter((p): p is number => typeof p === 'number' && !Number.isNaN(p)))];
}

export function collectDevPorts(): number[] {
  const ports: (number | undefined)[] = [];
  for (const a of getRegisteredPackages()) {
    ports.push(a.port);
  }
  return dedupePorts(ports);
}

export async function findListenerPids(ports: number[]): Promise<number[]> {
  if (!ports.length) {
    return [];
  }
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

/** The path out of `lsof -d cwd -Fn` output (the `n`-prefixed field), or null. */
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
  const { stdout, exitCode } = await execa('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    reject: false,
  });
  return exitCode === 0 ? parseLsofCwd(stdout) : null;
}

/** Splits pids into those running inside `root` and those belonging to something else. */
export async function partitionByWorkspace(
  pids: number[],
  root: string,
): Promise<{ ours: number[]; foreign: number[] }> {
  const ours: number[] = [];
  const foreign: number[] = [];
  const realRoot = resolveRealPath(root);
  for (const pid of pids) {
    const cwd = await processCwd(pid);
    // Unknown cwd (permission denied, exited mid-check) counts as foreign: killing something we
    // can't identify is exactly the mistake this guard exists to prevent.
    if (cwd && isInsideWorkspace(realRoot, resolveRealPath(cwd))) {
      ours.push(pid);
    } else {
      foreign.push(pid);
    }
  }
  return { ours, foreign };
}

/** Parses `ps -Ao pid=,pgid=` into `{ pid, pgid }` pairs. */
export function parsePsGroups(out: string): { pid: number; pgid: number }[] {
  return out
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([pid, pgid]) => Number.isInteger(pid) && Number.isInteger(pgid))
    .map(([pid, pgid]) => ({ pid: pid!, pgid: pgid! }));
}

/** Live members of each process group, from `ps` output. */
export function groupMembers(procs: { pid: number; pgid: number }[]): Map<number, number[]> {
  const byGroup = new Map<number, number[]>();
  for (const { pid, pgid } of procs) {
    const members = byGroup.get(pgid);
    if (members) {
      members.push(pid);
    } else {
      byGroup.set(pgid, [pid]);
    }
  }
  return byGroup;
}

/**
 * Kills package processes a previous session recorded in `running.json` but never cleaned up —
 * the SIGKILL case, where no shutdown path ran at all.
 *
 * Records are matched as **process groups**, not as single pids, and that distinction is the whole
 * point. Packages are spawned `detached: true`, so each recorded pid is also its group id, and the
 * group outlives its leader: a dev command that wraps the real worker (`env-cmd -- tsx watch …`, a
 * package manager, any `foo -- bar` shim) exits as soon as it has spawned, leaving the worker
 * running in that same group, reparented to PID 1. Checking whether the recorded pid is still alive
 * would skip exactly those — the ones that bind no port and so can't be found by a port sweep
 * either, which is how a `tsc --watch` / codegen generation survives every subsequent session.
 *
 * Before signalling, at least one live member of the group must still be running in the directory
 * the record was written with. A group id can only be created by a process whose pid equals it, so
 * combined with that check a recycled number can't take an unrelated process down with it. Groups
 * containing this process are never touched.
 *
 * Nor is anything touched while the session that wrote the record is **still running**. Reaching
 * this point doesn't mean that session ended: `decideControlPort` relocates instead of handing off
 * whenever it can't identify the instance holding the port (a wedged control API, or a second
 * session started against a different `-c` config), and in that case the recorded children are a
 * live session's packages, not orphans.
 */
export async function sweepRecordedOrphans(
  previous: RunningState | null,
  onStatus: (msg: string) => void = () => {},
): Promise<number[]> {
  const records = previous?.children ?? [];
  if (!records.length) {
    return [];
  }
  if (previous && isProcessAlive(previous.pid)) {
    return [];
  }
  const { stdout } = await execa('ps', ['-Ao', 'pid=,pgid='], { reject: false });
  const byGroup = groupMembers(parsePsGroups(stdout));

  const victims: number[] = [];
  for (const record of records) {
    const { pid } = record;
    const cwd = resolveRealPath(record.cwd);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
      continue;
    }
    const members = byGroup.get(pid) ?? [];
    // Never signal a group we're part of, whatever the record says.
    if (!members.length || members.includes(process.pid)) {
      continue;
    }
    let confirmed = false;
    for (const member of members) {
      const memberCwd = await processCwd(member);
      if (memberCwd && resolveRealPath(memberCwd) === cwd) {
        confirmed = true;
        break;
      }
    }
    if (confirmed) {
      victims.push(...members);
    }
  }

  if (victims.length) {
    onStatus(`cleaning up ${String(victims.length)} orphaned process(es) from a previous session`);
    await killTrees(victims);
  }
  return victims;
}

export async function killTrees(roots: number[]): Promise<void> {
  if (!roots.length) {
    return;
  }
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
 *
 * `quit()` **blocks** until the target reports its packages are torn down (ports freed), so by
 * the time it resolves the old session's dev ports are already clear. The subsequent pid poll
 * just waits out the target's own final exit (it still has to close its control server and quit
 * after acking) and is the robust source of truth — it survives the target hard-exiting or its
 * server closing mid-shutdown, cases where the HTTP ack never arrives. The whole wait is bounded
 * by `HANDOFF_FORCE_KILL_MS` (measured from the start), which sits past the target's own
 * worst-case graceful shutdown so a slow-but-graceful exit is never force-killed mid-cleanup;
 * only a target that overruns that gets its tree killed.
 */
export async function shutdownInstance(port: number, pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return;
  }
  const deadline = Date.now() + HANDOFF_FORCE_KILL_MS;
  await createControlClient(port).quit();
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
    if (os.platform() === 'win32') {
      process.kill(pid, 'SIGKILL');
    } else {
      await killTrees([pid]);
    }
  } catch {
    /* already gone */
  }
}

/**
 * Starts the dev reverse proxy for this session, if the loaded config declares one — before any
 * package starts, so the listener is bound and its port settled up front. Returns `null` when
 * the config has no `devReverseProxy`.
 *
 * Call it **after** {@link acquireDevSession}: a previous session being handed off releases the
 * proxy port as it shuts down, so whatever still holds it now is foreign — and that is a startup
 * error naming the port, never something to kill. (The proxy port is deliberately not part of
 * the dev-port sweep: its holder is a devtooie process, and a live session that merely relocated
 * would be killed outright.)
 */
export async function startSessionDevReverseProxy(opts: {
  /** The control API's port, so a "package stopped" page can spell out the restart URL. */
  controlApiPort?: number;
}): Promise<DevReverseProxyServer | null> {
  const config = getLoadedConfig();
  const proxy = config?.devReverseProxy;
  if (!config || !proxy) {
    return null;
  }
  if (await isPortListening(proxy.port)) {
    throw new Error(
      `dev reverse proxy port ${String(proxy.port)} is already in use by another program. ` +
        'Free it, or change `devReverseProxy.port` in devtooie.config.ts.',
    );
  }
  return startDevReverseProxy({
    port: proxy.port,
    rootDomain: proxy.rootDomain,
    routes: routesFromConfig(config),
    controlApiPort: opts.controlApiPort,
    urlScheme: proxy.urlScheme,
    urlPort: proxy.urlPort,
  });
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
  /** This session's logfile; its directory is recorded in `running.json` as `logDir`. */
  logFile?: string;
  onStatus?: (msg: string) => void;
}): Promise<number> {
  const onStatus = opts.onStatus ?? (() => {});
  // Read before `decideControlPort` — it rewrites `running.json` with this session's pid, which
  // would drop the previous session's child records before we've had a chance to sweep them.
  const previous = readRunning(process.cwd());
  const port = await decideControlPort({
    cwd: process.cwd(),
    configPath: opts.configPath,
    apiPortOverride: opts.apiPortOverride,
    logDir: opts.logFile ? path.dirname(opts.logFile) : undefined,
    logFile: opts.logFile,
    env: { isListening: isPortListening, probe: probeInstance, shutdown: shutdownInstance },
    onStatus,
  });
  // Sweep this workspace's orphans (Unix-only; needs lsof/ss/ps).
  if (os.platform() !== 'win32') {
    // First the processes a previous session recorded — this is the only sweep that reaches
    // packages which never bind a port.
    await sweepRecordedOrphans(previous, onStatus);

    onStatus('freeing dev ports');
    const holders = await findListenerPids(collectDevPorts());
    // Only ever kill a port holder that belongs to *this* workspace. A configured dev port is a
    // claim on a number, not ownership of it: an unrelated project (or any other program) may
    // legitimately be listening there, and killing it because we happen to want the port is a
    // side effect well outside what starting a dev session should do. Say so and let the
    // package's own startup fail loudly on the bound port instead.
    const { ours, foreign } = await partitionByWorkspace(holders, getWorkspaceDir());
    await killTrees(ours);
    for (const pid of foreign) {
      onStatus(`dev port held by another program (pid ${String(pid)}) — leaving it alone`);
    }
  }
  return port;
}
