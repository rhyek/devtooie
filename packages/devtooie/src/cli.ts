#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { Command } from 'commander';
import { execa } from 'execa';
import { renderApp } from './components/App.js';
import { startCommandServer } from './command-server.js';
import {
  type AnyPackageConfig,
  findPackage,
  getRegisteredPackages,
  getLoadedConfig,
} from './config.js';
import { DEFAULT_ENV_FILES, packageEnvLayer, resolveEnv } from './env.js';
import { acquireDevSession } from './dev-session.js';
import { handleShellError } from './errors.js';
import { runInit } from './init.js';
import {
  NoProjectConfigError,
  loadConfig,
  findWorkspaceRoot,
  findConfigPath,
} from './load-config.js';
import {
  DepType,
  buildRunnerArgs,
  findAncestorPackage,
  getDefaultLogFile,
  getExecArgs,
  hasScript,
  loadSelection,
  logTimestamp,
  resetSelection,
  resolveDeps,
  saveSelection,
  stripAnsi,
} from './lib.js';
import { createPlainStatusReporter } from './plain-status.js';
import { runPlain } from './runners/plain.js';
import { refreshSkillIfStale } from './skill.js';

interface RootOptions {
  package: string[];
  ui?: boolean;
  plain?: boolean;
  lastAnswers: boolean;
  phase: string;
  build: boolean;
  rebuild: boolean;
  logDir?: string;
}

/**
 * The directory devtooie was invoked from, captured before {@link anchorAtConfigRoot} may
 * `chdir` us to the config root. `cmd` uses it to figure out which package you're "inside".
 */
const INVOCATION_CWD = process.cwd();

/**
 * Very early step (runs for every command): find the workspace root (nearest ancestor with a
 * devtooie config), `chdir` into it so devtooie behaves identically from any subdirectory, and
 * merge that root's workspace-scope `.env` into our own `process.env`. Best-effort — a no-op when
 * there's no config (e.g. `devtooie init` in a fresh repo).
 */
async function anchorAtConfigRoot(invocationCwd: string): Promise<void> {
  const root = findWorkspaceRoot(invocationCwd);
  if (!root) return;
  if (root !== process.cwd()) process.chdir(root);
  try {
    await loadConfig(root);
    const files = getLoadedConfig()?.envFiles ?? DEFAULT_ENV_FILES;
    const { env } = resolveEnv({ cwd: root, relativeDir: '.', files });
    Object.assign(process.env, env);
  } catch {
    /* no/invalid config here — nothing to anchor or load */
  }
}

