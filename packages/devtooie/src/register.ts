import type { AnyAppConfig } from './config.js';

// Augmentation target — intentionally empty. Consumers/typegen augment it.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Register {}

type Resolved = Register extends { appConfigs: infer T extends readonly AnyAppConfig[] }
  ? T
  : readonly AnyAppConfig[];

export type AppConfig = Resolved[number];
export type AppName = AppConfig['name'];
