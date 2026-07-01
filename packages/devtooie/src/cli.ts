#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { Command } from 'commander';
import { execa } from 'execa';
import { renderApp } from './components/App.js';
import { startCommandServer } from './command-server.js';
import { type AnyAppConfig, findApp, getRegisteredApps } from './config.js';
import { acquireDevSession } from './dev-session.js';
import { handleShellError } from './errors.js';
import { runInit } from './init.js';
import { NoProjectConfigError, loadServices } from './load-config.js';
import {
  DepType,
  buildRunnerArgs,
  getExecArgs,
  getStateDir,
  hasScript,
  loadSelection,
  resetSelection,
  resolveDeps,
  saveSelection,
} from './lib.js';
import { getProjectConfig } from './project-config.js';
import { runPlain } from './runners/plain.js';
import { refreshSkillIfStale } from './skill.js';
import { runTypegen } from './typegen.js';

interface RootOptions {
  service: string[];
  ui?: boolean;
  plain?: boolean;
  lastAnswers: boolean;
  phase: string;
  build: boolean;
  rebuild: boolean;
  logfile?: string;
}

/** Commander option-parser for repeatable `-s/--service <name>` flags. */
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

/** Loads `devtooie.yaml` + the services module, printing a clear hint and exiting 1 if there is none. */
async function loadServicesOrExit(): Promise<AnyAppConfig[]> {
  try {
    return await loadServices();
  } catch (err) {
    if (err instanceof NoProjectConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

/** Exits with a clear message if any of `names` isn't a registered app. */
function validateServiceNames(names: string[]): void {
  const registered = new Set(getRegisteredApps().map((a) => a.name));
  const unknown = names.filter((n) => !registered.has(n));
  if (unknown.length > 0) {
    console.error(`Unknown service${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
    process.exit(1);
  }
}

/**
 * Resolves the service names for a non-interactive phase (build/plain), which — unlike
 * the UI — has no selector to fall back on: an explicit `--service` wins, then a saved
 * `--last-answers` selection, otherwise this exits with a hint naming `usage`.
 */
function resolveSelectedNames(
  opts: { service: string[]; lastAnswers: boolean },
  usage: string,
): string[] {
  if (opts.service.length > 0) return opts.service;
  if (opts.lastAnswers) {
    const saved = loadSelection() ?? [];
    if (saved.length === 0) {
      console.error('No saved selection found — run once without --last-answers first.');
      process.exit(1);
    }
    validateServiceNames(saved);
    return saved;
  }
  console.error(`${usage} requires --service or --last-answers.`);
  process.exit(1);
}

async function clearDist(app: AnyAppConfig): Promise<void> {
  await execa('rm', ['-rf', path.join(app.path, 'dist')], { reject: false });
}

async function buildOne(app: AnyAppConfig, script: string): Promise<void> {
  const [cmd, args] = getExecArgs(app, script);
  await execa(cmd, args, { stdio: 'inherit', cwd: app.path });
}

/** Builds every buildable dep in `deps.buildSet`, in dependency order, with console output. */
async function buildDeps(deps: ReturnType<typeof resolveDeps>): Promise<void> {
  const depApps = [...deps.buildSet].map((n) => findApp(n)).filter((a) => hasScript(a, 'build'));
  for (const [i, app] of depApps.entries()) {
    console.log(
      `${chalk.blue('▶')} building dep (${i + 1}/${depApps.length}): ${chalk.bold(app.name)}`,
    );
    await buildOne(app, 'build');
  }
  if (depApps.length > 0) console.log(chalk.green('✔ dependencies built'));
}

/** `--phase build` / `--build` / `--rebuild`: build deps then the selected services, then exit. */
async function runBuildPhase(names: string[], rebuild: boolean): Promise<void> {
  const apps = names.map((n) => findApp(n));
  const deps = resolveDeps(apps, [DepType.BUILD]);
  const depApps = [...deps.buildSet].map((n) => findApp(n)).filter((a) => hasScript(a, 'build'));
  const selectedApps = apps.filter((a) => hasScript(a, 'build') || hasScript(a, 'build:clean'));

  if (rebuild) {
    console.log(chalk.blue('▶ clearing dist/'));
    for (const app of [...depApps, ...selectedApps]) await clearDist(app);
  }

  for (const [i, app] of depApps.entries()) {
    console.log(
      `${chalk.blue('▶')} building dep (${i + 1}/${depApps.length}): ${chalk.bold(app.name)}`,
    );
    await buildOne(app, 'build');
  }

  for (const app of selectedApps) {
    const script = rebuild && hasScript(app, 'build:clean') ? 'build:clean' : 'build';
    console.log(`${chalk.blue('▶')} building: ${chalk.bold(app.name)}`);
    await buildOne(app, script);
  }

  console.log(chalk.green('✔ build complete'));
}

// ---------------------------------------------------------------------------
// Commander wiring
// ---------------------------------------------------------------------------

const program = new Command()
  .name('devtooie')
  .description("Dependency-aware CLI for a monorepo's local dev services")
  .option(
    '-s, --service <name>',
    'service to run (repeatable, bypasses the interactive selector)',
    collect,
    [],
  )
  .option('--ui', 'run the interactive TUI (default)')
  .option('--plain', 'run without the TUI, streaming logs to stdout')
  .option('--last-answers', 'skip the selector and reuse the last saved selection', false)
  .option('--phase <phase>', 'pipeline phase: "dev" (default) or "build"', 'dev')
  .option('--build', 'build the selected services + their build-time deps, then exit', false)
  .option(
    '--rebuild',
    "like --build, but clears each build target's dist/ first (implies --build)",
    false,
  )
  .option('--logfile <path>', 'write all service output to this file (truncated on each run)');

program
  .command('init')
  .description('interactively set up devtooie.yaml (and, optionally, the agent skill)')
  .action(async () => {
    await runInit();
  });

program
  .command('reset')
  .description('clear the saved service selection')
  .action(() => {
    resetSelection();
    console.log('Selection reset.');
    process.exit(0);
  });

program
  .command('resolvedeps')
  .description('print the build/dev/runtime deps for one or more --service names, as JSON')
  .action(async () => {
    // Reuses the root `-s/--service` option rather than redeclaring its own: commander
    // resolves a single option's value against whichever command owns it, so a second,
    // identically-flagged option on this subcommand would just shadow the root one and
    // silently swallow its value.
    const names = program.opts<RootOptions>().service;
    if (names.length === 0) {
      console.error('resolvedeps requires at least one --service <name>');
      process.exit(1);
    }
    await loadServicesOrExit();
    validateServiceNames(names);
    const apps = names.map((n) => findApp(n));
    const selectedNames = new Set(apps.map((a) => a.name));

    const build = resolveDeps(apps, [DepType.BUILD]);
    const dev = resolveDeps(apps, [DepType.DEV]);
    const runtime = resolveDeps(apps, [DepType.RUNTIME]);

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
  .command('typegen')
  .description('regenerate devtooie-env.d.ts from devtooie.yaml')
  .option('--out <path>', 'output path for the generated declaration file')
  .action((cmdOpts: { out?: string }) => {
    runTypegen({ out: cmdOpts.out });
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

  await loadServicesOrExit();

  // Best-effort: neither typegen nor a skill refresh should ever block a run.
  try {
    runTypegen();
  } catch (err) {
    console.error('devtooie: typegen failed (non-fatal):', err);
  }
  try {
    if (getProjectConfig()?.skill) {
      refreshSkillIfStale({ cwd: process.cwd(), version: readOwnVersion() });
    }
  } catch (err) {
    console.error('devtooie: skill refresh failed (non-fatal):', err);
  }

  // Validate --service names before mounting/running anything.
  validateServiceNames(opts.service);

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

  const logFile = opts.logfile ?? path.join(getStateDir(), 'devlog.txt');

  if (opts.plain) {
    const names = resolveSelectedNames(opts, '--plain');
    saveSelection(names);
    await acquireDevSession();
    const server = await startCommandServer({ onQuit: () => process.exit(0) });
    const apps = names.map((n) => findApp(n));
    const deps = resolveDeps(apps);
    try {
      await buildDeps(deps);
      await runPlain({ ...buildRunnerArgs(apps, deps), logFile }, server);
    } catch (err) {
      handleShellError(err);
    }
    return;
  }

  // --ui (default): App owns the selector -> build -> run phases and the control server.
  renderApp({ services: opts.service, lastAnswers: opts.lastAnswers, logFile });
});

await program.parseAsync(process.argv);
