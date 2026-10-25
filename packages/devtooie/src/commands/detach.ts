import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findService, getLoadedConfig, getWorkspaceDir } from '../config.js';
import {
  connectSessionControl,
  type ControlClient,
  type SessionStatus,
} from '../control-client.js';
import { isProcessAlive } from '../dev-session.js';
import { currentMode, shellEnvironment } from '../env.js';
import { hasDevScript, resolveDeps } from '../lib.js';
import { findConfigPath } from '../load-config.js';
import { getLogDir } from '../log-files.js';
import { readRunning } from '../running.js';
import { type RootOptions, resolveSelectedNamesOrExit } from './default.js';

// `--headless --detach [--wait]`: a session in the background — started, or the one already
// running in this mode, with what it lacks started into it — reported as one JSON line.

/** The exit code a detached session uses when it finds a session of its mode already running. */
export const DETACHED_FOUND_SESSION_EXIT = 75;

/** How long `--wait` waits when `--wait-timeout` doesn't say, in seconds. */
const DEFAULT_WAIT_TIMEOUT_S = 300;

/** How often the session is read while waiting for it. */
const POLL_MS = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What `--detach` prints on stdout, as one line of JSON. */
export interface DetachReport {
  ok: boolean;
  /** `started`: this call started the session. `reused`: one of the mode was already running. */
  session: 'started' | 'reused';
  pid: number;
  /** The session's control-API port. */
  port: number;
  mode: string;
  logFile: string | null;
  /**
   * The services this call started: for a session it started, all of them; for a reused one,
   * the ones it lacked, or had stopped. What a caller cleaning up after itself stops.
   */
  services: string[];
  /** Why it failed, when `ok` is false. */
  error?: string;
}

/** Progress, on stderr: stdout carries only the JSON line. */
const note = (message: string) => console.error(`devtooie: ${message}`);

export async function runDetached(opts: RootOptions): Promise<never> {
  const names = resolveSelectedNamesOrExit(opts, '--headless');
  const mode = currentMode();
  const workspaceDir = getWorkspaceDir();
  const configPath = findConfigPath(workspaceDir) ?? path.join(workspaceDir, 'devtooie.config.ts');
  const apiPort = getLoadedConfig()?.apiPort;
  const timeoutMs = (opts.waitTimeout ?? DEFAULT_WAIT_TIMEOUT_S) * 1000;

  // Everything the session runs for this selection that has a process to wait on: the selected
  // services and their runtime deps, as at a session's start.
  const runSet = [...resolveDeps(names.map((n) => findService(n))).runSet];
  const wanted = runSet.filter((name) => {
    const pkg = findService(name);
    return hasDevScript(pkg) && (names.includes(name) || pkg.autostart !== false);
  });

  const found = await findSession({ workspaceDir, configPath, mode, apiPort });
  if (found.kind === 'unresponsive') {
    finish(undefined, `a ${mode} session is recorded as running (pid ${String(found.pid)}) but doesn't answer on its control API; stop it, then try again`); // oxfmt-ignore
  }

  let report: DetachReport;
  let client: ControlClient;
  let alive: () => boolean;
  if (found.kind === 'running') {
    ({ report, client } = await reuse(found.client, mode, wanted, timeoutMs));
    const pid = report.pid;
    alive = () => isProcessAlive(pid);
  } else {
    const started = await start({
      names,
      mode,
      workspaceDir,
      configPath,
      apiPort,
      opts,
      wanted,
      timeoutMs,
    });
    if (started.kind === 'found-session') {
      // Another session of this mode came up meanwhile: use it instead.
      const again = await findSession({ workspaceDir, configPath, mode, apiPort });
      if (again.kind !== 'running') {
        finish(
          undefined,
          `a ${mode} session started meanwhile, but it can't be reached; try again`,
        );
      }
      ({ report, client } = await reuse(again.client, mode, wanted, timeoutMs));
      const pid = report.pid;
      alive = () => isProcessAlive(pid);
    } else {
      ({ report, client, alive } = started);
    }
  }

  if (opts.wait) {
    const error = await waitUntilReady(client, wanted, timeoutMs, alive);
    if (error) {
      finish(report, error);
    }
  }
  finish(report);
}

