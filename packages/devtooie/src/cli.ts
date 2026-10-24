#!/usr/bin/env node
import { Command, Option } from 'commander';
import type { RootOptions } from './commands/default.js';
import { rootOptionsRefusal } from './commands/root-options.js';
import { captureShellEnv, dropInjectedEnv, resolveMode } from './env.js';
import { handleShellError } from './errors.js';
import { passthroughArgs } from './infra/argv.js';
import { findWorkspaceRoot } from './load-config.js';

// The entry point: Commander wiring only. What a command runs lives under `commands/` and is
// imported by its action, so a command loads its own code and nothing else's — `--help` and
// `logs` don't pay for the config, `exec` doesn't pay for a session.

/**
 * The directory devtooie was invoked from, captured before {@link anchorAtWorkspaceRoot} may
 * `chdir` us to the config root. `exec` and `run` use it to figure out which package you're
 * "inside".
 */
const INVOCATION_CWD = process.cwd();

// First of all: a devtooie started from a process another devtooie started inherits that one's
// `.env` values and `PORT`. They are not this invocation's ambient environment (see
// `INJECTED_ENV_VAR`), so drop them before the mode, or anything else, is read from it.
dropInjectedEnv();

// Resolved from raw argv and published to the environment before anything else runs: the config
// (whose `port`/`urls` callbacks resolve `.env` files) is loaded by the command's action, which
// Commander only reaches after parsing. Writing it back also hands every child process the mode
// for free, the way Vite exposes MODE.
try {
  process.env.DEVTOOIE_MODE = resolveMode(process.argv);
} catch (err) {
  // Runs before Commander, so there's no usage output to lean on — just say what's wrong.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Published alongside it, for the config's callbacks and every child process: the directory
// devtooie was invoked in and, once anchorAtWorkspaceRoot finds it, the workspace root. Both
// describe this invocation, so a value inherited from a devtooie that started this one is dropped.
process.env.DEVTOOIE_CWD = INVOCATION_CWD;
delete process.env.DEVTOOIE_WORKSPACE_DIR;

/**
 * Very early step (runs for every command): find the workspace root (nearest ancestor with a
 * devtooie config) and `chdir` into it, so devtooie behaves identically from any subdirectory.
 * A no-op when there's no config (e.g. `devtooie init` in a fresh repo). The config itself is
 * loaded, and the workspace's `.env` merged into our own environment, by the commands that use
 * them (see `commands/workspace.ts`).
 */
function anchorAtWorkspaceRoot(invocationCwd: string): void {
  const root = findWorkspaceRoot(invocationCwd);
  if (!root) {
    return;
  }
  if (root !== process.cwd()) {
    process.chdir(root);
  }
  process.env.DEVTOOIE_WORKSPACE_DIR = root;
  // Before anything puts file values into `process.env`: what is there now is what the shell
  // handed us, and only that may win over a `.env` file (see captureShellEnv).
  captureShellEnv();
}

/** Commander option-parser for repeatable `-s/--service <name>` flags. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** What `exec` and `run` take from the root options. */
const oneOffOptions = () => {
  const { service: packageNames, logDir } = program.opts<RootOptions>();
  return { invocationCwd: INVOCATION_CWD, packageNames, logDir };
};

// ---------------------------------------------------------------------------
// Commander wiring
// ---------------------------------------------------------------------------

// `--mode`, declared on the root and again on each subcommand that takes it (see the note on
// `exec` for why both).
const MODE_FLAGS = '-m, --mode <name>';
const MODE_HELP =
  'environment mode selecting the .env.<mode> files to load (default: "development")';

const program = new Command()
  .name('devtooie')
  .description("Dependency-aware CLI for a monorepo's local dev services")
  .option(
    '-s, --service <name>',
    'service to run (repeatable, bypasses the interactive selector)',
    collect,
    [],
  )
  .option(MODE_FLAGS, MODE_HELP)
  .option('--ui', 'run the interactive TUI (default)')
  .option(
    '--headless',
    'run without the TUI, streaming logs to stdout (needs -s or --last-answers)',
  )
  .option('--detach', 'with --headless: start the session in the background and return')
  .option('--wait', 'with --detach: return once infra and every service is healthy')
  .option(
    '--wait-timeout <seconds>',
    'with --wait: how long to wait before failing (default: 300)',
    (value) => Number(value),
  )
  // Not shown: only there to name its spelling, `--headless`.
  .addOption(new Option('--plain').hideHelp())
  // Not shown: what `--detach` starts its background session with (see commands/detach.ts).
  .addOption(new Option('--detached-session').hideHelp())
  .option('--last-answers', 'skip the selector and reuse the last saved selection', false)
  .option('--phase <phase>', 'pipeline phase: "dev" (default) or "build"', 'dev')
  .option('--build', 'build the selected services + their build-time deps, then exit', false)
  .option(
    '--rebuild',
    "like --build, but clears each build target's dist/ first (implies --build)",
    false,
  )
  .option(
    '--log-dir <dir>',
    'write the timestamped session log into this directory (default: node_modules/.devtooie/logs/<mode>/)',
  )
  .option(
    '--kill-others',
    "quit the devtooie session already running for this project in the same mode instead of asking (agents: don't pass this unprompted)",
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
    const { runInit } = await import('./init.js');
    await runInit({ yes: opts.yes });
  });

program
  .command('reset')
  .description('clear the saved service selection')
  .action(async () => {
    const { resetSelection } = await import('./lib.js');
    resetSelection();
    console.log('Selection reset.');
    process.exit(0);
  });

