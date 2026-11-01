import { timingSafeEqual, X509Certificate } from 'node:crypto';
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import { createServer, request } from 'node:https';
import { isIP, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { TLSSocket } from 'node:tls';
import type { GatewayTcpContext } from '@nickhosting/game-sdk';
import { z } from 'zod';
import {
  SatisfactoryHttpsCache,
  satisfactoryCachedFunctions,
  satisfactoryJoinFunction,
  satisfactoryPlayerCredential,
} from './https-cache.js';

const caches = new Map<string, SatisfactoryHttpsCache>();
const writes = new Map<string, Promise<void>>();
const hydration = new WeakMap<SatisfactoryHttpsCache, Promise<void>>();
function cacheFor(context: GatewayTcpContext): SatisfactoryHttpsCache {
  const id = context.route?.serverId ?? '';
  let cache = caches.get(id);
  if (!cache) {
    cache = new SatisfactoryHttpsCache();
    caches.set(id, cache);
  }
  if (caches.size > 10000) {
    const first = caches.keys().next().value;
    if (first) caches.delete(first);
  }
  return cache;
}
function error(outgoing: ServerResponse, status = 503): void {
  if (!outgoing.headersSent)
    outgoing.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  outgoing.end(undefined);
}
function header(incoming: IncomingMessage, name: string): string | undefined {
  const value = incoming.headers[name];
  return typeof value === 'string' ? value : undefined;
}
const joinBody = z.strictObject({
  function: z.literal(satisfactoryJoinFunction),
  data: z.strictObject({}).optional(),
});
function hasOneHeader(incoming: IncomingMessage, name: string): boolean {
  let count = 0;
  for (let index = 0; index < incoming.rawHeaders.length; index += 2)
    if (incoming.rawHeaders[index]?.toLowerCase() === name) count++;
  return count === 1;
}
function isJoinIntent(incoming: IncomingMessage, body: Buffer): boolean {
  if (
    incoming.method !== 'POST' ||
    !/^\/api\/v1\/?$/.test(incoming.url ?? '') ||
    incoming.headers['content-encoding'] !== undefined ||
    !hasOneHeader(incoming, 'content-type') ||
    header(incoming, 'content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' ||
    !hasOneHeader(incoming, 'authorization') ||
    !hasOneHeader(incoming, 'x-factorygame-playerid') ||
    !satisfactoryPlayerCredential(header(incoming, 'authorization')) ||
    !/^(?:[a-fA-F0-9]{2}){1,1024}$/.test(header(incoming, 'x-factorygame-playerid') ?? '')
  )
    return false;
  try {
    return joinBody.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)))
      .success;
  } catch {
    return false;
  }
}
function parseFunction(incoming: IncomingMessage, body: Buffer): string | undefined {
  if (
    !/^\/api\/v1\/?$/.test(incoming.url ?? '') ||
    incoming.method !== 'POST' ||
    incoming.headers['content-encoding']
  )
    return undefined;
  try {
    const value = JSON.parse(body.toString('utf8'));
    return typeof value.function === 'string' ? value.function : undefined;
  } catch {
    return undefined;
  }
}
/** A stable public TLS session remains here while the backend starts. The
 * backend alone authenticates users and issues multiplayer tickets. */
