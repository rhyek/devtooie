# Exiting devtooie

How an interactive (fullscreen) devtooie session shuts down. This is a
**contributor** document. Two hard requirements drive the design:

1. **No lingering processes.** Every child dev process (and the control server,
   watchers, etc.) must be torn down before the process exits — whether the exit
   was triggered by the keyboard or the control API.
2. **Leave a trace.** The session runs in the terminal's alternate screen, which
   is restored to its pre-launch state on exit — so without help, devtooie would
   vanish without evidence it ran. The session is bookended with a line on the
   primary screen before it takes over and one after it tears down.

Related: the rendering model (alternate screen, why the shutdown frame collapses,
the root `overflow: hidden`) is in [`./rendering.md`](./rendering.md).

## Exit triggers

Every graceful exit funnels through a single `shutdown()` in `NativeRunner`:

| Trigger                        | Path                                                            |
| ------------------------------ | -------------------------------------------------------------- |
| **Ctrl+C, twice**              | `useInput`: the first press only shows a *Press Ctrl+C again to exit* toast and arms `pendingExitRef`; a second within `EXIT_CONFIRM_MS` (2s, the toast's lifetime) → `shutdown()` |
| **Control API `/command/quit`**| `server.setOnQuit(() => void shutdown())` → `shutdown()` (response held until step 7 acks it) |
| **Git branch changed**         | `watchGitBranch({ onChange })` → `shutdown()` (stale build)   |
| **`SIGHUP` / `SIGINT` / `SIGTERM`** | `installShutdownSignals` → `shutdown()` (no confirmation)  |
| **Ctrl+C during a shutdown** (impatient) | `shutdown()` re-entry guard → `forceKillAll()` + `process.exit(1)` |

Only the keystroke asks twice: a signal, a quit request or a branch change shuts down at once.
The confirmation is the run phase's alone — the service picker exits on the first press, and the
build phase has no input handler, so raw mode is off and Ctrl+C reaches the whole foreground
process group (devtooie and the builds it runs) as a `SIGINT`.

Because the control-API quit and Ctrl+C share the exact same `shutdown()`, the
cleanup is identical no matter how the exit was requested.

## The graceful shutdown sequence

`shutdown()` (`components/NativeRunner.tsx`), in order:

1. **Re-entry guard.** If a shutdown is already in progress, this is an impatient
   Ctrl+C (or a second signal or quit) — write `MOUSE_DISABLE` (this path exits
   before the unmount cleanup runs), `manager.forceKillAll()`, and
   `process.exit(1)` immediately (no waiting). `forceKillAll()` reaches the
   processes step 4 is still waiting on, too: `shutdownAll()` takes them out of
   the manager's state but keeps them in its `exiting` set until they're gone.
2. **Hand the mouse back.** Write `MOUSE_DISABLE` so SGR mouse reporting (enabled
   for drag-to-select) is off before the UI collapses; the unmount effect's
   cleanup also writes it, but only once Ink tears the tree down.
3. **Mark the UI shutting down** (`setShuttingDown(true)` + `markAllStopped()`).
   The run-phase render collapses to a single non-fullscreen `Shutting down…`
   line (see rendering doc — a fullscreen final frame would make Ink clear the
   terminal on unmount and risk a blank block on the restored screen).
4. **Kill every child**, bounded: `await Promise.race([manager.shutdownAll(),
   timeout(SHUTDOWN_TIMEOUT_MS)])`. `shutdownAll()` SIGTERMs every process group,
   waits up to `SHUTDOWN_GRACE_MS` (10s) for each to exit, then SIGKILLs any
   straggler; the outer `SHUTDOWN_TIMEOUT_MS` (15s) is a safety net kept above
   that grace so a stuck child can't hang the exit but the graceful wait still
   runs in full. (These constants live in `shutdown-timing.ts`.) A stop already
   under way — a restart caught mid-way — is waited out with the rest. From its first
   line `shutdownAll()` marks the manager closing, so nothing spawns afterwards —
   not a restart that was awaiting its stop, nor a control-API start, nor an infra
   action's next step.
5. **Finish off anything left** (`manager.forceKillAll()`), in case the graceful
   pass timed out or failed — while the `process.on('exit')` hook, the backstop
   for a crash, is still installed (step 8 removes it).
6. **Arm the safety net:** `setTimeout(() => process.exit(0), EXIT_SAFETY_NET_MS)`
   (5s). Every child is dead by now; this only keeps a stalled proxy close, server
   close or Ink teardown from leaving a lingering **parent** process. In the
   normal path `renderApp` (below) exits within milliseconds and it never fires.
7. **Close the dev reverse proxy**, then **ack a blocking quit**
   (`server.ackQuit()`). A `POST /command/quit` holds its HTTP response open; this
   releases it with `200` now that services are down and their ports are freed —
   so a handing-off newer session knows the ports are clear *before* we close the
   server. A no-op for a Ctrl+C quit (no HTTP request was held). Must run
   **after** step 4 and **before** the server closes.
8. **Close the control server** (`server.close()`), then **dispose the manager**
   (`manager.dispose()` — env-file watchers, the `process.on('exit')` handler,
   buffers).
9. **Hand off to Ink** (`exit()`, from `useApp()`): unmount the tree, which
   restores the primary screen and resolves `waitUntilExit`.

Steps 4, 7 and 8 run through a `settle()` that swallows a rejection, so one
failing step can't keep the session from reaching `exit()`. Everything that could leave
something running (steps 4–8) happens **before** `exit()`. Nothing about the
process-exit mechanism can affect it.

## Process exit + screen restore

The actual `process.exit` and the bookend lines live in `renderApp`
(`components/App.tsx`), which wraps the whole session:

```tsx
const startedAt = Date.now();
const logFileRef = { current: options.logFile };        // run phase keeps this current
process.stdout.write(`▶ devtooie started\n`);           // primary screen, before alt
const instance = render(<App logFileRef={logFileRef}/>, { alternateScreen: true, … });
void instance.waitUntilExit().finally(() => {
  const duration = formatDuration(Date.now() - startedAt);
  let message = `■ devtooie exited after ${duration}\n`;
  if (logFileRef.current) message += `  logfile: ${displayLogFile(logFileRef.current)}\n`;
  process.stdout.write(message, () => process.exit(0));
});
```

- The **`▶ devtooie started`** line is written to the primary screen *before* Ink
  enters the alternate screen, so it's saved with the primary buffer and reappears
  when the screen is restored on exit.
- **`waitUntilExit()`** resolves only after Ink's teardown barrier — i.e. after
  `exitAlternativeScreen` has flushed and the primary screen is restored — so the
  **`■ devtooie exited after …`** line lands on the clean, restored screen.
- Exiting from the write **callback** ensures that line is flushed before the
  process dies (rather than racing `process.exit`).
- The **`logfile:`** line beneath it prints the last logfile written to, through
  the shared `displayLogFile` helper (`lib.ts`) — relative to devtooie's cwd, the
  same string the footer showed during the run, so the path doesn't change shape
  on the way out. `renderApp` seeds `logFileRef.current` with the session's initial
  logfile and `NativeRunner` updates it whenever the log is rotated (`t`), so the
  path reflects the *current* file rather than the one the session opened with.

Result on the primary screen after a session:

```
> pnpm dev
▶ devtooie started
■ devtooie exited after 2 hours 14 minutes
  logfile: node_modules/.devtooie/logs/1783966456337.log
>
```

## Plain / non-TTY mode

`--headless` (and any non-TTY context) does not use the alternate screen or the
bookend lines, and there's no screen to restore. During a run it funnels quit
through its own graceful `shutdown()` (`runners/plain.ts`) — the same
shutdownAll → `server.ackQuit()` → `server.close()` order as the interactive
path, so a blocking `/command/quit` (and thus a handoff) works identically. Only
the pre-run bootstrap handler in `cli.ts` hard-exits (`process.exit(0)`), since
there's no process manager to shut down before the run phase attaches one.

## Invariants to preserve

- **Cleanup before exit, always.** In every graceful path, kill children
  (`shutdownAll`), close the server, and dispose the manager *before* `exit()`.
  Never move process-exit logic ahead of that.
- **One shutdown path.** Ctrl+C, control-API quit, and git-branch-change all call
  the same `shutdown()`. Don't fork them — a blocking `/command/quit` is served by
  having that one path call `server.ackQuit()`, not by a second handler.
- **Ack the blocking quit between children-down and server-close.** `server.ackQuit()`
  must run *after* `shutdownAll` (so the ack means "ports freed") and *before*
  `server.close()` (so the held response socket is still writable). A handoff relies
  on that ordering.
- **The process must always exit.** The `renderApp` handler is the normal exit;
  the `NativeRunner` `setTimeout` is the guaranteed fallback, armed before the
  first await that isn't bounded. Keep both.
- **Ctrl+C asks once, then exits.** The confirmation window and the toast share
  `EXIT_CONFIRM_MS`, so the window closes when the prompt goes away. Signals, a
  quit request and a branch change never ask.
- **Ctrl+C during a shutdown is a hard kill** — `MOUSE_DISABLE` +
  `forceKillAll()` + `process.exit(1)`, no waiting — and it must reach every
  process still in its grace period, not just the ones the manager still owns.
- **Nothing spawns once closing.** Every spawn path in `ProcessManager` (and
  `InfraControl.run`) checks the closing flag, so a transition already in flight
  can't start a process after the kill sweep.
- **The exit line prints after `waitUntilExit`**, never before — otherwise it
  lands on the alternate screen and is discarded on restore.
- **Release the mouse on every exit.** SGR mouse reporting is on during the run
  phase (for drag-to-select); write `MOUSE_DISABLE` on the way out of every path —
  the unmount cleanup, `shutdown()`, and the hard-kill branch all do — or the
  terminal is left capturing the mouse after devtooie exits.

## File map

| Concern                                             | Where                        |
| --------------------------------------------------- | ---------------------------- |
| Bookend lines, `waitUntilExit`-driven `process.exit`| `components/App.tsx`         |
| `shutdown()` sequence, safety net, shutdown collapse| `components/NativeRunner.tsx` |
| Control-API quit (`onQuit` / `setOnQuit` / `ackQuit`, held response) | `command-server.ts`  |
| `shutdownAll` / `forceKillAll` / `dispose`          | `process-manager.ts`         |
| Shutdown timing constants (grace, timeout, handoff) | `shutdown-timing.ts`         |
| Handoff (blocking quit + pid-poll + force-kill)     | `dev-session.ts`             |