/** Commander option-parser for repeatable `-p/--package <name>` flags. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Reads this package's own version (used for the skill-refresh staleness check). Falls back to '0.0.0'. */
function readOwnVersion(): string {
  try {
    const pkgPath = path.join(import.meta.dirname, '../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Loads `devtooie.config.ts`, printing a clear hint and exiting 1 if there is none. */
async function loadConfigOrExit(): Promise<AnyPackageConfig[]> {
  try {
    return await loadConfig();
  } catch (err) {
    if (err instanceof NoProjectConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

/** Exits with a clear message if any of `names` isn't a registered package. */
function validatePackageNames(names: string[]): void {
  const registered = new Set(getRegisteredPackages().map((p) => p.name));
  const unknown = names.filter((n) => !registered.has(n));
  if (unknown.length > 0) {
    console.error(`Unknown package${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
    process.exit(1);
  }
}

/**
 * Resolves the package names for a non-interactive phase (build/plain), which — unlike
 * the UI — has no selector to fall back on: an explicit `--package` wins, then a saved
 * `--last-answers` selection, otherwise this exits with a hint naming `usage`.
 */
function resolveSelectedNames(
  opts: { package: string[]; lastAnswers: boolean },
  usage: string,
): string[] {
  if (opts.package.length > 0) return opts.package;
  if (opts.lastAnswers) {
    const saved = loadSelection() ?? [];
    if (saved.length === 0) {
      console.error('No saved selection found — run once without --last-answers first.');
      process.exit(1);
    }
    validatePackageNames(saved);
    return saved;
  }
  console.error(`${usage} requires --package or --last-answers.`);
  process.exit(1);
}

async function clearDist(pkg: AnyPackageConfig): Promise<void> {
  const result = await execa('rm', ['-rf', path.join(pkg.path, 'dist')], { reject: false });
  if (result.exitCode !== 0) {
    console.error(`warning: could not clear ${path.join(pkg.path, 'dist')}`);
  }
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
  opts: { cwd: string; env: Record<string, string>; logFile: string },
): Promise<number> {
  const logFd = fs.openSync(opts.logFile, 'w');
  // Tee one child stream: raw bytes to the terminal, then line-buffered timestamped+stripped
  // lines to the logfile. Returns a flush for any trailing line with no final newline.
  const tee = (src: NodeJS.ReadableStream | null, term: NodeJS.WriteStream): (() => void) => {
    if (!src) return () => {};
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
    return result.exitCode ?? 1;
  } finally {
    fs.closeSync(logFd);
  }
}

/**
 * Resolves the target for the `cmd` subcommand. With an explicit `-p/--package` name, that
 * configured package is the target. Otherwise it's inferred from the directory devtooie was
 * invoked in: the nearest **ancestor package** of the invocation dir, or — below the root but
 * inside no package — the root itself (working dir = root, workspace-scope vars only). For a
 * package the working dir is its dir and the env its (`PORT` + `.env`) layer, exactly what the
 * TUI would spawn it with. Exits if there's no config, or if `--package` names an unknown one.
 * Returns the working dir and the env layer to merge over `process.env`.
 */
async function resolveCmdTargetOrExit(
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
  } catch {
    /* fall through to the no-config error below */
  }
  const config = getLoadedConfig();
  if (!config) {
    console.error(`No devtooie config found from ${invocationCwd}.`);
    process.exit(1);
  }
  const files = config.envFiles ?? DEFAULT_ENV_FILES;

  if (explicitName !== undefined) {
    const pkg = config.packages.find((p) => p.name === explicitName);
    if (!pkg) {
      console.error(`Package "${explicitName}" not found in the devtooie config.`);
      process.exit(1);
    }
    return { dir: pkg.path, envLayer: packageEnvLayer(pkg, { cwd: root, files }) };
  }

  const pkg = findAncestorPackage(invocationCwd, config.packages, root);
  if (pkg) {
    return { dir: pkg.path, envLayer: packageEnvLayer(pkg, { cwd: root, files }) };
  }
  return { dir: root, envLayer: resolveEnv({ cwd: root, relativeDir: '.', files }).env };
}

async function buildOne(pkg: AnyPackageConfig, script: string): Promise<void> {
  const [cmd, args] = getExecArgs(pkg, script);
  await execa(cmd, args, { stdio: 'inherit', cwd: pkg.path });
}

/** Builds every buildable dep in `deps.buildSet`, in dependency order, with console output. */
async function buildDeps(deps: ReturnType<typeof resolveDeps>): Promise<void> {
  const depPackages = [...deps.buildSet]
    .map((n) => findPackage(n))
    .filter((p) => hasScript(p, 'build'));
  for (const [i, pkg] of depPackages.entries()) {
    console.log(
      `${chalk.blue('▶')} building dep (${i + 1}/${depPackages.length}): ${chalk.bold(pkg.name)}`,
    );
    await buildOne(pkg, 'build');
  }
  if (depPackages.length > 0) console.log(chalk.green('✔ dependencies built'));
}

/** `--phase build` / `--build` / `--rebuild`: build deps then the selected packages, then exit. */
async function runBuildPhase(names: string[], rebuild: boolean): Promise<void> {
  const packages = names.map((n) => findPackage(n));
  const deps = resolveDeps(packages, [DepType.BUILD]);
  const depPackages = [...deps.buildSet]
    .map((n) => findPackage(n))
    .filter((p) => hasScript(p, 'build'));
  const selectedPackages = packages.filter(
    (p) => hasScript(p, 'build') || hasScript(p, 'build:clean'),
  );

  if (rebuild) {
    console.log(chalk.blue('▶ clearing dist/'));
    for (const pkg of [...depPackages, ...selectedPackages]) await clearDist(pkg);
  }

  for (const [i, pkg] of depPackages.entries()) {
    console.log(
      `${chalk.blue('▶')} building dep (${i + 1}/${depPackages.length}): ${chalk.bold(pkg.name)}`,
    );
    await buildOne(pkg, 'build');
  }

  for (const pkg of selectedPackages) {
    const script = rebuild && hasScript(pkg, 'build:clean') ? 'build:clean' : 'build';
    console.log(`${chalk.blue('▶')} building: ${chalk.bold(pkg.name)}`);
    await buildOne(pkg, script);
  }

  console.log(chalk.green('✔ build complete'));
}

// ---------------------------------------------------------------------------
// Commander wiring
// ---------------------------------------------------------------------------

const program = new Command()
  .name('devtooie')
  .description("Dependency-aware CLI for a monorepo's local dev packages")
  .option(
    '-p, --package <name>',
    'package to run (repeatable, bypasses the interactive selector)',
    collect,
    [],
  )
  .option('--ui', 'run the interactive TUI (default)')
  .option('--plain', 'run without the TUI, streaming logs to stdout')
  .option('--last-answers', 'skip the selector and reuse the last saved selection', false)
  .option('--phase <phase>', 'pipeline phase: "dev" (default) or "build"', 'dev')
  .option('--build', 'build the selected packages + their build-time deps, then exit', false)
  .option(
    '--rebuild',
    "like --build, but clears each build target's dist/ first (implies --build)",
    false,
  )
  .option(
    '--log-dir <dir>',
    'write the timestamped session log into this directory (default: node_modules/.devtooie/logs/)',
  );

program
  .command('init')
  .description('set up devtooie.config.ts (and, optionally, the agent skill)')
  .option(
    '-y, --yes',
    'non-interactive: accept defaults (scaffold config + install the agent skill)',
  )
  .action(async (opts: { yes?: boolean }) => {
    await runInit({ yes: opts.yes });
  });

program
  .command('reset')
  .description('clear the saved package selection')
  .action(() => {
    resetSelection();
    console.log('Selection reset.');
    process.exit(0);
  });

program
  .command('resolvedeps')
  .description('print the build/dev/runtime deps for a single package, as JSON')
  .argument('<package>', 'configured package name to resolve dependencies for')
  .action(async (packageName: string) => {
    await loadConfigOrExit();
    validatePackageNames([packageName]);
    const packages = [findPackage(packageName)];
    const selectedNames = new Set(packages.map((p) => p.name));

    const build = resolveDeps(packages, [DepType.BUILD]);
    const dev = resolveDeps(packages, [DepType.DEV]);
    const runtime = resolveDeps(packages, [DepType.RUNTIME]);

    console.log(
      JSON.stringify(
        {
          build: [...build.buildSet].filter((n) => !selectedNames.has(n)),
          dev: [...dev.buildSet].filter((n) => !selectedNames.has(n)),
          runtime: [...runtime.runSet].filter((n) => !selectedNames.has(n)),
        },
        null,
        2,
      ),
    );
    process.exit(0);
  });

program
  .command('cmd')
  .description(
    "run a one-off command with a package's environment (its dir + resolved .env); package inferred from the cwd or named with -p/--package",
  )
  .option(
    '-c, --cmd <script>',
    'run this package script / make target instead of a literal command; args after `--` are forwarded to it',
  )
  .argument(
    '[args...]',
    'a literal command to run (after `--`), or — with -c/--cmd — the args forwarded to that script',
  )
  .action(async (args: string[], opts: { cmd?: string }) => {
    // Explicit target via the root `-p/--package` global (reused rather than redeclared — see
    // the `resolvedeps` note); if omitted, the package is inferred from the directory devtooie
    // was invoked in (not the config root we may have chdir'd to — see anchorAtConfigRoot).
    const packageNames = program.opts<RootOptions>().package;
    if (packageNames.length > 1) {
      console.error('cmd targets a single package — pass --package at most once.');
      process.exit(1);
    }
    const { dir, envLayer } = await resolveCmdTargetOrExit(INVOCATION_CWD, packageNames[0]);

    let cmd: string;
    let cmdArgs: string[];
    if (opts.cmd !== undefined) {
      // `-c` names a package script / make target: resolve how to invoke it in this dir, then
      // forward the operands as its args. getExecArgs/hasScript key off `.path` only, so a
      // minimal package view over the resolved dir suffices.
      const pkgAtDir = { path: dir } as AnyPackageConfig;
      if (!hasScript(pkgAtDir, opts.cmd)) {
        console.error(`No "${opts.cmd}" script or make target found in ${dir}.`);
        process.exit(1);
      }
      [cmd, cmdArgs] = getExecArgs(pkgAtDir, opts.cmd, args);
    } else {
      // No `-c`: the operands are a literal command.
      if (args.length === 0) {
        console.error('cmd requires a command (after `--`) or a -c/--cmd script name.');
        process.exit(1);
      }
      [cmd, ...cmdArgs] = args as [string, ...string[]];
    }

    const logFile = getDefaultLogFile(program.opts<RootOptions>().logDir);
    console.error(`devtooie cmd: running in ${dir}; logging output to ${logFile}`);
    process.exit(await runCommand(cmd, cmdArgs, { cwd: dir, env: envLayer, logFile }));
  });

// ---------------------------------------------------------------------------
// Main flow (§6.5) — the default action, run only when no subcommand matched.
// ---------------------------------------------------------------------------

program.action(async () => {
  const opts = program.opts<RootOptions>();

  if (opts.ui && opts.plain) {
    console.error('Cannot use both --ui and --plain.');
    process.exit(1);
  }
  if (opts.phase !== 'dev' && opts.phase !== 'build') {
    console.error('--phase must be "dev" or "build".');
    process.exit(1);
  }

  await loadConfigOrExit();

  // Best-effort: a skill refresh should never block a run. No-ops unless the skill was
  // actually installed (tracked in node_modules/.devtooie/skill.json).
  try {
    refreshSkillIfStale({ cwd: process.cwd(), version: readOwnVersion() });
  } catch (err) {
    console.error('devtooie: skill refresh failed (non-fatal):', err);
  }

  // Validate --package names before mounting/running anything.
  validatePackageNames(opts.package);

  const phase: 'dev' | 'build' =
    opts.rebuild || opts.build ? 'build' : (opts.phase as 'dev' | 'build');

  if (phase === 'build') {
    const names = resolveSelectedNames(opts, 'the build phase');
    try {
      await runBuildPhase(names, opts.rebuild);
    } catch (err) {
      handleShellError(err);
    }
    return;
  }

  const logFile = getDefaultLogFile(opts.logDir);

  if (opts.plain) {
    const names = resolveSelectedNames(opts, '--plain');
    saveSelection(names);
    try {
      const statusReporter = createPlainStatusReporter();
      const configPath =
        findConfigPath(process.cwd()) ?? path.join(process.cwd(), 'devtooie.config.ts');
      const port = await acquireDevSession({
        configPath,
        apiPortOverride: getLoadedConfig()?.apiPort,
        logFile,
        onStatus: (msg) => statusReporter.update(msg),
      });
      statusReporter.done();
      const server = await startCommandServer({ onQuit: () => process.exit(0), port, configPath });
      const packages = names.map((n) => findPackage(n));
      const deps = resolveDeps(packages);
      await buildDeps(deps);
      await runPlain({ ...buildRunnerArgs(packages, deps), logFile }, server);
    } catch (err) {
      handleShellError(err);
    }
    return;
  }

  // --ui (default): App owns the selector -> build -> run phases and the control server.
  renderApp({ packages: opts.package, lastAnswers: opts.lastAnswers, logFile });
});

// Anchor at the config root (chdir + load its workspace-scope env) before dispatching any
// command, so devtooie behaves the same from anywhere in the tree.
await anchorAtConfigRoot(INVOCATION_CWD);
await program.parseAsync(process.argv).catch((err: unknown) => handleShellError(err));
