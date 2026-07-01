import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadServices, NoProjectConfigError } from './load-config.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-load-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('loadServices', () => {
  it('throws NoProjectConfigError when devtooie.yaml is missing', async () => {
    await expect(loadServices(dir)).rejects.toBeInstanceOf(NoProjectConfigError);
  });

  it('imports the services module and returns registered apps', async () => {
    // A compiled ESM services file (avoids relying on native TS in the test).
    const pkgIndex = path.resolve('packages/devtooie/dist/index.js');
    fs.writeFileSync(
      path.join(dir, 'services.mjs'),
      `import { defineAppConfigs } from ${JSON.stringify(pkgIndex)};\n` +
        `export default defineAppConfigs({ apps: [{ name: 'svc', types: ['backend'] }] });\n`,
    );
    fs.writeFileSync(path.join(dir, 'devtooie.yaml'), 'services: ./services.mjs\napiPort: 4099\n');
    const apps = await loadServices(dir);
    expect(apps.map((a: (typeof apps)[0]) => a.name)).toContain('svc');
  });
});
