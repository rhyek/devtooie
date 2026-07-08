import fs from 'node:fs';

export interface WatchTarget {
  /** Directory to watch (non-recursive). */
  dir: string;
  /** Basenames within `dir` whose create/change/remove should fire `onChange`. */
  filenames: string[];
  /** Fired (debounced) when any watched file in `dir` changes. */
  onChange: () => void;
}

/**
 * Watches a set of directories for changes to specific `.env` filenames and fires each
 * target's `onChange` (debounced) when one of its files is created, edited, or removed.
 * Watching directories — rather than the files themselves — means files that don't exist
 * yet are still picked up when they appear. Best-effort: a directory that can't be watched
 * (e.g. it doesn't exist) is skipped silently. Returns a disposer that stops every watcher.
 */
export function watchEnvFiles(opts: { targets: WatchTarget[]; debounceMs?: number }): () => void {
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
        if (!filename || !names.has(filename.toString())) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          target.onChange();
        }, debounceMs);
        timers.push(timer);
      });
      watchers.push(watcher);
    } catch {
      // best-effort: unwatchable directory (missing, permissions) is skipped.
    }
  }

  return () => {
    for (const w of watchers) w.close();
    for (const t of timers) clearTimeout(t);
  };
}
