import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPostinstall } from './postinstall.js';
import { skillInstallPath } from './skill.js';

// A fake consumer project (`root`) with devtooie installed under its node_modules as a symlink
// to a fake package dir — the layout npm and pnpm both produce, once realpath'd.
let root: string;
let packageDir: string;
const log: string[] = [];
const write = (line: string) => void log.push(line);

beforeEach(() => {
  log.length = 0;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-postinstall-')));
  packageDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-pkg-')));
  fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "consumer", "private": true }\n');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.symlinkSync(packageDir, path.join(root, 'node_modules', 'devtooie'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(packageDir, { recursive: true, force: true });
});

const run = (env: Record<string, string | undefined> = { INIT_CWD: root }) =>
  runPostinstall({ packageDir, env, version: '1.2.3', write });

describe('runPostinstall', () => {
  test('installs the skill when the project already has a config, leaving the config alone', async () => {
    const config = path.join(root, 'devtooie.config.ts');
    fs.writeFileSync(config, '// my config\n');
    await run();
    expect(fs.readFileSync(config, 'utf8')).toBe('// my config\n');
    expect(fs.existsSync(skillInstallPath(root))).toBe(true);
    expect(fs.readFileSync(skillInstallPath(root), 'utf8')).toContain('1.2.3');
    expect(log.join('\n')).toMatch(/agent skill/);
  });

  test('runs init when the project has no config: scaffolds it and installs the skill', async () => {
    await run();
    expect(fs.existsSync(path.join(root, 'devtooie.config.ts'))).toBe(true);
    expect(fs.existsSync(skillInstallPath(root))).toBe(true);
  });

  test('rewrites an outdated skill file', async () => {
    fs.writeFileSync(path.join(root, 'devtooie.config.ts'), '');
    fs.mkdirSync(path.dirname(skillInstallPath(root)), { recursive: true });
    fs.writeFileSync(skillInstallPath(root), '--- old ---\n');
    await run();
    expect(fs.readFileSync(skillInstallPath(root), 'utf8')).toContain('1.2.3');
  });

  test('does nothing without INIT_CWD (not run by a package manager)', async () => {
    await run({});
    expect(fs.existsSync(skillInstallPath(root))).toBe(false);
    expect(fs.existsSync(path.join(root, 'devtooie.config.ts'))).toBe(false);
  });

  test('does nothing in CI', async () => {
    await run({ INIT_CWD: root, CI: 'true' });
    expect(fs.existsSync(skillInstallPath(root))).toBe(false);
  });

  test('does nothing when the installing project is not the one devtooie is installed in', async () => {
    // e.g. devtooie's own workspace, or an unrelated `INIT_CWD`: node_modules/devtooie there
    // does not resolve to this package.
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-other-')));
    try {
      await run({ INIT_CWD: other });
      expect(fs.existsSync(skillInstallPath(other))).toBe(false);
      expect(fs.existsSync(path.join(other, 'devtooie.config.ts'))).toBe(false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  test('never throws: a failure is reported and swallowed', async () => {
    fs.writeFileSync(path.join(root, 'devtooie.config.ts'), '');
    // `.claude` as a file makes the skill dir uncreatable.
    fs.writeFileSync(path.join(root, '.claude'), '');
    await expect(run()).resolves.toBeUndefined();
    expect(log.join('\n')).toMatch(/could not/i);
  });
});
