import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ControlClient } from './control-client.js';
import type { ServiceName } from './register.js';

// `startStack()`: `devtooie --headless --detach --wait` as a function, for a test suite's setup.
// It runs the CLI rather than devtooie in-process, so the config loads in a process of its own and
// the caller's module state and environment are left alone.

export interface StartStackOptions<P extends string = ServiceName> {
  /** The services to bring up, as `-s` names them. Their runtime deps and the mode's infra come too. */
  services: P[];
  /** The mode, as `--mode` takes it. Unset, the CLI resolves it as it does from a shell. */
  mode?: string;
  /** Where the workspace is found from, as the CLI finds it from its working directory. Default `process.cwd()`. */
  cwd?: string;
  /** How long to wait for everything to be healthy, in seconds, as `--wait-timeout` takes it. Default 300. */
  waitTimeout?: number;
  /** A session's log directory, as `--log-dir` takes it. */
  logDir?: string;
  /**
   * The environment the session starts with. Default: this process's, without what a package
   * manager script and a test runner add to it (see {@link stackEnvironment}). Given, it is used
   * as it is.
   */
  env?: NodeJS.ProcessEnv;
}

export interface Stack<P extends string = ServiceName> {
  /** `started`: this call started the session. `reused`: one of the mode was already running. */
  session: 'started' | 'reused';
  /** The session's pid. */
  pid: number;
  /** The session's control-API port. */
  port: number;
  mode: string;
  /** The session's logfile. */
  logFile: string | null;
  /**
   * The services this call started: for a session it started, all of them; for a reused one, the
   * ones it lacked, or had stopped. `stop()` leaves those of a reused session running.
   */
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
  /** Quits the session if this call started it; does nothing for a reused one. */
  stop(): Promise<void>;
}

/** What `--detach` prints on stdout. */
interface DetachLine {
  ok: boolean;
  session?: 'started' | 'reused';
  pid?: number;
  port?: number;
  mode?: string;
  logFile?: string | null;
  services?: string[];
  error?: string;
}

/** How much of the CLI's stderr an error quotes when it printed no answer. */
const STDERR_TAIL = 4096;

/**
 * Brings up a detached, headless session with `services` and waits until every one of them, and
 * the mode's infra, is healthy — reusing a running session of the mode and starting into it what
 * it lacks. Throws devtooie's error, with the log's path, after quitting a session it started.
 */
export async function startStack<P extends string = ServiceName>(
  options: StartStackOptions<P>,
): Promise<Stack<P>> {
  const { createControlClient } = await import('./control-client.js');
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const args = [
    cli,
    ...(options.mode === undefined ? [] : ['--mode', options.mode]),
    '--headless',
    ...options.services.flatMap((name) => ['-s', name]),
    '--detach',
    '--wait',
    ...(options.waitTimeout === undefined ? [] : ['--wait-timeout', String(options.waitTimeout)]),
    ...(options.logDir === undefined ? [] : ['--log-dir', options.logDir]),
  ];
  const { line, code, stderr } = await runCli(args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? stackEnvironment(),
  });

  if (!line) {
    throw new Error(`devtooie exited with code ${String(code)} and no answer${stderr ? `:\n${stderr}` : ''}`); // prettier-ignore
  }
  const port = line.port ?? 0;
  const control = createControlClient<P>(port);
  const started = line.session === 'started';
  const stop = async () => {
    // Port 0: the session never came up, and the CLI saw it gone.
    if (!started || port === 0 || !isAlive(line.pid)) {
      return;
    }
    // A session that exits before it acks has quit all the same.
    if (!(await control.command.quit()) && isAlive(line.pid)) {
      throw new Error(`the devtooie session on port ${String(port)} did not quit`);
    }
  };
  const fail = async (error: string): Promise<never> => {
    // The failure that matters is the one being thrown; a failed quit is only reported beside it.
    await stop().catch((quitError: unknown) => console.error(quitError));
    throw new Error(`devtooie: ${error}${line.logFile ? ` (log: ${line.logFile})` : ''}`);
  };
  if (!line.ok) {
    return fail(line.error ?? 'the session did not come up');
  }

  const status = await control.query.status();
  if (!status?.config) {
    return fail(`the session on port ${String(port)} did not report its config`);
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
  return {
    session: started ? 'started' : 'reused',
    pid: status.pid,
    port,
    mode: status.mode,
    logFile: status.logFile,
    services: (line.services ?? []) as P[],
    origins,
    rootDomain: status.devReverseProxy?.rootDomain ?? null,
    control,
    stop,
  };
}

/** The fields of a resolved service an origin is made of. */
interface ServiceOrigin {
  publicOrigin?: string | null;
  port?: number;
}

/**
 * Runs the CLI to its exit: its progress goes on to this process's stderr, its answer is the last
 * line of its stdout.
 */
function runCli(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ line: DetachLine | null; code: number | null; stderr: string }> {
  const child = spawn(process.execPath, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    process.stderr.write(chunk);
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      const last = stdout.trim().split('\n').at(-1) ?? '';
      let line: DetachLine | null = null;
      try {
        line = JSON.parse(last) as DetachLine;
      } catch {
        // No answer: the error is on stderr.
      }
      resolve({ line, code, stderr: stderr.trim() });
    });
  });
}

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
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
