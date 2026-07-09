import { z } from 'zod';

// The Zod schemas — the single source of the config's shape, defaults, validation, AND field
// docs (via `.describe()`). `scripts/gen-config-types.ts` reads this file (it imports only
// `zod`, so it runs without a build) and emits `config.generated.ts` with the descriptions as
// JSDoc. `config.ts` then composes the public types from the generated ones, overriding the
// fields Zod can't represent well (`command`, and the name-referencing `name`/`waitFor`/`deps`).
//
// So: `.describe()` on a *kept* field flows to consumer hover automatically; *overridden*
// fields are documented in `config.ts` and need no `.describe()` here.

export const UrlLinkSchema = z.union([
  z.string(),
  z.object({ label: z.string(), url: z.string() }),
]);
export const UrlEntrySchema = z.union([UrlLinkSchema, z.array(UrlLinkSchema)]);

// `command` options as a union of the two *legal* shapes, so `{ watches: true, builds: false }`
// (and `{ builds: false }`, since watches then defaults true) is rejected at parse time.
export const CommandOptionsSchema = z.union([
  z.strictObject({ watches: z.literal(true).optional(), builds: z.literal(true).optional() }),
  z.strictObject({ watches: z.literal(false), builds: z.boolean().optional() }),
]);

export const CommandSchema = z
  .union([z.string(), z.tuple([z.string(), CommandOptionsSchema])])
  .default('dev')
  .transform((c) =>
    typeof c === 'string'
      ? { name: c, watches: true, builds: true }
      : { name: c[0], watches: c[1].watches ?? true, builds: c[1].builds ?? true },
  );

export const RunConfigSchema = z.object({
  selectable: z.boolean().optional().describe('Show in the interactive picker (default `true`).'),
  shortName: z.string().optional().describe('Shorter label used in the TUI in place of `name`.'),
  subdomain: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Reverse-proxy subdomain(s); the first feeds `$subdomain` substitution.'),
  port: z
    .number()
    .optional()
    .describe('Dev port; injected into the process as `PORT` and feeds `$port` substitution.'),
  hmrPort: z.number().optional().describe("A browser package's HMR socket port."),
  // Overridden in config.ts (transform → `any`); documented there.
  command: CommandSchema,
  urls: z
    .array(UrlEntrySchema)
    .optional()
    .describe(
      'Footer links; each entry is one line (a string, `{ label, url }`, or an array on one line).',
    ),
  healthcheck: z
    .string()
    .optional()
    .describe(
      'URL polled for readiness; also required by anything that lists this package in its `waitFor`.',
    ),
  // Overridden in config.ts (pinned to package names); documented there.
  waitFor: z.array(z.string()).optional(),
  deps: z
    .object({
      build: z.array(z.string()).optional(),
      dev: z.array(z.string()).optional(),
      runtime: z.array(z.string()).optional(),
    })
    .optional(),
});

export const PackageConfigSchema = z.object({
  // Overridden in config.ts (pinned to `N`); documented there.
  name: z.string(),
  relativeDir: z
    .string()
    .optional()
    .describe(
      'Directory holding the package, relative to `workspaceDir`. Defaults to `packages/<name>`.',
    ),
  types: z
    .array(z.enum(['backend', 'browser', 'lib']))
    .describe("One or more of `'backend' | 'browser' | 'lib'`; drives grouping in the picker."),
  // Overridden in config.ts (→ RunConfig<N>); documented there.
  run: RunConfigSchema.optional(),
});

export const DefineConfigSchema = z.object({
  apiPort: z
    .number()
    .optional()
    .describe(
      'Fixed control-API port; omit to let devtooie pick one (recorded in `running.json`).',
    ),
  // Overridden in config.ts (→ PackageConfigInput<N>[]); documented there.
  packages: z.array(PackageConfigSchema),
  urls: z
    .array(UrlEntrySchema)
    .optional()
    .describe('Workspace-wide footer links, not tied to a package (extrinsic `$token`s only).'),
  workspaceDir: z
    .string()
    .optional()
    .describe("Root each package's `relativeDir` resolves against. Defaults to `process.cwd()`."),
  tokens: z
    .record(z.string(), z.string().optional())
    .optional()
    .describe('Values for extrinsic `$token` substitution in `urls`/`healthcheck`.'),
  env: z
    .object({ files: z.array(z.string()).optional() })
    .optional()
    .describe('`.env` filenames loaded per package (defaults to the standard set).'),
});
