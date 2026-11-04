import { type ChildProcess, fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ControlClient, SessionEvent, SessionServiceStatus } from './control-client.js';
import type { InfraStatus } from './infra/control.js';
import type { ServiceName } from './register.js';

// `startStack()`: a headless session forked as this process's child, for a test suite's setup. It
// runs the CLI rather than devtooie in-process, so the config loads in a process of its own and
// the caller's module state and environment are left alone. The session ends with this process.

export interface StartStackOptions<P extends string = ServiceName> {
  /** The services to bring up, as `-s` names them. Their runtime deps and the mode's infra come too. */
  services: P[];
  /** The mode, as `--mode` takes it. Unset, the CLI resolves it as it does from a shell. */
  mode?: string;
  /** Where the workspace is found from, as the CLI finds it from its working directory. Default `process.cwd()`. */
  cwd?: string;
  /** How long to wait for everything to be healthy, in seconds. Default 300. */
  waitTimeout?: number;
  /** A session's log directory, as `--log-dir` takes it. */
  logDir?: string;
  /**
   * Quit a session of the mode already running in the workspace, and start this one in its
   * place, as `--kill-others` does. Without it, a running one fails the call.
   */
  killOthers?: boolean;
  /**
   * The environment the session starts with. Default: this process's, without what a package
   * manager script and a test runner add to it (see {@link stackEnvironment}). Given, it is used
   * as it is.
   */
  env?: NodeJS.ProcessEnv;
}

export interface Stack<P extends string = ServiceName> {
  /** Always `started`: a stack's session is the one its call started. */
  session: 'started';
  /** The session's pid. */
  pid: number;
  /** The session's control-API port. */
  port: number;
  mode: string;
  /** The session's logfile. */
  logFile: string | null;
  /** The services the session brought up: the ones asked for, and their runtime deps. */
  services: P[];
  /**
   * Every configured service's origin, selected or not: its public origin under the dev reverse
   * proxy, `http://localhost:<port>` otherwise. A service with no `port` has none.
   */
  origins: Partial<Record<P, string>>;
  /** The dev reverse proxy's canonical root domain, or null when the config declares no proxy. */
  rootDomain: string | null;
  /** A client for the session's control API. */
  control: ControlClient<P>;
  /** Quits the session, resolving once it has exited. */
  stop(): Promise<void>;
}

/** What a forked session sends its parent over the IPC channel. */
export interface StackMessage {
  type: 'started';
  pid: number;
  /** Its control-API port, listening by now. */
  port: number;
  sessionId: string;
  logFile: string;
  /** What it runs and will wait on: the selected services and their runtime deps. */
  services: string[];
}

/** How long to wait for health when `waitTimeout` doesn't say, in seconds. */
const DEFAULT_WAIT_TIMEOUT_S = 300;

/** How long `stop()` gives a session to exit after its quit, and again after a SIGTERM. */
const STOP_GRACE_MS = 30_000;

/**
 * How long everything must stay ready before the stack counts as up: a service with no healthcheck
 * is ready the moment it runs, before it can have failed.
 */
const SETTLE_MS = 1000;

/** How much of the session's own output an error quotes. */
const OUTPUT_TAIL_LINES = 20;

/**
 * A wait that doesn't keep the process running: the session's child process and channel do that
 * while there is one to wait on.
 */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/** Progress, on stderr. */
const note = (message: string) => console.error(`devtooie: ${message}`);

/**
 * Brings up a headless session with `services`, as this process's child, and waits until every one
 * of them, and the mode's infra, is healthy. The session ends with this process, however it ends.
 * A session of the mode already running fails the call, unless `killOthers` quits it. Throws
 * devtooie's error, with the log's path, after quitting the session.
 */
