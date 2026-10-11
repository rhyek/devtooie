import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

/**
 * End-to-end: the real CLI, as a child process, against a workspace on disk — the paths that have
 * no seam to test in-process (`devtooie run`, `devtooie exec`, `--build`, `--rebuild`).
 *
 * The CLI is compiled from the current source in `beforeAll` rather than taken from `dist/`, so
 * the spec never runs against a stale build. It is emitted under the package's own
 * `node_modules`: its imports then resolve the package's dependencies, and the output stays out
 * of git and eslint. The workspace reaches that same build as `devtooie` through a stand-in
 * package directory, so its config registers with the module instance the CLI runs.
 */
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(packageDir, 'node_modules', '.cache', 'cli-spec');
const cli = path.join(buildDir, 'cli.js');

let ws: string;
let app: string;
let order: string;

const script = (js: string) => `node -e "${js}"`;
const append = (text: string) =>
  script(`require('fs').appendFileSync('../../order.log','${text} ')`);

/** An executable in `<dir>/node_modules/.bin` that prints `<name>-OK`. */
function fakeBin(dir: string, name: string): void {
  const bin = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho ${name}-OK\n`, { mode: 0o755 });
}

function writePackage(name: string, scripts: Record<string, string>): string {
  const dir = path.join(ws, 'packages', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '2.0.0', scripts }),
  );
  return dir;
}

/** Runs the CLI in `cwd` (the workspace root unless given) and resolves with how it ended. */
function devtooie(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  return execa('node', [cli, ...args], {
    cwd: opts.cwd ?? ws,
    env: opts.env,
    reject: false,
  });
}

const lastLine = (text: string) => text.trim().split('\n').at(-1)!;

beforeAll(async () => {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  fs.rmSync(buildDir, { recursive: true, force: true });
  await execa(
    'node',
    [tsc, '-p', path.join(packageDir, 'tsconfig.build.json'), '--outDir', buildDir],
    { cwd: packageDir },
  );

  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-cli-')));
  order = path.join(ws, 'order.log');
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'wsroot', type: 'module' })); // prettier-ignore
  fs.writeFileSync(path.join(ws, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  fs.writeFileSync(
    path.join(ws, 'devtooie.config.ts'),
    [
      "import { defineConfig } from 'devtooie';",
      'export default defineConfig({',
      "  packageRootDir: 'packages',",
      '  env: {',
      '    vars: ({ envs }) => ({',
      '      ROOT_DIR: envs.DEVTOOIE_WORKSPACE_DIR,',
      "      APP_PINNED: 'from-config',",
      "      SHELL_SET: 'from-config',",
      "      PINNED_DIR: '/from/config',",
      '    }),',
      "    override: ['PINNED_DIR', 'APPENDED'],",
      '  },',
      '  packages: {',
      '    lib: {},',
      '    envbuild: {},',
      "    app: { deps: { build: ['lib'] } },",
      '    broken: {},',
      '    killed: {},',
      '  },',
      '});',
      '',
    ].join('\n'),
  );

  const standIn = path.join(ws, 'node_modules', 'devtooie');
  fs.mkdirSync(standIn, { recursive: true });
  fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
  fs.symlinkSync(buildDir, path.join(standIn, 'dist'));

  fakeBin(ws, 'rootbin');
  writePackage('lib', { dev: 'true', build: `rootbin && ${append('lib')}` });
  app = writePackage('app', {
    dev: 'true',
    build: `localbin && ${append('app')}`,
    'build:clean': append('app-clean'),
    argv: `${script('console.log(JSON.stringify(process.argv.slice(1)))')} x`,
    fail: 'exit 7',
    kill: script("process.kill(process.pid,'SIGKILL')"),
    cwd: script('console.log(process.cwd())'),
    env: script('console.log(process.env.APP_VAR)'),
    rootdir: script('console.log(process.env.ROOT_DIR)'),
    appended: script('console.log(process.env.APPENDED)'),
    whoami: script(
      "console.log(process.env.npm_package_name+' '+process.env.npm_package_version+' '+process.env.npm_lifecycle_event)",
    ),
    bins: 'localbin && rootbin',
    prehook: 'echo PRE',
    hook: 'echo MAIN',
    posthook: 'echo POST',
  });
  fakeBin(app, 'localbin');
  // A project reference with a comment and a trailing comma, as tsconfig files have them.
  fs.writeFileSync(
    path.join(app, 'tsconfig.json'),
    '{\n  // lib is built first\n  "references": [{ "path": "../lib" },],\n}\n',
  );
  fs.writeFileSync(
    path.join(app, '.env.development'),
    'APP_VAR=from-app-env-file\nAPP_PINNED=from-app-env-file\nAPP_DATA=${DEVTOOIE_WORKSPACE_DIR}/data\nAPP_ROOT_REF=${ROOT_DIR}/ref\n',
  );
  fs.writeFileSync(
    path.join(ws, '.env.development'),
    'DERIVED_DIR=$PINNED_DIR/storage\nAPPENDED="$APPENDED --flag"\n',
  );
  writePackage('envbuild', {
    dev: 'true',
    build: script(
      "require('fs').appendFileSync('../../order.log',process.env.ROOT_DIR+'|'+process.env.DERIVED_DIR)",
    ),
  });
  writePackage('broken', { dev: 'true', build: 'exit 3' });
  writePackage('killed', { dev: 'true', build: script("process.kill(process.pid,'SIGKILL')") });
}, 120_000);

afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(buildDir, { recursive: true, force: true });
});

describe('devtooie run', () => {
  test('forwards the operands to the script, intact', async () => {
    const args = ['a b', '--c=$HOME', "it's", '*'];
    const result = await devtooie(['run', '-p', 'app', 'argv', '--', ...args]);
    expect(JSON.parse(lastLine(result.stdout))).toEqual(['x', ...args]);
    expect(result.exitCode).toBe(0);
  });

  test("exits with the script's exit code", async () => {
    expect((await devtooie(['run', '-p', 'app', 'fail'])).exitCode).toBe(7);
  });

  test('exits with 128 + the signal number when a signal kills the script', async () => {
    expect((await devtooie(['run', '-p', 'app', 'kill'])).exitCode).toBe(137);
  });

  test("gives the script the package's .env values", async () => {
    const result = await devtooie(['run', '-p', 'app', 'env']);
    expect(lastLine(result.stdout)).toBe('from-app-env-file');
  });

  test('runs the script in the package directory, wherever it was invoked from', async () => {
    const result = await devtooie(['run', '-p', 'app', 'cwd']);
    expect(lastLine(result.stdout)).toBe(app);
  });

  test('infers the package from the directory it is invoked in', async () => {
    const result = await devtooie(['run', 'cwd'], { cwd: app });
    expect(lastLine(result.stdout)).toBe(app);
  });

  test("resolves binaries from the package's and the workspace root's node_modules/.bin", async () => {
    const result = await devtooie(['run', '-p', 'app', 'bins']);
    expect(result.stdout.trim().split('\n').slice(-2)).toEqual(['localbin-OK', 'rootbin-OK']);
  });

  test('tells the script which package and script it is', async () => {
    const result = await devtooie(['run', '-p', 'app', 'whoami'], {
      // What `pnpm devtooie` at the workspace root would have left in the environment.
      env: { npm_package_name: 'wsroot', npm_package_version: '0.0.1', npm_lifecycle_event: 'x' },
    });
    expect(lastLine(result.stdout)).toBe('app 2.0.0 whoami');
  });

  test("prints nothing but the script's own output", async () => {
    const result = await devtooie(['run', '-p', 'app', 'hook']);
    expect(result.stdout).toBe('MAIN');
    expect(result.stderr).toBe('');
  });

  test('does not run pre<name> and post<name> scripts', async () => {
    const result = await devtooie(['run', '-p', 'app', 'hook']);
    expect(lastLine(result.stdout)).toBe('MAIN');
    expect(result.stdout).not.toContain('PRE');
    expect(result.stdout).not.toContain('POST');
  });

  test("ignores a package manager's script-shell setting", async () => {
    const result = await devtooie(['run', '-p', 'app', 'hook'], {
      env: {
        npm_config_script_shell: '/usr/bin/false',
        pnpm_config_script_shell: '/usr/bin/false',
      },
    });
    expect(lastLine(result.stdout)).toBe('MAIN');
    expect(result.exitCode).toBe(0);
  });

  test('refuses a script the package does not have', async () => {
    const result = await devtooie(['run', '-p', 'app', 'nope']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`No "nope" script or make target found in ${app}.`);
  });

  test('fails when no script is named', async () => {
    const result = await devtooie(['run', '-p', 'app']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("missing required argument 'script'");
  });
});

describe('devtooie exec', () => {
  const PRINT = ['sh', '-c', 'pwd; echo $APP_VAR'];

  test('runs a literal command in the package directory, with its .env values', async () => {
    const result = await devtooie(['exec', '-p', 'app', '--', ...PRINT]);
    expect(result.stdout).toBe(`${app}\nfrom-app-env-file`);
    expect(result.exitCode).toBe(0);
  });

  test('infers the package from the directory it is invoked in', async () => {
    const result = await devtooie(['exec', '--', ...PRINT], { cwd: app });
    expect(result.stdout).toBe(`${app}\nfrom-app-env-file`);
  });

  test("exits with the command's exit code", async () => {
    expect((await devtooie(['exec', '-p', 'app', '--', 'sh', '-c', 'exit 5'])).exitCode).toBe(5);
  });

  test('fails when no command is given', async () => {
    const result = await devtooie(['exec', '-p', 'app']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('exec requires a command (after `--`).');
  });

  test('does not take a script name: -c is not an option', async () => {
    const result = await devtooie(['exec', '-p', 'app', '-c', 'hook']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('MAIN');
  });
});

describe('environment variables', () => {
  const print = (...names: string[]) => ['sh', '-c', names.map((n) => `echo "$${n}"`).join('; ')];

  test('tells a command where devtooie was invoked and where the workspace root is', async () => {
    const result = await devtooie(
      ['exec', '--', ...print('DEVTOOIE_CWD', 'DEVTOOIE_WORKSPACE_DIR')],
      { cwd: app },
    );
    expect(result.stdout).toBe(`${app}\n${ws}`);
  });

  test('replaces a DEVTOOIE_CWD inherited from whatever started devtooie', async () => {
    const result = await devtooie(['exec', '--', ...print('DEVTOOIE_CWD')], {
      cwd: app,
      env: { DEVTOOIE_CWD: '/somewhere/else', DEVTOOIE_WORKSPACE_DIR: '/somewhere/else' },
    });
    expect(result.stdout).toBe(app);
  });

  test('expands a reference to the workspace root in a .env file', async () => {
    const result = await devtooie(['exec', '-p', 'app', '--', ...print('APP_DATA')]);
    expect(result.stdout).toBe(`${ws}/data`);
  });

  test("gives a package's command the config's own vars, under its .env file", async () => {
    const result = await devtooie(['exec', '-p', 'app', '--', ...print('ROOT_DIR', 'APP_PINNED')]);
    expect(result.stdout).toBe(`${ws}\nfrom-app-env-file`);
  });

  test("lets the shell win over one of the config's own vars", async () => {
    const args = ['exec', '-p', 'app', '--', ...print('SHELL_SET')];
    expect((await devtooie(args)).stdout).toBe('from-config');
    expect((await devtooie(args, { env: { SHELL_SET: 'from-shell' } })).stdout).toBe('from-shell');
  });

  test("expands a .env file's reference to one of the config's own vars", async () => {
    const result = await devtooie(['exec', '-p', 'app', '--', ...print('APP_ROOT_REF')]);
    expect(result.stdout).toBe(`${ws}/ref`);
  });

  test("gives a package's script the config's own vars", async () => {
    const result = await devtooie(['run', '-p', 'app', 'rootdir']);
    expect(lastLine(result.stdout)).toBe(ws);
  });

  test("gives a command run outside every package the config's own vars", async () => {
    const result = await devtooie(['exec', '--', ...print('ROOT_DIR', 'APP_PINNED')]);
    expect(result.stdout).toBe(`${ws}\nfrom-config`);
  });

  test("gives a build script the config's own vars", async () => {
    fs.writeFileSync(order, '');
    const result = await devtooie(['--build', '-p', 'envbuild']);
    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(order, 'utf8')).toBe(`${ws}|/from/config/storage`);
  });

  describe('with the shell exporting a variable env.override names', () => {
    const env = { PINNED_DIR: '/from/shell' };
    const PRINT = print('PINNED_DIR', 'DERIVED_DIR');
    const expected = '/from/config\n/from/config/storage';

    test("gives a package's command the config's value, and a .env reference to it the same", async () => {
      const result = await devtooie(['exec', '-p', 'app', '--', ...PRINT], { env });
      expect(result.stdout).toBe(expected);
    });

    test('does the same for a command run outside every package', async () => {
      expect((await devtooie(['exec', '--', ...PRINT], { env })).stdout).toBe(expected);
    });

    test('extends a variable the shell exports exactly once, for a command and a script', async () => {
      const shell = { APPENDED: '--base' };
      const command = await devtooie(['exec', '-p', 'app', '--', ...print('APPENDED')], {
        env: shell,
      });
      expect(command.stdout).toBe('--base --flag');
      const scripted = await devtooie(['run', '-p', 'app', 'appended'], { env: shell });
      expect(lastLine(scripted.stdout)).toBe('--base --flag');
    });

    test('does the same for a build script', async () => {
      fs.writeFileSync(order, '');
      const result = await devtooie(['--build', '-p', 'envbuild'], { env });
      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(order, 'utf8')).toBe(`${ws}|/from/config/storage`);
    });
  });
});

describe('devtooie cmd', () => {
  test('is not a subcommand', async () => {
    const result = await devtooie(['cmd', '-p', 'app', '--', 'echo', 'MAIN']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('MAIN');
  });
});

describe('devtooie --build', () => {
  beforeEach(() => {
    fs.writeFileSync(order, '');
  });

  test('builds a build dependency before the package that needs it', async () => {
    const result = await devtooie(['--build', '-p', 'app']);
    expect(fs.readFileSync(order, 'utf8')).toBe('lib app ');
    expect(result.stdout).toContain('build complete');
    expect(result.exitCode).toBe(0);
  });

  test("a build script resolves binaries from the package's and the workspace root's node_modules/.bin", async () => {
    const result = await devtooie(['--build', '-p', 'app']);
    expect(result.stdout).toContain('rootbin-OK');
    expect(result.stdout).toContain('localbin-OK');
  });

  test('--rebuild runs build:clean for the selected package', async () => {
    const result = await devtooie(['--rebuild', '-p', 'app']);
    expect(fs.readFileSync(order, 'utf8')).toBe('lib app-clean ');
    expect(result.exitCode).toBe(0);
  });

  test('a build script that fails fails the command', async () => {
    const result = await devtooie(['--build', '-p', 'broken']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('build complete');
  });

  test('a build script killed by a signal fails the command', async () => {
    const result = await devtooie(['--build', '-p', 'killed']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('build complete');
  });
});
