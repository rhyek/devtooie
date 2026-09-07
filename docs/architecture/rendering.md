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

**Every phase fills the viewport.** Each phase component's root is sized to
`useWindowSize()` (`width={columns} height={rows}`) — `NativeRunner`, but also the
short pre-run phases (`PackageSelector`, `BuildProgress`). This is load-bearing,
not cosmetic: Ink only anchors a frame at the top when it detects it as
_fullscreen_ (`outputHeight >= viewportRows`). Entering the alternate screen
(`ESC[?1049h`) does **not** home the cursor, so a short, non-fullscreen frame is
drawn wherever the cursor was left on the primary screen — near the bottom, after
the shell prompt + the `▶ devtooie started` line — leaving a large blank gap
above it. Giving these phases a full-height root makes them fullscreen and
top-aligned. Any new phase must do the same.

## Layout

`NativeRunner` renders a full-height flex column (`components/NativeRunner.tsx`):

```
<Box flexDirection="column" width={columns} height={rows}>   // useWindowSize()
  <Box ref={topRef} flexShrink={0}>       // measured -> topHeight
    {↑ N older lines, when content is hidden above}
  </Box>
  <LogPane rows={viewport.rows} />        // flexGrow: 1 — fills the height
  <BottomChrome ref={bottomRef}>          // measured -> bottomHeight
    <ToastStack />                        // position: absolute — adds no height
    {↓ N newer lines, when scrolled up}
    <Box borderStyle="single"> …footer… </Box>
  </BottomChrome>
</Box>
```

