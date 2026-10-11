import fs from 'node:fs';
import { execa } from 'execa';
import { type AnyPackageConfig, getLoadedConfig } from '../config.js';
import { envFileNames, packageEnvLayer, workspaceEnvLayer } from '../env.js';
import {
  NoProjectConfigError,
  findConfigPath,
  findWorkspaceRoot,
  loadConfig,
} from '../load-config.js';
import {
  exitCodeOf,
  findAncestorPackage,
  getDefaultLogFile,
  getExecArgs,
  hasScript,
  logTimestamp,
  stripAnsi,
} from '../lib.js';
import { applyWorkspaceEnv, exitOnConfigLoadFailure } from './workspace.js';

// `devtooie exec` and `devtooie run`: one command, with a package's directory and environment.

/** What `exec` and `run` take from the command line. */
export interface OneOffOptions {
  /** The directory devtooie was invoked in — which package you are "inside". */
  invocationCwd: string;
  /** The root `-p/--package` values; at most one names the target. */
  packageNames: string[];
  /** The `--log-dir` override, if any. */
  logDir?: string;
}

/**
 * Runs `cmd`/`args` in `cwd` with `env` merged over the current environment; stdin is inherited
 * so the command stays interactive, and this returns once the command exits. stdout/stderr stream
 * to the terminal (raw, colors intact) *and* are teed into `logFile` — line-buffered, timestamped,
 * and ANSI-stripped, matching how a `--plain` session logs. Returns the command's exit code.
 */
async function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; logFile: string },
): Promise<number> {
  const logFd = fs.openSync(opts.logFile, 'w');
  // Tee one child stream: raw bytes to the terminal, then line-buffered timestamped+stripped
  // lines to the logfile. Returns a flush for any trailing line with no final newline.
  const tee = (src: NodeJS.ReadableStream | null, term: NodeJS.WriteStream): (() => void) => {
    if (!src) {
      return () => {};
    }
    let buf = '';
    src.on('data', (chunk: Buffer) => {
      term.write(chunk);
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        fs.writeSync(logFd, `${logTimestamp()} ${stripAnsi(buf.slice(0, nl))}\n`);
        buf = buf.slice(nl + 1);
      }
    });
    return () => {
      if (buf.length > 0) {
        fs.writeSync(logFd, `${logTimestamp()} ${stripAnsi(buf)}\n`);
        buf = '';
      }
    };
  };

  try {
    const child = execa(cmd, args, {
      cwd: opts.cwd,
      env: Object.assign({}, process.env, opts.env),
      stdin: 'inherit',
      reject: false,
    });
    const flushOut = tee(child.stdout, process.stdout);
    const flushErr = tee(child.stderr, process.stderr);
    const result = await child;
    flushOut();
    flushErr();
    return exitCodeOf(result);
  } finally {
    fs.closeSync(logFd);
  }
}

/**
 * Resolves the target for the `exec` and `run` subcommands. With an explicit `-p/--package` name, that
 * configured package is the target. Otherwise it's inferred from the directory devtooie was
 * invoked in: the nearest **ancestor package** of the invocation dir, or — below the root but
 * inside no package — the root itself (working dir = root, workspace-scope vars only). For a
 * package the working dir is its dir and the env its (`PORT` + `.env`) layer, exactly what the
 * TUI would spawn it with. Exits if there's no config, or if `--package` names an unknown one.
 * Returns the working dir and the env layer to merge over `process.env`.
 */