type FoundSession =
  | { kind: 'none' }
  | { kind: 'running'; client: ControlClient }
  | { kind: 'unresponsive'; pid: number };

/**
 * This config's session in this mode: one that answers, one recorded alive that doesn't (never
 * taken over), or none.
 */
async function findSession(opts: {
  workspaceDir: string;
  configPath: string;
  mode: string;
  apiPort?: number;
}): Promise<FoundSession> {
  const client = await connectSessionControl(opts);
  if (client) {
    return { kind: 'running', client };
  }
  const record = readRunning(opts.workspaceDir, opts.mode);
  if (record && isProcessAlive(record.pid)) {
    return { kind: 'unresponsive', pid: record.pid };
  }
  return { kind: 'none' };
}

/** Status values for a service that is up, or on its way up. */
const UNDER_WAY = new Set(['running', 'waiting', 'restarting', 'rebuilding']);

/** Starts into a running session whatever of `wanted` it lacks or has stopped. */
async function reuse(
  client: ControlClient,
  mode: string,
  wanted: string[],
  timeoutMs: number,
): Promise<{ report: DetachReport; client: ControlClient }> {
  const status = await statusOnceAttached(client, timeoutMs);
  if (!status) {
    finish(undefined, `the running ${mode} session didn't finish starting in time`);
  }
  const report: DetachReport = {
    ok: true,
    session: 'reused',
    pid: status.pid,
    port: client.port,
    mode,
    logFile: status.logFile,
    services: [],
  };
  for (const name of wanted) {
    const current = (await client.query.status())?.services?.[name];
    if (current !== undefined && UNDER_WAY.has(current)) {
      continue;
    }
    note(`starting ${name} in the running ${mode} session`);
    if (!(await client.command.service.start(name))) {
      finish(report, `the running ${mode} session didn't start ${name}; see ${status.logFile ?? 'its log'}`); // oxfmt-ignore
    }
    report.services.push(name);
  }
  note(`reusing the running ${mode} session (pid ${String(status.pid)})`);
  return { report, client };
}

/** The session's status once its services are known (`services` set), or null at the deadline. */
async function statusOnceAttached(
  client: ControlClient,
  timeoutMs: number,
): Promise<SessionStatus | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await client.query.status();
    if (status?.services) {
      return status;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(POLL_MS);
  }
}

/** Starts a headless session in the background and waits until its control API answers. */
async function start(opts: {
  names: string[];
  mode: string;
  workspaceDir: string;
  configPath: string;
  apiPort?: number;
  opts: RootOptions;
  wanted: string[];
  timeoutMs: number;
}): Promise<
  | { kind: 'found-session' }
  | { kind: 'started'; report: DetachReport; client: ControlClient; alive: () => boolean }
