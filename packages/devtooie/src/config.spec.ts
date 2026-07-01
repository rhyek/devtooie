import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { defineAppConfigs } from './config.js';

describe('defineAppConfigs path resolution', () => {
  it('defaults relativeDir to projects/<name> and resolves path against cwd', () => {
    const [app] = defineAppConfigs({ apps: [{ name: 'svc', types: ['backend'] }] });
    expect(app!.relativeDir).toBe('projects/svc');
    expect(app!.path).toBe(path.resolve(process.cwd(), 'projects/svc'));
  });

  it('honors explicit relativeDir and workspaceDir', () => {
    const [app] = defineAppConfigs({
      workspaceDir: '/repo',
      apps: [{ name: 'svc', relativeDir: 'apps/svc', types: [] }],
    });
    expect(app!.path).toBe(path.resolve('/repo', 'apps/svc'));
  });
});
