import { describe, expect, test } from 'vitest';
import { stackEnvironment } from './stack.js';

describe('stackEnvironment', () => {
  const shell = { PATH: '/usr/bin', HOME: '/home/dev', PNPM_HOME: '/home/dev/.pnpm' };

  test('drops what a package manager script adds, and keeps the shell', () => {
    const env = stackEnvironment({
      ...shell,
      INIT_CWD: '/ws',
      NODE: '/usr/bin/node',
      NODE_PATH: '/ws/node_modules/.pnpm/node_modules',
      PNPM_SCRIPT_SRC_DIR: '/ws',
      npm_lifecycle_event: 'test:e2e',
      npm_package_name: 'app',
    });
    expect(env).toEqual(shell);
  });

  test("drops Vitest's and Vite's variables under Vitest", () => {
    const env = stackEnvironment({
      ...shell,
      VITEST: 'true',
      VITEST_POOL_ID: '1',
      NODE_ENV: 'test',
      MODE: 'test',
      DEV: '1',
      PROD: '',
      SSR: '',
      BASE_URL: '/',
      TEST: 'true',
    });
    expect(env).toEqual(shell);
  });

  test("drops Jest's variables under Jest", () => {
    expect(stackEnvironment({ ...shell, JEST_WORKER_ID: '1', NODE_ENV: 'test' })).toEqual(shell);
  });

  test("keeps a shell's NODE_ENV and MODE outside a test runner", () => {
    const env = { ...shell, NODE_ENV: 'development', MODE: 'x' };
    expect(stackEnvironment(env)).toEqual(env);
  });
});