- `useWindowSize()` gives `{ columns, rows }` and re-renders on resize.
- **`BottomChrome`** (`components/BottomChrome.tsx`) is everything pinned below the
  log pane, as one bottom-aligned stack: the ↓ jump-to-latest row (only while
  scrolled up) above the bordered footer. It owns the stack and the border; the
  footer's contents come in as `children`, still composed by `NativeRunner`.
  `ToastStack` is a child too, but absolutely positioned — it floats above this
  box's top edge instead of sitting in the column, so it contributes nothing to
  `bottomHeight` (see [Toasts](#toasts)).
- The top indicator and `BottomChrome` are each measured every render via
  `measureElement` (`topHeight` / `bottomHeight`), so the log pane fills exactly the
  space between them: `paneHeight = rows − topHeight − bottomHeight`. That
  measurement is why a row can appear or disappear in the stack without any cursor
  math — the pane just resizes.
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
- **Wrapping** (`wrapLine`, and plain mode's `formatLine`, which just joins its rows so both
  paths lay out identically). Three things it has to get right, each of which was once wrong:
  - **Every** row carries the timestamp + `[name]` prefix, not just the first, so a wrapped line
    keeps an unbroken left gutter.
  - Continuation rows are indented by `hangingIndent(text)` — the width of a leading
    ` key:` — so they line up under the _value_, matching how `log-formatter.ts` aligns a value
    containing newlines. Falls back to the line's own leading whitespace, then to 0.
  - `wrapAnsi` is called with **`trim: false`**. Its default strips a row's leading whitespace,
    which eats the formatter's two-space property indent and leaves a wrapped `  key:` sitting two
    columns left of every key short enough not to wrap. Because `wrap-ansi` only wraps to one fixed
    width, `wrapRows` walks row by row, slicing off what the previous row consumed, so row 0 can be
    full width while the rest are narrower by the indent.

  `gutterWidth` measures the line's **actual** prefix rather than the nominal `prefixWidth`:
  devtooie's own labels are `padEnd`ed to the widest _package_ name and `padEnd` never truncates,
  so `[dt:control] ` stays wider than `prefixWidth` in a workspace of short names — and assuming
  the nominal width there overflows the terminal, where `truncate-end` silently eats the tail.

- **Log formatting** (`log-formatter.ts`): every **raw child-process** line runs through a
  formatter in the `start`/`spawnExtra` stdout/stderr handlers, via `addOutput` → `formatOutput`,
  _before_ it reaches `addLine` — so the buffer, screen, and logfile all hold the formatted text.
  A package's `logs.formatter` (if set) runs in place of the module's `defaultFormatter`
  (`= createFormatter()`, exposed publicly as `logging.formatter()`), which otherwise applies to
  **every package** — it passes non-JSON through and pretty-prints JSON logs as `[LEVEL] message` +
  indented properties. `addOutput` splits a multi-line result into separate buffered lines, so the
  indented ones group as continuations and each gets its own prefix in the logfile. A formatter owns
  presentation only of the lines it **rewrites**: whichever formatter ran, a line handed back
  unchanged keeps the plain/red-stderr rendering. Keep that rule shared — branching on whether a
  formatter was configured is what used to strip the red from stderr as soon as one was set.
  devtooie's own status lines (`started`, `stopping…`) never pass through any of this. The timestamp
  is still devtooie's (added in `addLine`), never the log's own.
- **Per-package `logs.timestamps`**: on-screen timestamp visibility is resolved per
  package (`pkg.logs.timestamps ?? top-level default`) into `showTsBySearchName`,
  stamped onto each `BufferedLine` as `showTs`, so `tsPrefix`/`gutterWidth` render
  (and align) each line by its own package's setting. The logfile is always
  timestamped regardless.
- **Timestamp layout (`timestamp-mode.ts`)**: a shown stamp is rendered in one of two
  layouts — `time` (`HH:MM:SS`, 9 columns of gutter) while every timestamped line **on
  screen** falls on one day, `date` (the full stamp, 20 columns) once two days are visible
  together. `useLogViewport` decides per render: it lays the buffer out in **both** modes
  (`countRows(line, cols, mode)` keeps one memo slot per mode, since evicting would thrash),
  tries the `time` window first and keeps it if `spansOneDay` holds over its visible range,
  else renders the `date` window. The choice is a pure function of the stored scroll
  position, so it can't oscillate. Because the narrower gutter reflows wrapped lines, the
  scroll offset is **stored in the `date` layout's row space** (the reference layout, where
  no line takes fewer rows) and translated into the rendered layout through a bottom
  **anchor** — the line at the bottom edge plus its rows clipped below (`bottomAnchor` /
  `anchorOffset` / `convertOffset` in `log-window.ts`). `scrollLines`/`scrollPages` move in
  rendered rows and translate back; `onContentResized` measures the buffer's growth in the
  `date` layout so a layout flip contributes no delta. A flip is a re-flow, so `NativeRunner`
  clears the selection on `viewport.tsMode` like it does on resize. Plain mode and the
  logfile always use the full stamp.

## Scrolling & input

Handled in `NativeRunner`'s `useInput`. **SGR mouse reporting** is enabled on
mount by writing `MOUSE_ENABLE` (`ESC[?1002h` button-event tracking + `ESC[?1006h`
SGR coordinates, from `mouse.ts`) and disabled on unmount. Ink delivers each
report to `useInput` as `input`; `isMouseSequence`/`parseMouseEvents` decode them.

`MOUSE_ENABLE` is **re-asserted on every resize**, because a terminal can hand our
session to a _fresh_ emulator that restores the modes from an incomplete snapshot.
VS Code's "Reload Window" does exactly this: the pty is reattached to a new
xterm.js restored by its `SerializeAddon`, which re-emits the _tracking_ mode
(`?1002h`) but not the _encoding_ mode (`?1006h`). Reports then resume in the
legacy X10 encoding (`ESC[M` + three coordinate bytes), which our SGR decoder
doesn't match — so the wheel and drag-select go silently dead while the keyboard
keeps working. A reattach always re-measures the terminal, so the resize heals it
before the next mouse event. As a backstop, `isLegacyMouseSequence` recognizes an
X10 report and re-asserts on the spot; its coordinate bytes arrive as their own
input event and are swallowed (`LEGACY_MOUSE_PAYLOAD_LENGTH`) so they can't type
themselves into the filter or a custom command. X10 itself is never decoded — it
caps at column 223 and its raw bytes are mangled by the input layer's UTF-8
decoding, and re-asserting brings SGR straight back.

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
  `↓ N newer lines — press End or Click here to jump to latest` line above the
  footer whenever content is hidden below (`hiddenBelow > 0`, i.e. scrolled up).
  Each is measured (`topRef`/`bottomRef`) and subtracted from `paneHeight`, and each
  is **centered** in the viewport — they address the whole pane, not the left-aligned
  rows they sit against. The bottom one's **`Click here`** is a click target (see
  "Click targets" below), so returning to the live tail never requires the keyboard;
  it is split into its own `<Box>`/`<Text>` purely to carry the ref, with the
  surrounding spacing kept inside the neighbouring strings rather than as a
  `columnGap`. Note that the centering `justifyContent` wraps a **single** child
  which then holds those three pieces: an odd amount of free space centers on a half
  column, and justifying the pieces directly makes each round it independently —
  which drifts them apart, doubling a space and clipping the last character.

