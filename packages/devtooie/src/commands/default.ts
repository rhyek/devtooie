import { handleShellError } from '../errors.js';
import { resolveSelectedNames } from '../lib.js';
import { readOwnVersion, refreshSkillIfStale } from '../skill.js';
import { runBuildPhase } from './build.js';
import { loadConfigOrExit, validatePackageNames } from './workspace.js';

// The default action — `devtooie` with no subcommand: the build phase, or a dev session.

/** The root command's options. */
export interface RootOptions {
  service: string[];
  /** Declared for --help/validation; the value in force is read from argv by resolveMode. */
  mode?: string;
  ui?: boolean;
  headless?: boolean;
  /** `--headless` only: start the session in the background and return. */
  detach?: boolean;
  /** `--detach` only: return once infra and every service is healthy. */
  wait?: boolean;
  /** `--wait` only: seconds before giving up. */
  waitTimeout?: number;
  /** Hidden: only accepted to be refused with its spelling. */
  plain?: boolean;
  /**
   * Hidden: this is the background session a `--detach` started. It never takes over a running
   * session: it exits with `DETACHED_FOUND_SESSION_EXIT`, and the `--detach` reuses that one.
   */
  detachedSession?: boolean;
  lastAnswers: boolean;
  phase: string;
  build: boolean;
  rebuild: boolean;
  logDir?: string;
  killOthers: boolean;
}

/**
 * The package names for a non-interactive phase (see `resolveSelectedNames` in lib), exiting
 * with the hint when there are none. An explicit `--package` was validated by the caller; a
 * saved selection is already pruned of names that are no longer packages.
 */
export function resolveSelectedNamesOrExit(
  opts: { service: string[]; lastAnswers: boolean },
  usage: string,
): string[] {
  const result = resolveSelectedNames(opts, usage);
  if ('error' in result) {
    console.error(result.error);
    process.exit(1);
  }
  return result.names;
}

/** Runs the phase the options ask for; a session ends by exiting the process. */
export async function runDefaultAction(opts: RootOptions): Promise<void> {
  await loadConfigOrExit();

  // Best-effort: a skill refresh should never block a run. No-ops unless the skill was
  // actually installed (tracked in node_modules/.devtooie/skill.json).
  try {
    refreshSkillIfStale({ cwd: process.cwd(), version: readOwnVersion() });
  } catch (err) {
    console.error('devtooie: skill refresh failed (non-fatal):', err);
  }

  // Validate --package names before mounting/running anything.
  validatePackageNames(opts.service);

  const phase: 'dev' | 'build' =
    opts.rebuild || opts.build ? 'build' : (opts.phase as 'dev' | 'build');

  if (phase === 'build') {
    const names = resolveSelectedNamesOrExit(opts, 'the build phase');
    try {
      await runBuildPhase(names, opts.rebuild);
    } catch (err) {
      handleShellError(err);
    }
    return;
  }

  if (opts.detach) {
    const { runDetached } = await import('./detach.js');
    await runDetached(opts);
  }

  // Only now: a build has no use for what a session loads.
  const { runDevSession } = await import('./session.js');
  await runDevSession(opts);
}