export async function acceptSatisfactoryHttps(
  socket: Socket,
  context: GatewayTcpContext,
): Promise<void> {
  const identity = await context.tlsIdentity();
  if (context.signal.aborted || socket.destroyed) return;
  const expected = new X509Certificate(identity.certificatePem).raw;
  const cache = cacheFor(context);
  const diagnosticOperations = new Set([
    ...satisfactoryCachedFunctions,
    'HealthCheck',
    'VerifyAuthenticationToken',
    'PasswordlessLogin',
    'PasswordLogin',
    satisfactoryJoinFunction,
  ]);
  function diagnostic(
    fn: string | undefined,
    outcome: 'health' | 'cached' | 'unavailable' | 'wake_result' | 'forwarding_attempt',
  ): void {
    try {
      context.onApiDiagnostic?.({
        operation: fn && diagnosticOperations.has(fn) ? fn : 'other',
        outcome,
      });
    } catch {
      // Diagnostics cannot change an API response or expose request contents.
    }
  }
  let loaded = hydration.get(cache);
  if (!loaded) {
    loaded = (async () => {
      try {
        const persisted = await context.loadPrivateState?.();
        if (persisted) cache.restore(persisted);
      } catch {
        /* Unavailable cache never grants offline authentication. */
      }
    })();
    hydration.set(cache, loaded);
  }
  await loaded;
  const persist = () => {
    if (!context.savePrivateState) return;
    const id = context.route.serverId;
    const previous = writes.get(id) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => context.savePrivateState?.(cache.snapshot()))
      .then(() => undefined)
      .catch(() => undefined);
    writes.set(id, pending);
    void pending.finally(() => {
      if (writes.get(id) === pending) writes.delete(id);
    });
  };
  const activeRequests = new WeakSet<ServerResponse>();
  function reserveActivity(outgoing: ServerResponse): boolean {
    if (activeRequests.has(outgoing) || !context.beginActivity) return true;
    const release = context.beginActivity();
    if (!release) return false;
    activeRequests.add(outgoing);
    outgoing.once('finish', release);
    outgoing.once('close', release);
    return true;
  }
  const server = createServer(
    {
      key: identity.privateKeyPem,
      cert: identity.certificatePem,
      minVersion: 'TLSv1.2',
      handshakeTimeout: 10000,
      maxHeaderSize: 16384,
      requestTimeout: 30000,
      headersTimeout: 10000,
    },
    (incoming, outgoing) => {
      // Only bounded JSON API requests are inspected. Upload/download streams stay
      // transparent online, with backpressure handled by Node's streams.
      const json =
        incoming.method === 'POST' &&
        /^\/api\/v1\/?$/.test(incoming.url ?? '') &&
        !String(incoming.headers['content-type'] ?? '').startsWith('multipart/');
      if (!json && context.canForward()) {
        forward(incoming, outgoing, undefined, undefined);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on('data', (part: Buffer) => {
        size += part.length;
        if (size > 262144) incoming.destroy();
        else chunks.push(part);
      });
      incoming.on('end', () => {
        void handle(incoming, outgoing, Buffer.concat(chunks)).catch(() => error(outgoing));
      });
    },
  );
  async function handle(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    body: Buffer,
  ): Promise<void> {
    if (context.signal.aborted) {
      incoming.destroy();
      return;
    }
    const fn = parseFunction(incoming, body);
    if (context.canForward()) {
      forward(incoming, outgoing, body, fn);
      return;
    }
    if (fn === 'HealthCheck') {
      diagnostic(fn, 'health');
      outgoing.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      outgoing.end(JSON.stringify({ data: { health: 'slow', serverCustomData: '' } }));
      return;
    }
    const authorization = header(incoming, 'authorization'),
      playerId = header(incoming, 'x-factorygame-playerid');
    // A cached successful read does not establish the backend token's current
    // validity. Only the backend may positively verify authentication.
    const cached = fn && cache.read(fn, authorization, playerId);
    if (cached) {
      diagnostic(fn, 'cached');
      outgoing.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      outgoing.end(cached);
      return;
    }
    // Like Minecraft Login Start, a syntactically valid join is an intention
    // to play. It is not proof of identity and does not depend on a recent read
    // cache. Admission/coalescing remain in Core; the backend authenticates the
    // unchanged request and is the only issuer of multiplayer tickets.
    if (!isJoinIntent(incoming, body)) {
      diagnostic(fn, 'unavailable');
      error(outgoing);
      return;
    }
    if (!reserveActivity(outgoing)) {
      error(outgoing);
      return;
    }
    const mode = await context.requestWake();
    diagnostic(fn, 'wake_result');
    if (!['waking', 'online'].includes(mode)) {
      error(outgoing);
      return;
    }
    const deadline = Date.now() + 25000;
    while (
      !context.canForward() &&
      Date.now() < deadline &&
      !context.signal.aborted &&
      !outgoing.destroyed
    )
      await delay(100, undefined, { signal: context.signal });
    if (!context.canForward() || outgoing.destroyed) {
      error(outgoing);
      return;
    }
    forward(incoming, outgoing, body, fn);
  }
  function forward(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    body: Buffer | undefined,
    fn: string | undefined,
  ): void {
    const passive =
      fn !== undefined &&
      (satisfactoryCachedFunctions.has(fn) ||
        ['HealthCheck', 'VerifyAuthenticationToken', 'PasswordlessLogin', 'PasswordLogin'].includes(
          fn,
        ));
    if (!passive && !reserveActivity(outgoing)) {
      error(outgoing);
      return;
    }
    const releaseForwarding = context.beginForwarding?.();
    if (context.beginForwarding && !releaseForwarding) {
      error(outgoing);
      return;
    }
    diagnostic(fn, 'forwarding_attempt');
    let upstream: ClientRequest;
    try {
      upstream = request(
        {
          hostname: context.route.backend.address,
          port: context.route.backend.port,
          method: incoming.method,
          path: incoming.url,
          agent: false,
          rejectUnauthorized: false,
          minVersion: 'TLSv1.2',
          headers: {
            ...incoming.headers,
            host: `${isIP(context.route.backend.address) === 6 ? `[${context.route.backend.address}]` : context.route.backend.address}:${context.route.backend.port}`,
          },
          signal: context.signal,
          timeout: 30000,
        },
        (response) => {
          const status = response.statusCode ?? 502;
          if (status === 401 || status === 403) {
            cache.reject(
              header(incoming, 'authorization'),
              header(incoming, 'x-factorygame-playerid'),
            );
            persist();
          }
          if (
            status >= 200 &&
            status < 300 &&
            (!fn ||
              (!satisfactoryCachedFunctions.has(fn) &&
                ![
                  'HealthCheck',
                  'VerifyAuthenticationToken',
                  'PasswordlessLogin',
                  'PasswordLogin',
                  satisfactoryJoinFunction,
                ].includes(fn)))
          ) {
            cache.clear();
            persist();
          }
          const capture =
            fn &&
            satisfactoryCachedFunctions.has(fn) &&
            status === 200 &&
            !response.headers['content-encoding'];
          const parts: Buffer[] = [];
          let length = 0;
          if (capture) {
            response.on('data', (chunk: Buffer) => {
              length += chunk.length;
              if (length <= 262144) parts.push(chunk);
            });
            response.on('end', () => {
              if (length <= 262144)
                cache.remember(
                  fn,
                  header(incoming, 'authorization'),
                  header(incoming, 'x-factorygame-playerid'),
                  Buffer.concat(parts).toString('utf8'),
                );
              persist();
            });
          }
          outgoing.writeHead(status, response.headers);
          response.pipe(outgoing);
        },
      );
    } catch {
      releaseForwarding?.();
      error(outgoing, 502);
      return;
    }
    upstream.on('socket', (raw) => {
      const tls = raw as TLSSocket;
      tls.once('secureConnect', () => {
        const actual = tls.getPeerCertificate().raw;
        if (
          !actual ||
          actual.length !== expected.length ||
          !timingSafeEqual(actual, expected) ||
          !context.canForward()
        ) {
          upstream.destroy();
          return;
        }
        if (body) upstream.end(body);
        else incoming.pipe(upstream);
      });
    });
    upstream.once('close', () => releaseForwarding?.());
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => error(outgoing, 502));
    outgoing.once('close', () => upstream.destroy());
  }
  server.on('tlsClientError', () => socket.destroy());
  server.on('clientError', () => socket.destroy());
  socket.once('close', () => server.close());
  server.emit('connection', socket);
}
