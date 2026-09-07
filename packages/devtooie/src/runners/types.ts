import type { AnyPackageConfig, ResolvedHealthcheck, UrlLine } from '../config.js';
import type { EnvOverride } from '../env.js';

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
  /** Variables whose `.env` value may beat the ambient environment. */
  envOverride?: EnvOverride;
  /** Prefix each on-screen log line with a timestamp (default `true`). */
  logTimestamps?: boolean;
  /** Workspace root that package `relativeDir`s resolve against (defaults to `process.cwd()`). */
  cwd?: string;
}
