import path from 'node:path';
import chalk from 'chalk';
import { startCommandServer } from '../command-server.js';
import { findService, getLoadedConfig } from '../config.js';
import { connectSessionControl } from '../control-client.js';
import { acquireDevSession, isProcessAlive, startSessionDevReverseProxy } from '../dev-session.js';
import { currentMode } from '../env.js';
import { handleShellError } from '../errors.js';
import { createInfraReporter } from '../infra/report.js';
import { InfraFailedError, runSessionInfra } from '../infra/session.js';
import { InfraError } from '../infra/types.js';
import { buildRunnerArgs, getDefaultLogFile, resolveDeps, saveSelection } from '../lib.js';
import { findConfigPath } from '../load-config.js';
import { createPlainStatusReporter } from '../plain-status.js';
import { renderAppInProduction } from '../render-app-production.js';
import { runPlain } from '../runners/plain.js';
import type { SessionInfra } from '../runners/types.js';
import { readRunning } from '../running.js';
import { preflightTakeover } from '../takeover.js';
import { buildDeps } from './build.js';
import { type RootOptions, resolveSelectedNamesOrExit } from './default.js';
import { DETACHED_FOUND_SESSION_EXIT } from './detach.js';

// A dev session: `--headless`, streaming to stdout, or the TUI.

/**
 * The infra step of a `--headless` session: the same `up` as `devtooie infra up`, reported the same
 * way, between the build output and the first package line. Exits 1 if a service doesn't come
 * up — the packages must not start against infrastructure that isn't there.
 */
async function runPlainInfraOrExit(): Promise<SessionInfra | undefined> {
  const reporter = createInfraReporter({ mode: currentMode() });
  try {
    const infra = await runSessionInfra(reporter.onEvent);
    if (infra) {
      reporter.finish({ ok: true, services: [] }, 'up');
    }
    return infra;
  } catch (err) {
    if (err instanceof InfraFailedError) {
      reporter.finish(err.summary, 'up');
      process.exit(1);
    }
    if (err instanceof InfraError) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
    throw err;
  }
}

/** Whether this config's session in the active mode is running: answering, or recorded alive. */
async function sessionOfThisModeIsRunning(configPath: string): Promise<boolean> {
  const mode = currentMode();
  const workspaceDir = process.cwd();
  const client = await connectSessionControl({
    workspaceDir,
    configPath,
    mode,
    apiPort: getLoadedConfig()?.apiPort,
  });
  if (client) {
    return true;
  }
  const record = readRunning(workspaceDir, mode);
  return record !== null && isProcessAlive(record.pid);
}

/** Starts the session the options ask for. It ends by exiting the process. */
export async function runDevSession(opts: RootOptions): Promise<void> {
  const logFile = getDefaultLogFile(opts.logDir);
  const configPath =
    findConfigPath(process.cwd()) ?? path.join(process.cwd(), 'devtooie.config.ts');

  // Resolved before the preflight below, so a `--headless` invocation that can't name its
  // packages fails with that usage error instead of first asking whether to quit a session
  // it was never going to start.
  const plainNames = opts.headless ? resolveSelectedNamesOrExit(opts, '--headless') : null;

  // Settle what happens to a session already running for this project *before* anything
  // starts. Acquisition frees the dev ports by killing whatever in this workspace holds
  // them, so once it begins the other session is gone either way — declining has to mean
  // exiting here. Shared by both the --headless and TUI paths, and deliberately ahead of the
  // TUI's alternate screen, so the prompt is an ordinary terminal prompt.
  if (opts.detachedSession && (await sessionOfThisModeIsRunning(configPath))) {
    console.error('devtooie: a session of this mode is already running; the --detach reuses it.');
    process.exit(DETACHED_FOUND_SESSION_EXIT);
  }
  const takeover = await preflightTakeover({
    configPath,
    killOthers: opts.killOthers,
    apiPortOverride: getLoadedConfig()?.apiPort,
  });
  if (!takeover.ok) {
    console.error(takeover.message);
    process.exit(1);
  }

  if (opts.headless) {
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
      // The dev reverse proxy (if configured) binds before anything else starts, so a foreign
      // holder of its port fails the run here rather than after the packages are up.
      const devReverseProxy = await startSessionDevReverseProxy({ controlApiPort: port });
      statusReporter.done();
      const server = await startCommandServer({
        onQuit: () => process.exit(0),
        port,
        configPath,
        logFile,
        devReverseProxy,
      });
      const packages = names.map((n) => findService(n));
      const deps = resolveDeps(packages);
      await buildDeps(deps);
      const infra = await runPlainInfraOrExit();
      // The services are ready: the proxy forwards to them from here on.
      devReverseProxy?.markInfraReady();
      await runPlain(
        { ...buildRunnerArgs(packages, deps), logFile, infra },
        server,
        devReverseProxy,
      );
    } catch (err) {
      handleShellError(err);
    }
    return;
  }

  // --ui (default): App owns the selector -> build -> run phases and the control server.
  // Loaded via renderAppInProduction so React (and thus all of Ink) runs in its
  // production build — its development build leaks User-Timing entries on every render
  // (see render-app-production.ts). Child dev processes still inherit the shell's NODE_ENV.
  await renderAppInProduction({ packages: opts.service, lastAnswers: opts.lastAnswers, logFile });
}
