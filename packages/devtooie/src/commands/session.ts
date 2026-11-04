import path from 'node:path';
import chalk from 'chalk';
import { startCommandServer } from '../command-server.js';
import { findService, getLoadedConfig } from '../config.js';
import { acquireDevSession, startSessionDevReverseProxy } from '../dev-session.js';
import { currentMode } from '../env.js';
import { handleShellError } from '../errors.js';
import { findSession, unresponsiveMessage } from '../find-session.js';
import { createInfraReporter } from '../infra/report.js';
import { InfraFailedError, runSessionInfra } from '../infra/session.js';
import { InfraError } from '../infra/types.js';
import {
  buildRunnerArgs,
  getDefaultLogFile,
  hasDevScript,
  resolveDeps,
  saveSelection,
} from '../lib.js';
import { findConfigPath } from '../load-config.js';
import { createPlainStatusReporter } from '../plain-status.js';
import { renderAppInProduction } from '../render-app-production.js';
import { runPlain } from '../runners/plain.js';
import type { SessionInfra } from '../runners/types.js';
import { sessionId } from '../running.js';
import type { StackMessage } from '../stack.js';
import { preflightTakeover } from '../takeover.js';
import { buildDeps } from './build.js';
import { type RootOptions, resolveSelectedNamesOrExit } from './default.js';

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

/**
 * Why a forked session (`startStack()`'s) must not start, or `undefined` when it may: a session of
 * its mode is running, or recorded alive, and `--kill-others` didn't say to quit it. A forked
 * session never quits one unasked, whoever started it.
 */
async function forkedSessionRefusal(
  configPath: string,
  killOthers: boolean,
): Promise<string | undefined> {
  if (killOthers) {
    return undefined;
  }
  const mode = currentMode();
  const found = await findSession({
    workspaceDir: process.cwd(),
    mode,
    configPath,
    apiPort: getLoadedConfig()?.apiPort,
  });
  if (found.kind === 'running') {
    return `a ${mode} session of this workspace is already running (pid ${String(found.status.pid)}); quit it, or start with killOthers to have it quit first`; // oxfmt-ignore
  }
  if (found.kind === 'unresponsive') {
    return `${unresponsiveMessage(found, mode)}; stop it, or start with killOthers to have it killed`;
  }
  return undefined;
}

/** What a session started for `names` runs and waits on: their dev processes and their runtime deps'. */
function servicesToWaitOn(names: string[]): string[] {
  const runSet = [...resolveDeps(names.map((n) => findService(n))).runSet];
  return runSet.filter((name) => {
    const pkg = findService(name);
    return hasDevScript(pkg) && (names.includes(name) || pkg.autostart !== false);
  });
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
  // Forked by `startStack()`: it ends with its parent, and reports to it over the channel.
  const forked = process.channel !== undefined;
  if (forked) {
    const refusal = await forkedSessionRefusal(configPath, opts.killOthers);
    if (refusal) {
      console.error(`devtooie: ${refusal}`);
      process.exit(1);
    }
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
      if (forked) {
        const message: StackMessage = {
          type: 'started',
          pid: process.pid,
          port: server.port,
          sessionId: sessionId(),
          logFile,
          services: servicesToWaitOn(names),
        };
        process.send?.(message);
      }
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
        // A forked session's output is in its log; its parent has no screen to stream it to.
        { echo: !forked },
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