## Text selection (drag, double-click, triple-click)

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
- **Value-scoped copy.** A rendered row's gutter (timestamp + `[name]`) and hanging
  indent are presentation, not text, so a copy that began _inside a value_ drops them.
  `classifyLine` locates where a line's value starts (` key:` → after the key;
  `[LEVEL] ` → after the token; indented-with-no-key → after the indent; anything else
  → column 0). `down` compares the press column against that: at or past it selects in
  `mode: 'value'` and records the `valueRun` (the line's wrapped rows plus any following
  indented continuations); left of it — the gutter or the key — keeps the old WYSIWYG
  mode, which is the escape hatch for copying a line as shown. `selectionCopyText`
  then floors every row at its `valueStart` and rejoins: rows of the **same** buffered
  line with no separator (the terminal introduced that break), distinct lines with a
  newline (the value contained one). Dragging either end outside the run reverts the
  whole copy to WYSIWYG. `rowSpan` takes the same floor so the highlight shows exactly
  what will be copied.
  `classifyLine` is deliberately **not** `hangingIndent` (`process-manager.ts`): that
  returns 0 for a `[LEVEL] …` header so a wrapped message stays flush with the gutter,
  while this returns the token width so selecting a message starts after `[INFO] `.
  Keep them separate. Row metadata (`RowMeta`: text, `contentStart`, `valueStart`,
  `lineIndex`, `kind`) is produced by `wrapLineRows` + `classifyLine` and carried
  through `windowRows`, which is generic over the row type.