> {
  const logDir = opts.opts.logDir ? path.resolve(opts.opts.logDir) : getLogDir();
  fs.mkdirSync(logDir, { recursive: true });
  // The session's own output before its log starts — and a crash's — goes here. Never the
  // caller's stdout: a caller reading it to the end would wait as long as the session runs.
  const outputFile = path.join(logDir, 'detached.out');
  const out = fs.openSync(outputFile, 'w');
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  const args = [
    cli,
    '--headless',
    ...opts.names.flatMap((name) => ['-s', name]),
    '--mode',
    opts.mode,
    ...(opts.opts.logDir ? ['--log-dir', logDir] : []),
    '--detached-session',
  ];
  note(`starting a ${opts.mode} session in the background: ${opts.names.join(', ')}`);
  // The environment this devtooie was started with: its own has the workspace's `.env` values
  // merged in, which the session would take for the shell's and let beat its own files.
  const child = spawn(process.execPath, args, {
    cwd: opts.workspaceDir,
    env: shellEnvironment(),
    detached: true,
    stdio: ['ignore', out, out],
  });
  fs.closeSync(out);
  let exitCode: number | null = null;
  child.on('exit', (code, signal) => {
    exitCode = code ?? (signal ? 128 : 1);
  });
  child.unref();
  const pid = child.pid!;
  const alive = () => exitCode === null && isProcessAlive(pid);

  const tail = () => {
    try {
      return fs.readFileSync(outputFile, 'utf8').trim().split('\n').slice(-20).join('\n');
    } catch {
      return '';
    }
  };
  const report: DetachReport = {
    ok: true,
    session: 'started',
    pid,
    port: 0,
    mode: opts.mode,
    logFile: null,
    services: opts.wanted,
  };

  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (Date.now() >= deadline && alive()) {
      // Alive but never answering: stop it, so nothing is left behind that no one can reach.
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        /* gone meanwhile */
      }
      finish(
        report,
        `the session didn't answer on its control API within ${String(Math.round(opts.timeoutMs / 1000))}s (see ${outputFile})`,
      );
    }
    if (exitCode === DETACHED_FOUND_SESSION_EXIT) {
      return { kind: 'found-session' };
    }
    if (!alive()) {
      const output = tail();
      finish(
        report,
        `the session exited before it was up (see ${outputFile})${output ? `:\n${output}` : ''}`,
      );
    }
    const client = await connectSessionControl({
      workspaceDir: opts.workspaceDir,
      configPath: opts.configPath,
      mode: opts.mode,
      apiPort: opts.apiPort,
    });
    const status = client ? await client.query.status() : null;
    if (client && status?.pid === pid) {
      report.port = client.port;
      report.logFile = status.logFile;
      note(`session up (pid ${String(pid)}, control port ${String(client.port)})`);
      return { kind: 'started', report, client, alive };
    }
    await sleep(POLL_MS);
  }
}

/**
 * Waits until the infra and every one of `wanted` is ready. Returns why it gave up — the session
 * gone, a service stopped, or the deadline — or `undefined` once all of it is ready.
 */
async function waitUntilReady(
  client: ControlClient,
  wanted: string[],
  timeoutMs: number,
  alive: () => boolean,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  note(`waiting for ${wanted.join(', ')} to be healthy`);
  let pending: string[] = [...wanted];
  for (;;) {
    if (!alive()) {
      return 'the session exited while starting; see its log';
    }
    const status = await client.query.status();
    if (status?.services && status.ready) {
      const stopped = wanted.filter((name) => status.services?.[name] === 'stopped');
      if (stopped.length > 0) {
        return `${stopped.join(', ')} stopped while starting; see ${status.logFile ?? 'the session log'}`;
      }
      const infra = Object.entries(status.infra ?? {}).filter(([, state]) => state !== 'running');
      pending = [
        ...infra.map(([name]) => `infra service ${name}`),
        ...wanted.filter((name) => status.ready?.[name] !== true),
      ];
      if (pending.length === 0) {
        note('everything is healthy');
        return undefined;
      }
    }
    if (Date.now() >= deadline) {
      return `not healthy after ${String(Math.round(timeoutMs / 1000))}s: ${pending.join(', ')}`;
    }
    await sleep(POLL_MS);
  }
}

/** Prints the JSON line — `ok: false` with `error` when given one — and exits accordingly. */
function finish(report: DetachReport | undefined, error?: string): never {
  if (error) {
    note(error);
  }
  if (report) {
    const line: DetachReport = error ? { ...report, ok: false, error } : report;
    console.log(JSON.stringify(line));
  } else if (error) {
    console.log(JSON.stringify({ ok: false, error }));
  }
  process.exit(error ? 1 : 0);
}
