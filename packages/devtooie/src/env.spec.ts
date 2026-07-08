import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_ENV_FILES, envCandidatePaths, resolveEnv } from './env.js';

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
  it('is base → dev.pre → dev → local, ascending precedence within a scope', () => {
    expect(DEFAULT_ENV_FILES).toEqual([
      '.env',
      '.env.development.pre',
      '.env.development',
      '.env.local',
    ]);
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

  it('returns only file-defined keys and does not mutate process.env', () => {
    write('.env', 'DEVTOOIE_ENV_SPEC_ONLY=x\n');
    const before = { ...process.env };
    const { env } = resolveEnv({ cwd, relativeDir: 'packages/api' });
    expect(Object.keys(env)).toEqual(['DEVTOOIE_ENV_SPEC_ONLY']);
    expect(process.env.DEVTOOIE_ENV_SPEC_ONLY).toBeUndefined();
    expect(process.env).toEqual(before);
  });
});
