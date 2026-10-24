// AUTO-GENERATED from config-schema.ts by scripts/gen-config-types.ts — DO NOT EDIT.
// Regenerate with `pnpm --filter devtooie gen` (also runs as part of `pnpm build`).
// Field docs come from the schemas' `.describe()`; `command`/`waitFor`/`deps`/`name`/
// `packages` and the package-level `logs` are overridden in config.ts, so their generated form
// here is intentionally ignored.
/* eslint-disable */

export type GeneratedServiceConfig = {
    /** Directory holding the service, relative to `workspaceDir`. Inferred as `<serviceRootDir>/<key>` when the config sets `serviceRootDir`; required otherwise. Set it to override the inferred one. */
    relativeDir?: string | undefined;
    /** Show in the interactive picker (default `true`). */
    selectable?: boolean | undefined;
    /** Shorter label used in the TUI in place of `name`. */
    shortName?: string | undefined;
    /** Color for this service's log-prefix label, overriding the auto-assigned palette color. Any Ink/chalk color: a name (`'magenta'`, `'blueBright'`), hex (`'#af87ff'`), `'rgb(175,135,255)'`, or `'ansi256(140)'`. */
    color?: string | undefined;
    proxy?: {
        subdomain: true | string | string[];
    } | undefined;
    subdomain?: undefined | undefined;
    tokens?: {
        [key: string]: string | undefined;
    } | undefined;
    port?: (number | any) | undefined;
    command: any;
    /** Automatically start this service during the run phase (default `true`). When `false`, devtooie leaves it stopped — start it yourself with the `s` hotkey (or a control-API `start`). Ignored when `command` is `null` (that service never starts). */
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
    /** tsconfig file (relative to the service dir) devtooie reads for project references to infer build-time deps. Defaults to `tsconfig.build.json`, then `tsconfig.json`. */
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
    /** Fixed control-API port; omit to let devtooie pick one (recorded in `running.<mode>.json`). A fixed port serves the session of one mode at a time. */
    apiPort?: number | undefined;
    services: {
        [key: string]: {
            /** Directory holding the service, relative to `workspaceDir`. Inferred as `<serviceRootDir>/<key>` when the config sets `serviceRootDir`; required otherwise. Set it to override the inferred one. */
            relativeDir?: string | undefined;
            /** Show in the interactive picker (default `true`). */
            selectable?: boolean | undefined;
            /** Shorter label used in the TUI in place of `name`. */
            shortName?: string | undefined;
            /** Color for this service's log-prefix label, overriding the auto-assigned palette color. Any Ink/chalk color: a name (`'magenta'`, `'blueBright'`), hex (`'#af87ff'`), `'rgb(175,135,255)'`, or `'ansi256(140)'`. */
            color?: string | undefined;
            proxy?: {
                subdomain: true | string | string[];
            } | undefined;
            subdomain?: undefined | undefined;
            tokens?: {
                [key: string]: string | undefined;
            } | undefined;
            port?: (number | any) | undefined;
            command: any;
            /** Automatically start this service during the run phase (default `true`). When `false`, devtooie leaves it stopped — start it yourself with the `s` hotkey (or a control-API `start`). Ignored when `command` is `null` (that service never starts). */
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
            /** tsconfig file (relative to the service dir) devtooie reads for project references to infer build-time deps. Defaults to `tsconfig.build.json`, then `tsconfig.json`. */
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
    serviceRootDir?: string | undefined;
    urls?: (((string | any) | {
        label: string;
        url: string | any;
    }) | ((string | any) | {
        label: string;
        url: string | any;
    })[])[] | undefined;
    devReverseProxy?: {
        port: number | any;
        rootDomain?: (string | string[] | any) | undefined;
        /** The service the bare `rootDomain` routes to. Must declare a `port`; needs no `proxy`, and without one its `PUBLIC_ORIGIN` is the bare root. Omit for a 404 there. */
        defaultService?: string | undefined;
        /** Scheme of the public URLs devtooie derives (footer links, `PUBLIC_ORIGIN`). Defaults from the canonical `rootDomain`: `http` on `localhost` (the browser hits the proxy directly, so the URLs carry its `port`), `https` on any other root (a TLS terminator in front, so no port). */
        urlScheme?: ("http" | "https") | undefined;
    } | undefined;
    infra?: {
        "docker-compose"?: {
            file?: string | undefined;
            readyTimeout?: number | undefined;
            services?: {
                [key: string]: {
                    enabled?: (boolean | any) | undefined;
                    port?: (number | any) | undefined;
                    proxy?: {
                        subdomain: true | string | string[];
                    } | undefined;
                    urls?: (((string | any) | {
                        label: string;
                        url: string | any;
                    }) | ((string | any) | {
                        label: string;
                        url: string | any;
                    })[])[] | undefined;
                    beforeDestroy?: any | undefined;
                    afterDestroy?: any | undefined;
                    beforeUp?: any | undefined;
                    afterReady?: any | undefined;
                };
            } | undefined;
        } | undefined;
    } | undefined;
    /** Root each service's `relativeDir` resolves against. Defaults to `process.cwd()`. */
    workspaceDir?: string | undefined;
    /** Arbitrary values handed to every `port`/`healthcheck`/`urls` callback as `tokens`. */
    tokens?: {
        [key: string]: string | undefined;
    } | undefined;
    env?: {
        vars?: any | undefined;
        /** Variables whose `.env` or `env.vars` value may beat the ambient environment (`true` for all). By default the ambient environment wins, as in Next.js/Vite/`node --env-file`. */
        override?: (boolean | string[]) | undefined;
    } | undefined;
    /** Log display options. */
    logs?: {
        /** Prefix each on-screen log line with a local-time (24-hour) timestamp — `HH:MM:SS` while everything on screen is from one day, `YYYY-MM-DD HH:MM:SS` once two days are visible. Defaults to `true`. The on-disk log file always includes timestamps regardless of this setting. */
        timestamps?: boolean | undefined;
    } | undefined;
};
