import type { AnyPackageConfig } from './config.js';

// Augmentation target — intentionally empty. Consumers augment it from devtooie.config.ts.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Register {}

type Resolved = Register extends {
  packageConfigs: infer T extends Record<string, AnyPackageConfig>;
}
  ? T
  : Record<string, AnyPackageConfig>;

/**
 * The resolved config of one package. Index it by name — `PackageConfig<'api'>` — to get that
 * package's own type, including its `tokens`; bare `PackageConfig` is the union of them all.
 */
export type PackageConfig<N extends PackageName = PackageName> = N extends keyof Resolved
  ? Resolved[N]
  : never;

/** Your package names, once `Register` is augmented; `string` otherwise. */
export type PackageName = Extract<keyof Resolved, string>;
