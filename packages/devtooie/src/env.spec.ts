import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ambientEnv,
  envCandidatePaths,
  envFileNames,
  literalizeForExpansion,
  packageEnvLayer,
  resolveEnv,
  resolveMode,
} from './env.js';
import type { AnyPackageConfig } from './config.js';

let cwd: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-env-'));
  fs.mkdirSync(path.join(cwd, 'packages', 'api'), { recursive: true });
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

function write(rel: string, contents: string): void {
  const p = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
}

/** Sets ambient vars for one assertion and always restores them. */
function withAmbient(vars: Record<string, string>, fn: () => void): void {
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

describe('envFileNames', () => {
  it('is base → local → mode → mode.local, ascending precedence within a scope', () => {
    expect(envFileNames('development')).toEqual([
      '.env',
      '.env.local',
      '.env.development',
      '.env.development.local',
    ]);
  });

  it('substitutes any mode name', () => {
    expect(envFileNames('test')).toEqual(['.env', '.env.local', '.env.test', '.env.test.local']);
    expect(envFileNames('apple')).toEqual(['.env', '.env.local', '.env.apple', '.env.apple.local']);
  });

  it('defaults to the development mode when DEVTOOIE_MODE is unset', () => {
    withAmbient({}, () => {
      delete process.env.DEVTOOIE_MODE;
      expect(envFileNames()).toEqual(envFileNames('development'));
    });
  });
});

describe('resolveMode', () => {
  it('reads --mode, --mode=, and -m', () => {
    expect(resolveMode(['node', 'cli', '--mode', 'test'])).toBe('test');
    expect(resolveMode(['node', 'cli', '--mode=test'])).toBe('test');
    expect(resolveMode(['node', 'cli', '-m', 'test'])).toBe('test');
  });

  it('accepts the flag before or after a subcommand', () => {
    expect(resolveMode(['node', 'cli', '--mode', 'test', 'cmd'])).toBe('test');
    expect(resolveMode(['node', 'cli', 'cmd', '--mode', 'test'])).toBe('test');
  });

  it('stops at the first `--` so the wrapped command keeps its own flags', () => {
    // `--mode watch` here belongs to vitest, not devtooie.
    withAmbient({}, () => {
      delete process.env.DEVTOOIE_MODE;
      expect(resolveMode(['node', 'cli', 'cmd', '--', 'vitest', '--mode', 'watch'])).toBe(
        'development',
      );
      // ...but a mode before the `--` still counts.
      expect(
        resolveMode(['node', 'cli', '--mode', 'test', 'cmd', '--', 'vitest', '--mode', 'watch']),
      ).toBe('test');
    });
  });

  it('falls back to DEVTOOIE_MODE, then development', () => {
    withAmbient({ DEVTOOIE_MODE: 'staging' }, () => {
      expect(resolveMode(['node', 'cli'])).toBe('staging');
    });
    withAmbient({}, () => {
      delete process.env.DEVTOOIE_MODE;
      expect(resolveMode(['node', 'cli'])).toBe('development');
    });
  });

  it('rejects a mode name that is not safe as a filename segment', () => {
    expect(() => resolveMode(['node', 'cli', '--mode', '../../etc'])).toThrow(/path separator/);
    expect(() => resolveMode(['node', 'cli', '--mode', '..'])).toThrow(/mode name/);
    expect(() => resolveMode(['node', 'cli', '--mode', ''])).toThrow(/mode name/);
  });

  it('allows dots inside a mode name', () => {
    expect(resolveMode(['node', 'cli', '--mode', 'e2e.ci'])).toBe('e2e.ci');
  });
});

describe('envCandidatePaths', () => {
  it('lists all workspace-scope files first, then package-scope files (ascending precedence)', () => {
    const paths = envCandidatePaths({
      cwd,
      relativeDir: 'packages/api',
      files: ['.env', '.env.local'],
    });
    expect(paths).toEqual([
      path.join(cwd, '.env'),
      path.join(cwd, '.env.local'),
      path.join(cwd, 'packages/api', '.env'),
      path.join(cwd, 'packages/api', '.env.local'),
    ]);
  });

  it("collapses to a single scope when relativeDir is '.'", () => {
    const paths = envCandidatePaths({ cwd, relativeDir: '.', files: ['.env', '.env.local'] });
    expect(paths).toEqual([path.join(cwd, '.env'), path.join(cwd, '.env.local')]);
  });

  it('produces the full eight-path order for a mode', () => {
    const paths = envCandidatePaths({
      cwd,
      relativeDir: 'packages/api',
      files: envFileNames('test'),
    });
    expect(paths.map((p) => path.relative(cwd, p))).toEqual([
      '.env',
      '.env.local',
      '.env.test',
      '.env.test.local',
      path.join('packages/api', '.env'),
      path.join('packages/api', '.env.local'),
      path.join('packages/api', '.env.test'),
      path.join('packages/api', '.env.test.local'),
    ]);
  });
});

describe('resolveEnv', () => {
  it('loads only files that exist', () => {
    write('.env', 'A=1\n');
    const { env, files } = resolveEnv({ cwd, relativeDir: 'packages/api' });
    expect(env).toEqual({ A: '1' });
    expect(files).toEqual([path.join(cwd, '.env')]);
  });

  it('package scope overrides workspace scope regardless of file rank', () => {
    write('.env.development', 'KEY=root\n');
    write('packages/api/.env', 'KEY=pkg\n');
    const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
    expect(env.KEY).toBe('pkg');
  });

  it('a mode file outranks .env.local within a scope (Vite order)', () => {
    write('.env.local', 'KEY=local\n');
    write('.env.development', 'KEY=mode\n');
    const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
    expect(env.KEY).toBe('mode');
  });

  it('.env.<mode>.local is the highest-ranked file in a scope', () => {
    write('.env', 'KEY=base\n');
    write('.env.local', 'KEY=local\n');
    write('.env.development', 'KEY=mode\n');
    write('.env.development.local', 'KEY=modelocal\n');
    const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
    expect(env.KEY).toBe('modelocal');
  });

  it('package-scope .env.local outranks a workspace-scope mode file (scope beats mode)', () => {
    write('.env.development', 'KEY=wsmode\n');
    write('packages/api/.env.local', 'KEY=pkglocal\n');
    const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
    expect(env.KEY).toBe('pkglocal');
  });

  it('modes are exclusive: another mode does not load .env.development', () => {
    write('.env', 'KEY=base\n');
    write('.env.development', 'KEY=dev\nDEV_ONLY=yes\n');
    write('.env.test', 'KEY=test\n');
    const { env } = resolveEnv({
      cwd,
      relativeDir: 'packages/api',
      files: envFileNames('test'),
    });
    expect(env.KEY).toBe('test');
    expect(env.DEV_ONLY).toBeUndefined();
  });

  it('loads a custom mode', () => {
    write('.env.apple', 'KEY=apple\n');
    const { env } = resolveEnv({
      cwd,
      relativeDir: 'packages/api',
      files: envFileNames('apple'),
    });
    expect(env.KEY).toBe('apple');
  });

  it('expands ${VAR} against earlier files and process.env', () => {
    withAmbient({ DEVTOOIE_ENV_SPEC: 'fromproc' }, () => {
      write('.env', 'BASE=hello\n');
      write('packages/api/.env.local', 'GREETING=${BASE} world\nECHO=${DEVTOOIE_ENV_SPEC}\n');
      const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
      expect(env.GREETING).toBe('hello world');
      expect(env.ECHO).toBe('fromproc');
    });
  });

  it('supports ${VAR:-default} and ${VAR:+alt} operators', () => {
    write(
      '.env',
      'SET=yes\nA=${SET:-fallback}\nB=${MISSING:-fallback}\nC=${SET:+present}\nD=${MISSING:+present}\n',
    );
    const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
    expect(env.A).toBe('yes');
    expect(env.B).toBe('fallback');
    expect(env.C).toBe('present');
    expect(env.D).toBe('');
  });

  it('returns only file-defined keys and does not mutate process.env', () => {
    write('.env', 'DEVTOOIE_ENV_SPEC_ONLY=x\n');
    const before = { ...process.env };
    const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
    expect(Object.keys(env)).toEqual(['DEVTOOIE_ENV_SPEC_ONLY']);
    expect(process.env.DEVTOOIE_ENV_SPEC_ONLY).toBeUndefined();
    expect(process.env).toEqual(before);
  });
});

describe('resolveEnv precedence against the ambient environment', () => {
  it('the ambient environment wins over a file var of the same name', () => {
    withAmbient({ DEVTOOIE_ENV_OVERRIDE: 'ambient' }, () => {
      write('.env', 'DEVTOOIE_ENV_OVERRIDE=fromfile\n');
      const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
      expect(env.DEVTOOIE_ENV_OVERRIDE).toBe('ambient');
    });
  });

  it('a cross-reference resolves against the ambient value the file lost to', () => {
    withAmbient({ DEVTOOIE_ENV_CROSS: 'ambient' }, () => {
      write('.env', 'DEVTOOIE_ENV_CROSS=fromfile\nDERIVED=${DEVTOOIE_ENV_CROSS}-x\n');
      const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
      expect(env.DEVTOOIE_ENV_CROSS).toBe('ambient');
      expect(env.DERIVED).toBe('ambient-x');
    });
  });

  it('a file var still wins where the ambient has none', () => {
    write('.env', 'DEVTOOIE_ENV_FILE_ONLY=fromfile\n');
    const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
    expect(env.DEVTOOIE_ENV_FILE_ONLY).toBe('fromfile');
  });

  it('override: [name] lets just that var beat the ambient', () => {
    withAmbient({ DEVTOOIE_ENV_A: 'ambientA', DEVTOOIE_ENV_B: 'ambientB' }, () => {
      write('.env', 'DEVTOOIE_ENV_A=fileA\nDEVTOOIE_ENV_B=fileB\n');
      const { env } = resolveEnv({
        cwd,
        relativeDir: 'packages/api',
        override: ['DEVTOOIE_ENV_A'],
      });
      expect(env.DEVTOOIE_ENV_A).toBe('fileA');
      expect(env.DEVTOOIE_ENV_B).toBe('ambientB');
    });
  });

  it('override: true restores blanket file-wins', () => {
    withAmbient({ DEVTOOIE_ENV_A: 'ambientA', DEVTOOIE_ENV_B: 'ambientB' }, () => {
      write('.env', 'DEVTOOIE_ENV_A=fileA\nDEVTOOIE_ENV_B=fileB\n');
      const { env } = resolveEnv({ cwd, relativeDir: 'packages/api', override: true });
      expect(env.DEVTOOIE_ENV_A).toBe('fileA');
      expect(env.DEVTOOIE_ENV_B).toBe('fileB');
    });
  });

  it('an overridden self-reference extends the ambient value (append pattern)', () => {
    withAmbient({ DEVTOOIE_ENV_APPEND: '--require /tmp/boot.js' }, () => {
      write('.env', 'DEVTOOIE_ENV_APPEND=$DEVTOOIE_ENV_APPEND --disable-warning=Experimental\n');
      const { env } = resolveEnv({
        cwd,
        relativeDir: 'packages/api',
        override: ['DEVTOOIE_ENV_APPEND'],
      });
      expect(env.DEVTOOIE_ENV_APPEND).toBe('--require /tmp/boot.js --disable-warning=Experimental');
    });
  });
});

describe('two-stage resolution (anchor merge, then per-package)', () => {
  // The CLI resolves workspace-scope env once at startup and merges it into its own process.env,
  // then resolves again per package. That first merge must NOT apply `override`, or a
  // self-referential value folds the file's contribution into the ambient base and the second
  // pass appends it again. Regression for a double-append that predates modes.
  it('appends a self-referential override exactly once', () => {
    withAmbient({ DEVTOOIE_ENV_TWOSTAGE: '--require /boot.js' }, () => {
      write('.env', 'DEVTOOIE_ENV_TWOSTAGE=$DEVTOOIE_ENV_TWOSTAGE --flag\n');

      // Stage 1: the anchor merge — no override, so this key resolves to its ambient value.
      const anchor = resolveEnv({ cwd, relativeDir: '.' });
      expect(anchor.env.DEVTOOIE_ENV_TWOSTAGE).toBe('--require /boot.js');
      Object.assign(process.env, anchor.env);

      // Stage 2: the package layer, which does apply the override.
      const { env } = resolveEnv({
        cwd,
        relativeDir: 'packages/api',
        override: ['DEVTOOIE_ENV_TWOSTAGE'],
      });
      expect(env.DEVTOOIE_ENV_TWOSTAGE).toBe('--require /boot.js --flag');
    });
  });
});

describe('literalizeForExpansion', () => {
  // This is the primary regression guard, and it is deliberately a property assertion rather than
  // a behavioral one. The bug it prevents is a *synchronous* infinite loop inside dotenvx, which
  // no test timeout can interrupt — a test that just called resolveEnv would hang the whole runner
  // instead of failing (verified: neutering the fix blocks the suite indefinitely). Asserting the
  // invariant directly fails fast and points straight at the cause.
  it('leaves no unescaped `$` for the expander to re-parse', () => {
    const out = literalizeForExpansion({
      SELF: '--require /boot.js ${SELF}',
      PLAIN: 'no dollars here',
      MIXED: 'a$b ${C} $D',
    });
    for (const value of Object.values(out)) {
      // Every `$` must be preceded by a backslash.
      expect(value.replaceAll('\\$', '')).not.toContain('$');
    }
  });

  it('leaves values without a `$` untouched', () => {
    expect(literalizeForExpansion({ A: 'plain', B: '' })).toEqual({ A: 'plain', B: '' });
  });
});

describe('resolveEnv expansion safety', () => {
  // Behavioral companions to the invariant test above: with the fix these return immediately and
  // assert the *values* are right. Without it they would hang, which is why they are not the
  // primary guard.
  it(
    'does not hang when an ambient value contains a literal self-reference',
    { timeout: 5000 },
    () => {
      withAmbient({ DEVTOOIE_ENV_POISON: '--require /boot.js ${DEVTOOIE_ENV_POISON}' }, () => {
        write('.env', 'DEVTOOIE_ENV_POISON=$DEVTOOIE_ENV_POISON --flag\n');
        const { env } = resolveEnv({
          cwd,
          relativeDir: 'packages/api',
          override: ['DEVTOOIE_ENV_POISON'],
        });
        // The inner literal is preserved verbatim rather than expanded again.
        expect(env.DEVTOOIE_ENV_POISON).toBe('--require /boot.js ${DEVTOOIE_ENV_POISON} --flag');
      });
    },
  );

  it('does not hang when the poisoned var is not overridden', { timeout: 5000 }, () => {
    withAmbient({ DEVTOOIE_ENV_POISON2: 'x ${DEVTOOIE_ENV_POISON2}' }, () => {
      write('.env', 'DEVTOOIE_ENV_POISON2=$DEVTOOIE_ENV_POISON2 --flag\n');
      const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
      // Ambient wins, and comes back as the real value — no stray escape backslash.
      expect(env.DEVTOOIE_ENV_POISON2).toBe('x ${DEVTOOIE_ENV_POISON2}');
    });
  });

  it('preserves a `$` inside an ambient value instead of expanding it away', () => {
    withAmbient({ DEVTOOIE_ENV_DOLLAR: 'hello$world' }, () => {
      write('.env', 'MSG=${DEVTOOIE_ENV_DOLLAR}!\n');
      const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
      expect(env.MSG).toBe('hello$world!');
    });
  });

  it('returns an ambient-won value without a stray escape backslash', () => {
    withAmbient({ DEVTOOIE_ENV_ESC: 'a$b' }, () => {
      write('.env', 'DEVTOOIE_ENV_ESC=fromfile\n');
      const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
      expect(env.DEVTOOIE_ENV_ESC).toBe('a$b');
    });
  });

  it('round-trips an ambient value that already contains an escaped dollar', () => {
    withAmbient({ DEVTOOIE_ENV_PREESC: 'lit\\$eral' }, () => {
      write('.env', 'OUT=${DEVTOOIE_ENV_PREESC}\n');
      const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
      expect(env.OUT).toBe('lit\\$eral');
    });
  });

  it('still expands file-to-file references (escaping is not over-applied)', () => {
    write('.env', 'A=one\nB=${A}/two\n');
    const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
    expect(env.B).toBe('one/two');
  });
});

describe('packageEnvLayer', () => {
  const mkPkg = (over: Partial<AnyPackageConfig>): AnyPackageConfig =>
    ({ name: 'api', relativeDir: 'packages/api', path: '/x', ...over }) as AnyPackageConfig;

  it('injects the package port as PORT, below its resolved .env vars', () => {
    write('.env', 'A=1\n');
    const layer = packageEnvLayer(mkPkg({ port: 3001 }), { cwd });
    expect(layer).toEqual({ PORT: '3001', A: '1' });
  });

  it('omits PORT when the package has no port, and an explicit .env PORT wins', () => {
    write('packages/api/.env', 'PORT=9999\n');
    expect(packageEnvLayer(mkPkg({}), { cwd }).PORT).toBe('9999');
    expect(packageEnvLayer(mkPkg({ port: 3001 }), { cwd }).PORT).toBe('9999');
  });
});

describe('ambientEnv', () => {
  it('snapshots process.env and drops undefined values', () => {
    process.env.DEVTOOIE_TEST_AMBIENT = 'yes';
    delete process.env.DEVTOOIE_TEST_MISSING;
    try {
      const env = ambientEnv();
      expect(env.DEVTOOIE_TEST_AMBIENT).toBe('yes');
      expect('DEVTOOIE_TEST_MISSING' in env).toBe(false);
      // A snapshot, not a live view.
      process.env.DEVTOOIE_TEST_AMBIENT = 'changed';
      expect(env.DEVTOOIE_TEST_AMBIENT).toBe('yes');
    } finally {
      delete process.env.DEVTOOIE_TEST_AMBIENT;
    }
  });

  it('returns real values, not the escaped copies used for expansion', () => {
    withAmbient({ DEVTOOIE_TEST_RAW: 'a$b' }, () => {
      expect(ambientEnv().DEVTOOIE_TEST_RAW).toBe('a$b');
    });
  });
});
