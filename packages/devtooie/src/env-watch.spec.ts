import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  it('fires (debounced) when a watched file is created or changed', async () => {
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

  it('ignores changes to files not in the watch list', async () => {
    let calls = 0;
    dispose = watchEnvFiles({
      targets: [{ dir, filenames: ['.env.local'], onChange: () => calls++ }],
      debounceMs: 40,
    });

    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x\n');
    await wait(150);
    expect(calls).toBe(0);
  });

  it('stops firing after dispose', async () => {
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

  it('does not throw when a target directory does not exist', () => {
    expect(() => {
      dispose = watchEnvFiles({
        targets: [{ dir: path.join(dir, 'missing'), filenames: ['.env'], onChange: () => {} }],
        debounceMs: 40,
      });
    }).not.toThrow();
  });
});
