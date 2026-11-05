import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { Config } from './config.js';
import { infraServicesOf, proxyHostsFor, serviceProxyHostsFor } from './config.js';

/**
 * The built-in dev reverse proxy.
 *
 * A TLS terminator on the machine (Caddy, say — not devtooie's concern) forwards `*.<rootDomain>`
 * to one loopback port per project. This is that port: each request is routed by its `Host` to the
 * package or infra service whose `proxy` declares that subdomain, on its resolved `port`. Since
 * devtooie also knows every package's live status, the proxy can answer for a package that is
 * stopped or still starting instead of surfacing a bare connection error. An infra service has no
 * live status: it is answered for as starting until the session's infra step has finished, and
 * forwarded to from then on. No TLS, no path-based routing, no auth.
 *
 * Built like the control API server: created early (before any package starts) so the listener
 * is bound and the port conflict is settled up front, then `attach`ed to the process manager once
 * that exists. Until then every package host answers 503 "starting"; every service host does until
 * `markInfraReady`.
 */

/** One hostname the proxy routes, and where to. */
export type DevReverseProxyRoute = {
  /** The full hostname: `<subdomain>.<rootDomain>`, or the bare `rootDomain` for `defaultService`. */
  host: string;
  /** The package's or service's resolved port, on loopback. */
  port: number;
} & (
  | {
      kind: 'package';
      /** The package this host routes to. */
      package: string;
      /** Whether the package declares a `healthcheck` — if so, requests wait for it to pass. */
      hasHealthcheck: boolean;
    }
  | {
      kind: 'service';
      /** The infra service this host routes to. */
      service: string;
    }
);

/** How a page names a route's target: `api`, `infra service mail`. */
function describeTarget(route: DevReverseProxyRoute): string {
  return route.kind === 'package' ? route.package : `infra service ${route.service}`;
}

/** What the proxy needs from the process manager. `ProcessManager` satisfies it structurally. */
export interface DevReverseProxyManager {
  /** A package's live status, or `null` for one this session isn't managing. */
  getStatus(name: string): string | null;
  /** Whether the package's healthcheck is currently passing. */
  isReady(name: string): boolean;
  /** Called on buffer/status changes; returns the unsubscribe. Readiness alone doesn't fire it. */
  subscribe(listener: () => void): () => void;
  /** devtooie's own `[devtooie]` log channel: attrs render as indented lines under the message. */
  systemLog: { info(attrs: Record<string, unknown>, message: string): void };
}

export interface DevReverseProxyServer {
  /** The port actually bound (the configured one, or the ephemeral one a test asked for). */
  port: number;
  /** The canonical root domain — the one `routes` are written under. */
  rootDomain: string;
  /** Every root domain routed: the canonical one, then its aliases. */
  rootDomains: string[];
  /** The route table, one entry per hostname under the canonical root (aliases route the same). */
  routes: DevReverseProxyRoute[];
  /** Hands the proxy the live statuses; logs the route table on devtooie's own channel. */
  attach(manager: DevReverseProxyManager): void;
  /**
   * The session's infra step has finished: forward to the infra service routes from now on.
   * Until it's called they answer 503 "starting", and drop websocket upgrades.
   */
  markInfraReady(): void;
  /** Stops listening and destroys every open socket, proxied websockets included. */
  close(): Promise<void>;
}

/** How long a request to a running-but-not-yet-ready package is held before a 503. */
export const READY_HOLD_MS = 15_000;
/** How often a held request re-checks readiness (the manager doesn't announce it). */
const READY_POLL_MS = 250;
/**
 * The most connections the proxy holds open to one upstream at a time. A burst of requests beyond
 * it waits for a free socket instead of dialling: a page load sends hundreds of module requests at
 * once (a dev server serves each file on its own), and macOS caps a listener's queue of
 * connections not yet accepted at 128 (`kern.ipc.somaxconn`), resetting the rest — each a 502.
 */
