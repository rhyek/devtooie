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

describe('runInit skill auto-update', () => {
  it('refreshes an already-installed skill without prompting (no --yes)', async () => {
    // First-time install (via --yes) so the managed skill file exists.
    await runInit({ cwd, yes: true });
    const file = path.join(cwd, '.claude/skills/devtooie/SKILL.md');
    // Simulate the on-disk skill drifting from the shipped template.
    fs.writeFileSync(file, 'STALE\n');

    // No --yes: because the skill already exists, init must refresh it WITHOUT prompting
    // (this would hang on the confirm() prompt if the auto-update path weren't taken).
    await runInit({ cwd });

    const out = fs.readFileSync(file, 'utf8');
    expect(out).not.toContain('STALE');
    expect(out).toContain('devtooie skill v');
  });
});
