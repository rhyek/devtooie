import type { AnyPackageConfig } from '../config.js';

export interface RunnerArgs {
  sortedPackages: AnyPackageConfig[];
  selectedSet: Set<string>;
  buildDepSet: Set<string>;
  rebuildableSet: Set<string>;
  waitForMap: Record<string, string[]>;
  healthcheckUrls: Record<string, string>;
  extraCommandsMap: Record<string, string[]>;
  logFile?: string;
  /** `.env` filenames resolved per package (defaults to the standard set when omitted). */
  envFiles?: string[];
  /** Workspace root that package `relativeDir`s resolve against (defaults to `process.cwd()`). */
  cwd?: string;
}