async function resolveOneOffTargetOrExit(
  invocationCwd: string,
  explicitName: string | undefined,
): Promise<{ dir: string; envLayer: Record<string, string> }> {
  const root = findWorkspaceRoot(invocationCwd);
  if (!root) {
    console.error(`No devtooie config found from ${invocationCwd}.`);
    process.exit(1);
  }
  try {
    await loadConfig(root);
    applyWorkspaceEnv(getLoadedConfig());
  } catch (err) {
    if (err instanceof NoProjectConfigError) {
      console.error(`No devtooie config found from ${invocationCwd}.`);
      process.exit(1);
    }
    exitOnConfigLoadFailure(root, err);
  }
  const config = getLoadedConfig();
  if (!config) {
    console.error(
      `${findConfigPath(root) ?? 'devtooie.config.ts'} loaded but registered no config — ` +
        'it must export a `defineConfig(...)` call as its default.',
    );
    process.exit(1);
  }
  const layerOpts = {
    cwd: root,
    files: config.envFiles ?? envFileNames(),
    override: config.envOverride,
    vars: config.envVars,
  };

  const configPackages = Object.values(config.packages);
  // The same layer the session spawns the package with: `PORT`, `PUBLIC_ORIGIN` under the dev
  // reverse proxy, then the config's own variables and its `.env` files.
  const layerFor = (pkg: AnyPackageConfig) => packageEnvLayer(pkg, layerOpts);
  if (explicitName !== undefined) {
    const pkg = configPackages.find((p) => p.name === explicitName);
    if (!pkg) {
      console.error(`Package "${explicitName}" not found in the devtooie config.`);
      process.exit(1);
    }
    return { dir: pkg.absoluteDir, envLayer: layerFor(pkg) };
  }

  const pkg = findAncestorPackage(invocationCwd, configPackages, root);
  if (pkg) {
    return { dir: pkg.absoluteDir, envLayer: layerFor(pkg) };
  }
  return { dir: root, envLayer: workspaceEnvLayer(layerOpts) };
}

/** The one package `exec`/`run` targets: its dir and env layer, from `-p` or the invocation dir. */
async function oneOffTargetOrExit(
  subcommand: 'exec' | 'run',
  opts: OneOffOptions,
): Promise<{ dir: string; envLayer: Record<string, string> }> {
  if (opts.packageNames.length > 1) {
    console.error(`${subcommand} targets a single package — pass --package at most once.`);
    process.exit(1);
  }
  return resolveOneOffTargetOrExit(opts.invocationCwd, opts.packageNames[0]);
}

/**
 * Runs a one-off command to completion and exits with its exit code. No preamble: `exec` and
 * `run` are meant to be composable, so their output is only the command's own (the run is still
 * teed to a logfile, which `devtooie logs --path` can point at).
 */
async function runOneOffAndExit(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; logDir?: string },
): Promise<never> {
  const logFile = getDefaultLogFile(opts.logDir);
  process.exit(await runCommand(cmd, args, { cwd: opts.cwd, env: opts.env, logFile }));
}

/** `devtooie exec -- <command>`: a literal command in the target package's dir and environment. */
export async function runExec(command: string[], opts: OneOffOptions): Promise<never> {
  const { dir, envLayer } = await oneOffTargetOrExit('exec', opts);
  const [cmd, ...args] = command;
  if (cmd === undefined) {
    console.error('exec requires a command (after `--`).');
    process.exit(1);
  }
  return runOneOffAndExit(cmd, args, {
    cwd: dir,
    env: Object.assign({}, process.env, envLayer),
    logDir: opts.logDir,
  });
}

/** `devtooie run <script>`: one of the target package's scripts or make targets. */
export async function runScriptCommand(
  script: string,
  args: string[],
  opts: OneOffOptions,
): Promise<never> {
  const { dir, envLayer } = await oneOffTargetOrExit('run', opts);
  // getExecArgs/hasScript key off `.absoluteDir` only, so a minimal package view over the
  // resolved dir suffices.
  const pkgAtDir = { absoluteDir: dir } as AnyPackageConfig;
  if (!hasScript(pkgAtDir, script)) {
    console.error(`No "${script}" script or make target found in ${dir}.`);
    process.exit(1);
  }
  const spec = getExecArgs(pkgAtDir, script, args, Object.assign({}, process.env, envLayer));
  return runOneOffAndExit(spec.cmd, spec.args, { cwd: dir, env: spec.env, logDir: opts.logDir });
}
