import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, findConfigPath, NoProjectConfigError } from './load-config.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-load-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('loadConfig', () => {
  it('throws NoProjectConfigError when no devtooie.config file exists', async () => {
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(NoProjectConfigError);
  });

  it('imports the config module and returns its resolved packages', async () => {
    // A compiled ESM config file (avoids relying on native TS in the test).
    const pkgIndex = path.resolve('packages/devtooie/dist/index.js');
    fs.writeFileSync(
      path.join(dir, 'devtooie.config.mjs'),
      `import { defineConfig } from ${JSON.stringify(pkgIndex)};\n` +
        `export default defineConfig({ apiPort: 4099, packages: [{ name: 'svc', types: ['backend'] }] });\n`,
    );
    const packages = await loadConfig(dir);
    expect(packages.map((p: (typeof packages)[0]) => p.name)).toContain('svc');
  });
});

describe('findConfigPath', () => {
  it('returns null when nothing matches', () => {
    expect(findConfigPath(dir)).toBeNull();
  });

  it('discovers devtooie.config.ts', () => {
    const p = path.join(dir, 'devtooie.config.ts');
    fs.writeFileSync(p, 'export default {};\n');
    expect(findConfigPath(dir)).toBe(p);
  });
});
