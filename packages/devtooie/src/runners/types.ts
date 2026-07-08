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
}