export const UPSTREAM_MAX_SOCKETS = 64;
/**
 * How long an idle connection to an upstream is kept. A request sent on a connection as the
 * upstream closes it is reset, so the proxy lets go first. Most servers close idle connections
 * without saying when (Go's at its `IdleTimeout`, gunicorn's at 2 s, uvicorn's at 5 s), so this is
 * shorter than any timeout a server commonly uses; a page load's burst reuses its connections well
 * within it, and a new connection on loopback costs next to nothing. One that announces its timeout
 * (`Keep-Alive: timeout=5`, every Node server) is closed `UPSTREAM_CLOSE_EARLY_MS` before that when
 * that comes sooner, and one seen closing an idle connection sooner has its own learned
 * (`UpstreamAgent`). A request the upstream drops is a 502: the proxy never sends one again.
 */
const UPSTREAM_IDLE_MS = 1_000;
const UPSTREAM_CLOSE_EARLY_MS = 2_000;
/**
 * How long the proxy keeps a client's idle connection open: longer than a TLS terminator keeps
 * one in its pool (Caddy: 2 min), so the terminator always lets go first. Node's default, 5 s,
 * would close connections the terminator still reuses, and each request caught by it is a 502.
 */
const CLIENT_IDLE_MS = 10 * 60_000;
/**
 * Node closes an HTTP/2 connection whose client cancels streams faster than about a thousand at
 * once, then 33 a second: a defence against "rapid reset" floods (CVE-2023-44487). Over h2c every
 * request a TLS terminator forwards shares one connection, and each page closed or reloaded
 * mid-load cancels its in-flight requests on it, so a busy e2e suite would trip it and fail every
 * other request on the connection. The proxy listens on loopback only, for one developer.
 */
const STREAM_RESETS_UNLIMITED = 2 ** 31 - 1;
/** Methods whose requests carry no body unless they say so (`content-length`, `transfer-encoding`). */
const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The pool of connections to the upstreams, which learns each upstream's idle timeout: when an
 * upstream closes a connection that sat idle in the pool, it closes idle ones after that long, so
 * from then on the proxy closes that upstream's idle connections itself, after half as long. (Node
 * never hands out an idle connection whose close is already waiting on it; this keeps the upstream
 * from closing one just as a request goes out on it.)
 */
class UpstreamAgent extends http.Agent {
  /** Per upstream port, the idle timeout learned for it. */
  readonly #learnedMs = new Map<number, number>();
  /** Each idle connection: when it went back in the pool, and its upstream. */
  readonly #idle = new WeakMap<net.Socket, { since: number; port: number }>();
  readonly #watched = new WeakSet<net.Socket>();

