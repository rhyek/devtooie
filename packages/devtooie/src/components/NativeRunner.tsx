import path from 'node:path';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useEffectEvent,
  useSyncExternalStore,
} from 'react';
import {
  Box,
  type DOMElement,
  Text,
  measureElement,
  useApp,
  useInput,
  useStdin,
  useStdout,
  useWindowSize,
} from 'ink';
import {
  ACCENT_COLOR,
  DANGER_COLOR,
  FOCUS_COLOR,
  LINK_COLOR,
  MUTED_COLOR,
  OK_COLOR,
  WARN_COLOR,
} from '../colors.js';
import type { startCommandServer } from '../command-server.js';
import { normalizeUrlEntry, type UrlLine } from '../config.js';
import type { DevReverseProxyServer } from '../dev-reverse-proxy.js';
import { watchGitBranch } from '../git-watch.js';
import type { InfraStatus } from '../infra/control.js';
import { displayLogFile, getGitBranch } from '../lib.js';
import { MOUSE_DISABLE, MOUSE_ENABLE, createMouseDecoder, type MouseChunk } from '../mouse.js';
import { ProcessManager } from '../process-manager.js';
import type { RunnerArgs } from '../runners/types.js';
import { SHUTDOWN_TIMEOUT_MS } from '../shutdown-timing.js';
import { installShutdownSignals } from '../signals.js';
import { BottomChrome } from './BottomChrome.js';
import { verticalTarget, type ItemRect } from './footer-nav.js';
import { HotkeyHints, type HotkeyHintItem } from './HotkeyHints.js';
import { LogPane, useDragSelection, useLogViewport } from './LogPane.js';
import { useToasts } from './ToastStack.js';

export type NativeRunnerProps = {
  args: RunnerArgs;
  /** Control API server, already listening, started by the caller before this component mounts. */
  server: Awaited<ReturnType<typeof startCommandServer>>;
  /**
   * The session's dev reverse proxy, already listening, or `null` when the config declares
   * none. Attached to the process manager here so it can answer by package status, and closed
   * with the session.
   */
  devReverseProxy?: DevReverseProxyServer | null;
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
  if (line.length === 0) {
    return 0;
  }
  return line.reduce((sum, u) => sum + linkWidth(u), 0) + (line.length - 1);
}

/** Which role each package status plays; the colors themselves live in `colors.ts`. */
const STATUS_COLORS: Record<PackageStatus, string> = {
  stopped: DANGER_COLOR,
  starting: WARN_COLOR,
  started: OK_COLOR,
  unknown: MUTED_COLOR,
  waiting: ACCENT_COLOR,
};

/** How an infra service's status draws its dot: the package palette, an action pulsing like a start. */
const INFRA_DOT_STATUS: Record<InfraStatus, PackageStatus> = {
  running: 'started',
  starting: 'starting',
  stopping: 'starting',
  restarting: 'starting',
  resetting: 'starting',
  stopped: 'stopped',
};

/**
 * How long a `t` on an infra service waits for the second `t` that confirms the reset — the
 * confirmation toast's lifetime, so the window closes when the prompt goes away.
 */
const RESET_CONFIRM_MS = 5000;

/**
 * How long a Ctrl+C waits for the second one that confirms the exit — the "press again" toast's
 * lifetime, so the window closes when the prompt goes away.
 */
const EXIT_CONFIRM_MS = 2000;

/**
 * How long a shutdown may take, once every child is dead, to close the proxy and the control
 * server and tear the UI down, before the process is exited regardless.
 */
const EXIT_SAFETY_NET_MS = 5000;

/** Rendered rows scrolled per mouse-wheel notch. */
const WHEEL_STEP = 3;

/**
 * How long a filter toast stays up — shorter than the default, because it only
 * confirms an action the user just took and whose result is already on screen
 * (the `[filter: …]` line, and the logs themselves changing).
 */
const FILTER_TOAST_MS = 2000;

/**
 * Absolute on-screen rect of an Ink element, in 1-based SGR mouse coordinates.
 * Ink's `measureElement` exposes only width/height, so to hit-test a click we
 * walk `parentNode` ourselves and sum each node's yoga offset to recover the
 * position — robust to footer layout changes and terminal resizes.
 */
function elementScreenRect(
  node: DOMElement | null | undefined,
): { col: number; row: number; width: number; height: number } | null {
  if (!node?.yogaNode) {
    return null;
  }
  let left = 0;
  let top = 0;
  let cur: DOMElement | undefined = node;
  while (cur?.yogaNode) {
    left += cur.yogaNode.getComputedLeft();
    top += cur.yogaNode.getComputedTop();
    cur = cur.parentNode;
  }
  return {
    // yoga offsets are 0-based from the root's top-left; SGR mouse coords are 1-based.
    col: left + 1,
    row: top + 1,
    width: node.yogaNode.getComputedWidth(),
    height: node.yogaNode.getComputedHeight(),
  };
}

