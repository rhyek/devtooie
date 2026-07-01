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

describe('token substitution', () => {
  it('substitutes intrinsic :name, :port, :subdomain', () => {
    const [app] = defineAppConfigs({
      apps: [
        {
          name: 'core',
          types: ['backend'],
          run: {
            port: 3001,
            subdomain: ['core', 'core-bg'],
            healthcheck: 'http://localhost::port/health',
            urls: ['https://:subdomain.local/:name'],
          },
        },
      ],
    });
    expect(app!.run!.healthcheck).toBe('http://localhost:3001/health');
    expect(app!.run!.urls![0]).toBe('https://core.local/core');
  });

  it('substitutes extrinsic tokens from opts.tokens (string and object urls)', () => {
    const [app] = defineAppConfigs({
      tokens: { domain: 'example.com', proxyport: '8443' },
      apps: [
        {
          name: 'web',
          types: ['browser'],
          run: { urls: [{ label: 'home', url: 'https://app.:domain::proxyport' }] },
        },
      ],
    });
    const url = app!.run!.urls![0];
    expect(typeof url === 'object' && url.url).toBe('https://app.example.com:8443');
  });
});

describe('validation', () => {
  it('throws when waitFor targets an app without a healthcheck', () => {
    expect(() =>
      defineAppConfigs({
        apps: [
          { name: 'a', types: ['backend'], run: { waitFor: ['b'] } },
          { name: 'b', types: ['backend'], run: {} },
        ],
      }),
    ).toThrow(/waitFor "b".*no healthcheck/);
  });

  it('throws when waitFor targets a missing app', () => {
    expect(() =>
      defineAppConfigs({
        apps: [{ name: 'a', types: ['backend'], run: { waitFor: ['ghost' as any] } }],
      }),
    ).toThrow(/waitFor "ghost"/);
  });

  it('throws when a url uses an unknown extrinsic token', () => {
    expect(() =>
      defineAppConfigs({
        apps: [{ name: 'a', types: ['browser'], run: { urls: ['https://:domain'] } }],
      }),
    ).toThrow(/:domain/);
  });
});