  override keepSocketAlive(socket: net.Socket): boolean {
    const port = socket.remotePort;
    const learned = port === undefined ? undefined : this.#learnedMs.get(port);
    // Node keeps the socket only when this returns true; @types/node types it as void.
    const kept = super.keepSocketAlive(socket) as unknown as boolean;
    if (port === undefined || learned === 0 || !kept) {
      return false;
    }
    if (learned !== undefined && learned < socket.timeout!) {
      socket.setTimeout(learned);
    }
    this.#idle.set(socket, { since: Date.now(), port });
    if (!this.#watched.has(socket)) {
      this.#watched.add(socket);
      // An idle connection the upstream closes is destroyed by Node at once, without 'end'.
      // One the proxy closes itself times out first, and teaches nothing.
      socket.on('timeout', () => this.#idle.delete(socket));
      socket.once('close', () => {
        const idle = this.#idle.get(socket);
        if (idle) {
          this.#learn(idle.port, Date.now() - idle.since);
        }
      });
    }
    return true;
  }

  override reuseSocket(socket: net.Socket, request: http.ClientRequest): void {
    this.#idle.delete(socket);
    super.reuseSocket(socket, request);
  }

  #learn(port: number, idleMs: number) {
    const learned = Math.floor(idleMs / 2);
    if (learned >= (this.#learnedMs.get(port) ?? Infinity)) {
      return;
    }
    this.#learnedMs.set(port, learned);
    // The pool's idle connections to it: closed now if they have already sat that long.
    const now = Date.now();
    for (const socket of Object.values(this.freeSockets).flat()) {
      const idle = socket && this.#idle.get(socket);
      if (!socket || idle?.port !== port) {
        continue;
      }
      const left = learned - (now - idle.since);
      if (left <= 0) {
        this.#idle.delete(socket);
        socket.destroy();
      } else {
        socket.setTimeout(left);
      }
    }
  }
}

/**
 * Headers that describe the connection between two hops rather than the message itself.
 * `node:http` manages these on each side; forwarding them would be at best redundant and at
 * worst wrong (a `transfer-encoding` copied onto a re-chunked body, say).
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * A request the proxy answers: HTTP/1.1, or a stream of an h2c connection (HTTP/2 without TLS),
 * which a TLS terminator in front can use to send a whole page load over one connection.
 */
type ProxyRequest = http.IncomingMessage | http2.Http2ServerRequest;
type ProxyResponse = http.ServerResponse | http2.Http2ServerResponse;

/** The first bytes of every HTTP/2 connection without TLS (RFC 9113, 3.4). */
const H2_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');

/** The request's host: `Host` over HTTP/1.1, `:authority` over HTTP/2. */
function hostHeaderOf(req: ProxyRequest): string | undefined {
  const authority = req.headers[':authority'];
  return req.headers.host ?? (typeof authority === 'string' ? authority : undefined);
}

/** Starts a response with no status message, on either protocol. */
function writeHead(res: ProxyResponse, status: number, headers: http.OutgoingHttpHeaders) {
  if (res instanceof http2.Http2ServerResponse) {
    res.writeHead(status, headers);
  } else {
    res.writeHead(status, headers);
  }
}

/** Drops a response mid-way: the connection over HTTP/1.1, the one stream over HTTP/2. */
function abortResponse(res: ProxyResponse) {
  if (res instanceof http2.Http2ServerResponse) {
    res.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
  } else {
    res.destroy();
  }
}

/**
 * The route table for a config, one entry per hostname: the packages' (`proxyHostsFor` order),
 * then the enabled infra services'.
 */
export function routesFromConfig(config: Config<string>): DevReverseProxyRoute[] {
  const routes: DevReverseProxyRoute[] = [];
  for (const pkg of Object.values(config.services)) {
    for (const host of proxyHostsFor(config, pkg)) {
      routes.push({
        kind: 'package',
        host,
        package: pkg.name,
        port: pkg.port!,
        hasHealthcheck: pkg.healthcheck !== undefined,
      });
    }
  }
  for (const { name, service } of infraServicesOf(config)) {
    for (const host of serviceProxyHostsFor(config, service)) {
      routes.push({ kind: 'service', host, service: name, port: service.port! });
    }
  }
  return routes;
}

/** The hostname of a `Host` header: lowercased, any `:port` dropped, or `null` when absent. */
export function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) {
    return null;
  }
  const host = hostHeader.trim().toLowerCase();
  // `[::1]:8443` — keep the bracketed literal, drop the port. Otherwise split on the last colon.
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

/** `true` when the request would rather have HTML than JSON. */
function acceptsHtml(req: ProxyRequest): boolean {
  return (req.headers.accept ?? '').includes('text/html');
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
}

/** A tiny self-contained page — inline styles, no assets, so it renders with nothing else up. */
function page(title: string, bodyHtml: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
    '<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.5rem;color:#222;background:#fafafa}' +
    'h1{font-size:1.4rem}code{background:#eee;padding:.1em .3em;border-radius:3px}ul{padding-left:1.2rem}small{color:#666}</style>' +
    `</head><body><h1>${escapeHtml(title)}</h1>${bodyHtml}<p><small>devtooie dev reverse proxy</small></p></body></html>`
  );
}

