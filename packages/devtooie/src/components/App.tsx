import { render, type Instance } from 'ink';
import React, { useCallback, useRef, useState } from 'react';
import { getRuntimeDepsMap, getServiceGroups, loadSelection, saveSelection } from '../lib.js';
import type { RunnerArgs } from '../runners/types.js';
import { BuildProgress, type ControlServer } from './BuildProgress.js';
import { NativeRunner } from './NativeRunner.js';
import { ServiceSelector, type ServiceSelectorGroup } from './ServiceSelector.js';

type Phase =
  | { type: 'service-select' }
  | { type: 'building'; selectedNames: string[] }
  | { type: 'running'; runnerArgs: RunnerArgs };

export type AppProps = {
  /** Explicit `--service` selections from the CLI; non-empty bypasses the selector entirely. */
  services?: string[];
  /** `--last-answers`: reuse the previously saved selection and skip the selector. */
  lastAnswers?: boolean;
  logFile?: string;
};

/**
 * Picks where the phase machine starts: an explicit CLI selection or a
 * `--last-answers` replay both skip straight past the interactive selector
 * into the build phase; otherwise the selector is shown first.
 */
function getInitialPhase(
  services: string[],
  lastAnswers: boolean,
  savedSelection: string[],
): Phase {
  if (services.length > 0) {
    return { type: 'building', selectedNames: services };
  }
  if (lastAnswers && savedSelection.length > 0) {
    return { type: 'building', selectedNames: savedSelection };
  }
  return { type: 'service-select' };
}

function toSelectorGroups(groups: ReturnType<typeof getServiceGroups>): ServiceSelectorGroup[] {
  return [
    { label: 'Backend', items: groups.backend },
    { label: 'Frontend', items: groups.frontend },
  ];
}

/**
 * Root component: a phase state machine (`service-select` -> `building` -> `running`)
 * that owns the one thing shared across those phases — the control server, received
 * from `BuildProgress` via `onControlReady` and handed to `NativeRunner` once the
 * build completes — plus the interactive selection, persisted via `saveSelection`
 * only when it actually came from the selector (a `--service`/`--last-answers` run
 * never touches it).
 */
export function App({ services = [], lastAnswers = false, logFile }: AppProps) {
  // Computed once: the registered-app catalog is fixed for the process's lifetime, and a
  // stable identity here means these props are never a reason for ServiceSelector to redo
  // its own memoized derivations.
  const [groups] = useState(() => toSelectorGroups(getServiceGroups()));
  const [runtimeDeps] = useState(getRuntimeDepsMap);
  const [savedSelection] = useState(() => loadSelection() ?? []);

  const [phase, setPhase] = useState<Phase>(() =>
    getInitialPhase(services, lastAnswers, savedSelection),
  );

  // Received from BuildProgress once its control server is listening, then handed to
  // NativeRunner for the rest of the run phase. A ref rather than state: receiving it
  // must not force a re-render, since NativeRunner's `server` prop has to keep its
  // identity for the run phase's lifetime (its watchGitBranch/poll effects tear down
  // and restart whenever `server` changes).
  const controlRef = useRef<ControlServer | null>(null);

  // Deferred here rather than inside ServiceSelector so that a --service/--last-answers
  // run — which never renders the selector — can't overwrite a previously saved selection.
  const onServicesSubmit = useCallback((selected: string[]) => {
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
    case 'service-select':
      return (
        <ServiceSelector
          groups={groups}
          runtimeDeps={runtimeDeps}
          initialSelected={savedSelection}
          onSubmit={onServicesSubmit}
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
      return <NativeRunner args={phase.runnerArgs} server={control} />;
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
  return render(<App {...options} />, {
    exitOnCtrlC: false,
    maxFps: 120,
  });
}