/** Whether an SGR mouse (`col`,`row`) — 1-based — lands on `rect`, with `colPad` cells of slack so a narrow glyph stays easy to click. */
function rectHit(
  rect: { col: number; row: number; width: number; height: number },
  col: number,
  row: number,
  colPad = 1,
): boolean {
  return (
    row >= rect.row &&
    row <= rect.row + rect.height - 1 &&
    col >= rect.col - colPad &&
    col <= rect.col + rect.width - 1 + colPad
  );
}

/** Wraps `text` in an OSC 8 terminal hyperlink; terminals without support just show the text. */
function hyperlink(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/** One footer line as a single string: each link hyperlinked, joined by a space. */
function renderLineText(line: UrlLine): string {
  return line.map((u) => hyperlink(u.url, u.label ?? u.url)).join(' ');
}

/**
 * The url a package's or service's heading links to in place of a line under it: its one link
 * when its `urls` is a single unlabelled entry, else `undefined`.
 */
function headingUrl(group: PackageUrlGroup): string | undefined {
  if (group.urls.length !== 1 || group.urls[0]?.length !== 1) {
    return undefined;
  }
  const link = group.urls[0][0];
  return link?.label === undefined ? link?.url : undefined;
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

/** A group with one unlabelled link shows it as its heading, with no line under it. */
function collapseHeading(group: PackageUrlGroup): PackageUrlGroup & { url?: string } {
  const url = headingUrl(group);
  return { ...group, urls: url === undefined ? group.urls : [], url };
}

/**
 * The right-hand footer column of links: workspace-wide (top-level) links first, then a
 * dim rule, then a bold-headed group per package, then the infra services' groups under an
 * `infra` caption. The rule shows only when both are present. A line with several links
 * renders them space-separated on one row. A package or service whose `urls` is one
 * unlabelled link has its heading link there, with no line under it.
 */
export function LinksColumn({
  topLevelUrls,
  packageUrlGroups,
  infraUrlGroups = [],
}: {
  topLevelUrls: UrlLine[];
  packageUrlGroups: PackageUrlGroup[];
  /** A group per infra service that declares `urls`, headed by the service's name. */
  infraUrlGroups?: PackageUrlGroup[];
}): React.ReactElement | null {
  const packageGroups = packageUrlGroups.map(collapseHeading);
  const serviceGroups = infraUrlGroups.map(collapseHeading);
  if (topLevelUrls.length === 0 && packageGroups.length === 0 && serviceGroups.length === 0) {
    return null;
  }
  const showSeparator = topLevelUrls.length > 0 && packageGroups.length + serviceGroups.length > 0;
  const separatorRule = '┈'.repeat(
    estimateRightColumnWidth([...packageGroups, ...serviceGroups], topLevelUrls),
  );
  const renderGroup = (group: PackageUrlGroup & { url?: string }, key: string) => (
    <React.Fragment key={key}>
      {group.url === undefined ? (
        <Text bold={group.selected}>{group.name}</Text>
      ) : (
        <Text bold={group.selected} wrap="truncate" color={LINK_COLOR}>
          {hyperlink(group.url, group.name)}
        </Text>
      )}
      {group.urls.map((line, j) => (
        <Text key={j} wrap="truncate" color={LINK_COLOR}>
          {renderLineText(line)}
        </Text>
      ))}
    </React.Fragment>
  );
  return (
    <Box flexDirection="column" alignItems="flex-end" flexShrink={0}>
      {topLevelUrls.map((line, i) => (
        // A brighter blue than Ink's default, which is too dark to read on this background.
        <Text key={`top-${i}`} wrap="truncate" color={LINK_COLOR}>
          {renderLineText(line)}
        </Text>
      ))}
      {showSeparator && <Text dimColor>{separatorRule}</Text>}
      {packageGroups.map((group) => renderGroup(group, `package-${group.name}`))}
      {/* Captioned so an infra service's name doesn't read as an application service's; in the default
          text color, like a heading that isn't a link, so it stands apart from the links under it. */}
      {serviceGroups.length > 0 && <Text>infra</Text>}
      {serviceGroups.map((group) => renderGroup(group, `service-${group.name}`))}
    </Box>
  );
}

/** Seed status for a package once it's (re)started: `starting` if it has a healthcheck, else `unknown`. */
function initialStatus(name: string, healthchecks: RunnerArgs['healthchecks']): PackageStatus {
  return healthchecks[name] ? 'starting' : 'unknown';
}

// ---------------------------------------------------------------------------
// usePackageStatuses — the 5-state status model + healthcheck polling
// ---------------------------------------------------------------------------

function usePackageStatuses(args: RunnerArgs, manager: ProcessManager, servicesVersion: number) {
  // A service added to the session goes into `args.sortedPackages` in place, so the version is
  // what says the list changed.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const packages = useMemo(() => [...args.sortedPackages], [args.sortedPackages, servicesVersion]);
  const healthchecks = args.healthchecks;

  const [statuses, setStatuses] = useState<Map<string, PackageStatus>>(() => {
    const map = new Map<string, PackageStatus>();
    for (const pkg of packages) {
      map.set(pkg.name, 'stopped');
    }
    return map;
  });

  // Reconcile against the ProcessManager every 2s. The manager is the source
  // of truth for both halves of a package's status: its process lifecycle,
  // and — since it owns the one healthcheck probe loop per package — whether
  // that package's healthcheck is currently passing. So this catches every
  // transition the TUI didn't itself drive: a crash, a dependency's
  // healthcheck finally passing, a restart/rebuild issued through the control
  // server rather than a hotkey, and the starting -> started flip.
  useEffect(() => {
    const interval = setInterval(() => {
      setStatuses((prev) => {
        let changed = false;
        const next = new Map(prev);
        // Over the current list, so a service added to the session gets its entry here.
        for (const { name } of packages) {
          const tuiStatus = prev.get(name) ?? 'stopped';
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
              target = !healthchecks[name]
                ? 'unknown'
                : manager.isReady(name)
                  ? 'started'
                  : 'starting';
              break;
            default:
              target = tuiStatus;
          }
          if (target !== prev.get(name)) {
            next.set(name, target);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [manager, healthchecks, packages]);

  const markStarted = useCallback(
    (name: string) => {
      setStatuses((prev) => new Map(prev).set(name, initialStatus(name, healthchecks)));
    },
    [healthchecks],
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
        next.set(pkg.name, initialStatus(pkg.name, healthchecks));
      }
      return next;
    });
  }, [packages, healthchecks]);

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
export function NativeRunner({
  args,
  server,
  devReverseProxy = null,
  logFileRef,
}: NativeRunnerProps) {
  const { exit } = useApp();

  const [gitBranch] = useState(getGitBranch);

  const [manager] = useState(() => new ProcessManager(args));
  // Bumped when a service joins the session: `args.sortedPackages` and the maps grow in place.
  const servicesVersion = useSyncExternalStore(
    useCallback((fn: () => void) => manager.subscribeServices(fn), [manager]),
    () => manager.getServicesVersion(),
  );

  const displayPackages = useMemo(
    () =>
      args.sortedPackages.map((pkg) => ({
        name: pkg.name,
        displayName: pkg.shortName ?? pkg.name,
        selected: args.selectedSet.has(pkg.name),
      })),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [args.sortedPackages, args.selectedSet, servicesVersion],
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [args.sortedPackages, args.selectedSet, servicesVersion]);

  const topLevelUrls = useMemo<UrlLine[]>(() => args.topLevelUrls ?? [], [args.topLevelUrls]);
  const infraUrlGroups = useMemo<PackageUrlGroup[]>(
    () =>
      (args.infra?.services ?? []).flatMap((service) =>
        service.urls === undefined || service.urls.length === 0
          ? []
          : [{ name: service.name, selected: false, urls: service.urls.map(normalizeUrlEntry) }],
      ),
    [args.infra],
  );

  // The footer cursor runs over the packages, then the infra services: `cursor` past the last
  // package is a service.
  const infraNames = manager.infra?.services ?? [];
  const itemCount = displayPackages.length + infraNames.length;
  // An infra service's status lives in the manager; re-render whenever one changes.
  const [, onInfraChange] = useReducer((n: number) => n + 1, 0);
  useEffect(() => manager.infra?.subscribe(onInfraChange), [manager]);
  /** Each footer item's element, by cursor index: what ↑/↓ measure the layout from. */
  const itemRefs = useRef<(DOMElement | null)[]>([]);
  /** The reset awaiting its confirming `t`, if one was asked for. */
  const pendingResetRef = useRef<{ service: string; toastId: number; at: number } | null>(null);
  /** The first Ctrl+C, awaiting the second that confirms the exit. */
  const pendingExitRef = useRef<{ toastId: number; at: number } | null>(null);
  useEffect(() => {
    devReverseProxy?.attach(manager);
  }, [devReverseProxy, manager]);
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
  } = usePackageStatuses(args, manager, servicesVersion);

  const shuttingDownRef = useRef(false);

  // The single graceful shutdown path for Ctrl+C and a detected git branch
  // change: stop every package and wait for it to actually exit, close the
  // control server, then exit this process. A second call (an impatient
  // repeat Ctrl+C) skips straight to a hard kill.
  const shutdown = useCallback(async () => {
    if (shuttingDownRef.current) {
      // Hard kill: exits immediately, before the unmount effect's cleanup runs,
      // so release the mouse here too.
      process.stdout.write(MOUSE_DISABLE);
      manager.forceKillAll();
      process.exit(1);
    }
    shuttingDownRef.current = true;
    // Hand the mouse back to the terminal before the UI collapses (the unmount
    // effect also does this, but only once Ink tears the tree down).
    process.stdout.write(MOUSE_DISABLE);
    setShuttingDown(true);
    markAllStopped();
    // Every step below is best-effort: a failing one must not keep the session from exiting.
    const settle = async (step: () => unknown): Promise<void> => {
      try {
        await step();
      } catch {
        /* the exit goes ahead regardless */
      }
    };
    await settle(() =>
      Promise.race([
        manager.shutdownAll(),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ]),
    );
    // Whatever the graceful pass left (it timed out, or failed) dies now, while the exit hook that
    // would otherwise be the last word is still installed — `dispose()` below removes it.
    manager.forceKillAll();
    // Safety net, armed before anything else is awaited: force-exit if closing the proxy or the
    // server, or Ink's teardown, ever stalls, so a session whose children are all dead can't leave
    // a lingering parent process. In the normal path renderApp exits first and this never fires.
    setTimeout(() => process.exit(0), EXIT_SAFETY_NET_MS);
    // The proxy first: it destroys every open socket (proxied websockets included), so a
    // lingering connection can't hold the exit.
    await settle(() => devReverseProxy?.close());
    // Packages are down and their ports freed — ack any blocking `/command/quit`
    // now (e.g. a newer session handing off), before we close the server below.
    await settle(() => server.ackQuit());
    await settle(() => server.close());
    await settle(() => manager.dispose());
    // Ink's teardown drives the exit from here: `exit()` unmounts, restores the
    // primary screen, and resolves `waitUntilExit` in renderApp, which prints the
    // "exited after …" line on the restored screen and exits the process.
    exit();
  }, [manager, server, devReverseProxy, exit, markAllStopped]);

  // Terminal-delivered signals route to the same graceful shutdown as Ctrl+C. Ctrl+C itself
  // arrives as a keystroke (the TUI runs the terminal in raw mode, so ISIG is off) and is handled
  // in `useInput` — these handlers cover the signals raw mode can't produce: SIGHUP from a closed
  // terminal or dropped SSH session, and an explicit `kill`. Without them devtooie dies on the
  // spot and leaves every detached package group orphaned to PID 1.
  useEffect(() => installShutdownSignals(() => void shutdown()), [shutdown]);

  // Measure the bottom section (scroll indicator + footer) every render so the
  // log pane above it can size itself to the remaining rows. The first
  // measurement also starts every package.
  const bottomRef = useRef<DOMElement>(null);
  const topRef = useRef<DOMElement>(null);
  // The clickable ⧉ copy glyph next to the logfile path; hit-tested on mouse press.
  const copyIconRef = useRef<DOMElement>(null);
  // The clickable "Click here" in the ↓ newer-lines indicator; hit-tested on mouse
  // press. Only mounted while scrolled up, so a null rect is the natural gate.
  const jumpToLatestRef = useRef<DOMElement>(null);
  const startedRef = useRef(false);
  // Whether the next input event is a legacy X10 mouse report's coordinate bytes,
  // which are swallowed whole (see the input handler). True only in the brief
  // window after a terminal reattach drops our SGR encoding mode.
  const swallowLegacyPayloadRef = useRef(false);
  const measureChrome = useCallback(() => {
    if (bottomRef.current) {
      setBottomHeight(measureElement(bottomRef.current).height);
    }
    if (topRef.current) {
      setTopHeight(measureElement(topRef.current).height);
    }
  }, []);
  // Runs every render to re-measure the chrome (top indicator + footer) as its
  // content changes; the setState calls bail on unchanged values, so no loop.
  useLayoutEffect(() => {
    measureChrome();
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

  // Transient notices, shown above the footer (see ToastStack / toasts.ts).
  const toasts = useToasts();

  // App-managed drag-to-select-and-copy over the log pane (native terminal
  // selection can't survive our in-place repaints — see selection.ts).
  const dragSelection = useDragSelection({
    rows: viewport.rows,
    firstVisibleFlatRow: viewport.firstVisibleFlatRow,
    topHeight,
    paneHeight,
    notify: toasts.notify,
    dismiss: toasts.dismiss,
  });
  const { clear: clearSelection, onMouse: onMouseSelect, highlights, flashCopy } = dragSelection;

  // Enable SGR mouse reporting so the wheel scrolls the viewport and click-drag
  // drives the app-managed selection (see mouse.ts / selection.ts).
  //
  // Re-asserted on every resize, not just on mount: a terminal that hands our
  // session to a *fresh* emulator restores the mouse modes from a snapshot, and
  // that snapshot can be incomplete. VS Code's "Reload Window" reattaches the pty
  // to a new xterm.js whose serializer re-emits the tracking mode (`?1002h`) but
  // not the SGR encoding mode (`?1006h`) — reports come back X10-encoded and stop
  // decoding, so the wheel and drag-select go dead while the keyboard still works.
  // Such a reattach always re-measures the terminal, so a resize is our signal to
  // heal it before the next mouse event; re-writing modes already set is a no-op.
  const { stdout } = useStdout();
  useEffect(() => {
    stdout.write(MOUSE_ENABLE);
  }, [stdout, columns, rows]);

  // On a resize, re-measure the chrome in the same commit as the new size. By the time this
  // listener runs Ink has laid the tree out at the new width (see "Resizing" in
  // docs/architecture/rendering.md), so a footer that now wraps differently already has its
  // new height — and taking it here, not after the commit, spares a frame whose pane is the
  // wrong height.
  useEffect(() => {
    stdout.on('resize', measureChrome);
    return () => {
      stdout.off('resize', measureChrome);
    };
  }, [stdout, measureChrome]);

  // Reporting takes over the mouse from the terminal while active, so it MUST be
  // disabled on unmount — and defensively in `shutdown()` — to hand the mouse back.
  useEffect(() => {
    return () => {
      stdout.write(MOUSE_DISABLE);
    };
  }, [stdout]);

  // A resize (wrapping changes), a filter change, or the timestamp column changing
  // width re-flows the visible content, invalidating the flat-row/column coordinates
  // a selection is anchored to — so drop any active selection.
  useEffect(() => {
    clearSelection();
  }, [columns, rows, activeFilter, viewport.tsMode, clearSelection]);

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
        manager.systemLog.warn(`git branch changed (${from} -> ${to}), shutting down`);
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

  // Every filter change goes through here, so the two entry points — `enter` in
  // filter mode, `esc` in normal mode — can't drift on what they announce. A
  // change that isn't one (re-applying the same terms, or clearing when nothing
  // is filtered) says nothing: a toast should mark a transition, not a keypress.
  const changeFilter = (next: string) => {
    if (next === activeFilter) {
      return;
    }
    setActiveFilter(next);
    toasts.notify({
      message: next ? 'Filter applied' : 'Filter cleared',
      duration: FILTER_TOAST_MS,
    });
  };

  useInput((input, key) => {
    // Ctrl+C works in every mode, and takes two presses: the first only asks, and a second while
    // that prompt is up exits. Once shutting down, a further one is the impatient hard kill.
    if (input === 'c' && key.ctrl) {
      const pending = pendingExitRef.current;
      if (shuttingDownRef.current || (pending && Date.now() - pending.at < EXIT_CONFIRM_MS)) {
        if (pending) {
          toasts.dismiss(pending.toastId);
        }
        pendingExitRef.current = null;
        void shutdown();
        return;
      }
      const toastId = toasts.notify({
        message: 'Press Ctrl+C again to exit',
        duration: EXIT_CONFIRM_MS,
      });
      pendingExitRef.current = { toastId, at: Date.now() };
      return;
    }

    if (shuttingDown) {
      return;
    }

    // The coordinate bytes of a legacy X10 mouse report, which the stdin listener below saw
    // arrive: they reach this handler as one input event of their own, and are dropped whole so
    // they can't type themselves into the filter or a custom command. Counting characters
    // instead would desync, since X10 encodes each coordinate as `value + 32` and anything past
    // column ~95 is a byte the UTF-8 decode turns into one or two U+FFFD.
    if (swallowLegacyPayloadRef.current) {
      swallowLegacyPayloadRef.current = false;
      return;
    }

    if (mode === 'filter') {
      if (key.return) {
        changeFilter(filterInput.trim());
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
          // Packages only: the menu belongs to a package, so the cursor is on one here.
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

    // Log viewport scrolling via the keyboard (the mouse wheel is handled in the
    // mouse block above); the arrows move the footer cursor. A selection is anchored to
    // content, so it rides along with scrolling and is intentionally kept.
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
    // ←/→ walk the packages and then the infra services as one list, wrapping at both ends;
    // ↑/↓ go to the item on the row above or below, as the footer is laid out right now.
    if (key.leftArrow) {
      setCursor((c) => (c - 1 + itemCount) % itemCount);
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => (c + 1) % itemCount);
      return;
    }
    if (key.upArrow || key.downArrow) {
      const rects: ItemRect[] = [];
      for (let i = 0; i < itemCount; i++) {
        const rect = elementScreenRect(itemRefs.current[i]);
        if (!rect) {
          return;
        }
        rects.push(rect);
      }
      setCursor(verticalTarget(rects, cursor, key.upArrow ? 'up' : 'down'));
      return;
    }

    if (input === 'c') {
      clearSelection();
      manager.clearBuffer();
      return;
    }

    // An infra service has keys of its own: `s` start/stop, `r` restart, `t` reset (asked
    // twice, since it deletes the service's data). `t` rotates the logfile only while a package
    // is focused; the package keys (`b`, `m`) do nothing on a service.
    const focusedService =
      cursor >= displayPackages.length ? infraNames[cursor - displayPackages.length] : undefined;
    if (
      focusedService !== undefined &&
      manager.infra &&
      (input === 's' || input === 'r' || input === 't')
    ) {
      const infra = manager.infra;
      if (infra.isBusy(focusedService)) {
        return;
      }
      const status = infra.status(focusedService);
      const isUp = status === 'running' || status === 'starting';
      if (input === 's') {
        infra.run(focusedService, isUp ? 'stop' : 'start');
      } else if (input === 'r' && isUp) {
        infra.run(focusedService, 'restart');
      } else if (input === 't') {
        const pending = pendingResetRef.current;
        if (pending?.service === focusedService && Date.now() - pending.at < RESET_CONFIRM_MS) {
          pendingResetRef.current = null;
          toasts.dismiss(pending.toastId);
          infra.run(focusedService, 'reset');
          return;
        }
        const service = focusedService;
        const toastId = toasts.notify({
          message: `Reset ${service}? Its data is deleted. Press t again to confirm.`,
          tone: 'warn',
          duration: RESET_CONFIRM_MS,
          actions: [
            {
              label: 'reset',
              onPress: () => {
                pendingResetRef.current = null;
                infra.run(service, 'reset');
              },
            },
          ],
        });
        pendingResetRef.current = { service, toastId, at: Date.now() };
      }
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

    if (key.escape) {
      // Escape clears an active selection first, then a sticky toast — which is how
      // one goes away without a mouse — then an active filter. Only *sticky* toasts
      // are in this chain: a passing notice clears itself, so letting one absorb the
      // `esc` aimed at the filter beneath it would just cost a keypress.
      if (clearSelection()) {
        return;
      }
      if (toasts.dismissNewestSticky()) {
        return;
      }
      if (activeFilter) {
        changeFilter('');
        setFilterInput('');
      }
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

  // Mouse reports never reach `useInput`: Ink drops terminal sequences that map to no key. They're
  // read from stdin's `data` events instead, which Ink emits for each chunk as it reads it, before
  // parsing it into input events — so when a legacy X10 report's coordinate bytes reach
  // `useInput`, the flag that drops them is already set. The wheel scrolls the viewport;
  // press/drag/release drive the app-managed selection (see mouse.ts / selection.ts).
  const onMouseChunk = useEffectEvent(({ reports, legacy }: MouseChunk) => {
    if (shuttingDown) {
      return;
    }
    // A legacy X10 report means the terminal reset our SGR encoding mode behind our back (see
    // mouse.ts) — re-assert reporting so the *next* event decodes again. This is the backstop
    // for a reattach that somehow didn't resize us; the resize effect above normally heals it
    // before any mouse event lands.
    if (legacy) {
      swallowLegacyPayloadRef.current = true;
      stdout.write(MOUSE_ENABLE);
    }
    for (const report of reports) {
      if (report.type === 'wheel') {
        // A selection is content-anchored, so it survives wheel scrolling too.
        viewport.scrollLines(report.dir === 'up' ? WHEEL_STEP : -WHEEL_STEP);
      } else {
        // A press on the footer's ⧉ glyph copies the absolute logfile path.
        if (report.type === 'down' && logFilePath) {
          const rect = elementScreenRect(copyIconRef.current);
          if (rect && rectHit(rect, report.col, report.row)) {
            flashCopy(path.resolve(logFilePath), 'copied logfile path');
            continue;
          }
        }
        // A press on the ↓ indicator's "Click here" jumps to the latest logs —
        // the mouse equivalent of End, for scrolling back without the keyboard.
        if (report.type === 'down') {
          const rect = elementScreenRect(jumpToLatestRef.current);
          if (rect && rectHit(rect, report.col, report.row)) {
            viewport.scrollToBottom();
            continue;
          }
        }
        // A press on a toast's `[action]` runs it (and takes that toast down).
        // Unlike the two above there can be several at once, so this walks the
        // targets the rendered stack registered rather than a fixed ref.
        if (report.type === 'down') {
          const target = [...toasts.targets.current.values()].find((t) => {
            const rect = elementScreenRect(t.node);
            return rect && rectHit(rect, report.col, report.row);
          });
          if (target) {
            target.press();
            continue;
          }
        }
        onMouseSelect(report);
      }
    }
  });
  const { stdin } = useStdin();
  useEffect(() => {
    const decode = createMouseDecoder();
    const onData = (chunk: string | Buffer) => onMouseChunk(decode(chunk.toString()));
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
      // Ink taking its `readable` listener away while this one was attached set stdin flowing,
      // with nothing left to read it; leave it paused, as Ink does.
      if (stdin.listenerCount('readable') === 0) {
        stdin.pause();
      }
    };
  }, [stdin]);

  // While shutting down, collapse to a single non-fullscreen line. Ink clears the
  // terminal when it unmounts a *fullscreen* frame (its shouldClearOnUnmount
  // path), which can leave a blank block on the restored primary screen after the
  // alternate screen is torn down. A short final frame avoids that.
  if (shuttingDown) {
    return <Text color={WARN_COLOR}>Shutting down… (press Ctrl+C again to force kill)</Text>;
  }

  const linksColumn = (
    <LinksColumn
      topLevelUrls={topLevelUrls}
      packageUrlGroups={packageUrlGroups}
      infraUrlGroups={infraUrlGroups}
    />
  );

  const focusedPackage = displayPackages[cursor];
  const focusedStatus = focusedPackage
    ? (statuses.get(focusedPackage.name) ?? 'stopped')
    : 'stopped';
  const focusedIsActive = focusedStatus !== 'stopped' && focusedStatus !== 'waiting';
  const focusedIsRebuildable = focusedPackage
    ? args.rebuildableSet.has(focusedPackage.name)
    : false;
  const focusedService =
    cursor >= displayPackages.length ? infraNames[cursor - displayPackages.length] : undefined;
  const focusedServiceStatus =
    focusedService === undefined ? undefined : manager.infra?.status(focusedService);
  const focusedServiceBusy =
    focusedService !== undefined && (manager.infra?.isBusy(focusedService) ?? false);
  const focusedServiceUp =
    focusedServiceStatus === 'running' || focusedServiceStatus === 'starting';

  // Session-level hotkeys (act on the whole session) — pinned to the top of the footer.
  // `t: rotate` lives next to the logfile path instead (see below).
  const sessionHints: HotkeyHintItem[] = [
    { header: 'logs' },
    { key: 'c', label: 'clear' },
    { key: 'f', label: 'filter' },
    { separator: true },
    { key: '^c', label: 'quit' },
  ];

  // Hotkeys for the focused package or infra service — rendered directly above the package
  // dots. The selection hint (and its separator) only makes sense with more than one item to
  // move the cursor between; ↑/↓ join it once infra puts a second row below the packages.
  const selectHints: HotkeyHintItem[] =
    itemCount > 1
      ? [{ key: infraNames.length > 0 ? '←→↑↓' : '← →', label: 'select' }, { separator: true }]
      : [];
  const packageHints: HotkeyHintItem[] =
    focusedService !== undefined
      ? [
          ...selectHints,
          { key: 'r', label: 'restart', dim: focusedServiceBusy || !focusedServiceUp },
          // Merged start/stop toggle, as for a package.
          { key: 's', label: focusedServiceUp ? 'stop' : 'start', dim: focusedServiceBusy },
          { key: 't', label: 'reset', dim: focusedServiceBusy },
        ]
      : [
          ...selectHints,
          { key: 'r', label: 'restart', dim: !focusedIsActive },
          { key: 'b', label: 'rebuild', dim: !focusedIsActive || !focusedIsRebuildable },
          // Merged start/stop toggle: show whichever action applies to the focused package.
          focusedIsActive ? { key: 's', label: 'stop' } : { key: 's', label: 'start' },
          { key: 'm', label: 'commands' },
        ];

  const filterLine = activeFilter ? (
    <Text color={ACCENT_COLOR}>[filter: {activeFilter}] esc: clear filter</Text>
  ) : null;

  const packageStatusDots = (
    <Box flexWrap="wrap" columnGap={2}>
      {displayPackages.map((pkg, i) => {
        const status = statuses.get(pkg.name) ?? 'stopped';
        const color = STATUS_COLORS[status];
        const dim = (status === 'starting' || status === 'waiting') && !pulse;
        const isFocused = i === cursor;
        return (
          <Box
            key={pkg.name}
            flexShrink={0}
            ref={(el: DOMElement | null) => {
              itemRefs.current[i] = el;
            }}
          >
            <Text color={color} dimColor={dim}>
              ●
            </Text>
            <Text> </Text>
            {/* Bold + underline, and no color: every hue in the footer already means
                something (the dot's status, the accent, the notice), so the selection
                is marked by weight and a rule instead. Bold carries it at a glance;
                the underline is what makes it unambiguous which name is selected when
                two sit side by side. */}
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
  const infraServices = args.infra?.services ?? [];

  const topSection = shuttingDown ? (
    <Text color={WARN_COLOR}>Shutting down... (press Ctrl+C again to force kill)</Text>
  ) : isFilter ? (
    <>
      <Text bold>Filter output (space-separated terms, all must match):</Text>
      <Box>
        <Text color={ACCENT_COLOR}>&gt; </Text>
        <Text>{filterInput}</Text>
        <Text color={ACCENT_COLOR}>_</Text>
      </Box>
      <Text dimColor>{'  enter: apply   esc: cancel   empty + enter: clear filter'}</Text>
    </>
  ) : isCommands ? (
    <>
      <Text bold>
        Commands for <Text color={ACCENT_COLOR}>{focusedPackage?.displayName ?? ''}</Text>{' '}
        <Text dimColor>(custom runs via a shell)</Text>:
      </Text>
      {commandMenuItems.map((item, i) => {
        const selected = i === commandsCursor;
        if (item.type === 'custom') {
          if (selected) {
            return (
              <Box key="__custom__">
                <Text color={FOCUS_COLOR}>❯ </Text>
                <Text color={FOCUS_COLOR}>&gt; </Text>
                <Text>{customCommandInput}</Text>
                <Text color={FOCUS_COLOR}>_</Text>
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
          <Text key={item.name} color={selected ? FOCUS_COLOR : undefined}>
            {selected ? '❯ ' : '  '}
            {item.name}
          </Text>
        );
      })}
      <Text dimColor>
        {displayPackages.length > 1
          ? '  ↑↓: navigate   ←→: service   enter: run   esc: cancel'
          : '  ↑↓: navigate   enter: run   esc: cancel'}
      </Text>
    </>
  ) : (
    <>
      <HotkeyHints hints={sessionHints} />
      {filterLine}
    </>
  );

  // The hotkeys for the selected item sit directly above the dots (no vertical gap) — only in
  // normal mode, where the top section shows the session-level hotkeys.
  const isNormal = !shuttingDown && !isFilter && !isCommands;

  const borderColor = shuttingDown
    ? WARN_COLOR
    : isFilter
      ? ACCENT_COLOR
      : isCommands
        ? FOCUS_COLOR
        : MUTED_COLOR;

  // `width="100%"` rather than `columns`: on a resize Ink repaints once on its own, before this
  // component has re-rendered at the new size. A root pinned to the old `columns` draws that
  // frame — the footer's box with it — at the old width, which a narrower terminal wraps into
  // garbage; a root that follows Ink's own root is laid out at the new width straight away.
  return (
    <Box flexDirection="column" width="100%" height={rows} overflow="hidden">
      {/* Centered: the indicators are addressed to the whole viewport, not to the
          left-aligned log rows they sit against. */}
      <Box ref={topRef} flexShrink={0} justifyContent="center">
        {viewport.hiddenAbove > 0 && (
          <Text dimColor>
            {`↑ ${viewport.hiddenAbove} older line${viewport.hiddenAbove === 1 ? '' : 's'} — press Home to jump to oldest`}
          </Text>
        )}
      </Box>
      {/* Always rendered so flexGrow pins the footer to the bottom from the first
          frame; paneHeight is briefly the full height until the footer is measured,
          which is harmless (the run-phase buffer starts empty, or with only the few
          lines infra printed while the session started). */}
      <LogPane rows={viewport.rows} highlights={highlights} />
      <BottomChrome
        ref={bottomRef}
        toasts={toasts}
        hiddenBelow={viewport.hiddenBelow}
        jumpToLatestRef={jumpToLatestRef}
        borderColor={borderColor}
      >
        <Box flexDirection="column" flexGrow={1}>
          {topSection}
          {/* One stack: the hotkeys for the selected item, then the packages and the infra
              services they act on. */}
          <Box flexDirection="column" marginTop={1}>
            {isNormal && <HotkeyHints hints={packageHints} />}
            {packageStatusDots}
            {infraServices.length > 0 && (
              // The session's infra, listed right under the packages and selectable with them.
              // Each dot is the service's live state, or pulses while an action runs.
              <Box flexWrap="wrap" columnGap={2}>
                <Text color={ACCENT_COLOR}>infra:</Text>
                {infraServices.map((service, j) => {
                  const index = displayPackages.length + j;
                  const status = INFRA_DOT_STATUS[manager.infra?.status(service.name) ?? 'running'];
                  const dim = status === 'starting' && !pulse;
                  const isFocused = index === cursor;
                  return (
                    <Box
                      key={`${service.provider}/${service.name}`}
                      flexShrink={0}
                      ref={(el: DOMElement | null) => {
                        itemRefs.current[index] = el;
                      }}
                    >
                      <Text color={STATUS_COLORS[status]} dimColor={dim}>
                        ●
                      </Text>
                      <Text> </Text>
                      <Text bold={isFocused} underline={isFocused}>
                        {service.name}
                      </Text>
                    </Box>
                  );
                })}
              </Box>
            )}
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Box columnGap={2}>
              <Text>
                <Text color={ACCENT_COLOR}>cwd: </Text>
                <Text color={OK_COLOR}>{path.basename(process.cwd())}</Text>
              </Text>
              {gitBranch && (
                <Text>
                  <Text color={ACCENT_COLOR}>git: </Text>
                  <Text color={OK_COLOR}>{gitBranch}</Text>
                </Text>
              )}
            </Box>
            {logFilePath && (
              <Box columnGap={2}>
                <Text dimColor>logfile: {displayLogFile(logFilePath)}</Text>
                {/* Click to copy the absolute logfile path (hit-tested via copyIconRef). */}
                <Box ref={copyIconRef}>
                  <Text color={LINK_COLOR}>⧉</Text>
                </Box>
                {/* With an infra service focused, `t` resets it instead. */}
                {isNormal && focusedService === undefined && (
                  <HotkeyHints hints={[{ key: 't', label: 'rotate' }]} />
                )}
              </Box>
            )}
          </Box>
        </Box>
        {linksColumn}
      </BottomChrome>
    </Box>
  );
}
