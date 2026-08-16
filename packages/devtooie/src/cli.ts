#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { Command } from 'commander';
import { execa } from 'execa';
import { startCommandServer } from './command-server.js';
import { connectControlClient } from './control-client.js';
import {
  type AnyPackageConfig,
  findPackage,
  getRegisteredPackages,
  getLoadedConfig,
} from './config.js';
import { envFileNames, packageEnvLayer, resolveEnv, resolveMode } from './env.js';
import { acquireDevSession } from './dev-session.js';
import { handleShellError } from './errors.js';
import { runInit } from './init.js';
import {
  NoProjectConfigError,
  formatConfigLoadFailure,
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
  getLogDir,
  hasScript,
  loadSelection,
  logTimestamp,
  resetSelection,
  resolveDeps,
  resolveLogFile,
  saveSelection,
  stripAnsi,
} from './lib.js';
import { readRunning } from './running.js';
import { createPlainStatusReporter } from './plain-status.js';
import { renderAppInProduction } from './render-app-production.js';
import { runPlain } from './runners/plain.js';
import { refreshSkillIfStale } from './skill.js';
import { preflightTakeover } from './takeover.js';

interface RootOptions {
  package: string[];
  /** Declared for --help/validation; the value in force is read from argv by resolveMode. */
  mode?: string;
  ui?: boolean;
  plain?: boolean;
  lastAnswers: boolean;
  phase: string;
  build: boolean;
  rebuild: boolean;
  logDir?: string;
  killOthers: boolean;
}

/**
 * The directory devtooie was invoked from, captured before {@link anchorAtConfigRoot} may
 * `chdir` us to the config root. `cmd` uses it to figure out which package you're "inside".
 */
const INVOCATION_CWD = process.cwd();

