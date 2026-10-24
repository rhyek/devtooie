import fs from 'node:fs';
import path from 'node:path';

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
 * target's `onChange` (debounced) when one of its files is created, edited, or removed — that is,
 * when what one of them reads as differs from the last time it fired (or from the start).
 * Watching directories — rather than the files themselves — means files that don't exist
 * yet are still picked up when they appear. Best-effort: a directory that can't be watched
 * (e.g. it doesn't exist) is skipped silently. Returns a disposer that stops every watcher.
 *
 * A watched name that is a symlink is also followed to the file it resolves to (through chains
 * and symlinked parent directories), whose directory is watched for that one basename: writing
 * through a link changes only its target, so the link's own directory never hears about it. The
 * resolution is redone whenever the target fires, which is how a link that is created, removed or
 * repointed moves its watch along.
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
  const timers: ReturnType<typeof setTimeout>[] = [];
  let disposed = false;

  // One watcher per real directory, shared by every target with a file there; each event is
  // dispatched by basename to whoever registered it.
  const dirs = new Map<string, { watcher: fs.FSWatcher; handlers: Map<string, Set<() => void>> }>();

  const subscribe = (dir: string, name: string, handler: () => void): (() => void) | null => {
    const key = realpathOrSelf(dir);
    let entry = dirs.get(key);
    if (!entry) {
      const handlers = new Map<string, Set<() => void>>();
      let watcher: fs.FSWatcher;
      try {
        watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
          // `filename` can be null on some platforms; without it we can't tell which file
          // changed, so we don't fire (avoids restarting on unrelated activity in the dir).
          if (!filename) {
            return;
          }
          for (const h of handlers.get(filename.toString()) ?? []) {
            h();
          }
        });
      } catch {
        // best-effort: unwatchable directory (missing, permissions) is skipped.
        return null;
      }
      // Without this listener an async failure is an unhandled 'error' event, which is fatal to
      // the process. Drop just this watcher and keep the session running.
      watcher.on('error', (error: Error) => {
        try {
          watcher.close();
        } catch {
          /* already closed */
        }
        if (dirs.get(key)?.watcher === watcher) {
          dirs.delete(key);
        }
        opts.onError?.(dir, error);
      });
      entry = { watcher, handlers };
      dirs.set(key, entry);
    }
    const { watcher, handlers } = entry;
    let set = handlers.get(name);
    if (!set) {
      set = new Set();
      handlers.set(name, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) {
        handlers.delete(name);
      }
      if (handlers.size === 0 && dirs.get(key)?.watcher === watcher) {
        dirs.delete(key);
        watcher.close();
      }
    };
  };

  for (const target of opts.targets) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Resolved link target → its unsubscribe. Kept across re-resolutions so an unchanged link keeps
    // its watcher: on macOS every new `fs.watch` rebuilds the process's FSEvents stream, and an
    // edit landing mid-rebuild is lost.
    let linkWatches = new Map<string, () => void>();

    const followLinks = () => {
      const realDir = realpathOrSelf(target.dir);
      const next = new Map<string, () => void>();
      for (const name of target.filenames) {
        const real = resolveLink(path.join(target.dir, name));
        // Not a link, or a link back to this same file: the directory watch already covers it.
        if (!real || real === path.join(realDir, name) || next.has(real)) {
          continue;
        }
        const stop =
          linkWatches.get(real) ?? subscribe(path.dirname(real), path.basename(real), fire);
        if (stop) {
          next.set(real, stop);
        }
      }
      for (const [real, stop] of linkWatches) {
        if (!next.has(real)) {
          stop();
        }
      }
      linkWatches = next;
    };

    // What each watched name reads as (through any link), or null when it can't be read. An event
    // that leaves all of them as they were fires nothing: a sync client rewriting its extended
    // attributes, a bare `touch`, or FSEvents reporting writes from just before the watch began.
    const readAll = () => target.filenames.map((name) => readOrNull(path.join(target.dir, name)));
    let seen = readAll();

    const fire = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        if (disposed) {
          return;
        }
        followLinks();
        const now = readAll();
        if (now.every((content, i) => sameContent(content, seen[i]))) {
          return;
        }
        seen = now;
        target.onChange();
      }, debounceMs);
      timers.push(timer);
    };

    for (const name of target.filenames) {
      subscribe(target.dir, name, fire);
    }
    followLinks();
  }

  return () => {
    disposed = true;
    for (const { watcher } of dirs.values()) {
      watcher.close();
    }
    dirs.clear();
    for (const t of timers) {
      clearTimeout(t);
    }
  };
}

function readOrNull(p: string): Buffer | null {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

function sameContent(a: Buffer | null, b: Buffer | null | undefined): boolean {
  return a && b ? a.equals(b) : !a && !b;
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The real path of `p` when `p` is a symlink, else null. A dangling link is null too: there is no
 * file to watch until the link is fixed, and fixing it fires the link's own directory watch.
 */
function resolveLink(p: string): string | null {
  try {
    if (!fs.lstatSync(p).isSymbolicLink()) {
      return null;
    }
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}
