import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { watchEnvFiles } from './env-watch.js';

let dir: string;
let dispose: (() => void) | undefined;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeout = 2000, step = 20): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) {
      return;
    }
    await new Promise((r) => setTimeout(r, step));
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-envwatch-'));
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('watchEnvFiles', () => {
  test('fires (debounced) when a watched file is created or changed', async () => {
    let calls = 0;
    dispose = watchEnvFiles({
      targets: [{ dir, filenames: ['.env.local'], onChange: () => calls++ }],
      debounceMs: 40,
    });

    fs.writeFileSync(path.join(dir, '.env.local'), 'A=1\n');
    await waitFor(() => calls >= 1);
    expect(calls).toBe(1);

    // Two quick writes collapse into a single debounced call.
    fs.writeFileSync(path.join(dir, '.env.local'), 'A=2\n');
    fs.writeFileSync(path.join(dir, '.env.local'), 'A=3\n');
    await waitFor(() => calls >= 2);
    expect(calls).toBe(2);
  });

  test('ignores changes to files not in the watch list', async () => {
    let calls = 0;
    dispose = watchEnvFiles({
      targets: [{ dir, filenames: ['.env.local'], onChange: () => calls++ }],
      debounceMs: 40,
    });

    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x\n');
    await wait(150);
    expect(calls).toBe(0);
  });

  test('stops firing after dispose', async () => {
    let calls = 0;
    const stop = watchEnvFiles({
      targets: [{ dir, filenames: ['.env.local'], onChange: () => calls++ }],
      debounceMs: 40,
    });
    stop();

    fs.writeFileSync(path.join(dir, '.env.local'), 'A=1\n');
    await wait(150);
    expect(calls).toBe(0);
  });

  describe('an event that leaves the content as it was', () => {
    // A sync client such as Dropbox rewrites its own extended attributes on a file a second or
    // more after each sync, and FSEvents reports that as a change to the file; the debounce can't
    // absorb it. Only a change to what the file reads as should restart anything.
    let file: string;
    let counter: { calls: number };
    beforeEach(async () => {
      file = path.join(dir, '.env.local');
      fs.writeFileSync(file, 'A=1\n');
      counter = { calls: 0 };
      dispose = watchEnvFiles({
        targets: [{ dir, filenames: ['.env.local'], onChange: () => counter.calls++ }],
        debounceMs: 40,
      });
      // Let the watch go live, and FSEvents' report of the write above pass.
      await wait(200);
      counter.calls = 0;
    });

    test('does not fire when only the modification time changes', async () => {
      const later = new Date(Date.now() + 10_000);
      fs.utimesSync(file, later, later);
      await wait(200);
      expect(counter.calls).toBe(0);

      fs.appendFileSync(file, 'B=2\n');
      await waitFor(() => counter.calls >= 1);
      expect(counter.calls).toBe(1);
    });

    test.skipIf(process.platform !== 'darwin')(
      'does not fire when only an extended attribute is written',
      async () => {
        execFileSync('xattr', ['-w', 'com.example.devtooie-spec', '1', file]);
        await wait(200);
        expect(counter.calls).toBe(0);
      },
    );
  });

  test('does not throw when a target directory does not exist', () => {
    expect(() => {
      dispose = watchEnvFiles({
        targets: [{ dir: path.join(dir, 'missing'), filenames: ['.env'], onChange: () => {} }],
        debounceMs: 40,
      });
    }).not.toThrow();
  });

  test('reports a watcher that fails after creation instead of crashing the process', () => {
    // The OS can fail a watcher asynchronously, long after `fs.watch()` returned — EMFILE on
    // macOS being the common one, since the FSEvents budget is machine-wide and an unrelated
    // watch-heavy dev stack can exhaust it. An FSWatcher with no 'error' listener turns that into
    // an unhandled 'error' event, which kills the whole devtooie process and every package with
    // it. Stand in a fake watcher so the failure is deterministic.
    const fake = new EventEmitter() as EventEmitter & { close: () => void };
    let closed = false;
    fake.close = () => {
      closed = true;
    };
    const spy = vi.spyOn(fs, 'watch').mockReturnValue(fake as unknown as fs.FSWatcher);

    const errors: { dir: string; message: string }[] = [];
    try {
      dispose = watchEnvFiles({
        targets: [{ dir, filenames: ['.env'], onChange: () => {} }],
        onError: (d, e) => errors.push({ dir: d, message: e.message }),
      });
      // Would throw "Unhandled 'error' event" with no listener attached.
      expect(() =>
        fake.emit('error', new Error('EMFILE: too many open files, watch')),
      ).not.toThrow();
    } finally {
      spy.mockRestore();
    }

    expect(errors).toEqual([{ dir, message: 'EMFILE: too many open files, watch' }]);
    expect(closed).toBe(true);
  });

  describe('a watched file that is a symlink', () => {
    // Writing through a link changes only the file it points to, so the link's own directory sees
    // no event. Personal env files kept in a synced folder and linked into the repo hit exactly
    // this: `.env.local -> .local/env/.env.local`, with `.local` itself a link to that folder.
    let ws: string;
    beforeEach(() => {
      ws = path.join(dir, 'ws');
      fs.mkdirSync(ws);
    });

    // A newly opened watch takes a moment to go live, and FSEvents reports writes made just before
    // it started (each case's setup) shortly after it does. Let both pass before counting.
    const settle = () => wait(200);
    async function watchWs(filenames = ['.env.local']): Promise<{ calls: number }> {
      const counter = { calls: 0 };
      dispose = watchEnvFiles({
        targets: [{ dir: ws, filenames, onChange: () => counter.calls++ }],
        debounceMs: 40,
      });
      await settle();
      counter.calls = 0;
      return counter;
    }

    test('fires when the file it points to is edited through the link', async () => {
      fs.mkdirSync(path.join(dir, 'real'));
      fs.writeFileSync(path.join(dir, 'real', '.env.local'), 'A=1\n');
      fs.symlinkSync('../real/.env.local', path.join(ws, '.env.local'));
      const counter = await watchWs();

      fs.appendFileSync(path.join(ws, '.env.local'), 'B=2\n');
      await waitFor(() => counter.calls >= 1);
      expect(counter.calls).toBe(1);
    });

    test('fires for a link reached through a symlinked directory', async () => {
      fs.mkdirSync(path.join(dir, 'synced', 'env'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'synced', 'env', '.env.local'), 'A=1\n');
      fs.symlinkSync('../synced', path.join(ws, '.local'));
      fs.symlinkSync('.local/env/.env.local', path.join(ws, '.env.local'));
      const counter = await watchWs();

      fs.appendFileSync(path.join(ws, '.env.local'), 'B=2\n');
      await waitFor(() => counter.calls >= 1);
      expect(counter.calls).toBe(1);
    });

    test('ignores files in the linked directory that no watched name points to', async () => {
      fs.mkdirSync(path.join(dir, 'real'));
      fs.writeFileSync(path.join(dir, 'real', '.env.local'), 'A=1\n');
      fs.symlinkSync('../real/.env.local', path.join(ws, '.env.local'));
      const counter = await watchWs(['.env.local', '.env']);

      // `.env` is a watched name, but the one in `ws` doesn't exist: nothing points at this file.
      fs.writeFileSync(path.join(dir, 'real', '.env'), 'X=1\n');
      await wait(150);
      expect(counter.calls).toBe(0);
    });

    test('follows the link when it is repointed', async () => {
      fs.mkdirSync(path.join(dir, 'old'));
      fs.mkdirSync(path.join(dir, 'new'));
      fs.writeFileSync(path.join(dir, 'old', '.env.local'), 'A=1\n');
      fs.writeFileSync(path.join(dir, 'new', '.env.local'), 'A=2\n');
      const link = path.join(ws, '.env.local');
      fs.symlinkSync('../old/.env.local', link);
      const counter = await watchWs();

      // Repointing the link changes what the file reads as, so it fires on its own.
      fs.unlinkSync(link);
      fs.symlinkSync('../new/.env.local', link);
      await waitFor(() => counter.calls >= 1);
      expect(counter.calls).toBe(1);
      await settle();
      counter.calls = 0;

      fs.appendFileSync(path.join(dir, 'new', '.env.local'), 'B=2\n');
      await waitFor(() => counter.calls >= 1);
      expect(counter.calls).toBe(1);

      fs.appendFileSync(path.join(dir, 'old', '.env.local'), 'B=2\n');
      await wait(150);
      expect(counter.calls).toBe(1);
    });
  });
});
