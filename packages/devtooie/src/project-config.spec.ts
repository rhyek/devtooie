import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProjectConfig, writeProjectConfig, findProjectConfigPath } from './project-config.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-pc-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('project-config', () => {
  it('returns null when no config file exists', () => {
    expect(findProjectConfigPath(dir)).toBeNull();
    expect(getProjectConfig(dir)).toBeNull();
  });

  it('round-trips a written config with defaults applied', () => {
    writeProjectConfig({ services: './services.ts', apiPort: 4099, skill: true }, dir);
    const cfg = getProjectConfig(dir)!;
    expect(cfg.services).toBe('./services.ts');
    expect(cfg.apiPort).toBe(4099);
    expect(cfg.skill).toBe(true);
  });

  it('defaults apiPort to 4099 when omitted', () => {
    fs.writeFileSync(path.join(dir, 'devtooie.yaml'), 'services: ./services.ts\n');
    expect(getProjectConfig(dir)!.apiPort).toBe(4099);
  });
});
