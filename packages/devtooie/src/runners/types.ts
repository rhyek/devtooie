import type { AnyAppConfig } from '../config.js';

export interface RunnerArgs {
  sortedApps: AnyAppConfig[];
  selectedSet: Set<string>;
  buildDepSet: Set<string>;
  rebuildableSet: Set<string>;
  waitForMap: Record<string, string[]>;
  healthcheckUrls: Record<string, string>;
  extraCommandsMap: Record<string, string[]>;
  logFile?: string;
}