- **Drag → select → copy-on-release.** `down` starts the selection; `move` (button
  held) extends it; `up` finalizes it, captures the ANSI-stripped text
  (`selectionCopyText`: character-precise on the first/last row, full width in between),
  and **copies it immediately** — `copyToClipboard` + a `copied N chars` toast, with
  no key press. This is deliberate: in the VS Code integrated terminal Cmd+C is
  swallowed by VS Code's keybinding layer before it reaches the process (its default
  Cmd+C binding needs a _native_ xterm selection, which our mouse reporting
  suppresses), so a copy hotkey can't be made reliable there. Copying on release
  sidesteps the key entirely. The highlight then **lingers for `SELECTION_LINGER_MS`
  (5s)** — so you briefly see what was copied — and the toast expires on its own
  clock, set to the same 5s so the two still go away together. They are two timers,
  though: dismissing the toast alone deliberately leaves the highlight up. `esc` (or
  a filter change / resize / `k` / a fresh drag) clears both sooner and cancels the
  linger. Scrolling does **not** clear it —
  the content-anchored highlight just rides along. The live selection lives in a ref
  (not state) so a burst of `move`+`up` in one read see each other synchronously; a
  reducer bump forces the repaint.
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
- **Double-click a word, triple-click a line** (`word-select.ts`, a pure module with
  no React in it). Both select **and copy immediately** — there's no drag to wait
  for — reusing `flashCopy`, so the highlight and the "copied N chars" toast behave
  exactly as after a drag. The handler leaves `dragging` false, which makes the
  trailing `up` (and any twitch `move`) fall through the existing guard untouched.
  - **Detecting the multi-click is on us.** The SGR protocol carries **no click
    count** — xterm.js gets one free from the DOM's `event.detail`, which we don't
    have — so `trackClick` times it: a second press within `DOUBLE_CLICK_MS` (300ms,
    tmux's `KEYC_CLICK_TIMEOUT`; xterm uses 250, kitty 500) on the **same cell**.
    The cell is tracked in _content_ coordinates (`col` + `flatRow`), so a wheel
    scroll between two presses lands on a different row and breaks the streak for
    free. A `move` resets it; an `up` must not. `mouse.ts` stays a pure protocol
    parser — click counting is stateful interpretation, not protocol.
  - **A URI short-circuits everything.** `wordSpanAt` first matches
    `scheme://…` up to whitespace and, if the press landed anywhere inside one,
    returns that whole match (minus trailing sentence punctuation and closing
    pairs — `/` stays, since `http://host/` is a real URI). This runs _before_ the
    character rules because inside a URI `?`, `=` and `&` bind rather than
    separate; outside one they do the opposite, and no single character class can
    be both.
  - **Word boundaries** otherwise follow the model every emulator uses — word
    characters plus _joiners_ that hold a run together — with one pass on top:
    trailing joiners are trimmed. Word chars are `[\p{L}\p{M}\p{N}_]` (the Unicode
    property escapes are load-bearing: ASCII `\w` breaks any accented word, and
    `\p{M}` keeps decomposed text from splitting mid-glyph). Joiners are
    `- . / ~ : @ # % +`; the trim set is the same minus `/`, and only ever applies
    to the **end**. That asymmetry is what makes `./scripts/x.sh.` come out as
    `./scripts/x.sh` while `.env`, `~/src` and `--verbose` keep their lead.
    `=`, `?` and `&` are deliberately _not_ joiners: they separate one thing from
    another, so `env=value` double-clicks to `env` (and the whole assignment is a
    triple-click away). Column math goes through the same `string-width` semantics
    as the rest of selection, so a wide glyph counts as two columns. A run of pure
    joiners (`...`) is kept whole rather than trimmed to nothing, and a press on
    whitespace or a bracket yields no span — it falls through to plain-click
    behavior rather than copying punctuation.
  - **Wrapping is invisible to it.** `wordSelectionAt` gathers every rendered row
    sharing the clicked row's `lineIndex`, concatenates each one's content past
    `contentStart`, and runs the word rules over _that_. It reproduces the emitted
    line exactly, because the wrapper is lossless — `wrapRows` slices off precisely
    what each row consumed (`trim: false`) and inserts nothing. The resulting span
    maps back to an anchor and focus that may sit on **different rows**, which the
    existing model already handles: `rowSpan` floors the highlight at `valueStart`
    on each row, and value-mode `selectionCopyText` rejoins rows of one line with
    no separator. So a URI split by the terminal's width still copies unbroken. A
    press in the gutter or hanging indent returns null here and falls back to the
    single-row scan — which is what still selects a `[package]` name.
  - **Triple-click** reuses the gutter rule: inside the value it takes the whole
    `valueRun` in value mode (so the copy has no timestamp/`[name]` prefix), on the
    gutter it takes the rendered row as shown. Like the drag it can only see the
    **visible** rows, so a value running off-screen clips. Four-plus clicks just
    re-run it, harmlessly.
- **Escape hatch.** With reporting on, the terminal's own selection is disabled;
  most terminals still force native selection while **Option/Alt** is held.
- **Click targets.** Hit-testing can't use `measureElement` (it returns only
  width/height), so `elementScreenRect` (`NativeRunner`) recovers an element's
  absolute cell by summing each ancestor's yoga `getComputedLeft/Top` up the
  `parentNode` chain, mapped to 1-based SGR coords; `rectHit` adds a cell of slack
  so a narrow target stays easy to click. Each target is a `<Box>` carrying a ref,
  tested against a mouse **press** in the mouse block _before_ `onMouseSelect`, so
  the press starts no selection. Three exist today, and this is the general hook
  for any future one:
  - **`⧉` in the footer** — copies the _absolute_ logfile path (`path.resolve`,
    not the relative string the line displays) and raises the same toast via
    `DragSelection.flashCopy(text, label)`.
  - **`Click here` in the `↓` indicator** — calls `viewport.scrollToBottom()`, the
    mouse equivalent of `End`. It's mounted only while scrolled up, so a null rect
    from `elementScreenRect` is the gate; no separate `hiddenBelow` check.
  - **A toast's `[action]`** — unlike the two above there can be several at once,
    so this walks `Toasts.targets` (a ref'd `Map` the rendered stack registers
    into) instead of a fixed ref. See below.

## Toasts

Transient notices, floating over the bottom of the log pane. `toasts.ts` is the
pure, unit-tested policy (what a toast is, the `MAX_TOASTS` cap, which one gives
way); `components/ToastStack.tsx` holds the React plumbing (`useToasts` — ids,
expiry timers, click targets) and the renderer.

- **`notify({ message, tone?, duration?, actions? })`** returns an id;
  `dismiss(id)` takes it down early. `duration` is ms or `'sticky'` — sticky toasts
  wait for the user, cleared by clicking an action or by `esc`.
