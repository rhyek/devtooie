import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import path from 'node:path';
import chalk from 'chalk';
import {
  Box,
  type DOMElement,
  Text,
  measureElement,
  useApp,
  useInput,
  useStdout,
  useWindowSize,
} from 'ink';
import type { startCommandServer } from '../command-server.js';
import { normalizeUrlEntry, type UrlLine } from '../config.js';
import { watchGitBranch } from '../git-watch.js';
import { getGitBranch } from '../lib.js';
import { ALT_SCROLL_DISABLE, ALT_SCROLL_ENABLE } from '../mouse.js';
import { ProcessManager } from '../process-manager.js';
import type { RunnerArgs } from '../runners/types.js';
import { HotkeyHints, type HotkeyHintItem } from './HotkeyHints.js';
import { LogPane, useLogViewport } from './LogPane.js';

export type NativeRunnerProps = {
  args: RunnerArgs;
  /** Control API server, already listening, started by the caller before this component mounts. */
  server: Awaited<ReturnType<typeof startCommandServer>>;
  /** Kept in sync with the active logfile path so `renderApp`'s exit line can print it. */
  logFileRef?: { current: string | undefined };
};

type Mode = 'normal' | 'filter' | 'commands';

/**
 * One row in the commands menu. The trailing `custom` entry doubles as a
 * free-form text field: while it's focused, typed characters are appended to
 * a pending shell command and `enter` runs it. That entry is always present,
 * so the menu is meaningful even for a package with no extra scripts/targets.
 */
type CommandMenuItem = { type: 'script'; name: string } | { type: 'custom' };

/**
 * Five states a package can be in, shown as a colored dot in the footer:
 * `stopped` (not running), `waiting` (blocked on a dependency's healthcheck),
 * `starting`/`started` (running, healthcheck-backed, not yet / already
 * passing), and `unknown` (running, no healthcheck configured so readiness
 * can't be distinguished from "just started").
 */
type PackageStatus = 'stopped' | 'starting' | 'started' | 'unknown' | 'waiting';

interface PackageUrlGroup {
  name: string;
  selected: boolean;
  /** Each entry is one footer line; a line with multiple links renders them space-separated. */
  urls: UrlLine[];
}

/** Displayed width of a single link: its label if it has one, else the raw URL. */
function linkWidth(u: { label?: string; url: string }): number {
  return (u.label ?? u.url).length;
}

/** Displayed width of one footer line: its links plus a single space between each. */
function lineWidth(line: UrlLine): number {
  if (line.length === 0) return 0;
  return line.reduce((sum, u) => sum + linkWidth(u), 0) + (line.length - 1);
}

const STATUS_COLORS: Record<PackageStatus, string> = {
  stopped: 'red',
  starting: 'yellow',
  started: 'green',
  unknown: 'gray',
  waiting: 'cyan',
};

