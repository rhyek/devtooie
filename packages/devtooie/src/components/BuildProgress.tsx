import React, { useEffect, useRef, useState } from 'react';
import { execa } from 'execa';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { findApp } from '../config.js';
import { startCommandServer } from '../command-server.js';
import { debugLog } from '../debug-log.js';
import { acquireDevSession } from '../dev-session.js';
import { buildRunnerArgs, getExecArgs, hasScript, resolveDeps } from '../lib.js';
import type { RunnerArgs } from '../runners/types.js';

/** The control server handed to `onControlReady`, owned by this component until the run phase takes over. */
export type ControlServer = Awaited<ReturnType<typeof startCommandServer>>;

export type BuildProgressProps = {
  selectedNames: string[];
  logFile?: string;
  onControlReady: (control: ControlServer) => void;
  onComplete: (runnerArgs: RunnerArgs) => void;
};

type BuildState =
  | { phase: 'resolving' }
  | { phase: 'building'; current: number; total: number; name: string }
  | { phase: 'handoff'; message: string }
  | { phase: 'done' }
  | { phase: 'error'; message: string };

/**
 * Shows the resolved build/runtime dependency summary for the selected
 * services, then drives the sequence that has to happen before the run
 * phase can start: hand off from any prior session, start the control
 * server, and build every dependency that needs it. The control server is
 * handed to the caller as soon as it's listening (`onControlReady`) so a
 * newer session can detect and close this one even mid-build; the fully
 * resolved run arguments are handed over once the build completes
 * (`onComplete`).
 */
export function BuildProgress({
  selectedNames,
  logFile,
  onControlReady,
  onComplete,
}: BuildProgressProps) {
  const { exit } = useApp();
  const [state, setState] = useState<BuildState>({ phase: 'resolving' });

  // The run phase takes ownership of the control server once handed off via
  // onComplete; until then, an unmount (cancelled build, build error) must
  // close it itself so a still-open server doesn't keep the process alive.
  const controlRef = useRef<ControlServer | null>(null);
  const handedOffRef = useRef(false);
  const errorExitScheduledRef = useRef(false);

  const selectedApps = selectedNames.map(findApp);
  const deps = resolveDeps(selectedApps);

  const buildDepNames = [...deps.buildSet];
  const runtimeDepNames = [...deps.runSet].filter(
    (name) => !selectedApps.some((app) => app.name === name),
  );
  const buildableApps = buildDepNames.map(findApp).filter((app) => hasScript(app, 'build'));

  useEffect(() => {
    let cancelled = false;

    async function handoffBuildRun() {
      // 1. Hand off from any already-running session before building, so it
      //    releases its ports. Best-effort: a handoff failure must never block a run.
      setState({ phase: 'handoff', message: 'checking for another running session...' });
      try {
        await acquireDevSession({
          onStatus: (message) => {
            if (!cancelled) {
              setState({ phase: 'handoff', message });
            }
          },
        });
      } catch {
        /* best-effort */
      }
      if (cancelled) {
        return;
      }

      // 2. Start the control server now (pid + quit) so a yet-newer session
      //    can detect and close this one while it builds. The run phase
      //    attaches its process manager once building finishes.
      debugLog('build: starting control server');
      const control = await startCommandServer({
        onQuit: () => {
          // No process manager yet, so there's nothing to shut down
          // gracefully — just exit. process.exit guarantees this process
          // dies so a handing-off session's wait resolves.
          exit();
          process.exit(0);
        },
      });
      if (cancelled) {
        void control.close();
        return;
      }
      controlRef.current = control;
      onControlReady(control);

      // 3. Build dependencies.
      for (let i = 0; i < buildableApps.length; i++) {
        if (cancelled) {
          return;
        }
        const app = buildableApps[i]!;
        setState({
          phase: 'building',
          current: i + 1,
          total: buildableApps.length,
          name: app.name,
        });
        try {
          const [cmd, args] = getExecArgs(app, 'build');
          await execa(cmd, args, { stdio: 'pipe', cwd: app.path });
        } catch (error) {
          if (cancelled) {
            return;
          }
          setState({
            phase: 'error',
            message: error instanceof Error ? error.message : 'Unknown build error',
          });
          return;
        }
      }
      if (cancelled) {
        return;
      }

      // 4. Run — the caller now owns the control server's lifecycle.
      setState({ phase: 'done' });
      handedOffRef.current = true;
      onComplete({ ...buildRunnerArgs(selectedApps, deps), logFile });
    }

    void handoffBuildRun();
    return () => {
      cancelled = true;
      if (!handedOffRef.current) {
        void controlRef.current?.close();
      }
    };
    // Intentionally runs once per mount: selectedNames/logFile are fixed for
    // this component's lifetime (a new selection remounts BuildProgress).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.phase === 'error') {
    if (!errorExitScheduledRef.current) {
      errorExitScheduledRef.current = true;
      // Give time for the error to render before exiting.
      setTimeout(() => {
        exit();
        process.exit(1);
      }, 100);
    }

    return (
      <Box flexDirection="column">
        <Text color="red" bold>
          Build failed
        </Text>
        <Text color="red">{state.message}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text backgroundColor="cyan" color="black" bold>
          {' devtooie '}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text bold>Selected: </Text>
        <Text>{selectedNames.join(', ')}</Text>
      </Box>

      {buildDepNames.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Build-time dependencies:</Text>
          {buildDepNames.map((name) => (
            <Text key={name} dimColor>
              {' '}
              {name}
            </Text>
          ))}
        </Box>
      )}

      {runtimeDepNames.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>Runtime dependencies:</Text>
          {runtimeDepNames.map((name) => (
            <Text key={name} dimColor>
              {'  '}
              {name} {'<-'} {deps.reasons[name] ?? 'dependency'}
            </Text>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        {state.phase === 'building' ? (
          <Text>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>{' '}
            Building dependencies ({state.current}/{state.total}): {state.name}
          </Text>
        ) : state.phase === 'handoff' ? (
          <Text>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>{' '}
            {state.message}
          </Text>
        ) : state.phase === 'done' ? (
          <Text color="green">Dependencies built.</Text>
        ) : buildableApps.length > 0 ? (
          <Text>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>{' '}
            Resolving dependencies...
          </Text>
        ) : (
          <Text color="green">No build dependencies needed.</Text>
        )}
      </Box>
    </Box>
  );
}
