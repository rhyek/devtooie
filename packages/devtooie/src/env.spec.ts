import { describe, it, expect, beforeEach, afterEach, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import primitives from '@dotenvx/primitives';
import {
  ambientEnv,
  assignedNames,
  dropInjectedEnv,
  envCandidatePaths,
  envFileNames,
  hideDollars,
  packageEnvLayer,
  resolveEnv,
  resolveMode,
  workspaceEnvLayer,
} from './env.js';
import type { AnyServiceConfig } from './config.js';

/** A layer without its `DEVTOOIE_INJECTED_ENV` list, for the assertions about what it resolves. */
function withoutList(layer: Record<string, string>): Record<string, string> {
  const { DEVTOOIE_INJECTED_ENV: _list, ...vars } = layer;
  return vars;
}

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
    expect(resolveMode(['node', 'cli', '--mode', 'test', 'exec'])).toBe('test');
    expect(resolveMode(['node', 'cli', 'exec', '--mode', 'test'])).toBe('test');
  });

  it('stops at the first `--` so the wrapped command keeps its own flags', () => {
    // `--mode watch` here belongs to vitest, not devtooie.
    withAmbient({}, () => {
      delete process.env.DEVTOOIE_MODE;
      expect(resolveMode(['node', 'cli', 'exec', '--', 'vitest', '--mode', 'watch'])).toBe(
        'development',
      );
      // ...but a mode before the `--` still counts.
      expect(
        resolveMode(['node', 'cli', '--mode', 'test', 'exec', '--', 'vitest', '--mode', 'watch']),
      ).toBe('test');
    });
  });

  test('stops at an `infra <provider>` passthrough, whose flags belong to the provider', () => {
    withAmbient({}, () => {
      delete process.env.DEVTOOIE_MODE;
      // `-m 2g` is `docker compose build`'s memory limit, not a devtooie mode.
      expect(resolveMode(['node', 'cli', 'infra', 'docker-compose', 'build', '-m', '2g'])).toBe(
        'development',
      );
      expect(resolveMode(['node', 'cli', 'infra', 'docker-compose', 'run', '--mode=x', 'db'])).toBe(
        'development',
      );
      // ...but a mode before the provider word still counts, in either position.
      expect(
        resolveMode(['node', 'cli', '-m', 'test', 'infra', 'docker-compose', 'build', '-m', '2g']),
      ).toBe('test');
      expect(
        resolveMode(['node', 'cli', 'infra', '-m', 'test', 'docker-compose', '--mode', 'x']),
      ).toBe('test');
      // The other infra subcommands take the mode anywhere, like `exec`.
      expect(resolveMode(['node', 'cli', 'infra', 'up', '--mode', 'test'])).toBe('test');
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

describe('resolveEnv references to an overridden variable', () => {
  const resolve = (override: boolean | string[] | undefined, vars?: Record<string, string>) =>
    resolveEnv({ cwd, relativeDir: 'packages/api', override, vars }).env;

  test("expand to the file's value, not the shell's, in a later file", () => {
    write('.env', 'DEVTOOIE_ENV_A=/file\n');
    write('.env.local', 'DEVTOOIE_ENV_B=$DEVTOOIE_ENV_A/storage\n');
    write('packages/api/.env', 'DEVTOOIE_ENV_C="${DEVTOOIE_ENV_A}/cache"\n');
    withAmbient({ DEVTOOIE_ENV_A: '/shell' }, () => {
      expect(resolve(['DEVTOOIE_ENV_A'])).toEqual({
        DEVTOOIE_ENV_A: '/file',
        DEVTOOIE_ENV_B: '/file/storage',
        DEVTOOIE_ENV_C: '/file/cache',
      });
      expect(resolve(true)).toEqual({
        DEVTOOIE_ENV_A: '/file',
        DEVTOOIE_ENV_B: '/file/storage',
        DEVTOOIE_ENV_C: '/file/cache',
      });
      expect(resolve(undefined)).toEqual({
        DEVTOOIE_ENV_A: '/shell',
        DEVTOOIE_ENV_B: '/shell/storage',
        DEVTOOIE_ENV_C: '/shell/cache',
      });
    });
  });

  test("expand to the config's own var when that is what the override lets win", () => {
    write('.env', 'DEVTOOIE_ENV_B=$DEVTOOIE_ENV_A/storage\n');
    withAmbient({ DEVTOOIE_ENV_A: '/shell' }, () => {
      const vars = { DEVTOOIE_ENV_A: '/config' };
      expect(resolve(['DEVTOOIE_ENV_A'], vars)).toEqual({
        DEVTOOIE_ENV_A: '/config',
        DEVTOOIE_ENV_B: '/config/storage',
      });
      expect(resolve(undefined, vars)).toEqual({
        DEVTOOIE_ENV_A: '/shell',
        DEVTOOIE_ENV_B: '/shell/storage',
      });
    });
  });

  test('expand to the appended value of a self-referential override', () => {
    write('.env', 'DEVTOOIE_ENV_APPEND=$DEVTOOIE_ENV_APPEND --flag\n');
    write('.env.local', 'DEVTOOIE_ENV_B="node $DEVTOOIE_ENV_APPEND"\n');
    withAmbient({ DEVTOOIE_ENV_APPEND: '--require /tmp/boot.js' }, () => {
      expect(resolve(['DEVTOOIE_ENV_APPEND'])).toEqual({
        DEVTOOIE_ENV_APPEND: '--require /tmp/boot.js --flag',
        DEVTOOIE_ENV_B: 'node --require /tmp/boot.js --flag',
      });
    });
  });

  test('keep a dollar in the overridden value literal', () => {
    write('.env', 'DEVTOOIE_ENV_APPEND=$DEVTOOIE_ENV_APPEND --flag\n');
    write('.env.local', 'DEVTOOIE_ENV_B="node $DEVTOOIE_ENV_APPEND"\n');
    withAmbient({ DEVTOOIE_ENV_APPEND: "--a '$HOME' ${X}" }, () => {
      expect(resolve(['DEVTOOIE_ENV_APPEND'])).toEqual({
        DEVTOOIE_ENV_APPEND: "--a '$HOME' ${X} --flag",
        DEVTOOIE_ENV_B: "node --a '$HOME' ${X} --flag",
      });
    });
  });
});

describe('resolveEnv with an override in force', () => {
  test("expands an overridden variable's own references by the usual rule: the shell's value", () => {
    write('.env', 'DEVTOOIE_ENV_A=/file\nDEVTOOIE_ENV_B=$DEVTOOIE_ENV_A/b\n');
    withAmbient({ DEVTOOIE_ENV_A: '/shell', DEVTOOIE_ENV_B: '/shell-b' }, () => {
      const { env } = resolveEnv({ cwd, relativeDir: '.', override: ['DEVTOOIE_ENV_B'] });
      expect(env).toEqual({ DEVTOOIE_ENV_A: '/shell', DEVTOOIE_ENV_B: '/shell/b' });
    });
  });

  test('leaves a variable the override names alone when no file sets it', () => {
    write('.env', 'DEVTOOIE_ENV_B=$DEVTOOIE_ENV_A/b\n');
    withAmbient({ DEVTOOIE_ENV_A: '/shell' }, () => {
      const { env } = resolveEnv({ cwd, relativeDir: '.', override: ['DEVTOOIE_ENV_A'] });
      expect(env).toEqual({ DEVTOOIE_ENV_B: '/shell/b' });
    });
  });

  test('runs a command substitution once', () => {
    const counter = path.join(cwd, 'counter');
    write('.env', `DEVTOOIE_ENV_A=$(echo x >> ${counter}; echo ran)\n`);
    const { env } = resolveEnv({ cwd, relativeDir: '.', override: ['DEVTOOIE_ENV_B'] });
    expect(env).toEqual({ DEVTOOIE_ENV_A: 'ran' });
    expect(fs.readFileSync(counter, 'utf8')).toBe('x\n');
  });
});

describe('two-stage resolution (anchor merge, then per-package)', () => {
  /**
   * What the CLI does at startup, for the duration of `fn`: note the environment the shell handed
   * over, then merge the workspace's files into `process.env`, under the config's `override`.
   * `fn` gets the shell's environment, to resolve against as the CLI's later resolutions do.
   */
  function anchored(
    override: boolean | string[] | undefined,
    fn: (shell: Record<string, string>) => void,
  ): void {
    const shell = ambientEnv();
    const { env } = resolveEnv({ cwd, relativeDir: '.', ambient: shell, override });
    withAmbient(env, () => fn(shell));
  }

  // The merge puts workspace file values into `process.env`, where they look like the shell's.
  // Only a variable the shell really set may win over a file — `override` is about those alone.
  for (const { shell, override, expected } of [
    { shell: undefined, override: [], expected: '3' },
    { shell: undefined, override: ['DEVTOOIE_ENV_A'], expected: '3' },
    { shell: '1', override: [], expected: '1' },
    { shell: '1', override: ['DEVTOOIE_ENV_A'], expected: '3' },
  ]) {
    const given = shell === undefined ? 'unset in the shell' : `${shell} in the shell`;
    const overriding = override.length > 0 ? 'overridden' : 'not overridden';
    test(`a variable ${given} and ${overriding} resolves to ${expected}`, () => {
      write('.env.development', 'DEVTOOIE_ENV_A=2\n');
      write('packages/api/.env.development', 'DEVTOOIE_ENV_A=3\n');
      withAmbient(shell === undefined ? {} : { DEVTOOIE_ENV_A: shell }, () => {
        anchored(override, (ambient) => {
          const { env } = resolveEnv({ cwd, relativeDir: 'packages/api', override, ambient });
          expect(env.DEVTOOIE_ENV_A).toBe(expected);
        });
      });
    });
  }

  test('override: true lets the deepest file beat the shell', () => {
    write('.env', 'DEVTOOIE_ENV_A=2\n');
    write('packages/api/.env', 'DEVTOOIE_ENV_A=3\n');
    withAmbient({ DEVTOOIE_ENV_A: '1' }, () => {
      anchored(true, (ambient) => {
        const { env } = resolveEnv({ cwd, relativeDir: 'packages/api', override: true, ambient });
        expect(env.DEVTOOIE_ENV_A).toBe('3');
      });
    });
  });

  // A session re-resolves on every restart; the value merged at startup must not shadow the file
  // it came from.
  test('picks up a workspace file edited after the merge', () => {
    write('.env', 'DEVTOOIE_ENV_A=before\n');
    anchored(undefined, (ambient) => {
      expect(process.env.DEVTOOIE_ENV_A).toBe('before');
      write('.env', 'DEVTOOIE_ENV_A=after\n');
      const { env } = resolveEnv({ cwd, relativeDir: 'packages/api', ambient });
      expect(env.DEVTOOIE_ENV_A).toBe('after');
    });
  });

  // The self-append pattern `env.override` exists for. The merge itself resolves without the
  // override, and the package pass expands `$VAR` against the shell's value — never against what
  // the merge left in `process.env` — so the flag is appended exactly once either way.
  test('appends a self-referential override exactly once', () => {
    write('.env', 'DEVTOOIE_ENV_TWOSTAGE=$DEVTOOIE_ENV_TWOSTAGE --flag\n');
    withAmbient({ DEVTOOIE_ENV_TWOSTAGE: '--require /boot.js' }, () => {
      anchored(['DEVTOOIE_ENV_TWOSTAGE'], (ambient) => {
        // devtooie's own environment carries the appended value, for what it starts itself…
        expect(process.env.DEVTOOIE_ENV_TWOSTAGE).toBe('--require /boot.js --flag');
        // …and a package's is still built from the shell's, so the flag isn't appended again.
        const { env } = resolveEnv({
          cwd,
          relativeDir: 'packages/api',
          override: ['DEVTOOIE_ENV_TWOSTAGE'],
          ambient,
        });
        expect(env.DEVTOOIE_ENV_TWOSTAGE).toBe('--require /boot.js --flag');
      });
    });
  });

  test('appends a self-referential override exactly once when the shell has no value', () => {
    write('.env', 'DEVTOOIE_ENV_TWOSTAGE="$DEVTOOIE_ENV_TWOSTAGE --flag"\n');
    anchored(['DEVTOOIE_ENV_TWOSTAGE'], (ambient) => {
      const { env } = resolveEnv({
        cwd,
        relativeDir: 'packages/api',
        override: ['DEVTOOIE_ENV_TWOSTAGE'],
        ambient,
      });
      expect(env.DEVTOOIE_ENV_TWOSTAGE).toBe(' --flag');
    });
  });
});

describe('captureShellEnv', () => {
  // A module of its own, so the recorded environment doesn't outlive the test.
  test('makes the environment at that moment the ambient one for later resolutions', async () => {
    vi.resetModules();
    const fresh = await import('./env.js');
    write('.env', 'DEVTOOIE_ENV_A=2\n');
    write('packages/api/.env', 'DEVTOOIE_ENV_A=3\n');

    fresh.captureShellEnv();
    const merged = fresh.resolveEnv({ cwd, relativeDir: '.' }).env;
    withAmbient(merged, () => {
      expect(fresh.resolveEnv({ cwd, relativeDir: 'packages/api' }).env.DEVTOOIE_ENV_A).toBe('3');
    });
  });

  test('keeps a variable the shell set winning over the files', async () => {
    vi.resetModules();
    const fresh = await import('./env.js');
    write('packages/api/.env', 'DEVTOOIE_ENV_A=3\n');
    withAmbient({ DEVTOOIE_ENV_A: '1' }, () => {
      fresh.captureShellEnv();
      expect(fresh.resolveEnv({ cwd, relativeDir: 'packages/api' }).env.DEVTOOIE_ENV_A).toBe('1');
    });
  });
});

describe('hideDollars', () => {
  // This is the primary regression guard, and it is deliberately a property assertion rather than
  // a behavioral one. The bug it prevents is a *synchronous* infinite loop inside dotenvx, which
  // no test timeout can interrupt — a test that just called resolveEnv would hang the whole runner
  // instead of failing (verified: neutering the fix blocks the suite indefinitely). Asserting the
  // invariant directly fails fast and points straight at the cause.
  test('leaves no `$` for the expander to parse', () => {
    const out = hideDollars(
      {
        SELF: '--require /boot.js ${SELF}',
        PLAIN: 'no dollars here',
        MIXED: 'a$b ${C} $D \\$E $(echo pwned)',
      },
      '<dollar>',
    );
    for (const value of Object.values(out)) {
      expect(value).not.toContain('$');
    }
    expect(out.MIXED).toBe('a<dollar>b <dollar>{C} <dollar>D \\<dollar>E <dollar>(echo pwned)');
  });

  test('leaves values without a `$` untouched', () => {
    expect(hideDollars({ A: 'plain', B: '' }, '<dollar>')).toEqual({ A: 'plain', B: '' });
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
  const mkPkg = (over: Partial<AnyServiceConfig>): AnyServiceConfig =>
    ({ name: 'api', relativeDir: 'packages/api', path: '/x', ...over }) as AnyServiceConfig;

  it('injects the package port as PORT, below its resolved .env vars', () => {
    write('.env', 'A=1\n');
    const layer = packageEnvLayer(mkPkg({ port: 3001 }), { cwd });
    expect(withoutList(layer)).toEqual({ PORT: '3001', A: '1' });
  });

  it('omits PORT when the package has no port, and an explicit .env PORT wins', () => {
    write('packages/api/.env', 'PORT=9999\n');
    expect(packageEnvLayer(mkPkg({}), { cwd }).PORT).toBe('9999');
    expect(packageEnvLayer(mkPkg({ port: 3001 }), { cwd }).PORT).toBe('9999');
  });

  test("ranks the config's own vars as a file below the .env files", () => {
    write('.env', 'A=1\nB=file\n');
    const layer = packageEnvLayer(mkPkg({ port: 3001 }), {
      cwd,
      vars: { B: 'config', C: 'config' },
    });
    expect(withoutList(layer)).toEqual({ PORT: '3001', A: '1', B: 'file', C: 'config' });
  });

  test("keeps the injected PORT over one set workspace-wide: in a .env file or the config's vars", () => {
    write('.env', 'PORT=9999\n');
    expect(packageEnvLayer(mkPkg({ port: 3001 }), { cwd }).PORT).toBe('3001');
    expect(packageEnvLayer(mkPkg({ port: 3001 }), { cwd, vars: { PORT: '4000' } }).PORT).toBe(
      '3001',
    );
  });

  test('passes a workspace-wide PORT on to a package that has no port of its own', () => {
    write('.env', 'PORT=9999\n');
    expect(packageEnvLayer(mkPkg({}), { cwd }).PORT).toBe('9999');
  });

  test("treats PUBLIC_ORIGIN the same way: only the package's own .env file replaces it", () => {
    const pkg = mkPkg({ publicOrigin: 'http://api.localhost:4000' });
    write('.env', 'PUBLIC_ORIGIN=https://workspace.example\n');
    expect(packageEnvLayer(pkg, { cwd }).PUBLIC_ORIGIN).toBe('http://api.localhost:4000');
    write('packages/api/.env', 'PUBLIC_ORIGIN=https://api.example\n');
    expect(packageEnvLayer(pkg, { cwd }).PUBLIC_ORIGIN).toBe('https://api.example');
  });

  test("counts the workspace's .env file as the package's own when the package is the workspace", () => {
    write('.env', 'PORT=9999\n');
    expect(packageEnvLayer(mkPkg({ relativeDir: '.', port: 3001 }), { cwd }).PORT).toBe('9999');
  });

  test("is not fooled by a PORT line inside another variable's quoted value", () => {
    write('packages/api/.env', 'NOTES="first line\nPORT=9999\nlast line"\n');
    expect(packageEnvLayer(mkPkg({ port: 3001 }), { cwd }).PORT).toBe('3001');
  });

  test('lets the shell win a PORT only where a file of the package sets one', () => {
    withAmbient({ PORT: '5000' }, () => {
      expect(packageEnvLayer(mkPkg({ port: 3001 }), { cwd }).PORT).toBe('3001');
      write('packages/api/.env', 'PORT=9999\n');
      expect(packageEnvLayer(mkPkg({ port: 3001 }), { cwd }).PORT).toBe('5000');
    });
  });

  test("lets the package's own .env file replace a config var the workspace's leaves alone", () => {
    write('packages/api/.env', 'B=package\n');
    const vars = { B: 'config' };
    expect(withoutList(packageEnvLayer(mkPkg({}), { cwd, vars }))).toEqual({ B: 'package' });
    expect(withoutList(workspaceEnvLayer({ cwd, vars }))).toEqual({ B: 'config' });
  });
});

describe('assignedNames', () => {
  test.each([
    ['plain, exported and colon-separated assignments', 'A=1\nexport B=2\nC: 3\n  D = 4 # note\n'],
    ['comments and blank lines', '# A=1\n\nB=2\n#C=3\n'],
    ['a quoted value spanning lines', 'A="one\nB=2\nthree"\nC=\'x\nD=4\'\nE=`y\nF=6`\nG=7\n'],
    ['windows line endings', 'A=1\r\nB="x\r\nC=3"\r\nD=4\r\n'],
    ['an empty value and a repeated name', 'A=\nB=1\nB=2\n'],
    ['an escaped quote inside a quoted value', 'A="say \\"hi\\"\nB=2"\nC=3\n'],
  ])('reads the names dotenvx does, with %s', (_what, source) => {
    const { parsed } = primitives.parseSync(source, { processEnv: {} });
    expect([...assignedNames(source)].sort()).toEqual(Object.keys(parsed).sort());
  });
});

describe('DEVTOOIE_INJECTED_ENV', () => {
  test("lists what a child gets that the shell didn't set, never DEVTOOIE_MODE", () => {
    vi.stubEnv('FROM_SHELL', 'shell');
    vi.stubEnv('DEVTOOIE_MODE', 'test');
    write('.env', 'FROM_FILE=1\nFROM_SHELL=file\n');
    const layer = workspaceEnvLayer({ cwd, vars: { FROM_CONFIG: 'x' } });
    const listed = layer.DEVTOOIE_INJECTED_ENV!.split(',');
    expect(listed).toEqual(expect.arrayContaining(['FROM_FILE', 'FROM_CONFIG']));
    // The shell's own value wins over the file, so the child's is the shell's: not listed.
    expect(listed).not.toContain('FROM_SHELL');
    expect(listed).not.toContain('DEVTOOIE_MODE');
  });

  test("a service's layer lists its PORT", () => {
    const pkg = { name: 'api', relativeDir: 'packages/api', path: '/x', port: 3001 } as unknown as AnyServiceConfig; // prettier-ignore
    expect(packageEnvLayer(pkg, { cwd }).DEVTOOIE_INJECTED_ENV!.split(',')).toContain('PORT');
  });

  test('dropInjectedEnv removes the listed variables and the list, keeping DEVTOOIE_MODE', () => {
    const env: NodeJS.ProcessEnv = {
      DEVTOOIE_INJECTED_ENV: 'A,PORT,DEVTOOIE_MODE',
      A: 'outer',
      PORT: '3001',
      DEVTOOIE_MODE: 'test',
      HOME: '/home/x',
    };
    dropInjectedEnv(env);
    expect(env).toEqual({ DEVTOOIE_MODE: 'test', HOME: '/home/x' });
  });
});

describe('workspaceEnvLayer', () => {
  test("is the workspace-scope .env vars, never a package's", () => {
    write('.env', 'A=1\n');
    write('packages/api/.env', 'A=2\n');
    expect(withoutList(workspaceEnvLayer({ cwd }))).toEqual({ A: '1' });
  });

  test("ranks the config's own vars below the .env files", () => {
    write('.env', 'A=1\nB=file\n');
    expect(withoutList(workspaceEnvLayer({ cwd, vars: { B: 'config', C: 'config' } }))).toEqual({
      A: '1',
      B: 'file',
      C: 'config',
    });
  });
});

describe("resolveEnv with the config's own vars", () => {
  const resolve = (vars: Record<string, string>, override?: boolean | string[]) =>
    resolveEnv({ cwd, relativeDir: 'packages/api', vars, override }).env;

  test('is just the vars when no file exists', () => {
    expect(resolve({ A: 'config', B: '' })).toEqual({ A: 'config', B: '' });
  });

  test("lets any file replace a var: the workspace's, then the package's", () => {
    write('.env', 'A=workspace\nB=workspace\n');
    write('packages/api/.env', 'B=package\n');
    expect(resolve({ A: 'config', B: 'config', C: 'config' })).toEqual({
      A: 'workspace',
      B: 'package',
      C: 'config',
    });
  });

  test('gives the ambient environment the win over a var, as over a file', () => {
    withAmbient({ DEVTOOIE_TEST_AMBIENT: 'shell' }, () => {
      expect(resolve({ DEVTOOIE_TEST_AMBIENT: 'config' })).toEqual({
        DEVTOOIE_TEST_AMBIENT: 'shell',
      });
    });
  });

  test('lets env.override hand a var the win back, by name or for all', () => {
    withAmbient({ DEVTOOIE_TEST_AMBIENT: 'shell' }, () => {
      const vars = { DEVTOOIE_TEST_AMBIENT: 'config' };
      expect(resolve(vars, ['DEVTOOIE_TEST_AMBIENT'])).toEqual(vars);
      expect(resolve(vars, true)).toEqual(vars);
      expect(resolve(vars, ['SOMETHING_ELSE'])).toEqual({ DEVTOOIE_TEST_AMBIENT: 'shell' });
    });
  });

  test('gives the shell the variable when the shell, a file and the config all set it', () => {
    write('.env', 'DEVTOOIE_TEST_AMBIENT=file\n');
    const vars = { DEVTOOIE_TEST_AMBIENT: 'config' };
    withAmbient({ DEVTOOIE_TEST_AMBIENT: 'shell' }, () => {
      expect(resolve(vars)).toEqual({ DEVTOOIE_TEST_AMBIENT: 'shell' });
      expect(resolve(vars, true)).toEqual({ DEVTOOIE_TEST_AMBIENT: 'file' });
    });
  });

  test("expands a file's reference to a var", () => {
    write('.env', 'UPLOADS=${DATA_DIR}/uploads\n');
    write('packages/api/.env', 'CACHE="$DATA_DIR/cache"\n');
    expect(resolve({ DATA_DIR: '/srv/data' })).toEqual({
      DATA_DIR: '/srv/data',
      UPLOADS: '/srv/data/uploads',
      CACHE: '/srv/data/cache',
    });
  });

  test("expands that reference to the shell's value when the shell wins the var", () => {
    write('.env', 'UPLOADS=${DEVTOOIE_TEST_AMBIENT}/uploads\n');
    withAmbient({ DEVTOOIE_TEST_AMBIENT: '/shell' }, () => {
      expect(resolve({ DEVTOOIE_TEST_AMBIENT: '/srv/data' }).UPLOADS).toBe('/shell/uploads');
    });
  });

  test.each([
    ['a dollar reference', 'a$b ${c} ${DEVTOOIE_TEST_AMBIENT}'],
    ['a command substitution', '$(echo pwned)'],
    ['a command substitution next to a single quote', "it's $(echo pwned)"],
    ['a trailing backslash', 'C:\\dir\\'],
    ['a backslash before a single quote', "it\\'s"],
    ['an escaped dollar', 'x\\$y'],
    ['double quotes and backticks', '"q" `b`'],
    ['a single quote', "it's"],
    ['a single quote next to a dollar', "it's $5 ${c}"],
    ['surrounding spaces', '  padded  '],
    ['a hash', 'a #not-a-comment'],
    ['a newline', 'line1\nline2'],
    ['backslashes', 'c:\\n\\t\\\\'],
    ['an equals sign', 'a=b'],
    ['a line that looks like an assignment', "x\nOTHER='y'"],
  ])('takes a value with %s literally', (_what, value) => {
    write('.env', 'FROM_FILE=1\n');
    withAmbient({ DEVTOOIE_TEST_AMBIENT: 'shell' }, () => {
      expect(resolve({ TRICKY: value, AFTER: 'after' })).toEqual({
        TRICKY: value,
        AFTER: 'after',
        FROM_FILE: '1',
      });
      expect(resolve({ TRICKY: value, AFTER: 'after' }, true)).toEqual({
        TRICKY: value,
        AFTER: 'after',
        FROM_FILE: '1',
      });
    });
  });

  test.each([
    ['', 'a$b ${c}'],
    [' next to a single quote', "it's $b ${c} \\$d"],
    [' in a command substitution next to a single quote', "it's $(echo pwned)"],
  ])('keeps a dollar%s literal when a file references the var', (_what, value) => {
    write('.env', 'COPY=${PRICE}!\n');
    const expected = { PRICE: value, COPY: `${value}!` };
    expect(resolve({ PRICE: value })).toEqual(expected);
    expect(resolve({ PRICE: value }, true)).toEqual(expected);
  });

  test('lets a file replace a var whose value has a single quote and a dollar', () => {
    write('.env', "PRICE='it\\'s \\$b'\n");
    expect(resolve({ PRICE: "it's $b" }).PRICE).toBe("it's \\$b");
  });
});

describe('encrypted values', () => {
  const secret = () => {
    const { publicKey, privateKey } = primitives.keypair();
    write(
      '.env',
      `DOTENV_PUBLIC_KEY="${publicKey}"\nSECRET="${primitives.encrypt(publicKey, 's3cret')}"\nPLAIN=1\n`,
    );
    return privateKey;
  };

  test('decrypts a value whose private key is in the ambient environment', () => {
    const privateKey = secret();
    const { env } = resolveEnv({
      cwd,
      relativeDir: '.',
      ambient: { DOTENV_PRIVATE_KEY: privateKey },
    });
    expect(env).toMatchObject({ SECRET: 's3cret', PLAIN: '1' });
  });

  test('leaves a value it has no key for as it is, and says which one on stderr', () => {
    secret();
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });
    try {
      const { env } = resolveEnv({ cwd, relativeDir: '.', ambient: {} });
      expect(env.SECRET).toMatch(/^encrypted:/);
      expect(env.PLAIN).toBe('1');
    } finally {
      spy.mockRestore();
    }
    expect(errors.join('\n')).toContain('could not decrypt SECRET');
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
