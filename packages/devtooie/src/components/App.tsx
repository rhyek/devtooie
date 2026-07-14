import chalk from 'chalk';
import { render, type Instance } from 'ink';
import path from 'node:path';
import React, { useCallback, useRef, useState } from 'react';
import { getRuntimeDepsMap, getSelectablePackages, loadSelection, saveSelection } from '../lib.js';
import type { RunnerArgs } from '../runners/types.js';
import { BuildProgress, type ControlServer } from './BuildProgress.js';
import { NativeRunner } from './NativeRunner.js';
import { PackageSelector } from './PackageSelector.js';
import { setTitleSequence } from '../terminal-title.js';

type Phase =
  | { type: 'package-select' }
  | { type: 'building'; selectedNames: string[] }
  | { type: 'running'; runnerArgs: RunnerArgs };

/**
 * A mutable holder for the session's current logfile path. The run phase updates
 * `current` whenever the log is rotated (`t`) so `renderApp`'s exit closure — which
 * runs outside the React tree, after Ink has torn down — can print the path of the
 * last logfile written to.
 */
export type LogFileRef = { current: string | undefined };

export type AppProps = {
  /** Explicit `--package` selections from the CLI; non-empty bypasses the selector entirely. */
  packages?: string[];
  /** `--last-answers`: reuse the previously saved selection and skip the selector. */
  lastAnswers?: boolean;
  logFile?: string;
  /** Set by `renderApp`; the run phase keeps its `current` in sync with the active logfile. */
  logFileRef?: LogFileRef;
};

/**
 * Picks where the phase machine starts: an explicit CLI selection or a
 * `--last-answers` replay both skip straight past the interactive selector
 * into the build phase; otherwise the selector is shown first.
 */
function getInitialPhase(
  packages: string[],
  lastAnswers: boolean,
  savedSelection: string[],
): Phase {
  if (packages.length > 0) {
    return { type: 'building', selectedNames: packages };
  }
  if (lastAnswers && savedSelection.length > 0) {
    return { type: 'building', selectedNames: savedSelection };
  }
  return { type: 'package-select' };
}

/**
 * Root component: a phase state machine (`package-select` -> `building` -> `running`)
 * that owns the one thing shared across those phases — the control server, received
 * from `BuildProgress` via `onControlReady` and handed to `NativeRunner` once the
 * build completes — plus the interactive selection, persisted via `saveSelection`
 * only when it actually came from the selector (a `--package`/`--last-answers` run
 * never touches it).
 */
export function App({ packages = [], lastAnswers = false, logFile, logFileRef }: AppProps) {
  // Computed once: the registered-package catalog is fixed for the process's lifetime, and a
  // stable identity here means these props are never a reason for PackageSelector to redo
  // its own memoized derivations.
  const [items] = useState(getSelectablePackages);
  const [runtimeDeps] = useState(getRuntimeDepsMap);
  const [savedSelection] = useState(() => loadSelection() ?? []);

  const [phase, setPhase] = useState<Phase>(() =>
    getInitialPhase(packages, lastAnswers, savedSelection),
  );

  // Received from BuildProgress once its control server is listening, then handed to
  // NativeRunner for the rest of the run phase. A ref rather than state: receiving it
  // must not force a re-render, since NativeRunner's `server` prop has to keep its
  // identity for the run phase's lifetime (its watchGitBranch/poll effects tear down
  // and restart whenever `server` changes).
  const controlRef = useRef<ControlServer | null>(null);

  // Deferred here rather than inside PackageSelector so that a --package/--last-answers
  // run — which never renders the selector — can't overwrite a previously saved selection.
  const onPackagesSubmit = useCallback((selected: string[]) => {
    saveSelection(selected);
    setPhase({ type: 'building', selectedNames: selected });
  }, []);

  const onControlReady = useCallback((control: ControlServer) => {
    controlRef.current = control;
  }, []);

  const onBuildComplete = useCallback((runnerArgs: RunnerArgs) => {
    setPhase({ type: 'running', runnerArgs });
  }, []);

  switch (phase.type) {
    case 'package-select':
      return (
        <PackageSelector
          items={items}
          runtimeDeps={runtimeDeps}
          initialSelected={savedSelection}
          onSubmit={onPackagesSubmit}
        />
      );

    case 'building':
      return (
        <BuildProgress
          selectedNames={phase.selectedNames}
          logFile={logFile}
          onControlReady={onControlReady}
          onComplete={onBuildComplete}
        />
      );

    case 'running': {
      const control = controlRef.current;
      if (!control) {
        // BuildProgress always calls onControlReady before onComplete, so this is
        // unreachable in practice; fail loudly rather than hand NativeRunner a
        // server it can't use.
        throw new Error('devtooie: reached the run phase without a control server');
      }
      // phase.runnerArgs keeps its identity across re-renders (it only changes via
      // this same setPhase call, which doesn't repeat once in the run phase), so
      // NativeRunner's `args` prop is stable for as long as this phase lasts.
      return <NativeRunner args={phase.runnerArgs} server={control} logFileRef={logFileRef} />;
    }
  }
}

export type RenderAppOptions = AppProps;

/**
 * Entry point the CLI mounts to start the TUI. Ctrl+C is left to each phase's own
 * `useInput` handler (the selector exits immediately; the run phase shuts down
 * gracefully) rather than Ink's default immediate-exit behavior, and the frame
 * rate is raised well above Ink's default so a fast run of keystrokes can't land
 * between a state commit and its render.
 */
export function renderApp(options: RenderAppOptions = {}): Instance {
  // Render the whole app in the terminal's alternate screen (like vim/htop): Ink
  // owns the full viewport, the footer stays glued to the bottom via flex layout,
  // and the original terminal contents are restored on exit. Child-process logs
  // are captured into the buffer and drawn by the virtualized LogPane rather than
  // streamed onto the primary screen.
  //
  // The alternate screen otherwise leaves no trace on the primary screen, so
  // bookend the session with a line before Ink takes over and one after it tears
  // down — both land on the primary screen. The "started" line is preserved across
  // the alt-screen save/restore; the "exited" line prints once `waitUntilExit`
  // resolves, which is after Ink has restored the primary screen. Ink's own
  // teardown drives the process exit from here (NativeRunner just calls `exit()`).
  const startedAt = Date.now();
  // Threaded into the run phase, which keeps `current` pointed at the active logfile
  // (updated on rotation) so the exit line below can print the last one written to.
  const logFileRef: LogFileRef = { current: options.logFile };
  // Pin the tab/window title to the project (the config-root basename). Child dev
  // processes emit their own title sequences, but those are stripped from captured
  // output (see terminal-title.ts / process-manager.ts) so this one stays put.
  if (process.stdout.isTTY) {
    process.stdout.write(setTitleSequence(`devtooie: ${path.basename(process.cwd())}`));
  }
  process.stdout.write(`${chalk.green('▶')} ${chalk.bold('devtooie')} ${chalk.dim('started')}\n`);
  const instance = render(<App {...options} logFileRef={logFileRef} />, {
    exitOnCtrlC: false,
    maxFps: 120,
    alternateScreen: true,
  });
  void instance.waitUntilExit().finally(() => {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    let message = chalk.dim(`■ devtooie exited after ${seconds}s\n`);
    if (logFileRef.current) {
      message += chalk.dim(`  logfile: ${path.resolve(logFileRef.current)}\n`);
    }
    process.stdout.write(message, () => {
      process.exit(0);
    });
  });
  return instance;
}