// Resolved from raw argv and published to the environment before anything else runs: the config is
// loaded (and its `port`/`urls` callbacks resolve `.env` files) inside anchorAtConfigRoot, which
// happens before Commander parses. Writing it back also hands every child process the mode for
// free, the way Vite exposes MODE.
try {
  process.env.DEVTOOIE_MODE = resolveMode(process.argv);
} catch (err) {
  // Runs before Commander, so there's no usage output to lean on — just say what's wrong.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

/**
 * Very early step (runs for every command): find the workspace root (nearest ancestor with a
 * devtooie config), `chdir` into it so devtooie behaves identically from any subdirectory, and
 * merge that root's workspace-scope `.env` into our own `process.env`. Best-effort — a no-op when
 * there's no config (e.g. `devtooie init` in a fresh repo).
 */
async function anchorAtConfigRoot(invocationCwd: string): Promise<void> {
  const root = findWorkspaceRoot(invocationCwd);
  if (!root) {
    return;
  }
  if (root !== process.cwd()) {
    process.chdir(root);
  }
  try {
    await loadConfig(root);
    const files = getLoadedConfig()?.envFiles ?? envFileNames();
    // Deliberately resolved WITHOUT the config's `env.override`. An overriding variable is
    // typically self-referential (`NODE_OPTIONS=$NODE_OPTIONS --flag`), and this merge is the
    // base that every later per-package resolution expands against — applying the override here
    // would fold the file's contribution into the ambient value, and the package-level pass
    // would then append it a second time. Without it these keys resolve to their ambient value,
    // so the assignment is a no-op for them and each child appends exactly once. (Nothing is
    // lost for devtooie's own process: node reads NODE_OPTIONS at startup, long before this.)
    const { env } = resolveEnv({ cwd: root, relativeDir: '.', files });
    Object.assign(process.env, env);
  } catch (err) {
    // Best-effort by design — this runs before *every* command (`init` included), so a config
    // that exists but won't load must not be fatal here; the commands that actually need it
    // report the failure in full. Don't go silent though: the workspace `.env` wasn't applied.
    if (!(err instanceof NoProjectConfigError)) {
      console.error(
        chalk.yellow(`devtooie: couldn't load the config at ${root} — workspace .env not applied.`),
      );
    }
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

/**
 * Prints *why* a config file that does exist wouldn't load, and exits 1. Kept separate from the
 * "no config found" message so a broken config never masquerades as a missing one.
 */
function exitOnConfigLoadFailure(root: string, err: unknown): never {
  console.error(formatConfigLoadFailure(findConfigPath(root) ?? root, err));
  process.exit(1);
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
    exitOnConfigLoadFailure(process.cwd(), err);
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
  if (opts.package.length > 0) {
    return opts.package;
  }
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
  const files = config.envFiles ?? envFileNames();
  const override = config.envOverride;

  const configPackages = Object.values(config.packages);
  if (explicitName !== undefined) {
    const pkg = configPackages.find((p) => p.name === explicitName);
    if (!pkg) {
      console.error(`Package "${explicitName}" not found in the devtooie config.`);
      process.exit(1);
    }
    return { dir: pkg.path, envLayer: packageEnvLayer(pkg, { cwd: root, files, override }) };
  }

  const pkg = findAncestorPackage(invocationCwd, configPackages, root);
  if (pkg) {
    return { dir: pkg.path, envLayer: packageEnvLayer(pkg, { cwd: root, files, override }) };
  }
  return { dir: root, envLayer: resolveEnv({ cwd: root, relativeDir: '.', files, override }).env };
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
  if (depPackages.length > 0) {
    console.log(chalk.green('✔ dependencies built'));
  }
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
    for (const pkg of [...depPackages, ...selectedPackages]) {
      await clearDist(pkg);
    }
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
  .option(
    '-m, --mode <name>',
    'environment mode selecting the .env.<mode> files to load (default: "development")',
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
  )
  .option(
    '--kill-others',
    "quit a devtooie session already running for this project instead of asking (agents: don't pass this unprompted)",
    false,
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
  // Also declared on the root, but Commander rejects a root-only option that appears after a
  // subcommand — so both `devtooie --mode test cmd …` and `devtooie cmd --mode test …` work.
  // resolveMode already read it off raw argv; this declaration is for --help and validation.
  .option(
    '-m, --mode <name>',
    'environment mode selecting the .env.<mode> files to load (default: "development")',
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

    // No preamble: `cmd` is meant to be composable, so its output is only the command's own
    // (the run is still teed to `logFile`, which `devtooie logs --path` can point at).
    const logFile = getDefaultLogFile(program.opts<RootOptions>().logDir);
    process.exit(await runCommand(cmd, cmdArgs, { cwd: dir, env: envLayer, logFile }));
  });

program
  .command('logs')
  .description(
    "print the current dev session's logfile (queried from the running instance, else the newest under node_modules/.devtooie/logs/)",
  )
  .option(
    '-f, --follow',
    'stream new lines live (native `tail -f`) instead of printing the file and exiting',
  )
  .option('--path', 'print the resolved logfile path instead of its contents, then exit')
  .action(async (opts: { follow?: boolean; path?: boolean }) => {
    // Strictly READ-ONLY: `devtooie logs` must NEVER terminate a running session. It only reads
    // running.json and issues a read-only GET /query/status, then cats/tails a file — it must
    // never go through acquireDevSession/decideControlPort, which hand off (shut down) an instance.
    if (opts.path && opts.follow) {
      console.error('devtooie logs: --path cannot be combined with -f/--follow.');
      process.exit(1);
    }
    const cwd = process.cwd();
    const running = readRunning(cwd);
    const client = await connectControlClient(cwd);
    const logFile = await resolveLogFile({
      liveLogFile: async () => {
        const status = client ? await client.queryStatus() : null;
        return typeof status?.logFile === 'string' ? status.logFile : null;
      },
      recordedLogFile: running?.logFile ?? null,
      fallbackDir: running?.logDir ?? getLogDir(),
    });
    if (!logFile) {
      console.error(
        'devtooie logs: no logfile found (no running session, and no logs under node_modules/.devtooie/logs/).',
      );
      process.exit(1);
    }
    if (opts.path) {
      console.log(logFile);
      process.exit(0);
    }
    // Native os commands, stdio inherited. No SIGINT handler is installed, so Ctrl+C stops only
    // this `cat`/`tail` — the (separate-process) devtooie session is untouched.
    const [bin, binArgs] = opts.follow
      ? (['tail', ['-n', '+1', '-f', logFile]] as const)
      : (['cat', [logFile]] as const);
    const result = await execa(bin, binArgs, { stdio: 'inherit', reject: false });
    process.exit(result.exitCode ?? (result.signal ? 0 : 1));
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
  const configPath =
    findConfigPath(process.cwd()) ?? path.join(process.cwd(), 'devtooie.config.ts');

  // Resolved before the preflight below, so a `--plain` invocation that can't name its
  // packages fails with that usage error instead of first asking whether to quit a session
  // it was never going to start.
  const plainNames = opts.plain ? resolveSelectedNames(opts, '--plain') : null;

  // Settle what happens to a session already running for this project *before* anything
  // starts. Acquisition frees the dev ports by killing whatever in this workspace holds
  // them, so once it begins the other session is gone either way — declining has to mean
  // exiting here. Shared by both the --plain and TUI paths, and deliberately ahead of the
  // TUI's alternate screen, so the prompt is an ordinary terminal prompt.
  const takeover = await preflightTakeover({
    configPath,
    killOthers: opts.killOthers,
    apiPortOverride: getLoadedConfig()?.apiPort,
  });
  if (!takeover.ok) {
    console.error(takeover.message);
    process.exit(1);
  }

  if (opts.plain) {
    const names = plainNames ?? [];
    saveSelection(names);
    try {
      const statusReporter = createPlainStatusReporter();
      const port = await acquireDevSession({
        configPath,
        apiPortOverride: getLoadedConfig()?.apiPort,
        logFile,
        onStatus: (msg) => statusReporter.update(msg),
      });
      statusReporter.done();
      const server = await startCommandServer({
        onQuit: () => process.exit(0),
        port,
        configPath,
        logFile,
      });
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
  // Loaded via renderAppInProduction so React (and thus all of Ink) runs in its
  // production build — its development build leaks User-Timing entries on every render
  // (see render-app-production.ts). Child dev processes still inherit the shell's NODE_ENV.
  await renderAppInProduction({ packages: opts.package, lastAnswers: opts.lastAnswers, logFile });
});

// Anchor at the config root (chdir + load its workspace-scope env) before dispatching any
// command, so devtooie behaves the same from anywhere in the tree.
await anchorAtConfigRoot(INVOCATION_CWD);
await program.parseAsync(process.argv).catch((err: unknown) => handleShellError(err));