export async function startStack<P extends string = ServiceName>(
  options: StartStackOptions<P>,
): Promise<Stack<P>> {
  const { createControlClient } = await import('./control-client.js');
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const args = [
    ...(options.mode === undefined ? [] : ['--mode', options.mode]),
    '--headless',
    ...options.services.flatMap((name) => ['-s', name]),
    ...(options.killOthers ? ['--kill-others'] : []),
    ...(options.logDir === undefined ? [] : ['--log-dir', options.logDir]),
  ];
  const timeoutMs = (options.waitTimeout ?? DEFAULT_WAIT_TIMEOUT_S) * 1000;
  const deadline = Date.now() + timeoutMs;

  // The session's own output, before its log starts and a crash's: a file, never a pipe, which
  // would fill (and hold the session) once this process stopped reading it.
  const output = openOutput();
  note(`starting a session: ${options.services.join(', ')}`);
  const child = fork(cli, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? stackEnvironment(),
    // Not this process's flags, a test runner's loaders among them. The cap a session starts
    // itself over with otherwise: a forked one can't, its channel wouldn't survive it.
    execArgv: ['--max-semi-space-size=2'],
    stdio: ['ignore', output.fd, output.fd, 'ipc'],
  });
  fs.closeSync(output.fd);
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exit = { code, signal };
      resolve();
    });
  });
  const gone = () => exit !== null;
  const describeExit = () => {
    const e = exit as { code: number | null; signal: NodeJS.Signals | null } | null;
    return e?.signal ? `was killed by ${e.signal}` : `exited with code ${String(e?.code)}`;
  };

  const started = await Promise.race<StackMessage | 'exited' | 'timeout'>([
    new Promise((resolve) => child.once('message', (m) => resolve(m as StackMessage))),
    exited.then(() => 'exited' as const),
    sleep(timeoutMs).then(() => 'timeout' as const),
  ]);
  if (started === 'exited') {
    const tail = output.tail();
    output.remove();
    throw new Error(`devtooie ${describeExit()} before the session was up${tail ? `:\n${tail}` : ''}`); // oxfmt-ignore
  }
  if (started === 'timeout') {
    await stopChild(child, exited, gone);
    const tail = output.tail();
    output.remove();
    throw new Error(`devtooie: the session didn't come up within ${String(timeoutMs / 1000)}s${tail ? `:\n${tail}` : ''}`); // oxfmt-ignore
  }

  const control = createControlClient<P>(started.port);
  const stop = async () => {
    if (gone()) {
      return;
    }
    // Kept running until the session has exited, which `startStack` stopped holding it for.
    child.ref();
    child.channel?.ref();
    // A session that exits before it acks has quit all the same.
    await control.command.quit();
    await stopChild(child, exited, gone);
  };
  const fail = async (error: string): Promise<never> => {
    const tail = output.tail();
    output.remove();
    // The failure that matters is the one being thrown; a failed quit is only reported beside it.
    await stop().catch((quitError: unknown) => console.error(quitError));
    throw new Error(`devtooie: ${error} (log: ${started.logFile})${tail && gone() ? `:\n${tail}` : ''}`); // oxfmt-ignore
  };
  note(`session up (pid ${String(started.pid)}, control port ${String(started.port)})`);

  const wanted = started.services as P[];
  const verdict = await waitUntilHealthy(control, wanted, {
    deadline,
    exited,
    timeoutMs,
    logFile: started.logFile,
  });
  if (verdict !== undefined) {
    return fail(gone() ? `the session ${describeExit()} while starting` : verdict);
  }
  // Up: the session's output is in its log from here on.
  output.remove();

  const status = await control.query.status();
  if (!status?.config) {
    return fail(`the session on port ${String(started.port)} did not report its config`);
  }
  const services = (status.config as { services?: Record<string, ServiceOrigin> }).services ?? {};
  const origins: Partial<Record<P, string>> = {};
  for (const [name, service] of Object.entries(services)) {
    const origin =
      service.publicOrigin ??
      (service.port === undefined ? undefined : `http://localhost:${String(service.port)}`);
    if (origin !== undefined) {
      origins[name as P] = origin;
    }
  }
  // From here the session needn't keep this process running: it ends when this process does.
  child.unref();
  child.channel?.unref();
  return {
    session: 'started',
    pid: started.pid,
    port: started.port,
    mode: status.mode,
    logFile: status.logFile,
    services: wanted,
    origins,
    rootDomain: status.devReverseProxy?.rootDomain ?? null,
    control,
    stop,
  };
}

/**
 * Follows the session's `/events` until the infra and every one of `wanted` is ready. Returns why
 * it gave up — a service stopped, the session gone or silent, the deadline — or `undefined` once
 * all of it is ready.
 */
