import type { AnyServiceConfig } from './config.js';

// Augmentation target — intentionally empty. Consumers augment it from devtooie.config.ts.
// oxlint-disable-next-line typescript/no-empty-object-type
export interface Register {}

type Resolved = Register extends {
  serviceConfigs: infer T extends Record<string, AnyServiceConfig>;
}
  ? T
  : Record<string, AnyServiceConfig>;

/**
 * The resolved config of one service. Index it by name — `ServiceConfig<'api'>` — to get that
 * service's own type, including its `tokens`; bare `ServiceConfig` is the union of them all.
 */
export type ServiceConfig<N extends ServiceName = ServiceName> = N extends keyof Resolved
  ? Resolved[N]
  : never;

/** Your service names, once `Register` is augmented; `string` otherwise. */
export type ServiceName = Extract<keyof Resolved, string>;
