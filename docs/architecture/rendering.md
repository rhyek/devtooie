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

The perf core lives in two pure, unit-tested modules and the `useLogViewport`
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
- **Log formatting** (`log-formatter.ts`): every **raw child-process** line runs through a
  formatter in the `start`/`spawnExtra` stdout/stderr handlers, via `addOutput` → `formatOutput`,
  *before* it reaches `addLine` — so the buffer, screen, and logfile all hold the formatted text.
  A package's `logs.formatter` (if set) owns presentation; otherwise the module's `defaultFormatter`
  (`= createFormatter()`, exposed publicly as `logging.formatter()`) runs and is applied to **every
  package** — it passes non-JSON through and pretty-prints JSON logs as `[LEVEL] message` + indented
  properties. `addOutput` splits a multi-line result into separate buffered lines, so the indented
  ones group as continuations and each gets its own prefix in the logfile. Lines the default leaves
  unchanged keep the plain/red-stderr rendering; devtooie's own status lines (`started`, `stopping…`)
  never pass through it. The timestamp is still devtooie's (added in `addLine`), never the log's own.
- **Per-package `logs.timestamps`**: on-screen timestamp visibility is resolved per
  package (`pkg.logs.timestamps ?? top-level default`) into `showTsBySearchName`,
  stamped onto each `BufferedLine` as `showTs`, so `tsPrefix`/`gutterWidth` render
  (and align) each line by its own package's setting. The logfile is always
  timestamped regardless.

## Scrolling & input

Handled in `NativeRunner`'s `useInput`. **SGR mouse reporting** is enabled on
mount by writing `MOUSE_ENABLE` (`ESC[?1002h` button-event tracking + `ESC[?1006h`
SGR coordinates, from `mouse.ts`) and disabled on unmount. Ink delivers each
report to `useInput` as `input`; `isMouseSequence`/`parseMouseEvents` decode them.

- **Mouse wheel**: reports arrive as buttons 64 (up) / 65 (down) and scroll the
  viewport by `WHEEL_STEP` rows (dropping any active selection).
- **Keyboard** (normal mode): `↑`/`↓` scroll a line, `PgUp`/`PgDn` page,
  `Home`/`End` jump to oldest/newest (End re-enters follow). `←`/`→` navigate
  packages (up/down no longer do, since they scroll). Any keyboard scroll drops an
  active selection.
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

## Text selection (drag to copy)

Because Ink owns the screen and repaints cells in place, the terminal's **native**
click-drag selection can't survive a scroll or an incoming log line (it's anchored
to screen cells, which we overwrite). So selection is **app-managed**, tmux-style:
enabling mouse reporting takes the mouse from the terminal, and `useDragSelection`
(`components/LogPane.tsx`) reimplements select-and-copy over the log content.

- **Content-anchored coordinates.** A selection is two points in the viewport's
  **flat rendered-row space** (`selection.ts`): row 0 is the oldest rendered row of
  the whole buffer, and a row keeps its index as new output is appended below it.
  `useLogViewport` exposes `firstVisibleFlatRow` to map between screen rows and
  that space. Anchoring here — not to screen cells — is what lets a selection ride
  along as content scrolls and as logs arrive (the thing native selection can't
  do). It's only invalidated by a re-flow: resize, filter change, or `k` clear
  (all call `clearSelection`); eviction past `MAX_BUFFER_LINES` shifts flat rows,
  the one accepted edge case.
- **Drag → select; `c` → copy.** `down` starts the selection; `move` (button
  held) extends it; `up` finalizes it and captures the WYSIWYG, ANSI-stripped
  text (`selectionText`: character-precise on the first/last row, full width in
  between) — but does **not** copy. Copying is a separate, deliberate action: `c`
  (a footer hint shown only while a selection exists) calls `copyToClipboard`,
  flashes `copied N lines`, and then **clears the selection** (the flash confirms
  it); `esc` (or a filter change / resize / `k`) also clears it. Scrolling does
  **not** clear it — the content-anchored highlight just rides along. The live
  selection lives in a ref (not state) so a burst of
  `move`+`up` in one read see each other synchronously; a reducer bump forces the
  repaint.
- **Clipboard (`clipboard.ts`), prompt-aware.** Locally it uses the **native
  command** (`pbcopy`/`clip`/`wl-copy`/…) only — reliable, and unlike OSC 52 it
  never trips a terminal's clipboard-access prompt (iTerm2's "Applications in
  terminal may access clipboard"). **OSC 52** is used over SSH (the only thing
  that reaches the user's local terminal) and as a local fallback when no native
  binary exists.
- **Highlight rendering.** `LogPane` gets a per-visible-row span; a highlighted row
  is split with `slice-ansi` into colored `pre`/`post` and an ANSI-stripped `mid`
  rendered `<Text inverse>` (stripping the middle sidesteps the embedded `ESC[0m`
  resets in log text cancelling the inversion).
- **Escape hatch.** With reporting on, the terminal's own selection is disabled;
  most terminals still force native selection while **Option/Alt** is held.

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
- **Alternate-scroll mode** (`?1007h`) for the wheel: translates the wheel into
  arrow keys without capturing the mouse, so the terminal's **native** selection
  keeps working — which is why an earlier cut of this branch used it. But native
  selection can't survive our in-place repaints (it goes static on new logs and
  copies the wrong line), so it was replaced by full SGR mouse **reporting**
  (`?1002h`+`?1006h`) driving an app-managed selection (see "Text selection"). The
  cost: the terminal's own selection is off while devtooie runs (Option/Alt still
  forces it).
- **An explicit copy-mode** (freeze the frame, move a cursor, `y` to yank, like
  tmux copy-mode): more robust but modal and higher-friction. Rejected for
  seamless always-on drag-select.

## File / symbol map

| Concern                                            | Where                        |
| -------------------------------------------------- | ---------------------------- |
| Alternate screen, phase machine, `renderApp`       | `components/App.tsx`         |
| Fullscreen layout, input, scroll/mouse wiring      | `components/NativeRunner.tsx` |
| Viewport hook, drag-select hook, presentational pane | `components/LogPane.tsx`   |
| Virtualization math (`computeWindow`/`windowRows`) | `log-window.ts`              |
| Scroll position + transitions                      | `scroll.ts`                  |
| SGR mouse escapes + `parseMouseEvents` decoder     | `mouse.ts`                   |
| Selection geometry/text math (highlight, copy text)| `selection.ts`               |
| Best-effort clipboard (OSC 52 + native command)    | `clipboard.ts`               |
| Tab/window title + stripping child title escapes   | `terminal-title.ts`          |
| Buffer, subscription, queries, plain-mode streaming| `process-manager.ts`         |

## Invariants to preserve

- Interactive mode never writes to the terminal directly — the screen is a pure
  function of the buffer + scroll state, rendered by Ink.
- `LogPane` renders at most `paneHeight` rows; keep the windowing
  (`computeWindow`/`windowRows`) as the single source of what's on screen.
- The `plain` path stays a plain line printer with none of the Ink rendering.
- SGR mouse **reporting** (`?1002h`+`?1006h`) is enabled while the run phase is
  mounted and **must be disabled on every exit path** or the terminal is left
  capturing the mouse: the unmount effect cleanup, the explicit write in
  `shutdown()`, and the hard-kill (second Ctrl+C) branch all write `MOUSE_DISABLE`.
- Text selection is app-managed and **anchored to flat-row/column content
  coordinates**, never to screen cells — that's what makes it survive scroll and
  incoming logs. Clear it on any re-flow (resize, filter, `k`); don't clear it on
  plain appends.
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
