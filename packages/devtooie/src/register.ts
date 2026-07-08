import type { AnyPackageConfig } from './config.js';

// Augmentation target — intentionally empty. Consumers augment it from devtooie.config.ts.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Register {}

type Resolved = Register extends { packageConfigs: infer T extends readonly AnyPackageConfig[] }
  ? T
  : readonly AnyPackageConfig[];

export type PackageConfig = Resolved[number];
export type PackageName = PackageConfig['name'];