async function waitUntilHealthy<P extends string>(
  control: ControlClient<P>,
  wanted: P[],
  opts: { deadline: number; exited: Promise<void>; timeoutMs: number; logFile: string },
): Promise<string | undefined> {
  note(`waiting for ${wanted.join(', ')} to be healthy`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, opts.deadline - Date.now()));
  void opts.exited.then(() => controller.abort());
  const services: Partial<Record<string, SessionServiceStatus>> = {};
  const ready: Partial<Record<string, boolean>> = {};
  const infra: Record<string, InfraStatus> = {};
  let attached = false;
  let pending: string[] = [...wanted];
  // Set while everything is ready, to when it has been so for long enough.
  let settled: ReturnType<typeof setTimeout> | undefined;
  let healthy = false;
  try {
    for await (const event of control.events({ signal: controller.signal })) {
      if (!apply(event, { services, ready, infra })) {
        continue;
      }
      attached ||= event.type !== 'snapshot' || event.services !== null;
      if (!attached) {
        continue;
      }
      const stopped = wanted.filter((name) => services[name] === 'stopped');
      if (stopped.length > 0) {
        return `${stopped.join(', ')} stopped while starting; see ${opts.logFile}`;
      }
      pending = [
        ...Object.entries(infra)
          .filter(([, state]) => state !== 'running')
          .map(([name]) => `infra service ${name}`),
        ...wanted.filter((name) => ready[name] !== true),
      ];
      if (pending.length > 0) {
        clearTimeout(settled);
        settled = undefined;
      } else {
        settled ??= setTimeout(() => {
          healthy = true;
          controller.abort();
        }, SETTLE_MS);
      }
    }
  } catch (error) {
    return `lost the session's events: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearTimeout(timer);
    clearTimeout(settled);
    controller.abort();
  }
  if (healthy) {
    note('everything is healthy');
    return undefined;
  }
  return Date.now() >= opts.deadline
    ? `not healthy after ${String(Math.round(opts.timeoutMs / 1000))}s: ${pending.join(', ')}`
    : 'the session ended its events while starting';
}

/** Folds an `/events` line into the state it tracks; false for one that changes nothing (a heartbeat). */
function apply(
  event: SessionEvent,
  state: {
    services: Partial<Record<string, SessionServiceStatus>>;
    ready: Partial<Record<string, boolean>>;
    infra: Record<string, InfraStatus>;
  },
): boolean {
  switch (event.type) {
    case 'snapshot':
      Object.assign(state.services, event.services ?? {});
      Object.assign(state.ready, event.ready ?? {});
      Object.assign(state.infra, event.infra ?? {});
      return true;
    case 'service':
      state.services[event.service] = event.status;
      state.ready[event.service] = event.ready;
      return true;
    case 'infra':
      state.infra[event.service] = event.status;
      return true;
    case 'session':
    case 'heartbeat':
      return false;
  }
}

/** Waits for a child the quit already reached to exit; SIGTERM, then SIGKILL, if it doesn't. */
async function stopChild(child: ChildProcess, exited: Promise<void>, gone: () => boolean) {
  for (const signal of [null, 'SIGTERM', 'SIGKILL'] as const) {
    if (gone()) {
      return;
    }
    if (signal) {
      child.kill(signal);
    }
    await Promise.race([exited, sleep(STOP_GRACE_MS)]);
  }
  if (!gone()) {
    throw new Error(`the devtooie session (pid ${String(child.pid)}) did not exit`);
  }
}

/** A file for the session's own output, unlinked once it isn't needed. */
function openOutput(): { fd: number; tail: () => string; remove: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-stack-'));
  const file = path.join(dir, 'output');
  const fd = fs.openSync(file, 'w');
  return {
    fd,
    tail: () => {
      try {
        return fs
          .readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .slice(-OUTPUT_TAIL_LINES)
          .join('\n');
      } catch {
        return '';
      }
    },
    // The session keeps writing to it: unlinked, it is gone from the disk once the session is.
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** The fields of a resolved service an origin is made of. */
interface ServiceOrigin {
  publicOrigin?: string | null;
  port?: number;
}

/** Variables a package manager sets for the scripts it runs, and for the binaries it shims. */
const PACKAGE_MANAGER_VARS = ['INIT_CWD', 'NODE', 'NODE_PATH', 'PNPM_SCRIPT_SRC_DIR'];

/** Variables Vitest sets in its process when `VITEST` is set: its own, and Vite's env. */
const VITEST_VARS = ['NODE_ENV', 'MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL', 'TEST'];

/** Variables Jest sets in its process when `JEST_WORKER_ID` is set. */
const JEST_VARS = ['NODE_ENV', 'JEST_WORKER_ID'];

/**
 * `env` without what a package manager script and a test runner add to it, which would otherwise
 * reach every service of a session started from a test: `npm_*`, `INIT_CWD`, `NODE`, `NODE_PATH`
 * and `PNPM_SCRIPT_SRC_DIR`; under Vitest, `VITEST*`, `NODE_ENV`, `MODE`, `DEV`, `PROD`, `SSR`,
 * `BASE_URL` and `TEST`; under Jest, `JEST_WORKER_ID` and `NODE_ENV`. What an outer devtooie
 * added, the session drops itself.
 */
export function stackEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const drop = new Set(PACKAGE_MANAGER_VARS);
  if (env.VITEST !== undefined) {
    VITEST_VARS.forEach((key) => drop.add(key));
  }
  if (env.JEST_WORKER_ID !== undefined) {
    JEST_VARS.forEach((key) => drop.add(key));
  }
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !drop.has(key) &&
        !key.startsWith('npm_') &&
        !(env.VITEST !== undefined && key.startsWith('VITEST')),
    ),
  );
}
