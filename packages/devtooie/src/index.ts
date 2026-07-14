export { defineConfig, PackageType, findPackage } from './config.js';
// devtooie's log utilities: `logging.formatter(config)` builds a structured-log formatter for a
// package's `logs.formatter` (and is the default applied to every package); the ecosystem helpers
// `logging.nodejs.{pino,winston}.formatter` are the same with adjusted defaults.
export { logging } from './log-formatter.js';
export type { FormatterConfig, FormatterFields, CustomField } from './log-formatter.js';
// Re-exported so a hand-written `logs.formatter` can validate structured log lines with zod
// without adding a direct dependency (devtooie already bundles it).
export { z } from 'zod';
export type {
  PackageConfigInput,
  DefineConfigOptions,
  ResolvedPackageConfig,
  AnyPackageConfig,
  Config,
  PackageTypeValue,
  UrlLink,
  UrlEntry,
  Command,
} from './config.js';
export type { Register, PackageConfig, PackageName } from './register.js';
export { resolveEnv, envCandidatePaths, DEFAULT_ENV_FILES } from './env.js';
export type { EnvResolution } from './env.js';