interface Problem {
  status: number;
  title: string;
  /** Extra JSON fields (and the paragraph list rendered in HTML). */
  detail: Record<string, unknown>;
  paragraphs: string[];
  listItems?: string[];
  headers: Record<string, string>;
}

function sendProblem(req: ProxyRequest, res: ProxyResponse, problem: Problem) {
  // The request is never needed, but read to its end: over HTTP/2, Node resets a stream whose
  // request was never read as soon as its response is written (see `forward`).
  req.resume();
  const headers = { 'cache-control': 'no-store', ...problem.headers };
  if (acceptsHtml(req)) {
    const items = problem.listItems?.length
      ? `<ul>${problem.listItems.map((i) => `<li><a href="${escapeHtml(i)}"><code>${escapeHtml(i)}</code></a></li>`).join('')}</ul>`
      : '';
    const body = problem.paragraphs.map((p) => `<p>${p}</p>`).join('') + items;
    writeHead(res, problem.status, { ...headers, 'content-type': 'text/html; charset=utf-8' });
    res.end(page(problem.title, body));
    return;
  }
  writeHead(res, problem.status, { ...headers, 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: problem.title, ...problem.detail }));
}

export async function startDevReverseProxy(opts: {
  /** The loopback port to bind; `0` for an ephemeral one (tests). */
  port: number;
  /** The canonical root domain, the one every route's `host` is under. */
  rootDomain: string;
  /**
   * Further root domains that route exactly like the canonical one: `<x>.<alias>` reaches what
   * `<x>.<rootDomain>` does, and the bare alias what the bare root does.
   */
  rootDomainAliases?: string[];
  routes: DevReverseProxyRoute[];
  /** The control API's port, if known, so a 503 page can spell out the exact `restart` URL. */
  controlApiPort?: number;
  /**
   * Scheme of the public URLs (`config.devReverseProxy.urlScheme`), so the 404 page can list
   * every route as a link that actually works: under `http` (the default) they carry the
   * proxy's own port, under `https` none (a TLS terminator on 443 in front).
   */
  urlScheme?: 'http' | 'https';
  /** Override of {@link READY_HOLD_MS}. */
  readyTimeoutMs?: number;
}): Promise<DevReverseProxyServer> {
  const { rootDomain, routes } = opts;
  const rootDomains = [rootDomain, ...(opts.rootDomainAliases ?? [])];
  const readyTimeoutMs = opts.readyTimeoutMs ?? READY_HOLD_MS;
  // Every route answers under every root: the same target, with `host` the one asked for, so a
  // status page names the hostname in the address bar. (No root is under another — the config
  // rejects that — so no alias host can shadow a canonical one.)
  const byHost = new Map(routes.map((r) => [r.host, r]));
  for (const alias of opts.rootDomainAliases ?? []) {
    for (const r of routes) {
      const host =
        r.host === rootDomain
          ? alias
          : r.host.endsWith(`.${rootDomain}`)
            ? `${r.host.slice(0, -rootDomain.length)}${alias}`
            : null;
      if (host !== null) {
        byHost.set(host, { ...r, host });
      }
    }
  }
  let manager: DevReverseProxyManager | null = null;
  let infraReady = false;
  /** Every socket we've seen, on either side, so `close()` can cut them all. */
  const sockets = new Set<Duplex>();
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  /**
   * The connections forwarded requests go out on: kept alive, at most `UPSTREAM_MAX_SOCKETS` per
   * upstream, so a burst queues here rather than in the upstream's listen backlog, and each idle
   * one closed before the upstream would close it. Websocket upgrades dial on their own, since an
   * upgraded socket leaves any pool.
   */
  const upstreamAgent = new UpstreamAgent({
    keepAlive: true,
    maxSockets: UPSTREAM_MAX_SOCKETS,
    timeout: UPSTREAM_IDLE_MS,
    agentKeepAliveTimeoutBuffer: UPSTREAM_CLOSE_EARLY_MS,
  });

  const restartHint = (name: string) =>
    opts.controlApiPort !== undefined
      ? `POST http://127.0.0.1:${String(opts.controlApiPort)}/command/service/restart/${name}`
      : `POST /command/service/restart/${name} on the control API`;

  const urlScheme = opts.urlScheme ?? 'http';
  // `port` (the bound one) is assigned below, before any request can arrive.
  let port = opts.port;
  const publicUrl = (host: string) =>
    `${urlScheme}://${host}${urlScheme === 'http' ? `:${String(port)}` : ''}`;

  const notFound = (req: ProxyRequest, res: ProxyResponse, host: string | null) => {
    const urls = routes.map((r) => publicUrl(r.host));
    sendProblem(req, res, {
      status: 404,
      title: `Nothing is routed at ${host ?? '(no Host header)'}`,
      detail: { host, routes: routes.map((r) => r.host), urls },
      paragraphs: [
        `The devtooie dev reverse proxy for ${rootDomains.map((d) => `<code>${escapeHtml(d)}</code>`).join(', ')} knows these hostnames` +
          (rootDomains.length > 1 ? ', each under every one of those roots:' : ':'),
      ],
      listItems: urls,
      headers: {},
    });
  };

  /**
   * A 503 for a package the proxy can't forward to right now. `status` is the package's live
   * status (or "starting" for one whose readiness is still pending), and `managed` says whether a
   * restart is even something this session can do for it.
   */
  const unavailable = (
    req: ProxyRequest,
    res: ProxyResponse,
    route: DevReverseProxyRoute & { kind: 'package' },
    status: string,
    managed: boolean,
  ) => {
    const how = managed
      ? `Start it with the <code>s</code> hotkey in devtooie, or <code>${escapeHtml(restartHint(route.package))}</code>.`
      : 'It is not part of the running devtooie session — start a session that includes it.';
    sendProblem(req, res, {
      status: 503,
      title: `${route.package} is ${status}`,
      detail: {
        service: route.package,
        status,
        host: route.host,
        hint: managed
          ? `start it with the s hotkey, or ${restartHint(route.package)}`
          : 'not part of the running devtooie session',
      },
      paragraphs: [
        `<code>${escapeHtml(route.host)}</code> routes to the service <code>${escapeHtml(route.package)}</code>, which is currently <strong>${escapeHtml(status)}</strong>.`,
        how,
        'This page refreshes on its own.',
      ],
      headers: { 'retry-after': '2', refresh: '2' },
    });
  };

  /** The 503 for an infra service while the session is still bringing the infra up. */
  const serviceStarting = (
    req: ProxyRequest,
    res: ProxyResponse,
    route: DevReverseProxyRoute & { kind: 'service' },
  ) => {
    sendProblem(req, res, {
      status: 503,
      title: `${describeTarget(route)} is starting`,
      detail: {
        infraService: route.service,
        status: 'starting',
        host: route.host,
        hint: 'devtooie is still bringing the infra up',
      },
      paragraphs: [
        `<code>${escapeHtml(route.host)}</code> routes to the infra service <code>${escapeHtml(route.service)}</code>, which devtooie is still bringing up.`,
        'This page refreshes on its own.',
      ],
      headers: { 'retry-after': '2', refresh: '2' },
    });
  };

  const badGateway = (
    req: ProxyRequest,
    res: ProxyResponse,
    route: DevReverseProxyRoute,
    err: NodeJS.ErrnoException,
  ) => {
    // oxfmt-ignore
    if (res.headersSent) {
      abortResponse(res);
      return;
    }
    const target = route.kind === 'package' ? { service: route.package } : { infraService: route.service }; // oxfmt-ignore
    sendProblem(req, res, {
      status: 502,
      title: `${describeTarget(route)} is not answering on port ${String(route.port)}`,
      detail: { ...target, port: route.port, code: err.code ?? null },
      paragraphs: [
        `<code>${escapeHtml(route.host)}</code> routes to <code>${escapeHtml(describeTarget(route))}</code> on <code>localhost:${String(route.port)}</code>, ` +
          `but the connection failed (<code>${escapeHtml(err.code ?? err.message)}</code>). ` +
          (route.kind === 'package'
            ? 'It may still be starting, or listening on a different port than its config says.'
            : 'It may have stopped, or publish a different port than its config says.'),
      ],
      headers: { 'retry-after': '1', refresh: '1' },
    });
  };

  /**
   * Where to dial a route: the package's or service's port on `localhost`, trying both loopback
   * families. A package may bind only one of them — Vite on a modern Node listens on `[::1]`
   * alone — and a fixed `127.0.0.1` would be refused there while the package's own healthcheck
   * (which dials `localhost` the same way) passes.
   */
  const upstreamAddress = (route: DevReverseProxyRoute) => ({
    host: 'localhost',
    port: route.port,
    autoSelectFamily: true,
  });

  /**
   * Copies headers minus the hop-by-hop set (upgrades keep theirs — the handshake needs them) and
   * HTTP/2's pseudo-headers (`:path`, `:authority`…), which have no place in an HTTP/1.1 message.
   */
  const endToEnd = (headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders => {
    const out: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      if (!HOP_BY_HOP.has(name) && !name.startsWith(':') && value !== undefined) {
        out[name] = value;
      }
    }
    return out;
  };

  /**
   * Resolves once the package can be forwarded to (`true`), or when it can't (`false`): status no
   * longer `running`, or the hold deadline passed. Re-checks on manager notifications and on a
   * short poll, since a readiness flip on its own doesn't notify. Also gives up if the client
   * goes away while waiting (its connection, or over HTTP/2 its stream), so a held request can't
   * outlive it.
   */
  const waitUntilReady = (route: DevReverseProxyRoute & { kind: 'package' }, res: ProxyResponse) =>
    // oxfmt-ignore
    new Promise<boolean>((resolve) => {
      const check = (): boolean => {
        if (!manager) {
          return false;
        }
        if (manager.getStatus(route.package) !== 'running') {
          finish(false);
          return true;
        }
        if (manager.isReady(route.package)) {
          finish(true);
          return true;
        }
        return false;
      };
      let done = false;
      const finish = (ok: boolean) => {
        if (done) {
          return;
        }
        done = true;
        unsubscribe();
        clearInterval(poll);
        clearTimeout(deadline);
        res.off('close', onClose);
        resolve(ok);
      };
      const onClose = () => finish(false);
      const unsubscribe = manager?.subscribe(() => void check()) ?? (() => {});
      const poll = setInterval(check, READY_POLL_MS);
      const deadline = setTimeout(() => finish(false), readyTimeoutMs);
      res.once('close', onClose);
      check();
    });

  const forward = (req: ProxyRequest, res: ProxyResponse, route: DevReverseProxyRoute) => {
    // oxfmt-ignore
    const upstream = http.request({
      ...upstreamAddress(route),
      agent: upstreamAgent,
      method: req.method,
      path: req.url,
      // `host` is kept as received (from `:authority` over HTTP/2), so Node won't synthesize one.
      headers: { ...endToEnd(req.headers), host: hostHeaderOf(req) },
    });
    upstream.on('response', (up) => {
      // HTTP/2 has no status message.
      if (res instanceof http2.Http2ServerResponse) {
        res.writeHead(up.statusCode ?? 502, endToEnd(up.headers));
      } else {
        res.writeHead(up.statusCode ?? 502, up.statusMessage, endToEnd(up.headers));
      }
      up.pipe(res);
    });
    upstream.on('error', (err: NodeJS.ErrnoException) => badGateway(req, res, route, err));
    const bodyless =
      BODYLESS_METHODS.has(req.method ?? '') &&
      req.headers['transfer-encoding'] === undefined &&
      (req.headers['content-length'] ?? '0') === '0';
    if (bodyless) {
      // Sent at once: over HTTP/2 a request can leave its side open after its headers (Caddy does
      // for one of unknown length), and piping it would forward a GET with a chunked body. Read
      // the (empty) request to its end all the same: over HTTP/2, Node resets a stream whose
      // request was never read as soon as its response is written, and a client still holding
      // its side open can receive that reset before the response's end, and drop the response.
      upstream.end();
      req.resume();
    } else {
      req.pipe(upstream);
    }
    // A client that leaves mid-request takes the upstream request with it.
    res.on('close', () => {
      if (!res.writableEnded) {
        upstream.destroy();
      }
    });
  };

  const handle = async (req: ProxyRequest, res: ProxyResponse) => {
    const host = hostnameOf(hostHeaderOf(req));
    const route = host === null ? undefined : byHost.get(host);
    if (!route) {
      return notFound(req, res, host);
    }
    // A service has no live status to consult: once the infra step is done it is up (that step
    // waits for it), and a service that went away since gets the 502 like any refused dial.
    if (route.kind === 'service') {
      return infraReady ? forward(req, res, route) : serviceStarting(req, res, route);
    }
    if (!manager) {
      return unavailable(req, res, route, 'starting', true);
    }
    const status = manager.getStatus(route.package);
    if (status === null) {
      return unavailable(req, res, route, 'not running', false);
    }
    if (status !== 'running') {
      return unavailable(req, res, route, status, true);
    }
    if (route.hasHealthcheck && !manager.isReady(route.package)) {
      let gone = false;
      res.once('close', () => (gone = true));
      const ready = await waitUntilReady(route, res);
      if (gone) {
        return;
      }
      if (!ready) {
        const now = manager.getStatus(route.package);
        return unavailable(req, res, route, now === 'running' ? 'starting' : (now ?? 'not running'), now !== null); // oxfmt-ignore
      }
    }
    forward(req, res, route);
  };

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });
  // Nothing here may time out on the proxy's account: SSE streams and long polls live as long as
  // the app in front and the package behind want them to.
  server.requestTimeout = 0;
  server.setTimeout(0);
  server.keepAliveTimeout = CLIENT_IDLE_MS;

  // The same requests over h2c. HTTP/2 needs no websocket path here: an upgrade is HTTP/1.1.
  const h2server = http2.createServer(
    {
      streamResetBurst: STREAM_RESETS_UNLIMITED,
      streamResetRate: STREAM_RESETS_UNLIMITED,
    },
    (req, res) => {
      void handle(req, res);
    },
  );
  h2server.setTimeout(0);
  const sessions = new Set<http2.ServerHttp2Session>();
  h2server.on('session', (session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });

  /**
   * Hands a new connection to the HTTP/2 server when it opens with HTTP/2's preface, else to the
   * HTTP/1.1 one, both serving the same port. The bytes read to tell them apart are put back on the
   * socket first: either server reads them from there (Node's HTTP/2 session takes a socket's
   * buffered bytes before reading its handle), so both get the socket itself.
   */
  const dispatch = (socket: net.Socket) => {
    track(socket);
    socket.on('error', () => socket.destroy());
    let seen = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      seen = Buffer.concat([seen, chunk]);
      const n = Math.min(seen.length, H2_PREFACE.length);
      const h2 = seen.subarray(0, n).equals(H2_PREFACE.subarray(0, n));
      if (h2 && seen.length < H2_PREFACE.length) {
        return; // not enough to tell yet
      }
      socket.off('data', onData);
      socket.pause();
      socket.unshift(seen);
      if (h2) {
        h2server.emit('connection', socket);
        return;
      }
      server.emit('connection', socket);
      socket.resume();
    };
    socket.on('data', onData);
  };
  const listener = net.createServer(dispatch);

  server.on('upgrade', (req, socket, head) => {
    track(socket);
    socket.on('error', () => socket.destroy());
    const host = hostnameOf(req.headers.host);
    const route = host === null ? undefined : byHost.get(host);
    // Not routable right now (unknown host, infra or manager not there yet, or a package not
    // `running`): just drop it — websocket clients such as Vite's HMR reconnect on their own,
    // and a real answer will be there once the target is up.
    const routable =
      route !== undefined &&
      (route.kind === 'service'
        ? infraReady
        : manager !== null && manager.getStatus(route.package) === 'running');
    if (!route || !routable) {
      socket.destroy();
      return;
    }
    const upstream = http.request({
      ...upstreamAddress(route),
      method: req.method,
      path: req.url,
      // The upgrade handshake *is* hop-by-hop: `connection`/`upgrade` must reach the package.
      headers: req.headers,
    });
    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      track(upSocket);
      upSocket.on('error', () => upSocket.destroy());
      // Replay the upstream's 101 verbatim: status line, then its headers as it sent them.
      const lines = [`HTTP/1.1 ${String(upRes.statusCode ?? 101)} ${upRes.statusMessage ?? 'Switching Protocols'}`]; // oxfmt-ignore
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
        lines.push(`${upRes.rawHeaders[i]!}: ${upRes.rawHeaders[i + 1]!}`);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upHead.length) {
        socket.write(upHead);
      }
      if (head.length) {
        upSocket.write(head);
      }
      socket.pipe(upSocket).pipe(socket);
      socket.once('close', () => upSocket.destroy());
      upSocket.once('close', () => socket.destroy());
    });
    // The package answered with a plain response instead of upgrading (a 4xx, say): pass the
    // status through and close, since there's no upgraded connection to keep.
    upstream.on('response', (upRes) => {
      const lines = [`HTTP/1.1 ${String(upRes.statusCode ?? 502)} ${upRes.statusMessage ?? ''}`, 'connection: close']; // oxfmt-ignore
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
        if (!HOP_BY_HOP.has(upRes.rawHeaders[i]!.toLowerCase())) {
          lines.push(`${upRes.rawHeaders[i]!}: ${upRes.rawHeaders[i + 1]!}`);
        }
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      upRes.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.end();
  });

  await new Promise<void>((resolve, reject) => {
    listener.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(
              `dev reverse proxy port ${String(opts.port)} is already in use by another program. ` +
                'Free it, or change `devReverseProxy.port` in devtooie.config.ts.',
            )
          : err,
      );
    });
    listener.listen(opts.port, '127.0.0.1', resolve);
  });
  port = (listener.address() as net.AddressInfo).port;

  return {
    port,
    rootDomain,
    rootDomains,
    routes,
    attach(m) {
      manager = m;
      // One entry: the listener as the message, then a line per route (`<host>: <package> :<port>`),
      // which the log formatter indents beneath it — readable at any terminal width.
      const table = Object.fromEntries(
        routes.map((r) => [r.host, `${describeTarget(r)} :${String(r.port)}`]),
      );
      m.systemLog.info(
        table,
        `dev reverse proxy listening on 127.0.0.1:${String(port)}` +
          (routes.length ? '' : ' — nothing to route (no service or infra service declares both `proxy` and `port`)'), // oxfmt-ignore
      );
    },
    markInfraReady() {
      infraReady = true;
    },
    close() {
      return new Promise<void>((resolve) => {
        listener.close(() => resolve());
        upstreamAgent.destroy();
        for (const session of sessions) {
          session.destroy();
        }
        for (const socket of sockets) {
          socket.destroy();
        }
      });
    },
  };
}
