import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execa } from 'execa';
import { describe, test, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';

/**
 * End-to-end: the real CLI, as a child process, against a workspace on disk — the paths that have
 * no seam to test in-process (`devtooie run`, `devtooie exec`, `--build`, `--rebuild`).
 *
 * The CLI is compiled from the current source in `beforeAll` rather than taken from `dist/`, so
 * the spec never runs against a stale build. It is emitted under the package's own
 * `node_modules`: its imports then resolve the package's dependencies, and the output stays out
 * of git and the linter. The workspace reaches that same build as `devtooie` through a stand-in
 * package directory, so its config registers with the module instance the CLI runs.
 */
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(packageDir, 'node_modules', '.cache', 'cli-spec');
const cli = path.join(buildDir, 'cli.js');

let ws: string;
let app: string;
let order: string;
let traceHook: string;

/**
 * A preload that records every module the process loads and writes the URLs to `$TRACE_OUT` as
 * it exits — how the specs below check that a command loads only what it runs.
 */
const TRACE_HOOK = `
import { registerHooks } from 'node:module';
import fs from 'node:fs';
const urls = [];
registerHooks({
  load(url, context, nextLoad) {
    urls.push(url);
    return nextLoad(url, context);
  },
});
process.on('exit', () => fs.writeFileSync(process.env.TRACE_OUT, JSON.stringify(urls)));
`;

/** What a traced run loaded: the third-party packages by name, and whether the config ran. */
function readTrace(file: string): { packages: Set<string>; evaluatedConfig: boolean } {
  const urls = JSON.parse(fs.readFileSync(file, 'utf8')) as string[];
  const packages = new Set<string>();
  for (const url of urls) {
    const name = /.*\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(url)?.[1];
    if (name !== undefined && name !== 'devtooie') {
      packages.add(name);
    }
  }
  return { packages, evaluatedConfig: urls.some((url) => url.endsWith('/devtooie.config.ts')) };
}

let traces = 0;
const nextTraceFile = () => path.join(ws, `trace-${String(traces++)}.json`);

/** Runs the CLI to its exit like {@link devtooie}, also resolving with what it loaded. */
async function traced(args: string[], opts: { cwd?: string } = {}) {
  const out = nextTraceFile();
  const result = await execa('node', ['--import', traceHook, cli, ...args], {
    cwd: opts.cwd ?? ws,
    env: { TRACE_OUT: out },
    reject: false,
  });
  return { result, ...readTrace(out) };
}

/**
 * Starts a `--headless` session, stops it once `until` has been printed (a package having started,
 * unless told otherwise), and resolves with its output and what it loaded.
 */
async function tracedPlainSession(names: string[], until = '] started') {
  const out = nextTraceFile();
  const child = execa(
    'node',
    ['--import', traceHook, cli, '--headless', ...names.flatMap((name) => ['-s', name])],
    { cwd: ws, env: { TRACE_OUT: out }, reject: false },
  );
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const giveUp = setTimeout(
      () => reject(new Error(`never printed ${until}:\n${output}`)),
      20_000,
    );
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(until)) {
        clearTimeout(giveUp);
        resolve();
      }
    });
  });
  child.kill('SIGINT');
  const result = await child;
  if (!fs.existsSync(out)) {
    throw new Error(
      `the session wrote no trace (exit ${String(result.exitCode)}, signal ${String(result.signal)}):\n${output}\n${String(result.stderr)}`,
    );
  }
  return { output, ...readTrace(out) };
}

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
  // TypeScript 7 exports no `bin/tsc`, so it's found next to the package.json it does export.
  const tsPackage = createRequire(import.meta.url).resolve('typescript/package.json');
  const tsc = path.join(path.dirname(tsPackage), 'bin', 'tsc');
  fs.rmSync(buildDir, { recursive: true, force: true });
  await execa(
    'node',
    [tsc, '-p', path.join(packageDir, 'tsconfig.build.json'), '--outDir', buildDir],
    { cwd: packageDir },
  );

  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-cli-')));
  order = path.join(ws, 'order.log');
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'wsroot', type: 'module' })); // oxfmt-ignore
  fs.writeFileSync(path.join(ws, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  fs.writeFileSync(
    path.join(ws, 'devtooie.config.ts'),
    [
      "import { defineConfig } from 'devtooie';",
      'export default defineConfig({',
      "  serviceRootDir: 'packages',",
      '  env: {',
      '    vars: ({ envs }) => ({',
      '      ROOT_DIR: envs.DEVTOOIE_WORKSPACE_DIR,',
      "      APP_PINNED: 'from-config',",
      "      SHELL_SET: 'from-config',",
      "      PINNED_DIR: '/from/config',",
      '    }),',
      "    override: ['PINNED_DIR', 'APPENDED'],",
      '  },',
      '  services: {',
      '    lib: {},',
      '    envbuild: {},',
      '    wide: {},',
      "    app: { deps: { build: ['lib'] } },",
      '    broken: {},',
      '    killed: {},',
      '    idle: {},',
      '    portonly: { port: 21051 },',
      '  },',
      '});',
      '',
    ].join('\n'),
  );

  const standIn = path.join(ws, 'node_modules', 'devtooie');
  fs.mkdirSync(standIn, { recursive: true });
  fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
  fs.symlinkSync(buildDir, path.join(standIn, 'dist'));

  traceHook = path.join(ws, 'trace-hook.mjs');
  fs.writeFileSync(traceHook, TRACE_HOOK);

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
    // A devtooie started from inside one: the script runs `devtooie exec` for `wide`.
    nested: `node "$NESTED_CLI" exec -s wide -- ${script("console.log(String(process.env.APP_VAR)+'|'+String(process.env.FROM_SHELL))")}`,
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
  // Prints a line wider than any terminal and one with glyphs that are not one column each.
  writePackage('wide', {
    dev: script(
      "console.log('x'.repeat(150));console.log('glyphs \\u2713 \\u4e2d\\u6587 done');setInterval(()=>{},1e9)",
    ),
  });
  writePackage('killed', { dev: 'true', build: script("process.kill(process.pid,'SIGKILL')") });
  writePackage('idle', { dev: script('setInterval(()=>{},1e9)') });
  // A port, and no process: an origin to report.
  writePackage('portonly', {});
}, 120_000);

afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(buildDir, { recursive: true, force: true });
});

describe('devtooie run', () => {
  test('forwards the operands to the script, intact', async () => {
    const args = ['a b', '--c=$HOME', "it's", '*'];
    const result = await devtooie(['run', '-s', 'app', 'argv', '--', ...args]);
    expect(JSON.parse(lastLine(result.stdout))).toEqual(['x', ...args]);
    expect(result.exitCode).toBe(0);
  });

  test("exits with the script's exit code", async () => {
    expect((await devtooie(['run', '-s', 'app', 'fail'])).exitCode).toBe(7);
  });

  test('exits with 128 + the signal number when a signal kills the script', async () => {
    expect((await devtooie(['run', '-s', 'app', 'kill'])).exitCode).toBe(137);
  });

  test("gives the script the package's .env values", async () => {
    const result = await devtooie(['run', '-s', 'app', 'env']);
    expect(lastLine(result.stdout)).toBe('from-app-env-file');
  });

  test('runs the script in the package directory, wherever it was invoked from', async () => {
    const result = await devtooie(['run', '-s', 'app', 'cwd']);
    expect(lastLine(result.stdout)).toBe(app);
  });

  test('infers the package from the directory it is invoked in', async () => {
    const result = await devtooie(['run', 'cwd'], { cwd: app });
    expect(lastLine(result.stdout)).toBe(app);
  });

  test("resolves binaries from the package's and the workspace root's node_modules/.bin", async () => {
    const result = await devtooie(['run', '-s', 'app', 'bins']);
    expect(result.stdout.trim().split('\n').slice(-2)).toEqual(['localbin-OK', 'rootbin-OK']);
  });

  test('tells the script which package and script it is', async () => {
    const result = await devtooie(['run', '-s', 'app', 'whoami'], {
      // What `pnpm devtooie` at the workspace root would have left in the environment.
      env: { npm_package_name: 'wsroot', npm_package_version: '0.0.1', npm_lifecycle_event: 'x' },
    });
    expect(lastLine(result.stdout)).toBe('app 2.0.0 whoami');
  });

  test("prints nothing but the script's own output", async () => {
    const result = await devtooie(['run', '-s', 'app', 'hook']);
    expect(result.stdout).toBe('MAIN');
    expect(result.stderr).toBe('');
  });

  test('does not run pre<name> and post<name> scripts', async () => {
    const result = await devtooie(['run', '-s', 'app', 'hook']);
    expect(lastLine(result.stdout)).toBe('MAIN');
    expect(result.stdout).not.toContain('PRE');
    expect(result.stdout).not.toContain('POST');
  });

  test("ignores a package manager's script-shell setting", async () => {
    const result = await devtooie(['run', '-s', 'app', 'hook'], {
      env: {
        npm_config_script_shell: '/usr/bin/false',
        pnpm_config_script_shell: '/usr/bin/false',
      },
    });
    expect(lastLine(result.stdout)).toBe('MAIN');
    expect(result.exitCode).toBe(0);
  });

  test('refuses a script the package does not have', async () => {
    const result = await devtooie(['run', '-s', 'app', 'nope']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`No "nope" script or make target found in ${app}.`);
  });

  test('fails when no script is named', async () => {
    const result = await devtooie(['run', '-s', 'app']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("missing required argument 'script'");
  });
});

describe('devtooie exec', () => {
  const PRINT = ['sh', '-c', 'pwd; echo $APP_VAR'];

  test('runs a literal command in the package directory, with its .env values', async () => {
    const result = await devtooie(['exec', '-s', 'app', '--', ...PRINT]);
    expect(result.stdout).toBe(`${app}\nfrom-app-env-file`);
    expect(result.exitCode).toBe(0);
  });

  test('infers the package from the directory it is invoked in', async () => {
    const result = await devtooie(['exec', '--', ...PRINT], { cwd: app });
    expect(result.stdout).toBe(`${app}\nfrom-app-env-file`);
  });

  test("exits with the command's exit code", async () => {
    expect((await devtooie(['exec', '-s', 'app', '--', 'sh', '-c', 'exit 5'])).exitCode).toBe(5);
  });

  test('fails when no command is given', async () => {
    const result = await devtooie(['exec', '-s', 'app']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('exec requires a command (after `--`).');
  });

  test('does not take a script name: -c is not an option', async () => {
    const result = await devtooie(['exec', '-s', 'app', '-c', 'hook']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('MAIN');
  });
});

describe('environment variables', () => {
  test('a devtooie started by a devtooie child drops what the outer one added, not the shell', async () => {
    const result = await devtooie(['run', '-s', 'app', 'nested'], {
      env: { NESTED_CLI: cli, FROM_SHELL: 'shell' },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    // APP_VAR came from app's .env file through the outer run: the inner exec, for `wide`, which
    // has no .env file of its own, doesn't see it. FROM_SHELL came from the shell, and survives.
    expect(lastLine(result.stdout)).toBe('undefined|shell');
  });

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
    const result = await devtooie(['exec', '-s', 'app', '--', ...print('APP_DATA')]);
    expect(result.stdout).toBe(`${ws}/data`);
  });

  test("gives a package's command the config's own vars, under its .env file", async () => {
    const result = await devtooie(['exec', '-s', 'app', '--', ...print('ROOT_DIR', 'APP_PINNED')]);
    expect(result.stdout).toBe(`${ws}\nfrom-app-env-file`);
  });

  test("lets the shell win over one of the config's own vars", async () => {
    const args = ['exec', '-s', 'app', '--', ...print('SHELL_SET')];
    expect((await devtooie(args)).stdout).toBe('from-config');
    expect((await devtooie(args, { env: { SHELL_SET: 'from-shell' } })).stdout).toBe('from-shell');
  });

  test("expands a .env file's reference to one of the config's own vars", async () => {
    const result = await devtooie(['exec', '-s', 'app', '--', ...print('APP_ROOT_REF')]);
    expect(result.stdout).toBe(`${ws}/ref`);
  });

  test("gives a package's script the config's own vars", async () => {
    const result = await devtooie(['run', '-s', 'app', 'rootdir']);
    expect(lastLine(result.stdout)).toBe(ws);
  });

  test("gives a command run outside every package the config's own vars", async () => {
    const result = await devtooie(['exec', '--', ...print('ROOT_DIR', 'APP_PINNED')]);
    expect(result.stdout).toBe(`${ws}\nfrom-config`);
  });

  test("gives a build script the config's own vars", async () => {
    fs.writeFileSync(order, '');
    const result = await devtooie(['--build', '-s', 'envbuild']);
    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(order, 'utf8')).toBe(`${ws}|/from/config/storage`);
  });

  describe('with the shell exporting a variable env.override names', () => {
    const env = { PINNED_DIR: '/from/shell' };
    const PRINT = print('PINNED_DIR', 'DERIVED_DIR');
    const expected = '/from/config\n/from/config/storage';

    test("gives a package's command the config's value, and a .env reference to it the same", async () => {
      const result = await devtooie(['exec', '-s', 'app', '--', ...PRINT], { env });
      expect(result.stdout).toBe(expected);
    });

    test('does the same for a command run outside every package', async () => {
      expect((await devtooie(['exec', '--', ...PRINT], { env })).stdout).toBe(expected);
    });

    test('extends a variable the shell exports exactly once, for a command and a script', async () => {
      const shell = { APPENDED: '--base' };
      const command = await devtooie(['exec', '-s', 'app', '--', ...print('APPENDED')], {
        env: shell,
      });
      expect(command.stdout).toBe('--base --flag');
      const scripted = await devtooie(['run', '-s', 'app', 'appended'], { env: shell });
      expect(lastLine(scripted.stdout)).toBe('--base --flag');
    });

    test('does the same for a build script', async () => {
      fs.writeFileSync(order, '');
      const result = await devtooie(['--build', '-s', 'envbuild'], { env });
      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(order, 'utf8')).toBe(`${ws}|/from/config/storage`);
    });
  });
});

describe('devtooie cmd', () => {
  test('is not a subcommand', async () => {
    const result = await devtooie(['cmd', '-s', 'app', '--', 'echo', 'MAIN']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('MAIN');
  });
});

describe('devtooie --build', () => {
  beforeEach(() => {
    fs.writeFileSync(order, '');
  });

  test('builds a build dependency before the package that needs it', async () => {
    const result = await devtooie(['--build', '-s', 'app']);
    expect(fs.readFileSync(order, 'utf8')).toBe('lib app ');
    expect(result.stdout).toContain('build complete');
    expect(result.exitCode).toBe(0);
  });

  test("a build script resolves binaries from the package's and the workspace root's node_modules/.bin", async () => {
    const result = await devtooie(['--build', '-s', 'app']);
    expect(result.stdout).toContain('rootbin-OK');
    expect(result.stdout).toContain('localbin-OK');
  });

  test('--rebuild runs build:clean for the selected package', async () => {
    const result = await devtooie(['--rebuild', '-s', 'app']);
    expect(fs.readFileSync(order, 'utf8')).toBe('lib app-clean ');
    expect(result.exitCode).toBe(0);
  });

  test('a build script that fails fails the command', async () => {
    const result = await devtooie(['--build', '-s', 'broken']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('build complete');
  });

  test('a build script killed by a signal fails the command', async () => {
    const result = await devtooie(['--build', '-s', 'killed']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('build complete');
  });
});

describe('devtooie --headless --detach', () => {
  /** Sessions a test started, quit after it whatever happened. */
  const started: { pid: number; port: number }[] = [];
  afterEach(async () => {
    for (const { pid, port } of started.splice(0)) {
      await fetch(`http://127.0.0.1:${String(port)}/command/quit`, { method: 'POST' }).catch(
        () => {},
      );
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    // The record outlives its session, and would point `logs` at this session's directory.
    fs.rmSync(path.join(ws, 'node_modules', '.devtooie', 'running.development.json'), {
      force: true,
    });
  });

  const detach = async (args: string[]) => {
    // Its own log directory: the logfiles here would otherwise be the newest the `logs` tests find.
    const logDir = path.join(ws, 'detach-logs');
    const result = await devtooie(['--headless', '--detach', '--log-dir', logDir, ...args], {
      env: { CI: '1' },
    });
    const report = JSON.parse(lastLine(result.stdout)) as {
      ok: boolean;
      session: string;
      pid: number;
      port: number;
      services: string[];
      logFile: string | null;
    };
    if (report.session === 'started') {
      started.push({ pid: report.pid, port: report.port });
    }
    return { result, report };
  };

  test('starts a session in the background, then reuses it, starting what it lacks', async () => {
    const first = await detach(['-s', 'wide', '--wait']);
    expect(first.result.exitCode, first.result.stderr).toBe(0);
    expect(first.report).toMatchObject({ ok: true, session: 'started', services: ['wide'] });
    expect(first.report.logFile).toMatch(/\.log$/);
    // The command returned, and the session it started runs on.
    expect(() => process.kill(first.report.pid, 0)).not.toThrow();

    const again = await detach(['-s', 'wide', '--wait']);
    expect(again.report).toMatchObject({ ok: true, session: 'reused', pid: first.report.pid, services: [] }); // oxfmt-ignore

    const more = await detach(['-s', 'idle', '--wait']);
    expect(more.report).toMatchObject({ ok: true, session: 'reused', services: ['idle'] });
    const status = (await (
      await fetch(`http://127.0.0.1:${String(first.report.port)}/query/status`)
    ).json()) as { services: Record<string, string>; ready: Record<string, boolean> };
    expect(status.ready).toMatchObject({ wide: true, idle: true });
  }, 120_000);

  describe('startStack()', () => {
    type StackModule = typeof import('./stack.js');
    /** The compiled module, so the CLI it runs is the one compiled beside it. */
    const load = () => import(pathToFileURL(path.join(buildDir, 'stack.js')).href) as Promise<StackModule>; // oxfmt-ignore
    const startStack = async (services: string[]) => {
      const { startStack, stackEnvironment } = await load();
      try {
        const stack = await startStack({
          services,
          cwd: app,
          logDir: path.join(ws, 'detach-logs'),
          env: stackEnvironment({ ...process.env, CI: '1' }),
        });
        if (stack.session === 'started') {
          started.push({ pid: stack.pid, port: stack.port });
        }
        return stack;
      } catch (error) {
        // A failed start quits its session; its record would still point `logs` here.
        fs.rmSync(path.join(ws, 'node_modules', '.devtooie', 'running.development.json'), {
          force: true,
        });
        throw error;
      }
    };

    test('starts a stack, reuses it, and stops only the one it started', async () => {
      const first = await startStack(['wide']);
      expect(first).toMatchObject({ session: 'started', mode: 'development', rootDomain: null, services: ['wide'] }); // oxfmt-ignore
      // Every configured service's origin, selected or not.
      expect(first.origins).toEqual({ portonly: 'http://localhost:21051' });
      expect((await first.control.query.status())?.ready).toMatchObject({ wide: true });

      const again = await startStack(['idle']);
      expect(again).toMatchObject({ session: 'reused', pid: first.pid, port: first.port, services: ['idle'] }); // oxfmt-ignore
      expect((await again.control.query.status())?.ready).toMatchObject({ wide: true, idle: true });
      await again.stop();
      expect(await first.control.query.status()).not.toBeNull();

      await first.stop();
      expect(await first.control.query.status()).toBeNull();
    }, 120_000);

    test("throws devtooie's error, after quitting the session it started", async () => {
      await expect(startStack(['broken'])).rejects.toThrow(
        /stopped while starting.*\(log: .*\.log\)/,
      );
      // Nothing was left running: the next call starts a session of its own.
      expect((await startStack(['idle'])).session).toBe('started');
    }, 120_000);

    test('throws what devtooie printed when it gave no answer', async () => {
      await expect(startStack(['nope'])).rejects.toThrow(/no answer:\n.*nope/s);
    });
  });

  test('refuses --detach without --headless, naming it', async () => {
    const result = await devtooie(['--detach', '-s', 'wide']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--detach needs --headless.');
  });
});

describe('what a command loads', () => {
  const HEAVY = ['zod', 'execa', '@dotenvx/primitives', 'pino', '@clack/prompts', 'typescript'];
  const SESSION_ONLY = ['pino', '@clack/prompts', 'jsonc-parser', 'typescript', 'ink', 'react'];

  const expectNotLoaded = (packages: Set<string>, names: string[]) => {
    expect(names.filter((name) => packages.has(name))).toEqual([]);
  };

  test('--help prints the usage without loading the config or anything a command needs', async () => {
    const { result, packages, evaluatedConfig } = await traced(['--help']);
    expect(result.stdout).toContain('Usage: devtooie');
    expect(result.exitCode).toBe(0);
    expect(evaluatedConfig).toBe(false);
    expectNotLoaded(packages, HEAVY);
  });

  test('logs --path finds the newest logfile without loading the config', async () => {
    await devtooie(['exec', '-s', 'app', '--', 'true']);
    const { result, packages, evaluatedConfig } = await traced(['logs', '--path'], { cwd: app });
    expect(result.stdout).toMatch(/node_modules\/\.devtooie\/logs\/.+\.log$/);
    expect(result.exitCode).toBe(0);
    expect(evaluatedConfig).toBe(false);
    expectNotLoaded(packages, HEAVY);
  });

  test('logs prints that logfile', async () => {
    await devtooie(['exec', '-s', 'app', '--', 'echo', 'in-the-log']);
    const result = await devtooie(['logs']);
    expect(result.stdout).toContain('in-the-log');
    expect(result.exitCode).toBe(0);
  });

  test('reset clears the saved selection without evaluating the config', async () => {
    const { result, evaluatedConfig } = await traced(['reset']);
    expect(result.stdout).toBe('Selection reset.');
    expect(result.exitCode).toBe(0);
    expect(evaluatedConfig).toBe(false);
  });

  test('exec loads nothing a session needs', async () => {
    const { result, packages } = await traced(['exec', '-s', 'app', '--', 'echo', 'ran']);
    expect(result.stdout).toBe('ran');
    expectNotLoaded(packages, [...SESSION_ONLY, 'string-width', 'wrap-ansi']);
  });

  test('run loads nothing a session needs', async () => {
    const { result, packages } = await traced(['run', '-s', 'app', 'cwd']);
    expect(lastLine(result.stdout)).toBe(app);
    expectNotLoaded(packages, [...SESSION_ONLY, 'string-width', 'wrap-ansi']);
  });

  test('show-config prints the resolved config, loading nothing that runs a command', async () => {
    const { result, packages } = await traced(['show-config']);
    const config = JSON.parse(result.stdout) as { services: Record<string, { name: string }> };
    expect(config.services.app?.name).toBe('app');
    expectNotLoaded(packages, ['execa', ...SESSION_ONLY]);
  });

  test("resolvedeps reads a package's project references without loading TypeScript", async () => {
    const { result, packages } = await traced(['resolvedeps', 'app']);
    expect(JSON.parse(result.stdout)).toEqual({ build: ['lib'], dev: [], runtime: [] });
    expectNotLoaded(packages, ['pino', '@clack/prompts', 'typescript', 'ink', 'react']);
  });

  test('a --headless session loads no TUI, no prompt library and no TypeScript', async () => {
    const { output, packages } = await tracedPlainSession(['app']);
    expect(output).toMatch(/\[app\] started/);
    expectNotLoaded(packages, ['ink', 'react', '@clack/prompts', 'typescript']);
  }, 30_000);

  test('a --headless session loads the row-wrapping packages only for a line that needs them', async () => {
    const { packages } = await tracedPlainSession(['app']);
    expectNotLoaded(packages, ['string-width', 'wrap-ansi', 'slice-ansi']);
  }, 30_000);

  test('a --headless session still wraps a long line to the terminal width, gutter on every row', async () => {
    const { output, packages } = await tracedPlainSession(['wide'], 'done');
    const rows = output.split('\n').filter((line) => /\[wide\] x+$/.test(line));
    // Piped, the terminal is taken as 120 columns: a 20-column timestamp, `[wide] `, the text.
    expect(rows.map((row) => row.length)).toEqual([120, 84]);
    expect(rows.map((row) => /x+$/.exec(row)![0].length)).toEqual([93, 57]);
    expect(output).toMatch(/\[wide\] glyphs \u2713 \u4e2d\u6587 done/);
    expect(packages.has('string-width')).toBe(true);
  }, 30_000);

  test("no command loads the env parser's CLI tooling", async () => {
    const { packages } = await traced(['exec', '-s', 'app', '--', 'true']);
    expectNotLoaded(packages, ['@dotenvx/dotenvx', '@dotenvx/tooling']);
  });
});

describe('the devtooie process', () => {
  /**
   * Each program a CLI run loaded, in order — one, or two once it starts over: the pid, the
   * directory it started in and the Node.js flags it ran with, recorded by a preload as it starts.
   */
  async function programsOf(args: string[]) {
    const out = path.join(ws, `process-${String(traces++)}.jsonl`);
    const hook = path.join(ws, 'process-hook.mjs');
    fs.writeFileSync(
      hook,
      "import fs from 'node:fs';\nfs.appendFileSync(process.env.PROCESS_OUT, JSON.stringify({ pid: process.pid, cwd: process.cwd(), execArgv: process.execArgv }) + '\\n');\n",
    );
    const child = execa('node', ['--import', hook, cli, ...args], {
      cwd: app,
      env: { PROCESS_OUT: out },
      reject: false,
    });
    const result = await child;
    const programs = fs
      .readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { pid: number; cwd: string; execArgv: string[] });
    return { result, hook, pid: child.pid, programs };
  }

  test('a session starts over with a small young generation, as it was started', async () => {
    // A service that doesn't exist: the session gets as far as checking it, then exits.
    const { result, hook, pid, programs } = await programsOf(['-s', 'nope']);
    expect(result.stderr).toContain('Unknown service: nope');
    expect(programs).toEqual([
      { pid, cwd: app, execArgv: ['--import', hook] },
      { pid, cwd: app, execArgv: ['--max-semi-space-size=2', '--import', hook] },
    ]);
  });

  test('a one-off command runs as it was started', async () => {
    const { result, hook, pid, programs } = await programsOf(['exec', '-s', 'app', '--', 'true']);
    expect(result.exitCode).toBe(0);
    expect(programs).toEqual([{ pid, cwd: app, execArgv: ['--import', hook] }]);
  });
});
