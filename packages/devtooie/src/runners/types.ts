import type { AnyPackageConfig, UrlLine } from '../config.js';

export interface RunnerArgs {
  sortedPackages: AnyPackageConfig[];
  selectedSet: Set<string>;
  buildDepSet: Set<string>;
  rebuildableSet: Set<string>;
  waitForMap: Record<string, string[]>;
  healthcheckUrls: Record<string, string>;
  extraCommandsMap: Record<string, string[]>;
  /**
   * Workspace-wide links (not tied to a package), rendered above the per-package links.
   * Each entry is one footer line; a line with multiple links renders them space-separated.
   */
  topLevelUrls?: UrlLine[];
  logFile?: string;
  /** `.env` filenames resolved per package (defaults to the standard set when omitted). */
  envFiles?: string[];
  /** Prefix each on-screen log line with a `YYYY-MM-DD HH:MM:SS` timestamp (default `false`). */
  logTimestamps?: boolean;
  /** Workspace root that package `relativeDir`s resolve against (defaults to `process.cwd()`). */
  cwd?: string;
}
