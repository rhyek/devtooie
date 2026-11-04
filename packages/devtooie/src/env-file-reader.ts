import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';

/** What reading one `.env` file came to. */
export type EnvFileRead =
  | { kind: 'text'; text: string }
  /** No such file, or a path through something that isn't a directory. */
  | { kind: 'missing' }
  /** Any other failure, by its error code: the file is there but couldn't be read. */
  | { kind: 'error'; code: string };

/**
 * Reads its argv's files in order, one JSON line each on fd 1, after a line naming the file it
 * is about to read. Written with `writeSync`: on macOS a write to a pipe is otherwise
 * asynchronous, and a read that doesn't return would keep its "reading" line from ever leaving.
 */
const READER_SCRIPT = `
const fs = require('node:fs');
const say = (line) => fs.writeSync(1, JSON.stringify(line) + '\\n');
for (const file of process.argv.slice(1)) {
  say({ reading: file });
  try {
    say({ file, text: fs.readFileSync(file, 'utf8') });
  } catch (error) {
    say(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? { file, missing: true } : { file, error: String(error.code) });
  }
}
`;

/** Readers still running, killed as the process exits: see {@link readEnvFiles}. */
const live = new Set<ChildProcess>();
let exitHookInstalled = false;

function killLiveReaders(): void {
  for (const child of live) {
    child.kill('SIGKILL');
  }
  live.clear();
}

/** A read of some `.env` files under way: see {@link readEnvFiles}. */
export interface EnvFilesReading {
  /** Each file's result, settling once every file has been read or the read was cancelled. */
  done: Promise<Map<string, EnvFileRead>>;
  /** Stops the read: `done` settles with whatever was read so far. */
  cancel(): void;
}

/**
 * Reads `files`, in order, in a child process, calling `onReading` with each one as its read
 * begins.
 *
 * A read can block for as long as something else decides: macOS holds a read of a File Provider
 * folder (Dropbox, iCloud) until the user answers its prompt to allow access, which can be hours.
 * Read on the event loop's thread, it stops the process answering anything, signals included.
 * Read on libuv's thread pool, it lets the process run, but not end: a process exits only once
 * every thread of the pool is done, so it couldn't stop until the read returned. A child process
 * blocked on a read is killed like any other, so this process stays free to go on and to stop. A
 * reader still running as this process exits is killed with it.
 *
 * Should the child fail to start, or stop before reading every file, the files it didn't get to
 * are read here instead, asynchronously.
 */
export function readEnvFiles(
  files: string[],
  onReading: (file: string) => void = () => {},
): EnvFilesReading {
  const results = new Map<string, EnvFileRead>();
  if (files.length === 0) {
    return { done: Promise.resolve(results), cancel: () => {} };
  }
  // The reader runs no preload of the user's: a `NODE_OPTIONS` `--import` would only slow it.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, ['-e', READER_SCRIPT, ...files], {
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  live.add(child);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', killLiveReaders);
  }
  let cancelled = false;

  let pending = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = JSON.parse(pending.slice(0, newline)) as
        | { reading: string }
        | { file: string; text?: string; missing?: true; error?: string };
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
      if ('reading' in line) {
        onReading(line.reading);
      } else if (line.text !== undefined) {
        results.set(line.file, { kind: 'text', text: line.text });
      } else if (line.missing) {
        results.set(line.file, { kind: 'missing' });
      } else {
        results.set(line.file, { kind: 'error', code: line.error ?? 'UNKNOWN' });
      }
    }
  });

  const done = new Promise<Map<string, EnvFileRead>>((resolve) => {
    let settled = false;
    const settle = async () => {
      if (settled) {
        return;
      }
      settled = true;
      live.delete(child);
      if (!cancelled) {
        for (const file of files.filter((f) => !results.has(f))) {
          onReading(file);
          results.set(file, await readInProcess(file));
        }
      }
      resolve(results);
    };
    child.on('error', () => void settle());
    // 'close', not 'exit': the last lines may still be in the pipe when the process exits.
    child.on('close', () => void settle());
  });

  return {
    done,
    cancel: () => {
      cancelled = true;
      child.kill('SIGKILL');
    },
  };
}

async function readInProcess(file: string): Promise<EnvFileRead> {
  try {
    return { kind: 'text', text: await fs.promises.readFile(file, 'utf8') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'error', code };
  }
}