- **Who raises one today:** the copy-on-select flash (`flashCopy`, via
  `useDragSelection`) and filter changes (`changeFilter` in `NativeRunner`, which
  both entry points — `enter` in filter mode, `esc` in normal mode — route through
  so they can't drift). `changeFilter` stays silent when the filter didn't actually
  change: a toast marks a transition, not a keypress.
- **`esc` order** is selection → newest **sticky** toast → filter, so a sticky toast
  is always dismissible without a mouse. Transient toasts are deliberately _not_ in
  that chain (`newestSticky`): they clear themselves, so letting one absorb the
  `esc` aimed at the filter beneath it would only cost the user a keypress — which
  is exactly what applying a filter (and toasting about it) would otherwise do.
- **The stack takes no space, and that is layout — not measurement.** It is a
  `position: absolute` child of `BottomChrome` with `bottom: 100%` and `right: 0`,
  so it is out of flow (the pane keeps every row, nothing reflows when a toast
  appears) and its bottom edge is glued to `BottomChrome`'s top edge. When the
  jump-to-latest row appears the chrome grows and the stack rides up with it;
  when it goes, back down. **Never reintroduce a measured height for this** — Yoga
  resolves it, and Ink parses a string offset as a percentage
  (`setPositionPercent`), which is what makes `bottom="100%"` work at all.
- **It paints over the tail of the last log rows.** With no `backgroundColor` only
  the glyphs are written, so the rest of each row shows through, and `right: 0`
  with an auto width keeps the overlay where log lines have usually run out. The
  accepted cost: a toast briefly hides the right-hand end of a line, and a drag
  underneath still selects the text it covers (selection is content-anchored, so
  the coordinates are right even where the pixels lie). Toasts are transient and
  capped, which is what keeps that cost small. (The jump-to-latest row, by
  contrast, is an ordinary in-flow row, centered and full width.)
- **The cap is a hard bound**, because each toast covers a log row's right-hand end
  while it's up. Over `MAX_TOASTS` (3) the oldest **transient** toast gives way
  first — a burst of routine notices must not silently retire a sticky one waiting
  on the user.
- **`useDragSelection` takes `notify`/`dismiss`, never the whole `Toasts` object.**
  That object is rebuilt every render; closing over it would change `clear`'s
  identity, and `clear` is a dependency of `NativeRunner`'s
  `[columns, rows, activeFilter, clearSelection]` effect — which would then fire on
  every render and drop the selection the instant it was made. Both callbacks are
  `useCallback`-stable for exactly this reason; keep them that way.
- **Timers close over the id alone**, never over the toast list, so they can't go
  stale; a toast the cap evicted keeps its timer until it fires (a harmless no-op
  dismissal), and unmount clears whatever is left.

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
- **A copy hotkey (`c`) instead of copy-on-release:** the earlier shape. Made
  copying a separate, deliberate key press to avoid clobbering the clipboard on a
  stray drag. Replaced by copy-on-release because the reflexive gesture — drag, then
  Cmd+C — can't work in the VS Code integrated terminal (Cmd+C never reaches the
  process; see "Text selection"), and per-user `keybindings.json` isn't shippable for
  a published package. Copying on release matches what Claude Code's own TUI does and
  needs no key; the accepted cost is that any drag overwrites the clipboard.

## File / symbol map

| Concern                                              | Where                         |
| ---------------------------------------------------- | ----------------------------- |
| Alternate screen, phase machine, `renderApp`         | `components/App.tsx`          |
| Fullscreen layout, input, scroll/mouse wiring        | `components/NativeRunner.tsx` |
| Viewport hook, drag-select hook, presentational pane | `components/LogPane.tsx`      |
| Virtualization math (`computeWindow`/`windowRows`)   | `log-window.ts`               |
| Scroll position + transitions                        | `scroll.ts`                   |
| SGR mouse escapes + `parseMouseEvents` decoder       | `mouse.ts`                    |
| Selection geometry/text math (highlight, copy text)  | `selection.ts`                |
| Toast policy (shape, cap, eviction)                  | `toasts.ts`                   |
| Toast hook, timers, click targets, overlay renderer  | `components/ToastStack.tsx`   |
| Bottom-aligned stack: jump row, footer, toast anchor | `components/BottomChrome.tsx` |
| Best-effort clipboard (OSC 52 + native command)      | `clipboard.ts`                |
| Tab/window title + stripping child title escapes     | `terminal-title.ts`           |
| Buffer, subscription, queries, plain-mode streaming  | `process-manager.ts`          |

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
  Enabling is **not** once-on-mount: keep the re-assert on resize and the legacy-
  report backstop, or a terminal reattach (VS Code "Reload Window") leaves the
  mouse dead until restart.
- The toast stack floats **out of flow** (`position: absolute`, `bottom: 100%`
  inside `BottomChrome`). Keep it that way: put it back in the column and every
  toast steals a log row and reflows the pane. Its anchoring is pure layout —
  never compute it from a measured height.
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
