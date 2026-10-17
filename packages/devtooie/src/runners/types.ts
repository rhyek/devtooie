import type { AnyPackageConfig, ResolvedHealthcheck, UrlLine } from '../config.js';
import type { EnvOverride } from '../env.js';

/** One line infra printed while a session started, kept for the session log. */
export interface InfraLogLine {
  /** The service the line belongs to; absent for the provider's own output. */
  service?: string;
  text: string;
  isError: boolean;
}

/** What a session's infra step hands the run phase. */
export interface SessionInfra {
  /**
   * The services brought up, for the footer — each with its public origin when the dev reverse
   * proxy routes it.
   */
  services: { provider: string; name: string; publicOrigin?: string }[];
  /** Everything infra printed on the way up, written at the top of the session log. */
  log: InfraLogLine[];
}

export interface RunnerArgs {
  sortedPackages: AnyPackageConfig[];
  selectedSet: Set<string>;
  buildDepSet: Set<string>;
  rebuildableSet: Set<string>;
  waitForMap: Record<string, string[]>;
  /** Readiness probe per package that configured one, keyed by package name. */
  healthchecks: Record<string, ResolvedHealthcheck>;
  extraCommandsMap: Record<string, string[]>;
  /**
   * Workspace-wide links (not tied to a package), rendered above the per-package links.
   * Each entry is one footer line; a line with multiple links renders them space-separated.
   */
  topLevelUrls?: UrlLine[];
  logFile?: string;
  /** `.env` filenames resolved per package (defaults to the active mode's set when omitted). */
  envFiles?: string[];
  /** Variables whose `.env` or `env.vars` value may beat the ambient environment. */
  envOverride?: EnvOverride;
  /** The config's own variables (`env.vars`, resolved), ranked as a file below the `.env` files. */
  envVars?: Record<string, string>;
  /** Prefix each on-screen log line with a timestamp (default `true`). */
  logTimestamps?: boolean;
  /** Workspace root that package `relativeDir`s resolve against (defaults to `process.cwd()`). */
  cwd?: string;
  /** The session's infra, once it is up; absent when the config declares none. */
  infra?: SessionInfra;
}
