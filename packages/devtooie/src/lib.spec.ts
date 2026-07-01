import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCommandRunner, getExecArgs, hasScript, hasDevScript, getExtraCommands } from './lib.js';
import type { AnyAppConfig } from './config.js';

let dir: string;
function app(over: Partial<AnyAppConfig> & { path: string }): AnyAppConfig {
  return { name: 'x', types: [], relativeDir: 'x', ...over } as AnyAppConfig;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-lib-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { dev: 'x', build: 'x', 'build:clean': 'x', codegen: 'x' } }),
  );
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('runner detection', () => {
  it('detects pnpm for a package.json app', () => {
    expect(getCommandRunner(app({ path: dir }))).toBe('pnpm');
    expect(getExecArgs(app({ path: dir }), 'dev')).toEqual(['pnpm', ['run', 'dev']]);
  });
  it('reads scripts', () => {
    expect(hasScript(app({ path: dir }), 'build')).toBe(true);
    expect(hasDevScript(app({ path: dir }))).toBe(true);
  });
  it('excludes runner-managed scripts from extra commands', () => {
    expect(getExtraCommands(app({ path: dir }))).toEqual(['codegen']);
  });
  it('falls back to pnpm when nothing present', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-empty-'));
    expect(getCommandRunner(app({ path: empty }))).toBe('pnpm');
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
