# Terminal UI rendering architecture

How devtooie draws its interactive terminal UI. This is a **contributor** document
about internals — not a usage guide. Read it before changing anything about the
log viewport, scrolling, the footer, or how output reaches the screen.

> This branch (`fullscreen-tui`) uses the **fullscreen / alternate-screen** model
> described below. The `main`/`footer-refactor` line uses a different
> "write-above" model (Ink renders only the footer; logs go to native
> scrollback). See the "Roads not taken" section for why this branch trades that
> away.

## The one idea to hold onto

devtooie runs as a **fullscreen TUI in the terminal's alternate screen** (like
`vim`/`htop`), and **Ink owns the entire viewport**:

- `renderApp` (`components/App.tsx`) mounts with `alternateScreen: true`, so the
  original terminal contents are saved on start and restored on exit.
- The screen is a flex column: a **log pane that fills the height** on top, and a
  **footer pinned to the bottom** by flexbox. On resize, Ink re-lays-out both — no
  cursor math, no gaps or ghosts.
- Child-process logs are **rendered by Ink**, not streamed to the terminal. They
  live in a `ProcessManager` buffer, and a **virtualized** `LogPane` draws only the
  rows that fit the viewport.

The trade-off: the terminal's **native scrollback is unavailable** in the
alternate screen, so scrolling back through history is an in-app feature (mouse
wheel + keys), not the terminal's own scroll.

## Phases

The app is a small phase machine (`components/App.tsx`), all in the alternate
screen:

```
package-select  ->  building  ->  running
(PackageSelector)  (BuildProgress)  (NativeRunner + ProcessManager)
```

Everything below is the **running** phase (`NativeRunner`). `renderApp` mounts the
whole tree with `exitOnCtrlC: false` (each phase owns Ctrl+C) and `maxFps: 120`.

## Layout

`NativeRunner` renders a full-height flex column (`components/NativeRunner.tsx`):

```
<Box flexDirection="column" width={columns} height={rows}>   // useWindowSize()
  <Box ref={topRef} flexShrink={0}>       // measured -> topHeight
    {↑ N older lines, when content is hidden above}
  </Box>
  <LogPane rows={viewport.rows} />        // flexGrow: 1 — fills the height
  <Box ref={bottomRef} flexShrink={0}>    // measured -> bottomHeight
    {↓ N newer lines, when scrolled up}
    <Box borderStyle="single"> …footer… </Box>
  </Box>
</Box>
```

- `useWindowSize()` gives `{ columns, rows }` and re-renders on resize.
- The top indicator and the bottom section (↓ indicator + footer) are each
  measured every render via `measureElement` (`topHeight` / `bottomHeight`), so the
  log pane fills exactly the space between them:
  `paneHeight = rows − topHeight − bottomHeight`.
- `LogPane` is always rendered (never gated on the measurement), so flexbox pins
  the footer to the bottom from the first frame; `paneHeight` is briefly the full
  height until the chrome is measured, which is harmless (the run-phase buffer
  starts empty).
- The footer content is unchanged from before (package dots, hotkey hints, URL
  links, `git:(branch)` / `logfile:`); it's simply no longer hand-positioned.

## Virtualized log viewport

The perf core lives in three pure, unit-tested modules and the `useLogViewport`
hook (`components/LogPane.tsx`).

- **`log-window.ts` — `computeWindow(rowCounts, paneHeight, scrollOffset)`**:
  variable-height virtualization anchored at the bottom. Given each line's
  rendered-row count, the pane height, and how far the view is scrolled up (in
  rendered rows from the newest output), it returns just the slice of lines that
  intersect the viewport, plus how many rows of the first/last line spill past the
  edges (`topClip`/`bottomClip`). `windowRows(...)` flattens that slice into
  exactly the on-screen rows, clipping the partially-visible ends.
- **`scroll.ts`**: the scroll position (`offset`, rows from the bottom; `0` =
  following the newest output) and its transitions — `scroll`, `scrollToTop`,
  `scrollToBottom`, and `onContentResized` (keeps a scrolled-up view pinned to the
  same content as the buffer grows; stays following at the bottom otherwise).
- **`mouse.ts`**: alternate-scroll-mode escapes for wheel scrolling (see below).

`useLogViewport(manager, width, height)`:

1. Subscribes to the manager with `useSyncExternalStore` (snapshot = the buffer
   `version`).
2. Reads the filtered visible lines, gets each line's row count (memoized on the
   line, recomputed only when the width changes), runs `computeWindow`, and
   materializes only the visible rows with `windowRows` — **never more than
   `height` `<Text>` nodes**, regardless of buffer size.
3. Holds the scroll position and exposes `scrollLines` / `scrollPages` /
   `scrollToTop` / `scrollToBottom`; pins a scrolled-up view through buffer growth
   via `onContentResized`.

`LogPane` itself is a dumb renderer: it draws the pre-windowed rows
bottom-aligned (`justifyContent="flex-end"`, so newest sits just above the
footer), each `<Text wrap="truncate-end">` (rows are already wrapped to width).

## ProcessManager: a subscribable buffer

`process-manager.ts` still owns process lifecycle, filtering, the logfile, and the
line buffer (capped at `MAX_BUFFER_LINES`). What changed:

- **It no longer paints the terminal in interactive mode.** `addLine` buffers the
  line, writes the logfile, and calls `notify()`. Only **plain mode**
  (`--plain`, non-TTY) still streams lines to stdout — all the write-above
  machinery (`renderNewLine`/`emitLine`/`resetScreen`/`replayBuffer`) is now gated
  behind `this.plain`.
