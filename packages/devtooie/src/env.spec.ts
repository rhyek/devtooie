import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_ENV_FILES, envCandidatePaths, resolveEnv, packageEnvLayer } from './env.js';
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

describe('DEFAULT_ENV_FILES', () => {
  it('is base → dev → local, ascending precedence within a scope', () => {
    expect(DEFAULT_ENV_FILES).toEqual(['.env', '.env.development', '.env.local']);
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
});

describe('resolveEnv', () => {
  it('loads only files that exist', () => {
    write('.env', 'A=1\n');
    // no package files
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

  it('within a scope, a later file in the list overrides an earlier one', () => {
    write('.env', 'KEY=base\n');
    write('.env.local', 'KEY=local\n');
    const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
    expect(env.KEY).toBe('local');
  });

  it('expands ${VAR} against earlier files and process.env', () => {
    process.env.DEVTOOIE_ENV_SPEC = 'fromproc';
    try {
      write('.env', 'BASE=hello\n');
      write('packages/api/.env.local', 'GREETING=${BASE} world\nECHO=${DEVTOOIE_ENV_SPEC}\n');
      const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
      expect(env.GREETING).toBe('hello world');
      expect(env.ECHO).toBe('fromproc');
    } finally {
      delete process.env.DEVTOOIE_ENV_SPEC;
    }
  });

  it('a file var overrides an ambient env var of the same name', () => {
    process.env.DEVTOOIE_ENV_OVERRIDE = 'ambient';
    try {
      write('.env', 'DEVTOOIE_ENV_OVERRIDE=fromfile\n');
      const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
      expect(env.DEVTOOIE_ENV_OVERRIDE).toBe('fromfile');
    } finally {
      delete process.env.DEVTOOIE_ENV_OVERRIDE;
    }
  });

  it('a self-reference extends the ambient value (append pattern)', () => {
    process.env.DEVTOOIE_ENV_APPEND = '--require /tmp/boot.js';
    try {
      write(
        '.env',
        'DEVTOOIE_ENV_APPEND=$DEVTOOIE_ENV_APPEND --disable-warning=ExperimentalWarning\n',
      );
      const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
      expect(env.DEVTOOIE_ENV_APPEND).toBe(
        '--require /tmp/boot.js --disable-warning=ExperimentalWarning',
      );
    } finally {
      delete process.env.DEVTOOIE_ENV_APPEND;
    }
  });

  it('a cross-reference prefers a file var over an ambient var of the same name', () => {
    process.env.DEVTOOIE_ENV_CROSS = 'ambient';
    try {
      write('.env', 'DEVTOOIE_ENV_CROSS=fromfile\nDERIVED=${DEVTOOIE_ENV_CROSS}-x\n');
      const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
      expect(env.DERIVED).toBe('fromfile-x');
    } finally {
      delete process.env.DEVTOOIE_ENV_CROSS;
    }
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
