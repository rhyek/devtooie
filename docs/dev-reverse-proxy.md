# Dev reverse proxy

> Part of the [devtooie](../README.md) documentation.

devtooie can run the project's dev reverse proxy itself. A TLS terminator on the machine
(Caddy, say — not devtooie's concern) forwards `*.<rootDomain>` to one loopback port per
project; devtooie owns that port and routes each request by the first label of its `Host`
header to the package or [infra service](./infra.md) whose `proxy` declares that subdomain, on
its resolved `port`.

Because devtooie also knows every package's live status, the proxy can **answer for a package
that is stopped or still starting** — a page saying so, rather than a bare connection error.

The proxy does no TLS, no path-based routing, and no auth.

## Config

```ts
export default defineConfig({
  packageRootDir: 'packages',
  devReverseProxy: {
    port: ({ envs }) => Number(envs.DEV_REVERSE_PROXY_PORT), // number | callback
    rootDomain: ({ envs }) => `myproject.${envs.LOCALDEV_DOMAIN}`, // string | string[] | callback, default 'localhost'
    defaultPackage: 'web', // optional: what the bare rootDomain routes to
    urlScheme: 'https', // optional; defaults from rootDomain: http on localhost, https elsewhere
  },
  infra: {
    'docker-compose': {
      services: {
        // the host side of the service's port mapping, which devtooie doesn't read from the file
        store: { port: ({ envs }) => Number(envs.STORE_PORT), proxy: { subdomain: 's3' } },
        mail: { port: 21054, proxy: { subdomain: true } }, // true: the key, `mail`
      },
    },
  },
  packages: {
    web: { port: 3000, proxy: { subdomain: ['web', 'www'] } },
    api: { port: 3001, proxy: { subdomain: true }, healthcheck: '/health' }, // true: the key, `api`
    worker: { port: 3002 }, // a port but no proxy: simply not routed
  },
});
```

- **The block's presence enables the proxy.** There is no `enabled` flag; remove the block to
  turn it off.
- **`port`** and **`rootDomain`** take a literal or a callback over the workspace-scope context
  `{ envs, tokens }` (the same one the workspace-wide `urls` get), resolved once at load like a
  package `port`. A callback returning `NaN` or an empty string is an error naming the field
  and the env files that were loaded. `rootDomain` defaults to **`localhost`**, which browsers
  resolve to loopback with nothing in front (see [No terminator](#no-terminator-plain-localhost)).
- **`rootDomain` as an array** — `['myproject.example.test', 'myproject.localhost']`, as a
  literal or a callback's return. The first entry is the **canonical** root; the rest are
  **aliases**, and a `Host` under one routes exactly as under the canonical root — subdomains,
  subdomain aliases, `defaultPackage` on the bare alias, infra services, status pages,
  WebSockets — with the `Host` still forwarded unchanged. Everything devtooie derives uses the
  canonical root alone: `PUBLIC_ORIGIN`, the `urlScheme` default, footer links, `publicOrigin`,
  and the 404 page's links. An alias suits a local-only name reached at the proxy directly,
  `http://web.myproject.localhost:<proxy port>`, beside a canonical root that a TLS terminator
  serves. The app behind it is configured from the canonical `PUBLIC_ORIGIN`, so whatever it
  derives from that — the HMR `clientPort` in the [Vite example](#websockets-and-vite-hmr), CORS
  origins, cookie domains — has to allow the alias as well.
- **`defaultPackage`** — the package the bare `rootDomain` routes to. Must declare a `port`,
  and needs no `proxy`: without one, the bare root is its public origin (its `PUBLIC_ORIGIN` and
  `publicOrigin`); with a `proxy.subdomain`, that subdomain stays its origin and the bare root is
  one more route to it. Without `defaultPackage` the bare root is a 404.
- **`urlScheme`** — `'http' | 'https'`. The scheme of the public URLs devtooie derives (footer
  links, `PUBLIC_ORIGIN`), and with it whether they carry a port. **Defaults from `rootDomain`**:
  `http` on `localhost`, `https` on any other root. `http` means the browser hits the proxy
  directly, so the URLs carry the proxy `port` — how a plain `localhost` setup works with nothing
  in front; `https` means a TLS terminator sits in front, so they carry no port. So the same
  package is `http://api.localhost:4000` under the default root and `https://api.myproject.test`
  under a custom one, with nothing else to set.

### `proxy`

A package and an infra service declare a route the same way, with a `proxy` block:

- **`subdomain`** (required) — a DNS label (lowercase letters, digits, and hyphens, at most 63
  characters, not starting or ending with a hyphen); an array of them, whose first entry is the
  canonical subdomain and the rest aliases that route too; or **`true`** for the package's or
  service's own key (`api: { proxy: { subdomain: true } }` is `subdomain: 'api'`). `true` needs a
  key that is itself a DNS label; a scoped, uppercase, or underscored one has to spell its
  subdomain out.

Without a `devReverseProxy` block, `proxy` is data for tooling that reads the exported config —
a reverse proxy of your own, say.

**Routable** packages and services are those declaring both `proxy` and `port`; one with a port
but no `proxy` is simply not routed. An infra service switched off for the mode (`enabled:
false`) is not routed either. Validation:

- `rootDomain` is a lowercase hostname (labels of `[a-z0-9-]`, no leading or trailing hyphen) —
  every entry, when it is an array. An array is non-empty, lists no entry twice, and has no
  entry under another (`dev.example.test` beside `example.test`), so a `Host` falls under at
  most one.
- `defaultPackage` names a declared package that has a `port`.
- Every subdomain and alias is unique across packages **and** infra services.
- A package that declares `proxy` but no `port` is an error when the block is present — it
  can't be routed. An infra service that declares `proxy` but no `port` is always an error.
- The proxy `port` equals no package's or infra service's port, and an infra service's port
  equals no package's (or another service's).

Each error names the offender.

## Routing

The proxy strips any `:port` from the `Host` header, then:

| Host                   | Routes to                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `<rootDomain>`         | `defaultPackage`, or 404 when unset.                                                        |
| `<label>.<rootDomain>` | The package or infra service whose canonical subdomain **or alias** is `<label>`.           |
| anything else          | 404 — including multi-label prefixes (`a.web.<rootDomain>`) and hosts outside `rootDomain`. |

With `rootDomain` an array, `<rootDomain>` above is any of its entries.

The 404 is a small page listing every hostname that does exist, as public URLs you can click:
`<subdomain>.<rootDomain>` for every routable package and infra service, aliases included, plus
the bare root when `defaultPackage` is set — all under the canonical root.

Requests are forwarded to the package's or service's port on `localhost`, trying both loopback
families (Vite on a modern Node listens on `[::1]` alone). The `Host` header is kept as
received — so a signature computed over it, like an S3 presigned URL's or a presigned POST
form's, still matches at the service — and every other request and response header passes through unchanged, except the
hop-by-hop ones (`connection`, `keep-alive`, `proxy-*`, `te`, `trailer`, `transfer-encoding`,
`upgrade`), which Node manages on each side. devtooie adds or rewrites no `X-Forwarded-*` —
the TLS terminator in front already sets them. Bodies stream both ways; nothing is buffered,
and the proxy has no request, response, or idle timeouts of its own, so SSE and long-lived
connections survive.

## Status pages

The proxy asks the process manager before forwarding:

| Package status                                   | Response                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stopped`, `waiting`, `rebuilding`, `restarting` | **503** immediately: a small HTML page (when the request accepts `text/html`) or JSON otherwise, naming the package and its status and how to start it (`s` hotkey, or `POST /command/restart/<name>` on the [control API](./control-api.md)). `Retry-After: 2`, `Cache-Control: no-store`; the HTML page refreshes itself. |
| `running`, with a `healthcheck` not yet passing  | The request is **held** up to 15 s, re-checking readiness, then proxied. Past 15 s, the same 503 with status `starting`.                                                                                                                                                                                                    |
| `running` and ready (or no `healthcheck`)        | Proxied. If the package refuses or resets the connection, a **502** page naming the package and port, `Retry-After: 1`.                                                                                                                                                                                                     |
| not part of the running session                  | **503**, saying so.                                                                                                                                                                                                                                                                                                         |

Before the session's process manager is up (during the build phase), every routable package
host answers 503 with status `starting`. If the client disconnects mid-request, the upstream
request is aborted.

### Infra services

An infra service has no live status for the proxy to ask about, so its routes go by the
session's infra step alone:

| When                                     | Response                                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Before the session's infra step finishes | **503** with status `starting`, naming the service, as HTML or JSON like the package pages. `Retry-After: 2`, `Cache-Control: no-store`. |
| After it                                 | Proxied. If the service refuses or resets the connection, a **502** page naming the service and its port, `Retry-After: 1`.      |

## WebSockets and Vite HMR

The proxy handles the `upgrade` event with the same `Host` routing, opens the upstream with the
original headers, and once the package or service answers `101` splices the two sockets both
ways. An upgrade to a package that is not `running` right now, or to an infra service before the
session's infra step has finished, is **dropped** (the socket is destroyed) rather than held, and
so is one the target fails to accept because it isn't listening yet: websocket clients reconnect
on their own, and a real answer is there once the target is up.

Vite HMR is the canonical client. Point its client at the TLS terminator's port and let the
websocket ride the same connection as the page — no separate HMR port:

```ts
// vite.config.ts
export default defineConfig({
  server: {
    // PUBLIC_ORIGIN is injected by devtooie — see below
    allowedHosts: [new URL(process.env.PUBLIC_ORIGIN!).hostname],
    // the public port: the TLS terminator's, or the proxy's own under plain localhost
    hmr: { clientPort: Number(new URL(process.env.PUBLIC_ORIGIN!).port) || 443 },
  },
});
```

## `PUBLIC_ORIGIN`

Every routable package's process — one with a `port` and either a `proxy` or the
`defaultPackage` slot — gets `PUBLIC_ORIGIN` injected next to `PORT`, under the same rule: only a `PUBLIC_ORIGIN` in the
package's own `.env` file overrides it. It is built from the block as

```
<urlScheme>://<canonical subdomain>.<rootDomain>[:<port>]
```

where the canonical subdomain is the package's `proxy.subdomain` (the first entry of an array —
aliases never appear here) and the port follows the [`urlScheme` rule](#config): the proxy
`port` under `http`, none under `https`. So `https://web.myproject.test` behind a TLS
terminator, and `http://web.localhost:21050` on plain `localhost`. A `defaultPackage` with no
`proxy` gets the bare root instead, `<urlScheme>://<rootDomain>[:<port>]`:
`https://myproject.test`, or `http://localhost:21050`. Any other package with no `proxy` gets
no `PUBLIC_ORIGIN` at all.

Apps use it for things like Vite's `server.allowedHosts` and `server.hmr` without repeating the
subdomain in their own config. `devtooie exec` and `devtooie run` hand the same variable to a one-off command.

## Footer links and the resolved config

devtooie adds no footer link of its own for a package: `urls` holds exactly what the config
lists. To show a package's public origin, list it — `''` (or `'/'`) is the origin itself, any
other path is resolved against it (see [Configuration](./configuration.md)). A lone
`urls: ['']` makes the package's name in the footer the link to its origin. An infra service
has no `urls`; the footer's link column lists each routed service's public origin under an
`infra` heading, below the packages' links.

The origin is on the resolved config as `publicOrigin` — for a package, the same value injected
as `PUBLIC_ORIGIN` — next to `config.devReverseProxy`:

```ts
// with `urls: ['', '/todos']` on web
config.devReverseProxy; // { port: 4000, rootDomain: 'myproject.example.test', rootDomains: ['myproject.example.test'], defaultPackage: 'web', urlScheme: 'https' } | undefined
config.packages.web.publicOrigin; // 'https://web.myproject.example.test'
config.packages.web.urls; // ['https://web.myproject.example.test', 'https://web.myproject.example.test/todos']
config.infra['docker-compose'].services.store; // { enabled: true, port: 9000, proxy: { subdomain: 's3' }, publicOrigin: 'https://s3.myproject.example.test', … }
```

`config.devReverseProxy.rootDomain` is the canonical root; `rootDomains` lists every entry,
canonical first. `devtooie show-config` prints all of this as JSON without starting a session.

## Lifecycle

The proxy starts **before any package**, in both the TUI and `--plain` modes, whenever the
loaded config has `devReverseProxy`. `devtooie exec`, `run`, `infra`, `logs`, `env`, and `init`
never start it.
On shutdown it closes and destroys every open socket, proxied websockets included, so a
lingering connection can't hold the exit.

Its port goes through the same conflict handling package ports get: a previous devtooie
session being handed off releases it as it shuts down; anything still holding it after that is
a startup error naming the port.

At start, one `[devtooie]` log entry names the proxy port, with one indented line per route
beneath it (`<host>: <package> :<port>`, or `<host>: infra service <name> :<port>`). The [control API](./control-api.md)'s `GET /query/status` reports
the same table under `devReverseProxy`.

## No terminator: plain `localhost`

With the default `rootDomain` (`localhost`) nothing needs to sit in front: browsers resolve
every `*.localhost` name to the loopback address, so `http://web.localhost:<proxy port>` reaches
the proxy, which routes it by the `web` label. `localhost` implies `urlScheme: 'http'`, under
which the public URLs devtooie derives carry the proxy port, so footer links and
`PUBLIC_ORIGIN` are right and Vite's HMR client (see above) connects to the same port the page
came from.

```ts
devReverseProxy: {
  port: ({ envs }) => Number(envs.DEV_REVERSE_PROXY_PORT),
  defaultPackage: 'frontend', // http://localhost:<proxy port> is the app
},
```

`*.localhost` resolution is a browser feature, not the OS resolver's: `curl` needs an explicit
`Host` header (`curl -H 'Host: web.localhost' http://127.0.0.1:<proxy port>/`).

## The TLS terminator

Anything that terminates TLS and forwards to a loopback port works. Point `rootDomain` at its
domain: a root other than `localhost` implies `urlScheme: 'https'`, so the public URLs point at
the terminator with no port. With Caddy, one site block per project:

```caddyfile
*.myproject.example.test, myproject.example.test {
  tls internal
  reverse_proxy 127.0.0.1:4000
}
```

where `4000` is the project's `devReverseProxy.port`. Caddy sets `X-Forwarded-*` itself, which
is why devtooie doesn't.
