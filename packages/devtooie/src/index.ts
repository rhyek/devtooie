export { defineConfig, PackageType, findPackage, proxyHostsFor } from './config.js';
// devtooie's log utilities: `logging.formatter(config)` builds a structured-log formatter for a
// package's `logs.formatter` (and is the default applied to every package); the ecosystem helpers
// `logging.nodejs.{pino,winston}.formatter` are the same with adjusted defaults.
export { logging } from './log-formatter.js';
export type {
  FormatterConfig,
  FormatterConfigInput,
  FormatterFields,
  CustomField,
  CustomFields,
} from './log-formatter.js';
// Re-exported so a hand-written `logs.formatter` can validate structured log lines with zod
// without adding a direct dependency (devtooie already bundles it).
export { z } from 'zod';
export type {
  PackageConfigInput,
  DefineConfigOptions,
  ResolvedPackageConfig,
  AnyPackageConfig,
  Config,
  DevReverseProxyInput,
  ProxyInput,
  ResolvedProxy,
  ResolvedDevReverseProxy,
  PackageTypeValue,
  ConfigContext,
  PackageContext,
  TokenRecord,
  PackageTokens,
  PortResolver,
  UrlResolver,
  UrlValue,
  UrlLinkInput,
  UrlEntryInput,
  UrlLink,
  UrlEntry,
  Command,
} from './config.js';
export type { Register, PackageConfig, PackageName } from './register.js';
export type {
  InfraInput,
  DockerComposeInfraInput,
  InfraServiceInput,
  InfraServiceCallbacks,
  InfraEnabledContext,
  InfraCallback,
  InfraCallbackContext,
  InfraReadyContext,
  InfraRunOptions,
  InfraRunResult,
  ResolvedInfra,
  ResolvedDockerComposeInfra,
  ResolvedInfraService,
} from './infra/types.js';
// What an infra callback's `control` is: a client for the running session's control API.
export type { ControlClient, SessionStatus, SessionPackageStatus } from './control-client.js';
export type { InfraAction, InfraStatus } from './infra/control.js';
export {
  resolveEnv,
  envCandidatePaths,
  ambientEnv,
  envFileNames,
  currentMode,
  DEFAULT_MODE,
  type Mode,
  type EnvOverride,
  type Envs,
  type DevtooieEnv,
} from './env.js';
export type { EnvResolution } from './env.js';
