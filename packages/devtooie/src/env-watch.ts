import fs from 'node:fs';

export interface WatchTarget {
  /** Directory to watch (non-recursive). */
  dir: string;
  /** Basenames within `dir` whose create/change/remove should fire `onChange`. */
  filenames: string[];
  /** Fired (debounced) when any watched file in `dir` changes. */
  onChange: () => void;
}

/** Reports a watcher that had to be abandoned, so the session can say so instead of dying. */
export type WatchErrorHandler = (dir: string, error: Error) => void;

/**
 * Watches a set of directories for changes to specific `.env` filenames and fires each
 * target's `onChange` (debounced) when one of its files is created, edited, or removed.
 * Watching directories — rather than the files themselves — means files that don't exist
 * yet are still picked up when they appear. Best-effort: a directory that can't be watched
 * (e.g. it doesn't exist) is skipped silently. Returns a disposer that stops every watcher.
 *
 * "Best-effort" has to cover failures that arrive *after* a successful `fs.watch()` call, not just
 * the synchronous throw. The OS can fail a watcher later — most commonly `EMFILE` on macOS, where
 * the FSEvents budget is machine-wide, so an unrelated project's watch-heavy dev stack can knock
 * this one over. An `FSWatcher` with no `error` listener makes that an unhandled `'error'` event,
 * which takes the whole devtooie process down and every package with it. Losing `.env`
 * live-reload for one directory is a much better outcome than losing the session.
 */
export function watchEnvFiles(opts: {
  targets: WatchTarget[];
  debounceMs?: number;
  onError?: WatchErrorHandler;
}): () => void {
  const debounceMs = opts.debounceMs ?? 250;
  const watchers: fs.FSWatcher[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];

  for (const target of opts.targets) {
    const names = new Set(target.filenames);
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const watcher = fs.watch(target.dir, { persistent: false }, (_event, filename) => {
        // `filename` can be null on some platforms; without it we can't tell which file
        // changed, so we don't fire (avoids restarting on unrelated activity in the dir).
        if (!filename || !names.has(filename.toString())) {
          return;
        }
        if (timer) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => {
          timer = null;
          target.onChange();
        }, debounceMs);
        timers.push(timer);
      });
      // Without this listener an async failure is an unhandled 'error' event, which is fatal to
      // the process. Drop just this watcher and keep the session running.
      watcher.on('error', (error: Error) => {
        try {
          watcher.close();
        } catch {
          /* already closed */
        }
        opts.onError?.(target.dir, error);
      });
      watchers.push(watcher);
    } catch {
      // best-effort: unwatchable directory (missing, permissions) is skipped.
    }
  }

  return () => {
    for (const w of watchers) {
      w.close();
    }
    for (const t of timers) {
      clearTimeout(t);
    }
  };
}
