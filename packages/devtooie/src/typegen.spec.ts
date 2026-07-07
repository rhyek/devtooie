import { describe, it, expect } from 'vitest';
import { computeAugmentation } from './typegen.js';

describe('computeAugmentation', () => {
  it('computes a ./relative import with the extension stripped', () => {
    const out = computeAugmentation('/repo/devtooie-env.d.ts', '/repo/services.ts');
    expect(out).toContain("typeof import('./services').default");
    expect(out).toContain("declare module 'devtooie'");
    // Must be a module (top-level export) so `declare module` augments rather than shadows.
    expect(out).toContain('export {};');
  });

  it('handles nested services paths', () => {
    const out = computeAugmentation('/repo/devtooie-env.d.ts', '/repo/config/services.ts');
    expect(out).toContain("import('./config/services').default");
  });
});
