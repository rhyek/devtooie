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

// `command` options. `watches`/`cleans` both imply building, so `builds: false` is only legal
// when the command neither watches nor cleans — rejected at parse time otherwise (e.g.
// `{ watches: true, builds: false }`, `{ builds: false }` since watches then defaults true, and
// `{ cleans: true, builds: false }`).
export const CommandOptionsSchema = z
  .strictObject({
    watches: z.boolean().optional(),
    builds: z.boolean().optional(),
    cleans: z.boolean().optional(),
  })
  .refine((o) => (o.builds ?? true) || (!(o.watches ?? true) && !(o.cleans ?? false)), {
    message: 'a command that watches or cleans must also build (builds cannot be false)',
  });

export const CommandSchema = z
  // `null` = the package has no dev process; devtooie never starts it (build/dep-only).
  .union([z.string(), z.tuple([z.string(), CommandOptionsSchema]), z.null()])
  .default('dev')
  .transform((c) =>
    c === null
      ? null
      : typeof c === 'string'
        ? { name: c, watches: true, builds: true, cleans: false }
        : {
            name: c[0],
            watches: c[1].watches ?? true,
            builds: c[1].builds ?? true,
            cleans: c[1].cleans ?? false,
          },
  );

// All per-package config is flat (no `run` nesting). `name`/`relativeDir` identify the package;
// the rest describe how to run/select/link it (omit them all for a build-only lib).
export const PackageConfigSchema = z.object({
  // Overridden in config.ts (pinned to `N`); documented there.
  name: z.string(),
  relativeDir: z
    .string()
    .optional()
    .describe(
      'Directory holding the package, relative to `workspaceDir`. Defaults to `packages/<name>`.',
    ),
  selectable: z.boolean().optional().describe('Show in the interactive picker (default `true`).'),
  shortName: z.string().optional().describe('Shorter label used in the TUI in place of `name`.'),
  color: z
    .string()
    .optional()
    .describe(
      "Color for this package's log-prefix label, overriding the auto-assigned palette color. Any Ink/chalk color: a name (`'magenta'`, `'blueBright'`), hex (`'#af87ff'`), `'rgb(175,135,255)'`, or `'ansi256(140)'`.",
    ),
  subdomain: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Reverse-proxy subdomain(s); the first feeds `$subdomain` substitution.'),
  port: z
    .number()
    .optional()
    .describe('Dev port; injected into the process as `PORT` and feeds `$port` substitution.'),
  // Overridden in config.ts (transform → `any`); documented there.
  command: CommandSchema,
  autostart: z
    .boolean()
    .optional()
    .describe(
      'Automatically start this package during the run phase (default `true`). When `false`, devtooie leaves it stopped — start it yourself with the `s` hotkey (or a control-API `restart`). Ignored when `command` is `null` (that package never starts).',
    ),
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
  tsconfig: z
    .string()
    .optional()
    .describe(
      'tsconfig file (relative to the package dir) devtooie reads for project references to infer build-time deps. Defaults to `tsconfig.build.json`, then `tsconfig.json`.',
    ),
  deps: z
    .object({
      build: z.array(z.string()).optional(),
      dev: z.array(z.string()).optional(),
      runtime: z.array(z.string()).optional(),
    })
    .optional(),
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
