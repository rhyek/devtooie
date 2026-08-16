// AUTO-GENERATED from config-schema.ts by scripts/gen-config-types.ts — DO NOT EDIT.
// Regenerate with `pnpm --filter devtooie gen` (also runs as part of `pnpm build`).
// Field docs come from the schemas' `.describe()`; `command`/`waitFor`/`deps`/`name`/
// `packages` and the package-level `logs` are overridden in config.ts, so their generated form
// here is intentionally ignored.
/* eslint-disable */

export type GeneratedPackageConfig = {
    /** Directory holding the package, relative to `workspaceDir`. Defaults to `packages/<name>`, where `<name>` is the key this package is declared under. */
    relativeDir?: string | undefined;
    /** Show in the interactive picker (default `true`). */
    selectable?: boolean | undefined;
    /** Shorter label used in the TUI in place of `name`. */
    shortName?: string | undefined;
    /** Color for this package's log-prefix label, overriding the auto-assigned palette color. Any Ink/chalk color: a name (`'magenta'`, `'blueBright'`), hex (`'#af87ff'`), `'rgb(175,135,255)'`, or `'ansi256(140)'`. */
    color?: string | undefined;
    tokens?: {
        [key: string]: string | undefined;
    } | undefined;
    port?: (number | any) | undefined;
    command: any;
    /** Automatically start this package during the run phase (default `true`). When `false`, devtooie leaves it stopped — start it yourself with the `s` hotkey (or a control-API `restart`). Ignored when `command` is `null` (that package never starts). */
    autostart?: boolean | undefined;
    urls?: (((string | any) | {
        label: string;
        url: string | any;
    }) | ((string | any) | {
        label: string;
        url: string | any;
    })[])[] | undefined;
    healthcheck?: ((string | any) | {
        url: string | any;
        timeout?: number | undefined;
    }) | undefined;
    waitFor?: string[] | undefined;
    /** tsconfig file (relative to the package dir) devtooie reads for project references to infer build-time deps. Defaults to `tsconfig.build.json`, then `tsconfig.json`. */
    tsconfig?: string | undefined;
    deps?: {
        build?: string[] | undefined;
        dev?: string[] | undefined;
        runtime?: string[] | undefined;
    } | undefined;
    logs?: {
        timestamps?: boolean | undefined;
        formatter?: any | undefined;
    } | undefined;
};

export type GeneratedDefineConfig = {
    /** Fixed control-API port; omit to let devtooie pick one (recorded in `running.json`). */
    apiPort?: number | undefined;
    packages: {
        [key: string]: {
            /** Directory holding the package, relative to `workspaceDir`. Defaults to `packages/<name>`, where `<name>` is the key this package is declared under. */
            relativeDir?: string | undefined;
            /** Show in the interactive picker (default `true`). */
            selectable?: boolean | undefined;
            /** Shorter label used in the TUI in place of `name`. */
            shortName?: string | undefined;
            /** Color for this package's log-prefix label, overriding the auto-assigned palette color. Any Ink/chalk color: a name (`'magenta'`, `'blueBright'`), hex (`'#af87ff'`), `'rgb(175,135,255)'`, or `'ansi256(140)'`. */
            color?: string | undefined;
            tokens?: {
                [key: string]: string | undefined;
            } | undefined;
            port?: (number | any) | undefined;
            command: any;
            /** Automatically start this package during the run phase (default `true`). When `false`, devtooie leaves it stopped — start it yourself with the `s` hotkey (or a control-API `restart`). Ignored when `command` is `null` (that package never starts). */
            autostart?: boolean | undefined;
            urls?: (((string | any) | {
                label: string;
                url: string | any;
            }) | ((string | any) | {
                label: string;
                url: string | any;
            })[])[] | undefined;
            healthcheck?: ((string | any) | {
                url: string | any;
                timeout?: number | undefined;
            }) | undefined;
            waitFor?: string[] | undefined;
            /** tsconfig file (relative to the package dir) devtooie reads for project references to infer build-time deps. Defaults to `tsconfig.build.json`, then `tsconfig.json`. */
            tsconfig?: string | undefined;
            deps?: {
                build?: string[] | undefined;
                dev?: string[] | undefined;
                runtime?: string[] | undefined;
            } | undefined;
            logs?: {
                timestamps?: boolean | undefined;
                formatter?: any | undefined;
            } | undefined;
        };
    };
    urls?: (((string | any) | {
        label: string;
        url: string | any;
    }) | ((string | any) | {
        label: string;
        url: string | any;
    })[])[] | undefined;
    /** Root each package's `relativeDir` resolves against. Defaults to `process.cwd()`. */
    workspaceDir?: string | undefined;
    /** Arbitrary values handed to every `port`/`healthcheck`/`urls` callback as `tokens`. */
    tokens?: {
        [key: string]: string | undefined;
    } | undefined;
    /** Environment-loading options. Which files load is chosen with `--mode`. */
    env?: {
        /** Variables whose `.env` value may beat the ambient environment (`true` for all). By default the ambient environment wins, as in Next.js/Vite/`node --env-file`. */
        override?: (boolean | string[]) | undefined;
    } | undefined;
    /** Log display options. */
    logs?: {
        /** Prefix each on-screen log line with a `YYYY-MM-DD HH:MM:SS` (24-hour) timestamp. Defaults to `false`. The on-disk log file always includes timestamps regardless of this setting. */
        timestamps?: boolean | undefined;
    } | undefined;
};
