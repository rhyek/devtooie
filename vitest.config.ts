import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.spec.ts'],
    // Restore all spies/mocks to their originals after each test, so a spy left
    // unrestored in one test can't leak into later tests.
    restoreMocks: true,
  },
});
