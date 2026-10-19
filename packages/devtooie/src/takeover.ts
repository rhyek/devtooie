import { startedByAgent } from './agent-detection.js';
import { connectControlClient, createControlClient, type SessionStatus } from './control-client.js';
import { currentMode } from './env.js';

/**
 * Deciding whether a starting session may quit the one already running for this project in the
 * same mode. A project runs one session per mode: a session in another mode runs alongside this
 * one, so it is never quit, and never asked about.
 *
 * This runs as a **preflight**, before `acquireDevSession` — it has to. Acquisition doesn't
 * only hand off the control port: right after, it frees the configured dev ports by
 * SIGKILLing whatever in this workspace holds them, which is the running session's package
 * processes. So there is no "start anyway, but leave the other one alone" — by the time
 * acquisition is underway, the other session is already dying. Declining has to mean
 * exiting before any of it begins.
 */

/** What a starting session should do about the session already running. */
export type TakeoverDecision =
  /** Quit the running session and take over — today's unconditional behavior. */
  | 'kill'
  /** Ask the person at the keyboard first. */
  | 'prompt'
  /** Refuse: nobody can be asked, and taking over wasn't authorized. */
  | 'error';

export interface TakeoverInput {
  /** `--kill-others` was passed. */
  killOthers: boolean;
  /** The **running** session reported `startedByAgent` on `/query/status`. */
  runningStartedByAgent: boolean;
  /** *This* process was started by a coding agent. */
  selfStartedByAgent: boolean;
  /** A person can actually answer a prompt (both ends of the terminal are a TTY). */
  isInteractive: boolean;
}

/**
 * The whole policy, as a pure function.
 *
 * The agent-to-agent rule is a boolean AND, not an identity check: an agent may replace a
 * session another agent started. Environment variables can say *that* an agent is driving,
 * never *which* agent or which of its sessions — so two agents working the same repo will
 * replace each other's sessions. That is the intended trade: an agent should never have to
 * stop and ask about a session no human is watching.
 */
export function resolveTakeover(input: TakeoverInput): TakeoverDecision {
  if (input.killOthers) {
    return 'kill';
  }
  if (input.runningStartedByAgent && input.selfStartedByAgent) {
    return 'kill';
  }
  return input.isInteractive ? 'prompt' : 'error';
}

/** `{ ok: false }` carries the text to print before exiting non-zero. */
export type PreflightOutcome = { ok: true } | { ok: false; message: string };

export interface PreflightOptions {
  /** Absolute path to this session's config — identifies "the same project". */
  configPath: string;
  /** This session's mode (the active one unless given) — only a session in it is quit. */
  mode?: string;
  /** `--kill-others`. */
  killOthers: boolean;
  /** An explicit `apiPort` from the config, which pins where a running instance would be. */
  apiPortOverride?: number;
  cwd?: string;
  /** Test seams. */
  deps?: Partial<PreflightDeps>;
}

export interface PreflightDeps {
  /** Reads the running instance's `/query/status`, or null when no instance answers. */
  queryRunning(cwd: string, apiPortOverride: number | undefined): Promise<SessionStatus | null>;
  /** Asks the person at the keyboard; `false` covers "no" and "cancelled". */
  askToQuit(status: SessionStatus): Promise<boolean>;
  isInteractive(): boolean;
  selfStartedByAgent(): boolean;
}

const defaultDeps: PreflightDeps = {
  async queryRunning(cwd, apiPortOverride) {
    const client =
      apiPortOverride === undefined
        ? await connectControlClient(cwd)
        : createControlClient(apiPortOverride);
    return client ? client.query.status() : null;
  },
  async askToQuit(status) {
    // Loaded here, not up top: most sessions start with no other one to ask about.
    const { confirm, isCancel } = await import('@clack/prompts');
    const answer = await confirm({
      message: `Another ${status.mode} devtooie session is running for this project (pid ${status.pid}). Quit it and start this one?`,
      initialValue: true,
    });
    return !isCancel(answer) && answer === true;
  },
  isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  selfStartedByAgent: startedByAgent,
};

/**
 * Clears the way for a new session, or explains why it can't. `{ ok: true }` means start
 * normally — either nothing is running, or quitting it is authorized and the acquisition
 * path's existing handoff will do it.
 */
export async function preflightTakeover(opts: PreflightOptions): Promise<PreflightOutcome> {
  const deps = { ...defaultDeps, ...opts.deps };
  const cwd = opts.cwd ?? process.cwd();
  const mode = opts.mode ?? currentMode();

  const running = await deps.queryRunning(cwd, opts.apiPortOverride);
  // Nothing running, something running for a *different* config, or this project's session in
  // another mode — all of which the handoff protocol leaves alone anyway (it relocates rather
  // than quitting them). A pinned `apiPort` held by another mode's session fails there instead.
  if (!running || running.configPath !== opts.configPath || running.mode !== mode) {
    return { ok: true };
  }

  const decision = resolveTakeover({
    killOthers: opts.killOthers,
    runningStartedByAgent: running.startedByAgent,
    selfStartedByAgent: deps.selfStartedByAgent(),
    isInteractive: deps.isInteractive(),
  });

  if (decision === 'kill') {
    return { ok: true };
  }
  if (decision === 'prompt') {
    return (await deps.askToQuit(running))
      ? { ok: true }
      : { ok: false, message: 'Left the running devtooie session alone.' };
  }
  return { ok: false, message: blockedMessage(running) };
}

/**
 * The no-TTY refusal. Its reader is almost always a coding agent — an agent's shell is
 * exactly what has no TTY — so it is written to tell an agent what to do next, and to make
 * plain that `--kill-others` is the user's call, not the agent's.
 */
function blockedMessage(running: SessionStatus): string {
  const whose = running.startedByAgent
    ? 'it was started by a coding agent'
    : 'it was not started by a coding agent, so someone is likely watching it in another terminal';
  return [
    `Another ${running.mode} devtooie session is already running for this project (pid ${running.pid}), and ${whose}.`,
    '',
    'devtooie will not quit it automatically, and there is no terminal here to ask.',
    '',
    '  - Ask the user to stop that session, then run devtooie again.',
    '  - Or re-run with --kill-others to quit it and take over.',
    '',
    'Do not pass --kill-others on your own initiative: it terminates that session and every',
    'dev process under it. Ask the user first.',
  ].join('\n');
}
