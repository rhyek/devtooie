import React, { useEffect, useRef, useState } from 'react';
import path from 'node:path';
import { execa } from 'execa';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { findPackage, getRegisteredPackages, getLoadedConfig } from '../config.js';
import { startCommandServer } from '../command-server.js';
import { debugLog } from '../debug-log.js';
import { acquireDevSession } from '../dev-session.js';
import { findConfigPath } from '../load-config.js';
import { pickRandomPort } from '../running.js';
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
 * packages, then drives the sequence that has to happen before the run
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

  const selectedPackages = selectedNames.map(findPackage);
  const deps = resolveDeps(selectedPackages);

  const buildDepNames = [...deps.buildSet];
  const runtimeDepNames = [...deps.runSet].filter(
    (name) => !selectedPackages.some((pkg) => pkg.name === name),
  );
  // Unlike selectedNames (validated by the caller), buildDepNames come from
  // deps.build/deps.dev config and may contain a typo'd, unregistered pkg
  // name; a non-throwing lookup lets that surface as the error phase instead
  // of crashing the component, mirroring how resolveDeps tolerates it.
  const buildablePackages = buildDepNames
    .map((name) => getRegisteredPackages().find((pkg) => pkg.name === name))
    .filter((pkg) => pkg !== undefined)
    .filter((pkg) => hasScript(pkg, 'build'));

  useEffect(() => {
    let cancelled = false;

    async function handoffBuildRun() {
      // Guard the whole flow: any failure here (handoff, control-server
      // start, or build) must land the component in the error phase rather
      // than escape as an unhandled rejection from the top-level `void
      // handoffBuildRun()` call below.
      try {
        // 1. Hand off from any already-running session before building, so it
        //    releases its ports. Best-effort: a handoff failure must never block a run.
        setState({ phase: 'handoff', message: 'checking for another running session...' });
        const configPath =
          findConfigPath(process.cwd()) ?? path.join(process.cwd(), 'devtooie.config.ts');
        let port: number | undefined;
        try {
          port = await acquireDevSession({
            configPath,
            apiPortOverride: getLoadedConfig()?.apiPort,
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
        //    attaches its process manager once building finishes. If the handoff
        //    above failed, fall back to a random port so the server can still bind.
        debugLog('build: starting control server');
        const control = await startCommandServer({
          port: port ?? pickRandomPort(),
          configPath,
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
        for (let i = 0; i < buildablePackages.length; i++) {
          if (cancelled) {
            return;
          }
          const pkg = buildablePackages[i]!;
          setState({
            phase: 'building',
            current: i + 1,
            total: buildablePackages.length,
            name: pkg.name,
          });
          try {
            const [cmd, args] = getExecArgs(pkg, 'build');
            await execa(cmd, args, { stdio: 'pipe', cwd: pkg.path });
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
        onComplete({ ...buildRunnerArgs(selectedPackages, deps), logFile });
      } catch (error) {
        if (cancelled) {
          return;
        }
        setState({
          phase: 'error',
          message: error instanceof Error ? error.message : 'Unknown build error',
        });
      }
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

  useEffect(() => {
    if (state.phase !== 'error') {
      return;
    }
    // Give time for the error to render before exiting.
    const timer = setTimeout(() => {
      exit();
      process.exit(1);
    }, 100);
    return () => clearTimeout(timer);
  }, [state.phase, exit]);

  if (state.phase === 'error') {
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
        ) : buildablePackages.length > 0 ? (
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
