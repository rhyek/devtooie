import fs from 'node:fs';
import path from 'node:path';

// Where a workspace's devtooie state and session logs live, and which logfile is the current
// one. Kept free of the config and of anything that spawns, so `devtooie logs` loads only this.

/** devtooie's per-workspace state directory, `node_modules/.devtooie/` (created if needed). */
export function getStateDir(): string {
  const dir = path.join(process.cwd(), 'node_modules', '.devtooie');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Default directory for timestamped session logs: `node_modules/.devtooie/logs/`. */
export function getLogDir(): string {
  return path.join(getStateDir(), 'logs');
}

/**
 * A fresh, timestamped log file path (`<timestamp>.log`) inside `dir` (created
 * if needed). Each run — and each in-session rotation — gets a unique name so
 * previous sessions' logs are never overwritten. Pass `dir` to choose the location
 * (e.g. the `--log-dir` override, or the current logfile's dir when rotating);
 * defaults to `getLogDir()`.
 */
export function getDefaultLogFile(dir: string = getLogDir()): string {
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${Date.now()}.log`);
}

/**
 * How a logfile path is shown to the user: relative to devtooie's working directory
 * (falling back to the path itself when it *is* the cwd). Shared by the footer and the
 * exit line so a session reports one and the same string throughout.
 */
export function displayLogFile(file: string): string {
  return path.relative(process.cwd(), file) || file;
}

/**
 * The most recently modified `*.log` file in `dir` (absolute path), or null when `dir` is
 * missing or holds no logfiles. Used by `devtooie logs` to locate the current session's log
 * when a live instance can't be queried for it.
 */
export function pickNewestLog(dir: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith('.log')) {
      continue;
    }
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile() && (!newest || st.mtimeMs > newest.mtimeMs)) {
        newest = { path: full, mtimeMs: st.mtimeMs };
      }
    } catch {
      /* raced away between readdir and stat — skip */
    }
  }
  return newest?.path ?? null;
}

/**
 * Picks the logfile `devtooie logs` should show, in order of precedence:
 *
 * 1. the running instance's current (rotation-aware) logfile, when it can be queried;
 * 2. the logfile recorded in `running.json` (`recordedLogFile`), when it still exists — more
 *    precise than scanning the dir, since a stray `devtooie exec` log could be newer;
 * 3. the newest `*.log` in `fallbackDir`.
 *
 * Returns null when none yields one. Purely read-only — it never touches the running session.
 */
export async function resolveLogFile(opts: {
  /** Asks the live instance for its current logfile; resolves null if there's no live answer. */
  liveLogFile: () => Promise<string | null>;
  /** The logfile recorded in `running.json`, used when there's no live answer and it still exists. */
  recordedLogFile?: string | null;
  /** Directory searched for the newest `*.log` as a last resort. */
  fallbackDir: string;
  /** Injectable for tests; defaults to {@link pickNewestLog}. */
  newestLog?: (dir: string) => string | null;
  /** Injectable for tests; defaults to `fs.existsSync`. */
  exists?: (file: string) => boolean;
}): Promise<string | null> {
  const live = await opts.liveLogFile();
  if (live) {
    return live;
  }
  const exists = opts.exists ?? fs.existsSync;
  if (opts.recordedLogFile && exists(opts.recordedLogFile)) {
    return opts.recordedLogFile;
  }
  return (opts.newestLog ?? pickNewestLog)(opts.fallbackDir);
}