program
  .command('resolvedeps')
  .description('print the build/dev/runtime deps for a single service, as JSON')
  .argument('<service>', 'configured service name to resolve dependencies for')
  .action(async (packageName: string) => {
    const { resolveDepsCommand } = await import('./commands/inspect.js');
    await resolveDepsCommand(packageName);
  });

program
  .command('show-config')
  .description(
    'print the fully resolved config as JSON (what a running session reports on GET /query/status) — no session needed',
  )
  // Declared here too so `devtooie show-config --mode test` works (see `exec`); the config
  // resolves against that mode's `.env` files, which is what a callback `port` reads.
  .option(MODE_FLAGS, MODE_HELP)
  .action(async () => {
    const { showConfig } = await import('./commands/inspect.js');
    await showConfig();
  });

program
  .command('exec')
  .description(
    "run a one-off command with a service's environment (its dir + resolved .env); service inferred from the cwd or named with -s/--service",
  )
  // Also declared on the root, but Commander rejects a root-only option that appears after a
  // subcommand — so both `devtooie --mode test exec …` and `devtooie exec --mode test …` work.
  // resolveMode already read it off raw argv; this declaration is for --help and validation.
  .option(MODE_FLAGS, MODE_HELP)
  .argument('[command...]', 'the command to run, after `--`')
  .action(async (command: string[]) => {
    const { runExec } = await import('./commands/one-off.js');
    await runExec(command, oneOffOptions());
  });

program
  .command('run')
  .description(
    "run one of a service's scripts or make targets with its environment (its dir + resolved .env); service inferred from the cwd or named with -s/--service",
  )
  .option(MODE_FLAGS, MODE_HELP) // see `exec`
  .argument('<script>', 'the package.json script or make target to run')
  .argument('[args...]', 'arguments forwarded to it, after `--`')
  .action(async (script: string, args: string[]) => {
    const { runScriptCommand } = await import('./commands/one-off.js');
    await runScriptCommand(script, args, oneOffOptions());
  });

program
  .command('logs')
  .description(
    "print the logfile of the mode's dev session (queried from the running instance, else the newest under node_modules/.devtooie/logs/<mode>/)",
  )
  .option(MODE_FLAGS, MODE_HELP) // see `exec`
  .option(
    '-f, --follow',
    'stream new lines live (native `tail -f`) instead of printing the file and exiting',
  )
  .option('--path', 'print the resolved logfile path instead of its contents, then exit')
  .action(async (opts: { follow?: boolean; path?: boolean }) => {
    const { runLogs } = await import('./commands/logs.js');
    await runLogs(opts);
  });

// `infra`: the services the packages need but that aren't packages (see `commands/infra.ts`).
const infra = program
  .command('infra')
  .description(
    'bring up, tear down, or drive the infrastructure declared under `infra` (databases, caches, …)',
  )
  .option(MODE_FLAGS, MODE_HELP);

infra
  .command('up')
  .description(
    'start the services (all, or the ones named), wait until they are ready, then exit; they keep running',
  )
  .argument('[services...]', 'services to start (default: all)')
  .option('--reset', 'destroy the services first, then start them clean', false)
  .option(MODE_FLAGS, MODE_HELP)
  .action(async (services: string[], opts: { reset: boolean }) => {
    const { runInfraAction } = await import('./commands/infra.js');
    await runInfraAction('up', { services, reset: opts.reset });
  });

infra
  .command('down')
  .description('stop and remove the containers (all, or the ones named); their data is kept')
  .argument('[services...]', 'services to stop (default: all)')
  .option(MODE_FLAGS, MODE_HELP)
  .action(async (services: string[]) => {
    const { runInfraDown } = await import('./commands/infra.js');
    await runInfraDown(services);
  });

infra
  .command('destroy')
  .description(
    'remove the services and their data: the ones named, or — with none named — the whole project (containers, volumes, networks)',
  )
  .argument('[services...]', 'services to destroy (default: everything)')
  .option(MODE_FLAGS, MODE_HELP)
  .action(async (services: string[]) => {
    const { runInfraAction } = await import('./commands/infra.js');
    await runInfraAction('destroy', { services });
  });

// Listed for --help. A real invocation never reaches this action: it's dispatched from raw argv
// before Commander parses (see the bottom of this file), because nothing after the provider word
// is devtooie's to interpret — not `-m`, not `-p`, not `--help`.
infra
  .command('docker-compose')
  .description(
    'run `docker compose` itself against this project and mode — everything after it goes to Compose untouched (put --mode before it)',
  )
  .argument('[args...]', 'arguments for `docker compose`')
  .allowUnknownOption()
  .allowExcessArguments()
  .helpOption(false)
  .action(async (args: string[]) => {
    await runInfraPassthrough('docker-compose', args);
  });

/** `infra <provider> …`: the provider's own tool, bound to this project and mode. */
async function runInfraPassthrough(provider: string, args: string[]): Promise<never> {
  const infraCommands = await import('./commands/infra.js');
  return infraCommands.runInfraPassthrough(provider, args, INVOCATION_CWD);
}

// The default action, run only when no subcommand matched.
program.action(async () => {
  const opts = program.opts<RootOptions>();

  const refusal = rootOptionsRefusal(opts);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }

  const { runDefaultAction } = await import('./commands/default.js');
  await runDefaultAction(opts);
});

// Anchor at the workspace root before dispatching any command, so devtooie behaves the same
// from anywhere in the tree.
anchorAtWorkspaceRoot(INVOCATION_CWD);
const passthrough = passthroughArgs(process.argv);
if (passthrough) {
  await runInfraPassthrough(passthrough.provider, passthrough.args);
}
await program.parseAsync(process.argv).catch((err: unknown) => handleShellError(err));
