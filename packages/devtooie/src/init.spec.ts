import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInit } from './init.js';

let cwd: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-init-'));
  fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

describe('runInit --yes (non-interactive)', () => {
  it('scaffolds the config, reconciles tsconfig, and installs the skill without prompting', async () => {
    await runInit({ cwd, yes: true });
    expect(fs.existsSync(path.join(cwd, 'devtooie.config.ts'))).toBe(true);
    expect(fs.existsSync(path.join(cwd, 'tsconfig.json'))).toBe(true);
    expect(fs.existsSync(path.join(cwd, '.claude/skills/devtooie/SKILL.md'))).toBe(true);
  });

  it('is idempotent: keeps the existing config and does not duplicate the tsconfig include', async () => {
    await runInit({ cwd, yes: true });
    const config = fs.readFileSync(path.join(cwd, 'devtooie.config.ts'), 'utf8');

    await runInit({ cwd, yes: true });
    // An existing config is left untouched.
    expect(fs.readFileSync(path.join(cwd, 'devtooie.config.ts'), 'utf8')).toBe(config);
    // devtooie.config.ts appears exactly once in tsconfig's include.
    const ts = fs.readFileSync(path.join(cwd, 'tsconfig.json'), 'utf8');
    expect((ts.match(/devtooie\.config\.ts/g) ?? []).length).toBe(1);
  });
});