- **Subscription API for Ink**: `subscribe(listener)` + `getVersion()` (a
  monotonic counter) back `useSyncExternalStore`. `notify()` bumps the version and
  flushes listeners on a **microtask**, coalescing a burst of log lines into one
  re-render.
- **Buffer queries**: `getVisibleLines()` (group-aware filter result, memoized per
  version), `countRows(line, width)` (memoized per line), and
  `wrapLine(line, width)` (rendered rows for one line).

## Scrolling & input

Handled in `NativeRunner`'s `useInput`:

- **Mouse wheel**: enabled on mount by writing `ALT_SCROLL_ENABLE` (`ESC[?1007h`,
  the terminal's **alternate-scroll mode**) and disabled on unmount. This does
  **not** enable mouse reporting, so **native click-drag text selection keeps
  working** (essential for copying log lines). Instead the terminal translates the
  wheel into Up/Down arrow presses while in the alternate screen, so the wheel and
  the arrow keys drive the same scroll. See `mouse.ts` for the full rationale.
- **Keyboard** (normal mode): `↑`/`↓` scroll a line (this is also where the wheel
  arrives), `PgUp`/`PgDn` page, `Home`/`End` jump to oldest/newest (End re-enters
  follow). `←`/`→` navigate packages (up/down no longer do, since they scroll).
- **Keyboard** (commands mode, the `m` menu): `↑`/`↓` move within the focused
  package's command list and `←`/`→` switch the focused package in place — the
  same wrap-around cursor as normal mode — so commands on another package can be
  picked without leaving the menu. Switching is suppressed only while the custom
  row holds typed text (which a switch would clear), resets the highlight to the
  new package's first row, and clears any custom input.
- One-line **scroll indicators** frame the pane when the log overflows: a
  `↑ N older lines — press Home to jump to oldest` line at the very top whenever
  content is hidden above (`hiddenAbove > 0`, i.e. not scrolled to the top), and a
  `↓ N newer lines — press End to jump to latest` line above the footer whenever
  content is hidden below (`hiddenBelow > 0`, i.e. scrolled up). Each is measured
  (`topRef`/`bottomRef`) and subtracted from `paneHeight`.

## Plain / non-TTY mode

`--plain` (and any non-TTY context — `runners/plain.ts` builds
`new ProcessManager(args, { plain: true })`) is unchanged: no alternate screen, no
Ink log rendering; `addLine` streams each line to stdout. All the interactive
machinery is gated on `!plain`. Don't regress this path.

## Roads not taken (and why this shape)

- **Write-above on the primary screen** (the `main` model): Ink renders only the
  footer, logs go to real **native scrollback**, and the footer is hand-anchored
  to the bottom via cursor math. Keeps the terminal's own wheel scroll, but the
  hand-anchoring is fragile (resize gaps/ghosts) and can't pin a footer without a
  1-row cursor line. This branch trades native scrollback for Ink owning the
  screen, which makes the footer and resize trivially correct and enables the
  virtualized viewport — at the cost of reimplementing scroll in-app.
- **SGR mouse reporting** (`?1000h`) for the wheel: gives precise wheel events but
  captures all clicks/drags, breaking native text selection. Rejected in favor of
  alternate-scroll mode (`?1007h`), which keeps selection working.

## File / symbol map

| Concern                                            | Where                        |
| -------------------------------------------------- | ---------------------------- |
| Alternate screen, phase machine, `renderApp`       | `components/App.tsx`         |
| Fullscreen layout, input, scroll/mouse wiring      | `components/NativeRunner.tsx` |
| Virtualized viewport hook + presentational pane    | `components/LogPane.tsx`     |
| Virtualization math (`computeWindow`/`windowRows`) | `log-window.ts`              |
| Scroll position + transitions                      | `scroll.ts`                  |
| Alternate-scroll-mode escapes (wheel scrolling)    | `mouse.ts`                   |
| Tab/window title + stripping child title escapes   | `terminal-title.ts`          |
| Buffer, subscription, queries, plain-mode streaming| `process-manager.ts`         |

## Invariants to preserve

- Interactive mode never writes to the terminal directly — the screen is a pure
  function of the buffer + scroll state, rendered by Ink.
- `LogPane` renders at most `paneHeight` rows; keep the windowing
  (`computeWindow`/`windowRows`) as the single source of what's on screen.
- The `plain` path stays a plain line printer with none of the Ink rendering.
- Never enable mouse *reporting* (`?1000h`): it would break native click-drag
  text selection, which is essential for copying log lines. Use alternate-scroll
  mode (`?1007h`) for the wheel, and disable it on unmount.
- The tab/window title is pinned once to `devtooie: <config-root basename>` on
  mount (`renderApp`, via `terminal-title.ts`). Child dev processes emit their own
  OSC 0/1/2 title escapes, and since their output is captured and re-rendered to
  the real terminal those would otherwise make the tab flicker — so
  `stripTitleSequences` removes them at every `process-manager.ts` ingestion point.
  Keep both halves: set our title, and strip theirs.
- On shutdown, collapse the UI to a short (non-fullscreen) frame so Ink's
  fullscreen-unmount clear can't leave a blank block on the restored screen, and
  flush stdout (an empty-write barrier) before `process.exit` so the
  alternate-screen teardown writes aren't truncated.