/**
 * Upper bound on how long a graceful shutdown may take before this session
 * exits anyway, so a second Ctrl+C (or an impatient caller waiting on
 * `/command/quit`) never has to wait indefinitely for a stuck child process.
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Wraps `text` in an OSC 8 terminal hyperlink; terminals without support just show the text. */
function hyperlink(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/** One footer line as a single string: each link hyperlinked, joined by a space. */
function renderLineText(line: UrlLine): string {
  return line.map((u) => hyperlink(u.url, u.label ?? u.url)).join(' ');
}

/** Natural width of the right-hand URL column, so the left column knows how much room it can use. */
function estimateRightColumnWidth(urlGroups: PackageUrlGroup[], topLevelUrls: UrlLine[]): number {
  let maxWidth = 0;
  for (const line of topLevelUrls) {
    maxWidth = Math.max(maxWidth, lineWidth(line));
  }
  for (const group of urlGroups) {
    maxWidth = Math.max(maxWidth, group.name.length);
    for (const line of group.urls) {
      maxWidth = Math.max(maxWidth, lineWidth(line));
    }
  }
  return maxWidth;
}

/**
 * The right-hand footer column of links: workspace-wide (top-level) links first, then a
 * dim rule, then a bold-headed group per package. The rule shows only when both are
 * present. A line with several links renders them space-separated on one row.
 */
export function LinksColumn({
  topLevelUrls,
  packageUrlGroups,
}: {
  topLevelUrls: UrlLine[];
  packageUrlGroups: PackageUrlGroup[];
}): React.ReactElement | null {
  if (topLevelUrls.length === 0 && packageUrlGroups.length === 0) {
    return null;
  }
  const showSeparator = topLevelUrls.length > 0 && packageUrlGroups.length > 0;
  const separatorRule = '┈'.repeat(estimateRightColumnWidth(packageUrlGroups, topLevelUrls));
  return (
    <Box flexDirection="column" alignItems="flex-end" flexShrink={0}>
      {topLevelUrls.map((line, i) => (
        // A brighter blue than Ink's default, which is too dark to read on this background.
        <Text key={`top-${i}`} wrap="truncate" color="#58a6ff">
          {renderLineText(line)}
        </Text>
      ))}
      {showSeparator && <Text dimColor>{separatorRule}</Text>}
      {packageUrlGroups.map((group) => (
        <React.Fragment key={group.name}>
          <Text bold={group.selected}>{group.name}</Text>
          {group.urls.map((line, i) => (
            <Text key={i} wrap="truncate" color="#58a6ff">
              {renderLineText(line)}
            </Text>
          ))}
        </React.Fragment>
      ))}
    </Box>
  );
}

/** Seed status for a package once it's (re)started: `starting` if it has a healthcheck, else `unknown`. */
function initialStatus(name: string, healthcheckUrls: Record<string, string>): PackageStatus {
  return healthcheckUrls[name] ? 'starting' : 'unknown';
}

// ---------------------------------------------------------------------------
// usePackageStatuses — the 5-state status model + healthcheck polling
// ---------------------------------------------------------------------------

function usePackageStatuses(args: RunnerArgs, manager: ProcessManager) {
  const packages = useMemo(() => args.sortedPackages, [args.sortedPackages]);
  const healthcheckUrls = args.healthcheckUrls;

  const [statuses, setStatuses] = useState<Map<string, PackageStatus>>(() => {
    const map = new Map<string, PackageStatus>();
    for (const pkg of packages) {
      map.set(pkg.name, 'stopped');
    }
    return map;
  });

  // Poll every package with a configured healthcheck, but only while the TUI
  // already considers it starting/started — this owns just the
  // starting <-> started distinction, nothing else.
  //
  // Mirrors the `waitingPollInFlight` guard in ProcessManager's own
  // healthcheck poll: a tick is skipped entirely while the previous tick's
  // fetches are still outstanding, and each fetch is bounded with a timeout,
  // so a hung endpoint can neither pile up requests nor hang forever.
  useEffect(() => {
    const names = Object.keys(healthcheckUrls);
    if (names.length === 0) {
      return;
    }
    let pollInFlight = false;
    const interval = setInterval(() => {
      if (pollInFlight) {
        return;
      }
      pollInFlight = true;
      const fetches = names.map((name) => {
        const url = healthcheckUrls[name]!;
        return fetch(url, { signal: AbortSignal.timeout(1500) })
          .then((res) => {
            setStatuses((prev) => {
              const curr = prev.get(name);
              if (curr !== 'starting' && curr !== 'started') {
                return prev;
              }
              const next: PackageStatus = res.ok ? 'started' : 'starting';
              return curr === next ? prev : new Map(prev).set(name, next);
            });
          })
          .catch(() => {
            setStatuses((prev) => {
              const curr = prev.get(name);
              if (curr !== 'starting' && curr !== 'started') {
                return prev;
              }
              return curr === 'starting' ? prev : new Map(prev).set(name, 'starting');
            });
          });
      });
      void Promise.allSettled(fetches).finally(() => {
        pollInFlight = false;
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [healthcheckUrls]);

  // Reconcile against the ProcessManager every 2s. The manager is the source
  // of truth for process lifecycle, so this catches every transition the TUI
  // didn't itself drive — a crash, a dependency's healthcheck finally
  // passing, or (notably) a restart/rebuild issued through the control
  // server rather than a hotkey. Without this loop, an externally triggered
  // rebuild would flip the dot red the moment the process stops and never
  // flip it back once it returns, since nothing local calls markStarted.
  useEffect(() => {
    const interval = setInterval(() => {
      setStatuses((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [name, tuiStatus] of prev) {
          const mgrStatus = manager.getStatus(name);
          if (!mgrStatus) {
            continue;
          }
          let target: PackageStatus;
          switch (mgrStatus) {
            case 'waiting':
              target = 'waiting';
              break;
            case 'rebuilding':
            case 'restarting':
              target = 'starting';
              break;
            case 'stopped':
              target = 'stopped';
              break;
            case 'running':
              target =
                tuiStatus === 'starting' || tuiStatus === 'started'
                  ? tuiStatus
                  : initialStatus(name, healthcheckUrls);
              break;
            default:
              target = tuiStatus;
          }
          if (target !== tuiStatus) {
            next.set(name, target);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [manager, healthcheckUrls]);

  const markStarted = useCallback(
    (name: string) => {
      setStatuses((prev) => new Map(prev).set(name, initialStatus(name, healthcheckUrls)));
    },
    [healthcheckUrls],
  );

  const markStopped = useCallback((name: string) => {
    setStatuses((prev) => new Map(prev).set(name, 'stopped'));
  }, []);

  const markRebuilding = useCallback((name: string) => {
    setStatuses((prev) => new Map(prev).set(name, 'starting'));
  }, []);

  const markWaiting = useCallback((name: string) => {
    setStatuses((prev) => new Map(prev).set(name, 'waiting'));
  }, []);

  const markAllStarted = useCallback(() => {
    setStatuses((prev) => {
      const next = new Map(prev);
      for (const pkg of packages) {
        next.set(pkg.name, initialStatus(pkg.name, healthcheckUrls));
      }
      return next;
    });
  }, [packages, healthcheckUrls]);

  const markAllStopped = useCallback(() => {
    setStatuses((prev) => {
      const next = new Map(prev);
      for (const pkg of packages) {
        next.set(pkg.name, 'stopped');
      }
      return next;
    });
  }, [packages]);

  return {
    statuses,
    markStarted,
    markStopped,
    markRebuilding,
    markWaiting,
    markAllStarted,
    markAllStopped,
  };
}

// ---------------------------------------------------------------------------
// NativeRunner
// ---------------------------------------------------------------------------

/**
 * Owns the run phase: creates the `ProcessManager`, drives it from a
 * `useInput` hotkey handler, and renders a footer (hotkey hints, per-package
 * status dots, git branch, logfile path, package URLs) above which the
 * manager streams every package's own output directly to the terminal. The
 * footer's real height is measured every render via `measureElement` and fed
 * back into the manager so its scrollback-clearing logic never clears rows
 * the footer itself occupies.
 */
export function NativeRunner({ args, server, logFileRef }: NativeRunnerProps) {
  const { exit } = useApp();

  const [gitBranch] = useState(getGitBranch);

  const displayPackages = useMemo(
    () =>
      args.sortedPackages.map((pkg) => ({
        name: pkg.name,
        displayName: pkg.shortName ?? pkg.name,
        selected: args.selectedSet.has(pkg.name),
      })),
    [args.sortedPackages, args.selectedSet],
  );

  const packageUrlGroups = useMemo<PackageUrlGroup[]>(() => {
    const groups: PackageUrlGroup[] = [];
    for (const pkg of args.sortedPackages) {
      const urls = pkg.urls;
      if (!urls || urls.length === 0) {
        continue;
      }
      groups.push({
        name: pkg.shortName ?? pkg.name,
        selected: args.selectedSet.has(pkg.name),
        urls: urls.map(normalizeUrlEntry),
      });
    }
    return groups;
  }, [args.sortedPackages, args.selectedSet]);

  const topLevelUrls = useMemo<UrlLine[]>(() => args.topLevelUrls ?? [], [args.topLevelUrls]);

  const [manager] = useState(() => new ProcessManager(args));
  // Current logfile path shown in the footer; updated when the log is rotated (`t`).
  const [logFilePath, setLogFilePath] = useState(args.logFile);
  // Mirror the active logfile into the shared holder so `renderApp`'s exit line —
  // which runs after Ink tears down — can print the last logfile written to.
  useEffect(() => {
    if (logFileRef) {
      logFileRef.current = logFilePath;
    }
  }, [logFileRef, logFilePath]);
  const [mode, setMode] = useState<Mode>('normal');
  const [cursor, setCursor] = useState(0);
  const [shuttingDown, setShuttingDown] = useState(false);
  const [filterInput, setFilterInput] = useState('');
  const [activeFilter, setActiveFilter] = useState('');
  const [pulse, setPulse] = useState(true);
  /** Measured height of the bottom section (scroll indicator + footer); the log pane fills the rest. */
  const [bottomHeight, setBottomHeight] = useState(0);
  /** Measured height of the top "older lines" indicator (0 or 1 rows). */
  const [topHeight, setTopHeight] = useState(0);
  const [commandsCursor, setCommandsCursor] = useState(0);
  const [customCommandInput, setCustomCommandInput] = useState('');

  // Extra scripts/targets (excluding dev/build/build:clean) for the focused package.
  const focusedExtraCommands = useMemo(() => {
    const focused = displayPackages[cursor];
    if (!focused) {
      return [];
    }
    return args.extraCommandsMap[focused.name] ?? [];
  }, [cursor, displayPackages, args.extraCommandsMap]);

  // Commands-mode menu: every extra script, plus a trailing free-form entry. Never empty.
  const commandMenuItems = useMemo<CommandMenuItem[]>(
    () => [
      ...focusedExtraCommands.map((name) => ({ type: 'script' as const, name })),
      { type: 'custom' },
    ],
    [focusedExtraCommands],
  );

  const {
    statuses,
    markStarted,
    markStopped,
    markRebuilding,
    markWaiting,
    markAllStarted,
    markAllStopped,
  } = usePackageStatuses(args, manager);

  const shuttingDownRef = useRef(false);

  // The single graceful shutdown path for Ctrl+C and a detected git branch
  // change: stop every package and wait for it to actually exit, close the
  // control server, then exit this process. A second call (an impatient
  // repeat Ctrl+C) skips straight to a hard kill.
  const shutdown = useCallback(async () => {
    if (shuttingDownRef.current) {
      manager.forceKillAll();
      process.exit(1);
    }
    shuttingDownRef.current = true;
    setShuttingDown(true);
    markAllStopped();
    await Promise.race([
      manager.shutdownAll(),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
    await server.close();
    manager.dispose();
    // Ink's teardown drives the exit from here: `exit()` unmounts, restores the
    // primary screen, and resolves `waitUntilExit` in renderApp, which prints the
    // "exited after Ns" line on the restored screen and exits the process.
    exit();
    // Safety net: force-exit if that teardown ever stalls, so a fully-cleaned-up
    // session (every child already killed above) can't leave a lingering parent
    // process. In the normal path renderApp exits first and this never fires.
    setTimeout(() => process.exit(0), 1500);
  }, [manager, server, exit, markAllStopped]);

  // Measure the bottom section (scroll indicator + footer) every render so the
  // log pane above it can size itself to the remaining rows. The first
  // measurement also starts every package.
  const bottomRef = useRef<DOMElement>(null);
  const topRef = useRef<DOMElement>(null);
  const startedRef = useRef(false);
  // Runs every render to re-measure the chrome (top indicator + footer) as its
  // content changes; the setState calls bail on unchanged values, so no loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (bottomRef.current) {
      setBottomHeight(measureElement(bottomRef.current).height);
    }
    if (topRef.current) {
      setTopHeight(measureElement(topRef.current).height);
    }
    if (!startedRef.current) {
      startedRef.current = true;
      manager.startAll();
      markAllStarted();
      for (const name of manager.getWaiting()) {
        markWaiting(name);
      }
    }
  });

  // Apply the active filter to the manager; the log pane re-renders from the
  // filtered buffer on the resulting notify.
  useEffect(() => {
    manager.setFilter(activeFilter ? activeFilter.split(/\s+/) : []);
  }, [manager, activeFilter]);

  // Terminal size drives the full-screen flex layout and the virtualized log
  // viewport; both reflow automatically on resize because Ink owns the screen.
  const { columns, rows } = useWindowSize();
  const paneHeight = Math.max(0, rows - topHeight - bottomHeight);
  const viewport = useLogViewport(manager, columns, paneHeight);

  // Enable the terminal's alternate-scroll mode so the wheel scrolls the log
  // viewport (delivered as Up/Down) without capturing the mouse — native
  // click-drag text selection keeps working. Disabled on unmount.
  const { stdout } = useStdout();
  useEffect(() => {
    stdout.write(ALT_SCROLL_ENABLE);
    return () => {
      stdout.write(ALT_SCROLL_DISABLE);
    };
  }, [stdout]);

  // Kill every child process when this run phase unmounts.
  useEffect(() => {
    return () => {
      manager.killAll();
    };
  }, [manager]);

  // Attach the manager to the already-listening control server, so status
  // queries and restart/rebuild requests become servable immediately.
  useEffect(() => {
    server.attach(manager);
  }, [manager, server]);

  // Take over `/command/quit` routing from whatever handler the server was
  // constructed with (BuildProgress's hard-exit — there's no process manager to
  // shut down yet at that point) so a quit request received during the run phase
  // — an external one, or a newer session's handoff — goes through this phase's
  // own graceful shutdown instead. Handed back to a no-op on unmount, since this
  // phase is the one that owns `shutdown` from here on.
  useEffect(() => {
    server.setOnQuit(() => void shutdown());
    return () => {
      server.setOnQuit(() => {});
    };
  }, [server, shutdown]);

  // If the checked-out branch changes underneath this session, shut down
  // gracefully — a stale build against the old branch is unsafe to keep serving.
  useEffect(() => {
    const stopWatching = watchGitBranch({
      onChange: (from, to) => {
        manager.logSystem(chalk.yellow(`git branch changed (${from} -> ${to}), shutting down`));
        void shutdown();
      },
    });
    return () => stopWatching();
  }, [manager, shutdown]);

  // Pulse animation for starting/waiting dots (toggles dim every 500ms).
  useEffect(() => {
    const interval = setInterval(() => setPulse((v) => !v), 500);
    return () => clearInterval(interval);
  }, []);

  useInput((input, key) => {
    // Ctrl+C always works, regardless of mode.
    if (input === 'c' && key.ctrl) {
      void shutdown();
      return;
    }

    if (shuttingDown) {
      return;
    }

    if (mode === 'filter') {
      if (key.return) {
        setActiveFilter(filterInput.trim());
        setMode('normal');
      } else if (key.escape) {
        setFilterInput(activeFilter);
        setMode('normal');
      } else if (key.backspace || key.delete) {
        setFilterInput((v) => v.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setFilterInput((v) => v + input);
      }
      return;
    }

    if (mode === 'commands') {
      const focusedItem = commandMenuItems[commandsCursor];
      const isCustomFocused = focusedItem?.type === 'custom';

      if (key.upArrow) {
        setCommandsCursor((c) => (c - 1 + commandMenuItems.length) % commandMenuItems.length);
      } else if (key.downArrow) {
        setCommandsCursor((c) => (c + 1) % commandMenuItems.length);
      } else if (key.leftArrow || key.rightArrow) {
        // Switch the focused package without leaving the menu, so commands on
        // another package can be picked without esc + re-navigate + m. Blocked
        // only while the custom row holds typed text (which the switch clears),
        // so an in-progress custom command is never silently discarded.
        const blocked = isCustomFocused && customCommandInput.length > 0;
        if (!blocked && displayPackages.length > 1) {
          const delta = key.rightArrow ? 1 : -1;
          setCursor((c) => (c + delta + displayPackages.length) % displayPackages.length);
          setCommandsCursor(0);
          setCustomCommandInput('');
        }
      } else if (key.return) {
        const focusedPackage = displayPackages[cursor];
        if (!focusedItem || !focusedPackage) {
          setMode('normal');
          return;
        }
        if (focusedItem.type === 'script') {
          manager.runCommand(focusedPackage.name, focusedItem.name);
          setMode('normal');
        } else {
          const trimmed = customCommandInput.trim();
          if (trimmed) {
            manager.runCustomCommand(focusedPackage.name, trimmed);
          }
          setMode('normal');
        }
      } else if (key.escape) {
        setMode('normal');
      } else if (isCustomFocused && (key.backspace || key.delete)) {
        setCustomCommandInput((v) => v.slice(0, -1));
      } else if (isCustomFocused && input && !key.ctrl && !key.meta) {
        setCustomCommandInput((v) => v + input);
      }
      return;
    }

    // Normal mode.

    // Log viewport scrolling. The mouse wheel arrives here as Up/Down via the
    // terminal's alternate-scroll mode (see mouse.ts), so the wheel and the arrow
    // keys drive the same scroll; left/right navigate packages.
    if (key.pageUp) {
      viewport.scrollPages(1);
      return;
    }
    if (key.pageDown) {
      viewport.scrollPages(-1);
      return;
    }
    if (key.home) {
      viewport.scrollToTop();
      return;
    }
    if (key.end) {
      viewport.scrollToBottom();
      return;
    }
    if (key.upArrow) {
      viewport.scrollLines(1);
      return;
    }
    if (key.downArrow) {
      viewport.scrollLines(-1);
      return;
    }

    if (key.leftArrow) {
      setCursor((c) => (c - 1 + displayPackages.length) % displayPackages.length);
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => (c + 1) % displayPackages.length);
      return;
    }

    if (input === 'k') {
      manager.clearBuffer();
      return;
    }

    if (input === 't' && args.logFile) {
      setLogFilePath(manager.rotateLogFile());
      return;
    }

    if (input === 'f') {
      setFilterInput(activeFilter);
      setMode('filter');
      return;
    }

    if (key.escape && activeFilter) {
      setActiveFilter('');
      setFilterInput('');
      return;
    }

    // Everything past this point acts on the focused package.
    const focusedPackage = displayPackages[cursor];
    if (!focusedPackage) {
      return;
    }
    const focusedName = focusedPackage.name;
    const focusedStatus = statuses.get(focusedName) ?? 'stopped';
    const isActive = focusedStatus !== 'stopped' && focusedStatus !== 'waiting';

    // The commands menu is always available, independent of run state — even
    // a stopped package can still have its custom command entry used.
    if (input === 'm') {
      setCommandsCursor(0);
      setCustomCommandInput('');
      setMode('commands');
      return;
    }

    if (input === 'r' && isActive) {
      if (manager.restart(focusedName)) {
        markRebuilding(focusedName);
      }
      return;
    }

    if (input === 'b' && isActive && args.rebuildableSet.has(focusedName)) {
      if (manager.rebuild(focusedName)) {
        markRebuilding(focusedName);
      }
      return;
    }

    if (input === 's' && isActive) {
      markStopped(focusedName);
      void manager.stop(focusedName).catch(() => {});
      return;
    }

    if (input === 's' && !isActive) {
      manager.start(focusedName);
      // `start()` silently no-ops for a package with no runnable dev script
      // (see `ProcessManager.start`/`canDev`), so only optimistically mark it
      // as started if the manager's own state shows it actually did.
      if (manager.getStatus(focusedName) !== 'stopped') {
        markStarted(focusedName);
      }
      return;
    }
  });

  // While shutting down, collapse to a single non-fullscreen line. Ink clears the
  // terminal when it unmounts a *fullscreen* frame (its shouldClearOnUnmount
  // path), which can leave a blank block on the restored primary screen after the
  // alternate screen is torn down. A short final frame avoids that.
  if (shuttingDown) {
    return <Text color="yellow">Shutting down… (press Ctrl+C again to force kill)</Text>;
  }

  const linksColumn = (
    <LinksColumn topLevelUrls={topLevelUrls} packageUrlGroups={packageUrlGroups} />
  );

  const focusedPackage = displayPackages[cursor];
  const focusedStatus = focusedPackage
    ? (statuses.get(focusedPackage.name) ?? 'stopped')
    : 'stopped';
  const focusedIsActive = focusedStatus !== 'stopped' && focusedStatus !== 'waiting';
  const focusedIsRebuildable = focusedPackage
    ? args.rebuildableSet.has(focusedPackage.name)
    : false;

  // Session-level hotkeys (act on the whole session) — pinned to the top of the footer.
  // `t: rotate` lives next to the logfile path instead (see below).
  const sessionHints: HotkeyHintItem[] = [
    { header: 'logs' },
    { key: 'k', label: 'clear' },
    { key: 'f', label: 'filter' },
    { separator: true },
    { key: '^c', label: 'quit' },
  ];

  // Per-package hotkeys (act on the focused package) — rendered directly under the dots.
  // `← →: select` (and its separator) only make sense when there's more than one package
  // to move the cursor between; with a single package it's dropped.
  const packageHints: HotkeyHintItem[] = [
    ...(displayPackages.length > 1
      ? [{ key: '← →', label: 'select' } as HotkeyHintItem, { separator: true } as HotkeyHintItem]
      : []),
    { key: 'r', label: 'restart', dim: !focusedIsActive },
    { key: 'b', label: 'rebuild', dim: !focusedIsActive || !focusedIsRebuildable },
    // Merged start/stop toggle: show whichever action applies to the focused package.
    focusedIsActive ? { key: 's', label: 'stop' } : { key: 's', label: 'start' },
    { key: 'm', label: 'commands' },
  ];

  const filterLine = activeFilter ? (
    <Text color="cyan">[filter: {activeFilter}] esc: clear filter</Text>
  ) : null;

  const packageStatusDots = (
    <Box flexWrap="wrap" columnGap={2}>
      {displayPackages.map((pkg, i) => {
        const status = statuses.get(pkg.name) ?? 'stopped';
        const color = STATUS_COLORS[status];
        const dim = (status === 'starting' || status === 'waiting') && !pulse;
        const isFocused = i === cursor;
        return (
          <Box key={pkg.name} flexShrink={0}>
            <Text color={color} dimColor={dim}>
              ●
            </Text>
            <Text> </Text>
            <Text bold={isFocused} underline={isFocused}>
              {pkg.displayName}
            </Text>
          </Box>
        );
      })}
    </Box>
  );

  const isFilter = mode === 'filter';
  const isCommands = mode === 'commands';

  const topSection = shuttingDown ? (
    <Text color="yellow">Shutting down... (press Ctrl+C again to force kill)</Text>
  ) : isFilter ? (
    <>
      <Text bold>Filter output (space-separated terms, all must match):</Text>
      <Box>
        <Text color="cyan">&gt; </Text>
        <Text>{filterInput}</Text>
        <Text color="cyan">_</Text>
      </Box>
      <Text dimColor>{'  enter: apply   esc: cancel   empty + enter: clear filter'}</Text>
    </>
  ) : isCommands ? (
    <>
      <Text bold>
        Commands for <Text color="cyan">{focusedPackage?.displayName ?? ''}</Text>{' '}
        <Text dimColor>(custom runs via a shell)</Text>:
      </Text>
      {commandMenuItems.map((item, i) => {
        const selected = i === commandsCursor;
        if (item.type === 'custom') {
          if (selected) {
            return (
              <Box key="__custom__">
                <Text color="magenta" bold>
                  ❯{' '}
                </Text>
                <Text color="magenta">&gt; </Text>
                <Text>{customCommandInput}</Text>
                <Text color="magenta">_</Text>
              </Box>
            );
          }
          return (
            <Text key="__custom__" dimColor>
              {'  <custom command…>'}
            </Text>
          );
        }
        return (
          <Text key={item.name} color={selected ? 'magenta' : undefined} bold={selected}>
            {selected ? '❯ ' : '  '}
            {item.name}
          </Text>
        );
      })}
      <Text dimColor>
        {displayPackages.length > 1
          ? '  ↑↓: navigate   ←→: package   enter: run   esc: cancel'
          : '  ↑↓: navigate   enter: run   esc: cancel'}
      </Text>
    </>
  ) : (
    <>
      <HotkeyHints hints={sessionHints} />
      {filterLine}
    </>
  );

  // Per-package hotkeys sit directly under the dots (no vertical gap) — only in
  // normal mode, where the top section shows the session-level hotkeys.
  const isNormal = !shuttingDown && !isFilter && !isCommands;

  const borderColor = shuttingDown ? 'yellow' : isFilter ? 'cyan' : isCommands ? 'magenta' : 'gray';

  return (
    <Box flexDirection="column" width={columns} height={rows} overflow="hidden">
      <Box ref={topRef} flexShrink={0}>
        {viewport.hiddenAbove > 0 && (
          <Text dimColor>
            {`  ↑ ${viewport.hiddenAbove} older line${viewport.hiddenAbove === 1 ? '' : 's'} — press Home to jump to oldest`}
          </Text>
        )}
      </Box>
      {/* Always rendered so flexGrow pins the footer to the bottom from the first
          frame; paneHeight is briefly the full height until the footer is measured,
          which is harmless (the run-phase buffer starts empty). */}
      <LogPane rows={viewport.rows} />
      <Box ref={bottomRef} flexDirection="column" flexShrink={0}>
        {viewport.hiddenBelow > 0 && (
          <Text dimColor>
            {`  ↓ ${viewport.hiddenBelow} newer line${viewport.hiddenBelow === 1 ? '' : 's'} — press End to jump to latest`}
          </Text>
        )}
        <Box borderStyle="single" borderColor={borderColor} paddingX={1} columnGap={4}>
          <Box flexDirection="column" flexGrow={1}>
            {topSection}
            <Box marginTop={1}>{packageStatusDots}</Box>
            {isNormal && <HotkeyHints hints={packageHints} />}
            <Box flexDirection="column" marginTop={1}>
              {gitBranch && (
                <Text>
                  <Text color="cyan">git:(</Text>
                  <Text color="green">{gitBranch}</Text>
                  <Text color="cyan">)</Text>
                </Text>
              )}
              {logFilePath && (
                <Box columnGap={2}>
                  <Text dimColor>
                    logfile: {path.relative(process.cwd(), logFilePath) || logFilePath}
                  </Text>
                  {isNormal && <HotkeyHints hints={[{ key: 't', label: 'rotate' }]} />}
                </Box>
              )}
            </Box>
          </Box>
          {linksColumn}
        </Box>
      </Box>
    </Box>
  );
}
