import { timingSafeEqual, X509Certificate } from 'node:crypto';
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import { createServer, request } from 'node:https';
import { isIP, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { TLSSocket } from 'node:tls';
import {
  type GatewayOfflineApiResponse,
  type GatewayTcpContext,
  gatewayOfflineApiRequestSchema,
} from '@nickhosting/game-sdk';
import { z } from 'zod';
import { isNickHostingCommand } from './console-commands.js';
import {
  SatisfactoryHttpsCache,
  satisfactoryCachedFunctions,
  satisfactoryJoinFunction,
  satisfactoryPlayerCredential,
} from './https-cache.js';
import { captureSatisfactoryResponseBody } from './https-cache-response.js';
import { supportsNativeOfflineOperation } from './native-api.js';

const caches = new Map<string, SatisfactoryHttpsCache>();
const writes = new Map<string, Promise<void>>();
const hydration = new WeakMap<SatisfactoryHttpsCache, Promise<void>>();
const pendingByServer = new Map<string, number>();
let totalPendingRequests = 0;
const maxPendingBodyBytes = 64 * 1024;
const offlineLimits = new Map<string, { since: number; requests: number; passwords: number }>();
function permitOffline(serverId: string, peer: string, password: boolean): boolean {
  const key = JSON.stringify([serverId, peer]),
    now = Date.now();
  let entry = offlineLimits.get(key);
  if (!entry || now - entry.since >= 60000) {
    for (const [key, value] of offlineLimits)
      if (now - value.since >= 60000) offlineLimits.delete(key);
    if (!entry && offlineLimits.size >= 10000) return false;
    entry = { since: now, requests: 0, passwords: 0 };
    offlineLimits.set(key, entry);
  }
  entry.requests++;
  if (password) entry.passwords++;
  return entry.requests <= 120 && entry.passwords <= 10;
}
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
  outgoing.end(
    JSON.stringify({ errorCode: status === 429 ? 'rate_limit_exceeded' : 'server_unavailable' }),
  );
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
function offlineRequest(incoming: IncomingMessage, body: Buffer) {
  if (
    !hasOneHeader(incoming, 'content-type') ||
    incoming.headers['content-encoding'] ||
    (incoming.headers.authorization !== undefined && !hasOneHeader(incoming, 'authorization')) ||
    (incoming.headers['x-factorygame-playerid'] !== undefined &&
      !hasOneHeader(incoming, 'x-factorygame-playerid'))
  )
    return undefined;
  const parts = (header(incoming, 'content-type') ?? '').split(';').map((part) => part.trim());
  if (parts.shift()?.toLowerCase() !== 'application/json') return undefined;
  let charset = 'iso-8859-1';
  if (parts.length > 1) return undefined;
  if (parts.length) {
    const match = /^charset=(?:"([^"]+)"|([^\s"]+))$/i.exec(parts[0] ?? '');
    if (!match) return undefined;
    charset = (match[1] ?? match[2] ?? '').toLowerCase();
  }
  try {
    // Native HTTP defaults to ISO-8859-1, not UTF-8 or Windows-1252.
    const text =
      charset === 'iso-8859-1'
        ? body.toString('latin1')
        : charset === 'utf-8' || charset === 'utf-16le'
          ? new TextDecoder(charset, { fatal: true }).decode(body)
          : charset === 'us-ascii' && body.every((byte) => byte < 128)
            ? body.toString('ascii')
            : undefined;
    if (text === undefined) return undefined;
    const value = z
      .strictObject({ function: z.string(), data: z.record(z.string(), z.unknown()).optional() })
      .parse(JSON.parse(text));
    return gatewayOfflineApiRequestSchema.parse({
      operation: value.function,
      data: value.data,
      authorization: header(incoming, 'authorization'),
      playerId: header(incoming, 'x-factorygame-playerid'),
    });
  } catch {
    return undefined;
  }
}
/** Stable public TLS remains here while the backend starts. Core verifies
 * native stopped-instance authentication; only the backend issues entry tickets. */
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
    outcome: 'health' | 'cached' | 'native' | 'unavailable' | 'wake_result' | 'forwarding_attempt',
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
  let pendingRequests = 0;
  function reservePending(outgoing: ServerResponse): (() => void) | undefined {
    const id = context.route?.serverId ?? '';
    const count = pendingByServer.get(id) ?? 0;
    if (totalPendingRequests >= 128 || pendingRequests >= 8 || count >= 64) return undefined;
    totalPendingRequests++;
    pendingRequests++;
    pendingByServer.set(id, count + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      totalPendingRequests--;
      pendingRequests--;
      const remaining = (pendingByServer.get(id) ?? 1) - 1;
      if (remaining > 0) pendingByServer.set(id, remaining);
      else pendingByServer.delete(id);
      outgoing.off('close', release);
      context.signal.removeEventListener('abort', release);
    };
    outgoing.once('close', release);
    context.signal.addEventListener('abort', release, { once: true });
    return release;
  }
  async function waitForBackend(outgoing: ServerResponse, acceptedWake = false): Promise<boolean> {
    const budget = context.backendWaitTimeoutMs ?? 30000;
    if (!Number.isSafeInteger(budget) || budget <= 0) return false;
    const deadline = Date.now() + budget;
    const disconnected = new AbortController();
    const disconnect = () => disconnected.abort();
    outgoing.once('close', disconnect);
    const signal = AbortSignal.any([context.signal, disconnected.signal]);
    let awaitingWakeSnapshot = acceptedWake;
    try {
      while (
        !context.canForward() &&
        Date.now() < deadline &&
        !signal.aborted &&
        !outgoing.destroyed
      ) {
        const mode = context.mode?.() ?? 'waking';
        if (mode === 'waking' || mode === 'online') awaitingWakeSnapshot = false;
        else if (!(mode === 'sleeping' && awaitingWakeSnapshot)) return false;
        await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal });
      }
      return !signal.aborted && !outgoing.destroyed && context.canForward();
    } catch {
      return false;
    } finally {
      outgoing.off('close', disconnect);
    }
  }
  async function forwardWhenReady(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    body: Buffer,
    fn: string,
  ): Promise<void> {
    if (context.signal.aborted || outgoing.destroyed) return;
    if (body.length > maxPendingBodyBytes) return error(outgoing, 413);
    const release = reservePending(outgoing);
    if (!release) return error(outgoing, 429);
    try {
      if (await waitForBackend(outgoing)) forward(incoming, outgoing, body, fn);
      else error(outgoing);
    } finally {
      release();
    }
  }
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
    if (context.consoleReplyOnly?.()) return error(outgoing);
    const decoded =
      incoming.method === 'POST' && /^\/api\/v1\/?$/.test(incoming.url ?? '')
        ? offlineRequest(incoming, body)
        : undefined;
    const fn = decoded?.operation ?? parseFunction(incoming, body);
    if (fn === 'RunCommand') {
      const commands = Object.entries(decoded?.data ?? {}).filter(
        ([key]) => key.toLowerCase() === 'command',
      );
      if (!decoded || commands.length !== 1 || typeof commands[0]?.[1] !== 'string')
        return error(outgoing, 400);
      const command = commands[0][1];
      if (isNickHostingCommand(command) || !context.canForward()) {
        if (body.length > maxPendingBodyBytes) return error(outgoing, 413);
        if (!context.requestConsoleCommand) return error(outgoing);
        if (!permitOffline(context.route.serverId, socket.remoteAddress ?? '', false))
          return error(outgoing, 429);
        const releasePending = reservePending(outgoing);
        if (!releasePending) return error(outgoing, 429);
        const releaseReply = context.beginConsoleReply?.();
        if (context.beginConsoleReply && !releaseReply) {
          releasePending();
          return error(outgoing, 429);
        }
        if (releaseReply) {
          outgoing.once('finish', releaseReply);
          outgoing.once('close', releaseReply);
        }
        // Intercepted online reads count just like forwarded requests. Sleeping
        // commands remain passive until Core explicitly accepts a lifecycle action.
        if (context.canForward() && !reserveActivity(outgoing)) {
          releasePending();
          return error(outgoing);
        }
        try {
          const response = await context.requestConsoleCommand(decoded);
          if (context.signal.aborted || outgoing.destroyed) return;
          outgoing.writeHead(response.status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          outgoing.end(response.status === 204 ? undefined : JSON.stringify(response.body));
        } finally {
          releasePending();
        }
        return;
      }
    }
    if (context.canForward()) {
      forward(incoming, outgoing, body, fn);
      return;
    }
    // Do not retain a large request while waiting for a stopped or starting
    // backend. Online streams retain their existing forwarding behavior.
    if (body.length > maxPendingBodyBytes) return error(outgoing, 413);
    if (fn === 'HealthCheck') {
      diagnostic(fn, 'health');
      outgoing.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      outgoing.end(JSON.stringify({ data: { health: 'slow', serverCustomData: '' } }));
      return;
    }
    // Startup is already authorized. Reads remain passive while waiting, then
    // count as client activity when forwarded to the real backend.
    if (
      fn &&
      supportsNativeOfflineOperation(fn) &&
      ['waking', 'online'].includes(context.mode?.() ?? '')
    ) {
      await forwardWhenReady(incoming, outgoing, body, fn);
      return;
    }
    if (fn && supportsNativeOfflineOperation(fn) && context.requestOfflineApi) {
      const request = offlineRequest(incoming, body);
      if (!request || context.mode() !== 'sleeping' || context.route.wakeEnabled === false) {
        diagnostic(fn, 'unavailable');
        error(outgoing);
        return;
      }
      if (
        !permitOffline(context.route.serverId, socket.remoteAddress ?? '', fn === 'PasswordLogin')
      ) {
        error(outgoing, 429);
        return;
      }
      let response: GatewayOfflineApiResponse;
      try {
        response = await context.requestOfflineApi(request);
      } catch (failure) {
        if (!context.signal.aborted && ['waking', 'online'].includes(context.mode())) {
          await forwardWhenReady(incoming, outgoing, body, fn);
          return;
        }
        throw failure;
      }
      if (!context.signal.aborted && ['waking', 'online'].includes(context.mode())) {
        await forwardWhenReady(incoming, outgoing, body, fn);
        return;
      }
      if (context.signal.aborted || outgoing.destroyed || context.mode() !== 'sleeping')
        return error(outgoing);
      diagnostic(fn, 'native');
      outgoing.writeHead(response.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      outgoing.end(
        response.status === 204
          ? undefined
          : JSON.stringify(response.body ?? { errorCode: 'server_unavailable' }),
      );
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
    const releasePending = reservePending(outgoing);
    if (!releasePending) return error(outgoing, 429);
    if (!reserveActivity(outgoing)) {
      releasePending();
      error(outgoing);
      return;
    }
    try {
      const mode = await context.requestWake();
      diagnostic(fn, 'wake_result');
      if (!['waking', 'online'].includes(mode) || !(await waitForBackend(outgoing, true))) {
        error(outgoing);
        return;
      }
      forward(incoming, outgoing, body, fn);
    } finally {
      releasePending();
    }
  }
  function forward(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    body: Buffer | undefined,
    fn: string | undefined,
  ): void {
    if (!reserveActivity(outgoing)) {
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
          const capture = fn && satisfactoryCachedFunctions.has(fn) && status === 200;
          const parts: Buffer[] = [];
          let length = 0;
          if (capture) {
            response.on('data', (chunk: Buffer) => {
              length += chunk.length;
              if (length <= 262144) parts.push(chunk);
            });
            response.on('end', () => {
              if (length > 262144) return;
              void captureSatisfactoryResponseBody(
                Buffer.concat(parts),
                response.headers['content-encoding'],
              )
                .then((captured) => {
                  if (captured === undefined) return;
                  cache.remember(
                    fn,
                    header(incoming, 'authorization'),
                    header(incoming, 'x-factorygame-playerid'),
                    captured,
                  );
                  persist();
                })
                .catch(() => undefined);
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
