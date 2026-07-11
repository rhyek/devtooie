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
import { DEFAULT_ENV_FILES, resolveEnv } from './env.js';
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
  getDefaultLogFile,
  getExecArgs,
  hasScript,
  loadSelection,
  resetSelection,
  resolveDeps,
  saveSelection,
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
  .description('print the build/dev/runtime deps for one or more --package names, as JSON')
  .action(async () => {
    // Reuses the root `-p/--package` option rather than redeclaring its own: commander
    // resolves a single option's value against whichever command owns it, so a second,
    // identically-flagged option on this subcommand would just shadow the root one and
    // silently swallow its value.
    const names = program.opts<RootOptions>().package;
    if (names.length === 0) {
      console.error('resolvedeps requires at least one --package <name>');
      process.exit(1);
    }
    await loadConfigOrExit();
    validatePackageNames(names);
    const packages = names.map((n) => findPackage(n));
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
  .command('env')
  .description("resolve a package's .env files, then print them or run a command with them")
  .option(
    '--dir <relativeDir>',
    'package dir to resolve .env files for, relative to the workspace root; defaults to the current directory',
  )
  .argument('[command...]', 'command to run with the resolved envs (pass after `--`)')
  .action(async (command: string[], opts: { dir?: string }) => {
    // Discover the workspace root (nearest ancestor with a devtooie config) so this works
    // from anywhere; fall back to cwd + default file list when there's no project.
    const startCwd = process.cwd();
    const workspaceRoot = findWorkspaceRoot(startCwd) ?? startCwd;
    let files = DEFAULT_ENV_FILES;
    try {
      await loadConfig(workspaceRoot);
      files = getLoadedConfig()?.envFiles ?? DEFAULT_ENV_FILES;
    } catch {
      /* no devtooie config here — use the default file list */
    }

    // --dir is relative to the workspace root (matching config `relativeDir`s); with no
    // --dir, default to the current directory expressed relative to that root.
    const relativeDir = opts.dir ?? (path.relative(workspaceRoot, startCwd) || '.');

    const { env } = resolveEnv({ cwd: workspaceRoot, relativeDir, files });

    if (command.length > 0) {
      const [cmd, ...args] = command;
      const result = await execa(cmd!, args, {
        cwd: process.cwd(),
        env: Object.assign({}, process.env, env),
        stdio: 'inherit',
        reject: false,
      });
      process.exit(result.exitCode ?? 1);
    }

    for (const key of Object.keys(env).sort()) {
      console.log(`${key}=${env[key]}`);
    }
    process.exit(0);
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

await program.parseAsync(process.argv).catch((err: unknown) => handleShellError(err));
