import { execa } from 'execa';

export interface ExecOptions {
  cwd: string;
  /** The child's whole environment — nothing is inherited implicitly. */
  env: Record<string, string>;
  /** Called with each complete output line as it arrives (`isError` for stderr). */
  onLine?: (line: string, isError: boolean) => void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs a command to completion with its output captured. Injected, so specs need no Docker. */
export type Exec = (command: string, args: string[], opts: ExecOptions) => Promise<ExecResult>;

/** Runs a command with the terminal handed over to it; resolves with its exit code. */
export type SpawnInherit = (
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
) => Promise<number>;

/** The exit code a shell reports for a command it couldn't find. */
const SPAWN_FAILED = 127;

/** Why a command never ran, from execa's result for a child that failed to spawn. */
function spawnFailure(command: string, result: { shortMessage?: string }): string {
  return result.shortMessage ?? `could not run ${command}`;
}

/** Feeds `onLine` complete lines from a stream of chunks; returns the flush for a trailing one. */
function lineSplitter(onLine: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        onLine(buf.slice(0, nl).replace(/\r$/, ''));
        buf = buf.slice(nl + 1);
      }
    },
    flush() {
      if (buf.length > 0) {
        onLine(buf.replace(/\r$/, ''));
        buf = '';
      }
    },
  };
}

/**
 * Runs a command with stdin closed and both output streams captured, handing each line to
 * `onLine` as it arrives. **Never rejects**: a non-zero exit is a result, and a command that
 * can't be spawned at all comes back as exit 127 with the reason in `stderr` — callers decide
 * what a failure means.
 */
export const execLines: Exec = async (command, args, { cwd, env, onLine }) => {
  const child = execa(command, args, {
    cwd,
    env,
    extendEnv: false,
    reject: false,
    stdin: 'ignore',
    stripFinalNewline: false,
  });
  const out = lineSplitter((line) => onLine?.(line, false));
  const err = lineSplitter((line) => onLine?.(line, true));
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk.toString('utf8')));
  const result = await child;
  out.flush();
  err.flush();
  if (result.exitCode === undefined && !result.signal) {
    return { exitCode: SPAWN_FAILED, stdout: '', stderr: spawnFailure(command, result) };
  }
  return {
    // Killed by a signal: no exit code, and not a success.
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

/**
 * Runs a command with stdin, stdout and stderr inherited — the terminal is the command's, so a
 * TTY stays a TTY — and resolves with its exit code.
 *
 * While it runs, devtooie doesn't exit on SIGINT: the terminal delivers Ctrl+C to the whole
 * foreground group, so the command gets it too and decides what it means (`logs -f` stops,
 * an attached `up` shuts its containers down first). SIGTERM is forwarded.
 */
export const spawnInherit: SpawnInherit = async (command, args, { cwd, env }) => {
  const child = execa(command, args, {
    cwd,
    env,
    extendEnv: false,
    reject: false,
    stdio: 'inherit',
  });
  const ignoreInterrupt = () => {};
  const forwardTerminate = () => child.kill('SIGTERM');
  process.on('SIGINT', ignoreInterrupt);
  process.on('SIGTERM', forwardTerminate);
  try {
    const result = await child;
    if (result.exitCode === undefined && !result.signal) {
      console.error(spawnFailure(command, result));
      return SPAWN_FAILED;
    }
    return result.exitCode ?? 1;
  } finally {
    process.off('SIGINT', ignoreInterrupt);
    process.off('SIGTERM', forwardTerminate);
  }
};
