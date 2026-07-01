import os from 'node:os';
import { execa } from 'execa';
import { getRegisteredApps } from './config.js';
import { getApiPort } from './lib.js';

export function parseLsofPids(out: string): number[] {
  return out
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function parseSsPids(out: string): number[] {
  return [...out.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
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
  for (const a of getRegisteredApps()) {
    ports.push(a.run?.port, a.run?.hmrPort);
  }
  ports.push(getApiPort());
  return dedupePorts(ports);
}

export async function findListenerPids(ports: number[]): Promise<number[]> {
  if (!ports.length) return [];
  if (os.platform() === 'darwin') {
    const { stdout } = await execa('lsof', ['-t', ...ports.flatMap((p) => ['-i', `:${p}`])], {
      reject: false,
    });
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

export async function acquireDevSession(
  opts: { onStatus?: (msg: string) => void } = {},
): Promise<void> {
  if (os.platform() === 'win32') return; // Unix-only handoff
  const port = getApiPort();
  const onStatus = opts.onStatus ?? (() => {});
  // 1. Detect a live prior session and ask it to quit.
  try {
    const res = await fetch(`http://127.0.0.1:${port}/query/pid`, {
      signal: AbortSignal.timeout(500),
    });
    if (res.ok) {
      const { pid } = (await res.json()) as { pid: number };
      if (pid && pid !== process.pid) {
        onStatus('closing previous session');
        await fetch(`http://127.0.0.1:${port}/command/quit`, { method: 'POST' }).catch(() => {});
        const deadline = Date.now() + 11_000;
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0);
          } catch {
            break;
          } // ESRCH → gone
          await new Promise((r) => setTimeout(r, 250));
        }
        try {
          process.kill(pid, 0);
          await killTrees([pid]);
        } catch {
          /* already gone */
        }
      }
    }
  } catch {
    /* no prior session */
  }
  // 2. Always sweep dev ports.
  onStatus('freeing dev ports');
  const holders = await findListenerPids(collectDevPorts());
  await killTrees(holders);
}
