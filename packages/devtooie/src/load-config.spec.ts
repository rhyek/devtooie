import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadConfig,
  findConfigPath,
  findWorkspaceRoot,
  formatConfigLoadFailure,
  MIN_TS_CONFIG_NODE,
  NoProjectConfigError,
} from './load-config.js';

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
        `export default defineConfig({ apiPort: 4099, packages: [{ name: 'svc' }] });\n`,
    );
    const packages = await loadConfig(dir);
    expect(packages.map((p: (typeof packages)[0]) => p.name)).toContain('svc');
  });
});

describe('loadConfig failure modes', () => {
  it('rejects with the underlying error — not NoProjectConfigError — when the config throws', async () => {
    fs.writeFileSync(path.join(dir, 'devtooie.config.mjs'), `throw new Error('boom in config');\n`);
    const err = await loadConfig(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NoProjectConfigError);
    expect((err as Error).message).toContain('boom in config');
  });
});

describe('formatConfigLoadFailure', () => {
  it('names the config file and includes the underlying error', () => {
    const msg = formatConfigLoadFailure('/w/devtooie.config.ts', new Error('Unexpected token'));
    expect(msg).toContain('Failed to load /w/devtooie.config.ts');
    expect(msg).toContain('Unexpected token');
  });

  it('adds the Node-version hint when Node cannot import TypeScript', () => {
    const err = Object.assign(new TypeError('Unknown file extension ".ts"'), {
      code: 'ERR_UNKNOWN_FILE_EXTENSION',
    });
    const msg = formatConfigLoadFailure('/w/devtooie.config.ts', err, 'v22.17.1');
    expect(msg).toContain('Unknown file extension ".ts"');
    expect(msg).toContain('v22.17.1');
    expect(msg).toContain(`>=${MIN_TS_CONFIG_NODE}`);
  });

  it('omits the Node hint for unrelated failures', () => {
    const msg = formatConfigLoadFailure('/w/devtooie.config.ts', new Error('boom'), 'v22.17.1');
    expect(msg).not.toContain(MIN_TS_CONFIG_NODE);
  });

  it('stringifies a non-Error throw', () => {
    expect(formatConfigLoadFailure('/w/devtooie.config.ts', 'just a string')).toContain(
      'just a string',
    );
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

describe('findWorkspaceRoot', () => {
  it('returns the nearest ancestor directory containing a devtooie config', () => {
    fs.writeFileSync(path.join(dir, 'devtooie.config.ts'), 'export default {};\n');
    const nested = path.join(dir, 'packages', 'api');
    fs.mkdirSync(nested, { recursive: true });
    expect(findWorkspaceRoot(nested)).toBe(dir);
  });

  it('returns the dir itself when the config is right there', () => {
    fs.writeFileSync(path.join(dir, 'devtooie.config.mjs'), 'export default {};\n');
    expect(findWorkspaceRoot(dir)).toBe(dir);
  });

  it('returns null when no config exists up the tree', () => {
    expect(findWorkspaceRoot(dir)).toBeNull();
  });
});
