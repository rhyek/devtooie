import chalk from 'chalk';
import type { startCommandServer } from '../command-server.js';
import { watchGitBranch } from '../git-watch.js';
import { ProcessManager } from '../process-manager.js';
import { SHUTDOWN_TIMEOUT_MS } from '../shutdown-timing.js';
import type { RunnerArgs } from './types.js';

/**
 * Drives a run session with no interactive UI: every selected package streams
 * its output as plain, colour-prefixed lines to stdout/stderr. The session
 * ends on SIGINT/SIGTERM, a `/command/quit` request against the control
 * server, or a detected git branch change — all funnelled through the same
 * graceful shutdown path, with a second signal forcing an immediate exit.
 */
export async function runPlain(
  args: RunnerArgs,
  server: Awaited<ReturnType<typeof startCommandServer>>,
): Promise<void> {
  const manager = new ProcessManager(args, { plain: true });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      // Already tearing down and asked again — stop waiting and force it.
      manager.forceKillAll();
      process.exit(1);
    }
    shuttingDown = true;
    stopBranchWatch();
    await Promise.race([
      manager.shutdownAll(),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
    // Packages are down and their ports freed — ack any blocking `/command/quit`
    // (e.g. a newer session handing off) before closing the server below.
    server.ackQuit();
    await server.close();
    manager.dispose();
    process.exit(0);
  };

  // Attach before starting packages so status/restart/rebuild requests are
  // servable the moment anything spawns. Also take over `/command/quit`
  // routing from whatever handler the server was constructed with (typically
  // a hard exit, since there's no process manager yet at that point), so a
  // quit request received during this session goes through the graceful
  // shutdown above instead.
  server.attach(manager);
  server.setOnQuit(() => void shutdown());
  manager.startAll();

  const stopBranchWatch = watchGitBranch({
    onChange: (from, to) => {
      manager.logSystem(chalk.yellow(`git branch changed (${from} → ${to}), shutting down`));
      void shutdown();
    },
  });

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // This promise only settles by way of shutdown() calling process.exit()
  // itself, so it simply keeps the runner's returned promise pending for the
  // lifetime of the session.
  await new Promise<void>(() => {
    /* resolved only via process.exit() inside shutdown() */
  });
}
