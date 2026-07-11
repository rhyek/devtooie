// AUTO-GENERATED from config-schema.ts by scripts/gen-config-types.ts — DO NOT EDIT.
// Regenerate with `pnpm --filter devtooie gen` (also runs as part of `pnpm build`).
// Field docs come from the schemas' `.describe()`; `command`/`waitFor`/`deps`/`name`/
// `packages` are overridden in config.ts, so their generated form here is intentionally ignored.
/* eslint-disable */

export type GeneratedPackageConfig = {
    name: string;
    /** Directory holding the package, relative to `workspaceDir`. Defaults to `packages/<name>`. */
    relativeDir?: string | undefined;
    /** Show in the interactive picker (default `true`). */
    selectable?: boolean | undefined;
    /** Shorter label used in the TUI in place of `name`. */
    shortName?: string | undefined;
    /** Color for this package's log-prefix label, overriding the auto-assigned palette color. Any Ink/chalk color: a name (`'magenta'`, `'blueBright'`), hex (`'#af87ff'`), `'rgb(175,135,255)'`, or `'ansi256(140)'`. */
    color?: string | undefined;
    /** Reverse-proxy subdomain(s); the first feeds `$subdomain` substitution. */
    subdomain?: (string | string[]) | undefined;
    /** Dev port; injected into the process as `PORT` and feeds `$port` substitution. */
    port?: number | undefined;
    /** A browser package's HMR socket port. */
    hmrPort?: number | undefined;
    command: any;
    /** Footer links; each entry is one line (a string, `{ label, url }`, or an array on one line). */
    urls?: ((string | {
        label: string;
        url: string;
    }) | (string | {
        label: string;
        url: string;
    })[])[] | undefined;
    /** URL polled for readiness; also required by anything that lists this package in its `waitFor`. */
    healthcheck?: string | undefined;
    waitFor?: string[] | undefined;
    /** tsconfig file (relative to the package dir) devtooie reads for project references to infer build-time deps. Defaults to `tsconfig.build.json`, then `tsconfig.json`. */
    tsconfig?: string | undefined;
    deps?: {
        build?: string[] | undefined;
        dev?: string[] | undefined;
        runtime?: string[] | undefined;
    } | undefined;
};

export type GeneratedDefineConfig = {
    /** Fixed control-API port; omit to let devtooie pick one (recorded in `running.json`). */
    apiPort?: number | undefined;
    packages: {
        name: string;
        /** Directory holding the package, relative to `workspaceDir`. Defaults to `packages/<name>`. */
        relativeDir?: string | undefined;
        /** Show in the interactive picker (default `true`). */
        selectable?: boolean | undefined;
        /** Shorter label used in the TUI in place of `name`. */
        shortName?: string | undefined;
        /** Color for this package's log-prefix label, overriding the auto-assigned palette color. Any Ink/chalk color: a name (`'magenta'`, `'blueBright'`), hex (`'#af87ff'`), `'rgb(175,135,255)'`, or `'ansi256(140)'`. */
        color?: string | undefined;
        /** Reverse-proxy subdomain(s); the first feeds `$subdomain` substitution. */
        subdomain?: (string | string[]) | undefined;
        /** Dev port; injected into the process as `PORT` and feeds `$port` substitution. */
        port?: number | undefined;
        /** A browser package's HMR socket port. */
        hmrPort?: number | undefined;
        command: any;
        /** Footer links; each entry is one line (a string, `{ label, url }`, or an array on one line). */
        urls?: ((string | {
            label: string;
            url: string;
        }) | (string | {
            label: string;
            url: string;
        })[])[] | undefined;
        /** URL polled for readiness; also required by anything that lists this package in its `waitFor`. */
        healthcheck?: string | undefined;
        waitFor?: string[] | undefined;
        /** tsconfig file (relative to the package dir) devtooie reads for project references to infer build-time deps. Defaults to `tsconfig.build.json`, then `tsconfig.json`. */
        tsconfig?: string | undefined;
        deps?: {
            build?: string[] | undefined;
            dev?: string[] | undefined;
            runtime?: string[] | undefined;
        } | undefined;
    }[];
    /** Workspace-wide footer links, not tied to a package (extrinsic `$token`s only). */
    urls?: ((string | {
        label: string;
        url: string;
    }) | (string | {
        label: string;
        url: string;
    })[])[] | undefined;
    /** Root each package's `relativeDir` resolves against. Defaults to `process.cwd()`. */
    workspaceDir?: string | undefined;
    /** Values for extrinsic `$token` substitution in `urls`/`healthcheck`. */
    tokens?: {
        [key: string]: string | undefined;
    } | undefined;
    /** `.env` filenames loaded per package (defaults to the standard set). */
    env?: {
        files?: string[] | undefined;
    } | undefined;
};
