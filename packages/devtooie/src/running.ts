import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/**
 * Random control-API port range: `14000`–`14099` (100 ports). Kept below the OS ephemeral
 * range (Linux 32768+, macOS 49152+) and above the usual app dev-server ports, so a picked
 * port neither collides with app servers nor gets grabbed as a transient outbound port.
 */
export const CONTROL_PORT_MIN = 14000;
export const CONTROL_PORT_COUNT = 100;

/** Persisted at `node_modules/.devtooie/running.json`: this workspace's control-API port + owner pid. */
export interface RunningState {
  port: number;
  pid: number;
  /**
   * Absolute directory the session writes its timestamped logs into (`dev-<timestamp>.log`).
   * Lets a tool find the current session's logs even when started with `--log-dir`. Omitted
   * by callers that don't run a session (e.g. tests).
   */
  logDir?: string;
}

/** Identity of a live devtooie instance, as reported by its `/query/pid` endpoint. */
export interface InstanceInfo {
  pid: number;
  /** Absolute path to the `devtooie.config.*` that instance was started with. */
  configPath: string;
}

export function runningFilePath(cwd: string): string {
  return path.join(cwd, 'node_modules', '.devtooie', 'running.json');
}

export function readRunning(cwd: string): RunningState | null {
  try {
    const s = JSON.parse(fs.readFileSync(runningFilePath(cwd), 'utf8')) as RunningState;
    if (typeof s.port === 'number' && typeof s.pid === 'number') return s;
    return null;
  } catch {
    return null;
  }
}

export function writeRunning(cwd: string, state: RunningState): void {
  const file = runningFilePath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

/** A random port in the control range, avoiding any in `exclude`. */
export function pickRandomPort(exclude: number[] = []): number {
  const ex = new Set(exclude);
  const avail: number[] = [];
  for (let p = CONTROL_PORT_MIN; p < CONTROL_PORT_MIN + CONTROL_PORT_COUNT; p++) {
    if (!ex.has(p)) avail.push(p);
  }
  if (avail.length === 0) return CONTROL_PORT_MIN + Math.floor(Math.random() * CONTROL_PORT_COUNT);
  return avail[Math.floor(Math.random() * avail.length)]!;
}

/** `true` if something is accepting TCP connections on `127.0.0.1:port`. */
export function isPortListening(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (v: boolean) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => resolve(false));
  });
}

/** Queries a port's `/query/pid`; returns the instance identity, or null if it isn't a devtooie instance. */
export async function probeInstance(port: number, timeoutMs = 500): Promise<InstanceInfo | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/query/pid`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { pid?: number; configPath?: string };
    if (typeof body.pid === 'number' && typeof body.configPath === 'string') {
      return { pid: body.pid, configPath: body.configPath };
    }
    return null;
  } catch {
    return null;
  }
}

/** Network side effects used by {@link decideControlPort}; injected so the decision logic is testable. */
export interface PortEnv {
  isListening(port: number): Promise<boolean>;
  probe(port: number): Promise<InstanceInfo | null>;
  shutdown(port: number, pid: number): Promise<void>;
}

/**
 * Decides which port this session's control API should bind, and records it in
 * `running.json`. See the module for the full protocol; in short:
 *
 * - Explicit `apiPortOverride` → use that fixed port; hand off (shut down) only a
 *   same-workspace instance already on it, never a foreign one.
 * - Otherwise start from the recorded port (or a fresh random one) and, if it's occupied:
 *   hand off + reuse when it's this same workspace, or relocate to a new random port when
 *   it's a different workspace (or a non-devtooie listener). A free port is used as-is.
 */
export async function decideControlPort(opts: {
  cwd: string;
  /** Absolute path to this session's own `devtooie.config.*`. */
  configPath: string;
  apiPortOverride?: number;
  pid?: number;
  /** Directory this session writes its logs into; recorded in `running.json` as `logDir`. */
  logDir?: string;
  env: PortEnv;
  onStatus?: (message: string) => void;
}): Promise<number> {
  const pid = opts.pid ?? process.pid;
  const onStatus = opts.onStatus ?? (() => {});
  const finalize = (port: number): number => {
    // `logDir: undefined` is dropped by JSON.stringify, so it's simply omitted when unset.
    writeRunning(opts.cwd, { port, pid, logDir: opts.logDir });
    return port;
  };

  if (opts.apiPortOverride != null) {
    const info = await opts.env.probe(opts.apiPortOverride);
    if (info && info.configPath === opts.configPath) {
      onStatus('closing previous session');
      await opts.env.shutdown(opts.apiPortOverride, info.pid);
    }
    return finalize(opts.apiPortOverride);
  }

  const state = readRunning(opts.cwd);
  let candidate = state?.port ?? pickRandomPort();
  const tried = new Set<number>();
  for (let i = 0; i < CONTROL_PORT_COUNT; i++) {
    tried.add(candidate);
    if (!(await opts.env.isListening(candidate))) return finalize(candidate);

    const info = await opts.env.probe(candidate);
    if (info && info.configPath === opts.configPath) {
      onStatus('closing previous session');
      await opts.env.shutdown(candidate, info.pid);
      return finalize(candidate);
    }
    // A different workspace's instance, or a non-devtooie listener — leave it alone and relocate.
    candidate = pickRandomPort([...tried]);
  }
  return finalize(candidate);
}
