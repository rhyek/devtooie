export { defineConfig, ServiceType, findService, proxyHostsFor } from './config.js';
// devtooie's log utilities: `logging.formatter(config)` builds a structured-log formatter for a
// service's `logs.formatter` (and is the default applied to every service); the ecosystem helpers
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
  ServiceConfigInput,
  DefineConfigOptions,
  ResolvedServiceConfig,
  AnyServiceConfig,
  Config,
  DevReverseProxyInput,
  ProxyInput,
  ResolvedProxy,
  ResolvedDevReverseProxy,
  ServiceTypeValue,
  ConfigContext,
  ServiceContext,
  TokenRecord,
  ServiceTokens,
  PortResolver,
  UrlResolver,
  UrlValue,
  UrlLinkInput,
  UrlEntryInput,
  UrlLink,
  UrlEntry,
  Command,
} from './config.js';
export type { Register, ServiceConfig, ServiceName } from './register.js';
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
// A test suite's stack: a detached headless session, started or reused, waited on until healthy.
export { startStack, stackEnvironment } from './stack.js';
export type { StartStackOptions, Stack } from './stack.js';
// What an infra callback's `control` is: a client for the running session's control API.
export type { ControlClient, SessionStatus, SessionServiceStatus } from './control-client.js';
export type { ServiceAction } from './command-server.js';
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
