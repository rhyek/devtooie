import { describe, it, expect } from 'vitest';
import { WATCH_PATHS_ENV, formatWatchPathFlags, usesUnscopedNodeWatch } from './watch-paths.js';

describe('usesUnscopedNodeWatch', () => {
  it('flags a bare node --watch', () => {
    expect(usesUnscopedNodeWatch('node --watch src/index.ts')).toBe(true);
    expect(usesUnscopedNodeWatch('node --watch --enable-source-maps dist/main.js')).toBe(true);
  });

  it('accepts a scoped watcher, whatever the flag order', () => {
    expect(usesUnscopedNodeWatch('node --watch --watch-path=./dist dist/main.js')).toBe(false);
    expect(usesUnscopedNodeWatch('node --watch-path=./dist --watch dist/main.js')).toBe(false);
  });

  it(`accepts a script that splices in $${WATCH_PATHS_ENV}`, () => {
    expect(usesUnscopedNodeWatch(`node --watch $${WATCH_PATHS_ENV} src/index.ts`)).toBe(false);
    expect(usesUnscopedNodeWatch(`node --watch \${${WATCH_PATHS_ENV}} src/index.ts`)).toBe(false);
  });

  it("ignores watchers that are not Node's own", () => {
    // These have their own (sane) watch scoping; the recursive-node_modules behavior is specific
    // to `node --watch`.
    expect(usesUnscopedNodeWatch('tsx watch --clear-screen=false src/main.ts')).toBe(false);
    expect(usesUnscopedNodeWatch('tsc --watch --preserveWatchOutput')).toBe(false);
    expect(usesUnscopedNodeWatch('nodemon --watch src src/index.js')).toBe(false);
    expect(usesUnscopedNodeWatch('vite build --watch')).toBe(false);
  });

  it('finds node --watch after a shell operator', () => {
    expect(usesUnscopedNodeWatch('pnpm build && node --watch dist/main.js')).toBe(true);
  });
});

describe('formatWatchPathFlags', () => {
  it('renders one flag per directory', () => {
    expect(formatWatchPathFlags(['/a/src', '/b/dist'])).toBe(
      '--watch-path=/a/src --watch-path=/b/dist',
    );
  });

  it('is empty when nothing was derived, so splicing it in is a no-op', () => {
    expect(formatWatchPathFlags([])).toBe('');
  });
});
