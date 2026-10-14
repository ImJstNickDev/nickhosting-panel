import { randomUUID } from 'node:crypto';
import { createSocket, type Socket as DatagramSocket, type RemoteInfo } from 'node:dgram';
import { connect, createServer, isIP, type Server, type Socket } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { DomainError } from '@nickhosting/core';
import {
  type GatewayControl,
  type GatewayEndpoint,
  type GatewayMode,
  type GatewayProtocolAdapter,
  type GatewayProtocolObservation,
  type GatewayResponseMode,
  type GatewayRoute,
  type GatewaySafety,
  type GatewaySnapshot,
  gatewaySnapshotSchema,
} from '@nickhosting/game-sdk';
import { GatewaySafetyError } from '@nickhosting/gateway-safety';
import { NetworkObservationError } from '@nickhosting/pterodactyl-adapter';
import { z } from 'zod';
import {
  GatewayProviderRateLimitedError,
  GatewayRouteRevisionStaleError,
} from './control-client.js';
import { readinessReceipt } from './readiness-receipt.js';
import { sleepReceipt } from './sleep-receipt.js';

const positive = z.number().int().positive().max(2_147_483_647);
export const gatewayDataPlanePolicySchema = z
  .object({
    maximumLeaseMs: positive,
    maxClockSkewMs: z.number().int().nonnegative().max(60_000),
    pollIntervalMs: positive,
    observationIntervalMs: positive,
    probeTimeoutMs: positive,
    tcpConnectTimeoutMs: positive,
    tcpIdleTimeoutMs: positive,
    classificationTimeoutMs: positive,
    maxClassificationBytes: positive,
    maxProtocolResponseBytes: positive,
    maxTcpConnections: positive,
    maxUdpSessions: positive,
    udpIdleTimeoutMs: positive,
    maxUdpQueuedBytes: positive,
    wakeRetryMs: positive,
    gracefulShutdownMs: positive,
  })
  .strict();
export type GatewayDataPlanePolicy = z.infer<typeof gatewayDataPlanePolicySchema>;

export interface GatewayDataPlaneOptions {
  gatewayId: string;
  control: GatewayControl;
  safety: GatewaySafety;
  protocols: readonly GatewayProtocolAdapter[];
  policy: GatewayDataPlanePolicy;
  now?: () => number;
  logger?: {
    log(
      level: 'debug' | 'info' | 'warn' | 'error',
      event: string,
      data?: Readonly<Record<string, unknown>>,
    ): void;
  };
}

interface UdpSession {
  socket: DatagramSocket;
  lastActivity: number;
  connecting: boolean;
  queued: Buffer[];
  queuedBytes: number;
}
interface Listener {
  route: GatewayRoute;
  backendReady: boolean;
  statusOnly?: boolean;
  // Presentation only: never replaces the committed route or its lease authority.
  statusMode?: GatewayResponseMode;
  tcp?: Server;
  udp?: DatagramSocket;
  clients: Set<Socket>;
  forwardingClients: Set<Socket>;
  sessions: Map<string, UdpSession>;
}

/** One process owns the hot route cache. There is no Core, SQL or Redis call in
 * an established forwarding stream. Fresh authenticated leases bound outages. */
export function createGatewayDataPlane(options: GatewayDataPlaneOptions) {
  const policy = gatewayDataPlanePolicySchema.parse(options.policy);
  if (
    !z.uuid().safeParse(options.gatewayId).success ||
    new Set(options.protocols.map((p) => p.id)).size !== options.protocols.length
  )
    throw new DomainError('configuration_invalid');
  const now = options.now ?? Date.now;
  const listeners = new Map<string, Listener>();
  const protocols = new Map(options.protocols.map((adapter) => [adapter.id, adapter]));
  const wakeRequests = new Map<
    string,
    {
      at: number;
      promise: Promise<GatewayMode>;
      inFlight: boolean;
      requestId: string;
      coalesced: number;
    }
  >();
  const counters = {
    tcpAccepted: 0,
    tcpRejected: 0,
    tcpBytesToBackend: 0,
    tcpBytesToClient: 0,
    udpReceived: 0,
    udpDropped: 0,
    udpBytesToBackend: 0,
    udpBytesToClient: 0,
    wakeRequests: 0,
    wakeErrors: 0,
    observationErrors: 0,
    observationsDiscarded: 0,
    observationCycles: 0,
    lastObservationDurationMs: 0,
    maximumObservationDurationMs: 0,
    lastObservationProbeDurationMs: 0,
    lastObservationReportDurationMs: 0,
    lastSnapshotDurationMs: 0,
    snapshotErrors: 0,
    leaseExpirations: 0,
  };
  let snapshot: GatewaySnapshot | undefined;
  // Authenticated candidates may be probed before they are safe to bind. This
  // breaks first-start readiness bootstrap without granting forwarding rights.
  let candidateSnapshot: GatewaySnapshot | undefined;
  let controlAvailable = false;
  let providerRetryAt = 0;
  const deferProvider = (error: GatewayProviderRateLimitedError) => {
    controlAvailable = false;
    providerRetryAt = Math.max(providerRetryAt, now() + error.retryAfterMs);
  };
  let stopping = false;
  let started = false;
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let observationTimer: ReturnType<typeof setTimeout> | undefined;
  let idleDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const sampledIdleDeadlines = new Map<string, string>();
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let serial: Promise<void> = Promise.resolve();
  let refreshing: Promise<void> | undefined;
  let observing: Promise<void> | undefined;
  const startupObservations = new Map<string, Promise<void>>();
  const observationEpochs = new Map<string, object>();
  let shutdown: Promise<void> | undefined;
  const startupWatches = new Map<
    string,
    { key: string; abort: AbortController; retryAt: number; done: boolean }
  >();
  let pendingUdpIntents = 0;
  let pendingUdpResponseBytes = 0;
  const sleepWatches = new Map<string, { abort: AbortController; deadline: number }>();
  const quiescence = new Map<
    string,
    { deadline: number; observedAt: number; generation: string; routes: GatewayRoute[] }
  >();
  const loggedRouteStates = new Map<string, string>();
  const logTiming = (event: string, data: Readonly<Record<string, unknown>>) => {
    try {
      options.logger?.log('info', event, data);
    } catch {
      // Diagnostic sink failures must not change admission, leases or forwarding.
    }
  };
  const routeIdentity = (route: GatewayRoute) => ({
    routeId: route.id,
    serverId: route.serverId,
    generation: route.generation,
    routeRevision: route.revision,
    wakeJobId: route.wakeJobId,
  });
  const bounded = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(
              new DomainError('integration_unavailable', 503, {
                gatewaySafetyReason: 'validation_timeout',
              }),
            );
          }, policy.probeTimeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const clientsCount = () =>
    [...listeners.values()].reduce((count, listener) => count + listener.clients.size, 0);
  const sessionsCount = () =>
    [...listeners.values()].reduce((count, listener) => count + listener.sessions.size, 0);
  const leased = () => !stopping && !!snapshot && Date.parse(snapshot.expiresAt) > now();
  const active = (listener: Listener) => leased() && listeners.get(listener.route.id) === listener;
  const protocol = (route: GatewayRoute) => {
    const candidate = route.protocol && protocols.get(route.protocol.handlerId);
    try {
      return candidate?.supports(route) ? candidate : undefined;
    } catch {
      return undefined;
    }
  };
  const dropSession = (listener: Listener, key: string) => {
    const session = listener.sessions.get(key);
    if (!session) return;
    listener.sessions.delete(key);
    try {
      session.socket.close();
    } catch {
      /* A connecting or failed socket may already be closed. */
    }
  };
  const clearSessions = (listener: Listener) => {
    for (const client of listener.clients) client.destroy();
    for (const key of listener.sessions.keys()) dropSession(listener, key);
  };
  const closeListener = (listener: Listener, force = true): Promise<void> => {
    if (force) clearSessions(listener);
    if (listener.udp) {
      for (const key of listener.sessions.keys()) dropSession(listener, key);
      try {
        listener.udp.close();
      } catch {
        /* Already closed after a socket error. */
      }
    }
    return new Promise((resolve) => {
      if (!listener.tcp) return resolve();
      listener.tcp.close(() => resolve());
    });
  };
  const response = (route: GatewayRoute, mode: GatewayResponseMode) => {
    try {
      const bytes = protocol(route)?.response(
        { route, signal: AbortSignal.timeout(policy.classificationTimeoutMs) },
        mode,
      );
      return bytes && bytes.byteLength <= policy.maxProtocolResponseBytes ? bytes : undefined;
    } catch {
      return undefined;
    }
  };
  // Quiescence only fences gameplay: bounded protocol status/disconnect replies
  // remain available on the already authorized listener while an idle stop settles.
  const responseMode = (listener: Listener, mode = listener.route.mode): GatewayResponseMode =>
    quiescence.has(listener.route.serverId)
      ? 'stopping'
      : listener.statusOnly && listener.statusMode
        ? listener.statusMode
        : !listener.backendReady && listener.route.mode === 'online'
          ? 'blocked'
          : mode;
  const logRouteTransition = (
    listener: Listener,
    reason: string,
    available = active(listener),
    snapshotApplyDurationMs?: number,
  ) => {
    if (!options.logger) return;
    const effectiveMode = available ? responseMode(listener) : 'unavailable';
    const forwardable =
      available &&
      listener.route.mode === 'online' &&
      listener.backendReady &&
      !quiescence.has(listener.route.serverId);
    // Revisions and lease timestamps change on routine renewal, but do not
    // constitute a player-visible transition. Generation changes do.
    const signature = JSON.stringify([listener.route.generation, effectiveMode, forwardable]);
    if (loggedRouteStates.get(listener.route.id) === signature) return;
    loggedRouteStates.set(listener.route.id, signature);
    logTiming('gateway.route_transition', {
      ...routeIdentity(listener.route),
      reason,
      responseMode: effectiveMode,
      forwardable,
      snapshotRevision: snapshot?.revision,
      leaseExpiresAt: snapshot?.expiresAt,
      snapshotApplyDurationMs,
    });
    if (!available) loggedRouteStates.delete(listener.route.id);
  };
  const wake = (route: GatewayRoute): Promise<GatewayMode> => {
    if (!leased() || quiescence.has(route.serverId) || listeners.get(route.id)?.statusOnly)
      return Promise.resolve('blocked');
    const previous = wakeRequests.get(route.serverId);
    if (previous && (previous.inFlight || now() - previous.at < policy.wakeRetryMs)) {
      previous.coalesced++;
      if (previous.coalesced === 1)
        logTiming('gateway.wake_coalesced', {
          ...routeIdentity(route),
          requestId: previous.requestId,
          inFlight: previous.inFlight,
        });
      return previous.promise;
    }
    counters.wakeRequests++;
    const requestId = randomUUID();
    const issuedAt = performance.now();
    logTiming('gateway.wake_requested', {
      ...routeIdentity(route),
      requestId,
      source: 'intentional_join',
    });
    const promise: Promise<GatewayMode> = options.control
      .requestWake({ routeId: route.id, routeRevision: route.revision, requestId })
      .then((result) => {
        logTiming('gateway.wake_completed', {
          ...routeIdentity(route),
          requestId,
          operationId: result.operationId,
          resultMode: result.mode,
          durationMs: Math.round(performance.now() - issuedAt),
          coalescedJoins:
            wakeRequests.get(route.serverId)?.requestId === requestId
              ? wakeRequests.get(route.serverId)?.coalesced
              : undefined,
        });
        return result.mode;
      })
      .catch(() => {
        counters.wakeErrors++;
        logTiming('gateway.wake_completed', {
          ...routeIdentity(route),
          requestId,
          resultMode: 'blocked',
          outcome: 'control_unavailable',
          durationMs: Math.round(performance.now() - issuedAt),
        });
        return 'blocked' as const;
      })
      .finally(() => {
        const current = wakeRequests.get(route.serverId);
        if (current?.promise === promise) current.inFlight = false;
      });
    wakeRequests.set(route.serverId, {
      at: now(),
      promise,
      inFlight: true,
      requestId,
      coalesced: 0,
    });
    return promise;
  };
  const processIntent = async (
    listener: Listener,
    input: Uint8Array,
  ): Promise<{ pending?: boolean; bytes?: Uint8Array }> => {
    if (!active(listener)) return {};
    const route = listener.route;
    const handler = protocol(route);
    if (!handler) return {};
    try {
      const intent = handler.classify(input, {
        route,
        signal: AbortSignal.timeout(policy.classificationTimeoutMs),
      });
      if (intent.kind === 'need-more') return { pending: true };
      if (intent.kind === 'status') return { bytes: response(route, responseMode(listener)) };
      if (intent.kind !== 'join') return {};
      const mode =
        route.mode === 'sleeping' || route.mode === 'blocked' ? await wake(route) : route.mode;
      return active(listener) && listener.route === route
        ? { bytes: response(route, responseMode(listener, mode)) }
        : {};
    } catch {
      return {};
    }
  };
  const accept = (listener: Listener, socket: Socket) => {
    socket.on('error', () => socket.destroy());
    if (!active(listener) || clientsCount() >= policy.maxTcpConnections) {
      counters.tcpRejected++;
      socket.destroy();
      return;
    }
    counters.tcpAccepted++;
    listener.clients.add(socket);
    socket.once('close', () => {
      listener.clients.delete(socket);
      listener.forwardingClients.delete(socket);
    });
    socket.setNoDelay(true);
    socket.setTimeout(policy.tcpIdleTimeoutMs, () => socket.destroy());
    if (
      listener.backendReady &&
      listener.route.mode === 'online' &&
      !quiescence.has(listener.route.serverId)
    ) {
      listener.forwardingClients.add(socket);
      const backend = connect({
        host: listener.route.backend.address,
        port: listener.route.backend.port,
        allowHalfOpen: true,
      });
      backend.setNoDelay(true);
      const timer = setTimeout(() => {
        socket.destroy();
        backend.destroy();
      }, policy.tcpConnectTimeoutMs);
      timer.unref();
      backend.once('connect', () => clearTimeout(timer));
      backend.on('error', () => socket.destroy());
      backend.once('close', (failed) => {
        clearTimeout(timer);
        if (failed || !backend.readableEnded) socket.destroy();
      });
      socket.once('close', () => {
        clearTimeout(timer);
        backend.destroy();
      });
      socket.on('data', (bytes: Buffer) => {
        counters.tcpBytesToBackend += bytes.length;
      });
      backend.on('data', (bytes: Buffer) => {
        counters.tcpBytesToClient += bytes.length;
      });
      socket.pipe(backend).pipe(socket);
      return;
    }
    const handler = protocol(listener.route);
    if (handler?.createSession) {
      const sessionRoute = listener.route;
      const controller = new AbortController();
      let session: ReturnType<NonNullable<GatewayProtocolAdapter['createSession']>>;
      try {
        session = handler.createSession({
          route: sessionRoute,
          signal: controller.signal,
          onSessionDiagnostic: (event) => {
            try {
              options.logger?.log('debug', 'gateway.protocol_response', {
                routeId: sessionRoute.id,
                ...event,
              });
            } catch {
              /* Diagnostic sink only. */
            }
          },
        });
      } catch {
        controller.abort();
        socket.destroy();
        return;
      }
      let buffered = Buffer.alloc(0);
      let inputBytes = 0;
      let outputBytes = 0;
      let draining = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let lastInputAt = 0;
      const idleMs = session.classificationIdleMs;
      if (
        idleMs !== undefined &&
        (!Number.isSafeInteger(idleMs) || idleMs <= 0 || idleMs > 2_147_483_647)
      ) {
        controller.abort();
        socket.destroy();
        return;
      }
      const timer = setTimeout(() => socket.destroy(), policy.classificationTimeoutMs);
      timer.unref();
      socket.once('close', () => {
        clearTimeout(timer);
        clearTimeout(idleTimer);
        controller.abort();
      });
      const valid = () =>
        !socket.destroyed &&
        !controller.signal.aborted &&
        active(listener) &&
        listener.route.revision === sessionRoute.revision;
      const rejectSession = () => {
        socket.destroy();
        return false;
      };
      const consume = async (finalize = false): Promise<boolean> => {
        while (buffered.length && valid()) {
          const intent =
            finalize && session.finalize ? session.finalize(buffered) : session.classify(buffered);
          finalize = false;
          if (
            !Number.isSafeInteger(intent.consumedBytes) ||
            intent.consumedBytes < 0 ||
            intent.consumedBytes > buffered.length ||
            (intent.kind === 'need-more' ? intent.consumedBytes !== 0 : intent.consumedBytes === 0)
          )
            return rejectSession();
          if (intent.kind === 'need-more') return true;
          buffered = buffered.subarray(intent.consumedBytes);
          if (intent.kind === 'unsupported') return rejectSession();
          if (intent.kind === 'continue') continue;
          const state =
            intent.kind === 'join' &&
            (sessionRoute.mode === 'sleeping' || sessionRoute.mode === 'blocked')
              ? await wake(sessionRoute)
              : sessionRoute.mode;
          if (!valid()) return rejectSession();
          const result = session.response(responseMode(listener, state));
          outputBytes += result.bytes?.byteLength ?? 0;
          if (outputBytes > policy.maxProtocolResponseBytes) return rejectSession();
          if (result.close) {
            // Flush the reply and drain trailing login bytes until FIN or the
            // absolute deadline. A paused read side can otherwise lose the
            // disconnect reply when the deadline destroys the socket.
            draining = true;
            buffered = Buffer.alloc(0);
            if (result.bytes) socket.end(result.bytes);
            else socket.end();
            return false;
          }
          if (result.bytes?.byteLength)
            await new Promise<void>((resolve, reject) =>
              socket.write(result.bytes as Uint8Array, (error) =>
                error ? reject(error) : resolve(),
              ),
            );
        }
        if (!valid()) socket.destroy();
        return false;
      };
      const run = (finalize = false) => {
        socket.pause();
        void consume(finalize)
          .then((pending) => {
            // Only arriving bytes rearm the idle boundary. An incomplete full
            // packet stays pending until more bytes or the absolute deadline.
            if (pending && !finalize && idleMs !== undefined && session.finalize && valid()) {
              idleTimer = setTimeout(
                () => {
                  idleTimer = undefined;
                  if (valid() && !draining) run(true);
                },
                Math.max(1, idleMs - (performance.now() - lastInputAt)),
              );
              idleTimer.unref();
            }
            if (!socket.destroyed) socket.resume();
          })
          .catch(() => socket.destroy());
      };
      socket.on('data', (chunk: Buffer) => {
        clearTimeout(idleTimer);
        idleTimer = undefined;
        lastInputAt = performance.now();
        inputBytes += chunk.length;
        if (inputBytes > policy.maxClassificationBytes) return void socket.destroy();
        if (draining) return;
        buffered = Buffer.concat([buffered, chunk]);
        run();
      });
      return;
    }
    let bytes = Buffer.alloc(0);
    let processing = false;
    const timer = setTimeout(() => socket.destroy(), policy.classificationTimeoutMs);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
    socket.on('data', (chunk: Buffer) => {
      if (processing) return;
      if (bytes.length + chunk.length > policy.maxClassificationBytes) return void socket.destroy();
      bytes = Buffer.concat([bytes, chunk]);
      processing = true;
      socket.pause();
      void processIntent(listener, bytes).then((result) => {
        if (result.pending) {
          processing = false;
          socket.resume();
          return;
        }
        if (result.bytes) socket.end(result.bytes);
        else socket.destroy();
      });
    });
  };
  const sendUdpResponse = (
    listener: Listener,
    bytes: Uint8Array,
    remote: Pick<RemoteInfo, 'address' | 'port'>,
  ) => {
    const socket = listener.udp;
    if (!socket || !active(listener)) return;
    try {
      const queuedBytes = [...listeners.values()].reduce(
        (count, current) => count + (current.udp?.getSendQueueSize() ?? 0),
        0,
      );
      if (
        Math.max(queuedBytes, pendingUdpResponseBytes) + bytes.byteLength >
        policy.maxUdpQueuedBytes
      ) {
        counters.udpDropped++;
        return;
      }
      pendingUdpResponseBytes += bytes.byteLength;
      try {
        socket.send(bytes, remote.port, remote.address, (error) => {
          pendingUdpResponseBytes -= bytes.byteLength;
          if (error) counters.udpDropped++;
        });
        counters.udpBytesToClient += bytes.byteLength;
      } catch (error) {
        pendingUdpResponseBytes -= bytes.byteLength;
        throw error;
      }
    } catch {
      counters.udpDropped++;
    }
  };
  const receive = (listener: Listener, message: Buffer, remote: RemoteInfo) => {
    counters.udpReceived++;
    if (!active(listener)) {
      counters.udpDropped++;
      return;
    }
    if (
      !listener.backendReady ||
      listener.route.mode !== 'online' ||
      quiescence.has(listener.route.serverId)
    ) {
      if (
        message.length > policy.maxClassificationBytes ||
        pendingUdpIntents + sessionsCount() >= policy.maxUdpSessions
      ) {
        counters.udpDropped++;
        return;
      }
      pendingUdpIntents++;
      void processIntent(listener, message)
        .then((result) => {
          if (result.bytes && active(listener)) sendUdpResponse(listener, result.bytes, remote);
        })
        .finally(() => {
          pendingUdpIntents--;
        });
      return;
    }
    const key = `${remote.family}:${remote.address}:${remote.port}`;
    let session = listener.sessions.get(key);
    if (!session) {
      if (sessionsCount() + pendingUdpIntents >= policy.maxUdpSessions) {
        counters.udpDropped++;
        return;
      }
      const socket = createSocket(isIP(listener.route.backend.address) === 6 ? 'udp6' : 'udp4');
      session = { socket, lastActivity: now(), connecting: true, queued: [], queuedBytes: 0 };
      listener.sessions.set(key, session);
      const current = session;
      socket.on('error', () => dropSession(listener, key));
      socket.on('message', (bytes: Buffer) => {
        if (!active(listener) || listener.sessions.get(key) !== current) return;
        current.lastActivity = now();
        sendUdpResponse(listener, bytes, remote);
      });
      socket.connect(listener.route.backend.port, listener.route.backend.address, () => {
        if (listener.sessions.get(key) !== current) return;
        current.connecting = false;
        for (const queued of current.queued) socket.send(queued, () => {});
        current.queued = [];
        current.queuedBytes = 0;
      });
    }
    session.lastActivity = now();
    if (
      session.queuedBytes + session.socket.getSendQueueSize() + message.length >
      policy.maxUdpQueuedBytes
    ) {
      counters.udpDropped++;
      return;
    }
    counters.udpBytesToBackend += message.length;
    if (session.connecting) {
      session.queued.push(message);
      session.queuedBytes += message.length;
    } else session.socket.send(message, () => {});
  };
  const bind = async (route: GatewayRoute, backendReady: boolean): Promise<Listener> => {
    const listener: Listener = {
      route,
      backendReady,
      clients: new Set(),
      forwardingClients: new Set(),
      sessions: new Map(),
    };
    try {
      if (route.public.transport === 'tcp') {
        listener.tcp = createServer({ allowHalfOpen: true }, (socket) => accept(listener, socket));
        await new Promise<void>((resolve, reject) => {
          listener.tcp?.once('error', reject);
          listener.tcp?.listen(
            {
              host: route.public.address,
              port: route.public.port,
              exclusive: true,
              ipv6Only: true,
            },
            () => {
              listener.tcp?.off('error', reject);
              resolve();
            },
          );
        });
        listener.tcp.on('error', () => {
          logRouteTransition(listener, 'socket_error', false);
          void closeListener(listener);
          listeners.delete(route.id);
        });
      } else {
        listener.udp = createSocket({
          type: isIP(route.public.address) === 6 ? 'udp6' : 'udp4',
          reuseAddr: false,
          ipv6Only: isIP(route.public.address) === 6,
        });
        listener.udp.on('message', (message, remote) => receive(listener, message, remote));
        await new Promise<void>((resolve, reject) => {
          listener.udp?.once('error', reject);
          listener.udp?.bind(
            { address: route.public.address, port: route.public.port, exclusive: true },
            () => {
              listener.udp?.off('error', reject);
              resolve();
            },
          );
        });
        listener.udp.on('error', () => {
          logRouteTransition(listener, 'socket_error', false);
          void closeListener(listener);
          listeners.delete(route.id);
        });
      }
      return listener;
    } catch (error) {
      await closeListener(listener);
      throw error;
    }
  };
  const expire = async () => {
    if (snapshot && Date.parse(snapshot.expiresAt) > now()) return;
    const expired = [...listeners.values()];
    for (const listener of expired) logRouteTransition(listener, 'lease_expired', false);
    listeners.clear();
    wakeRequests.clear();
    for (const watch of sleepWatches.values()) watch.abort.abort();
    sleepWatches.clear();
    if (expired.length) counters.leaseExpirations++;
    await Promise.all(expired.map((listener) => closeListener(listener)));
  };
  const apply = async (input: unknown, fetchStartedAt: number) => {
    const applyStarted = performance.now();
    const parsed = gatewaySnapshotSchema.safeParse(input);
    if (!parsed.success || stopping) throw new DomainError('validation_failed');
    const next = parsed.data;
    const latest = candidateSnapshot ?? snapshot;
    const issued = Date.parse(next.issuedAt);
    const expires = Date.parse(next.expiresAt);
    if (
      next.gatewayId !== options.gatewayId ||
      fetchStartedAt > now() ||
      issued > now() + policy.maxClockSkewMs ||
      expires <= now() ||
      expires - issued > policy.maximumLeaseMs ||
      (latest && (next.revision < latest.revision || issued < Date.parse(latest.issuedAt))) ||
      (latest &&
        next.revision === latest.revision &&
        !isDeepStrictEqual(next.routes, latest.routes))
    )
      throw new DomainError('conflict');
    const owned = [...listeners.values()].map((listener) => listener.route.public);
    for (const route of next.routes) {
      const previous = latest?.routes.find((candidate) => candidate.id === route.id);
      if (
        route.revision > next.revision ||
        (previous &&
          (route.revision < previous.revision ||
            (route.revision === previous.revision && !isDeepStrictEqual(route, previous))))
      )
        throw new DomainError('conflict');
    }
    const previousCandidate = candidateSnapshot;
    candidateSnapshot = next;
    const readiness = new Map<string, boolean>();
    // Missing active binding/proof belongs to one server, not to independent
    // allocations in the same authenticated snapshot. Withhold every role of
    // that server together; all other safety failures keep their global path.
    const withheldServers = new Set<string>();
    const withholdServer = async (serverId: string, staged: Listener[] = []) => {
      withheldServers.add(serverId);
      const rejected = [...listeners.values()].filter(
        (listener) => listener.route.serverId === serverId,
      );
      for (let index = staged.length - 1; index >= 0; index--) {
        const listener = staged[index];
        if (listener?.route.serverId === serverId) {
          rejected.push(listener);
          staged.splice(index, 1);
        }
      }
      for (const listener of rejected) {
        logRouteTransition(listener, 'safety_rejected', false);
        listeners.delete(listener.route.id);
      }
      await Promise.all(rejected.map((listener) => closeListener(listener)));
    };
    for (const route of next.routes) {
      if (stopping) throw new DomainError('integration_unavailable');
      if (withheldServers.has(route.serverId)) continue;
      try {
        await bounded(async () => {
          // Listener validation can establish its initial proof from the same
          // fresh inspection; a separate backend inspection duplicates inventory.
          const verdict = await options.safety.validate(route, owned);
          readiness.set(route.id, verdict?.backendReady ?? true);
          // A known failed backend must stop receiving traffic immediately,
          // even if validation of another route keeps this snapshot pending.
          const current = listeners.get(route.id);
          if (verdict?.backendReady === false && current?.backendReady) {
            current.backendReady = false;
            clearSessions(current);
            logRouteTransition(current, 'backend_not_ready');
          }
        });
      } catch (error) {
        // Core may advance a route while fresh inventory/protocol evidence is
        // collected. This candidate never becomes authoritative; the already
        // committed route keeps only its original lease during a bounded retry.
        if (error instanceof GatewayProviderRateLimitedError) {
          candidateSnapshot = snapshot;
          deferProvider(error);
          throw error;
        }
        if (error instanceof GatewayRouteRevisionStaleError) {
          candidateSnapshot = previousCandidate;
          throw error;
        }
        logTiming('gateway.safety_failure', {
          ...routeIdentity(route),
          reason:
            error instanceof GatewaySafetyError
              ? error.reason
              : error instanceof NetworkObservationError
                ? `observer_${error.reason}`
                : error instanceof DomainError &&
                    error.details?.gatewaySafetyReason === 'validation_timeout'
                  ? 'validation_timeout'
                  : 'validation_failed',
          routeMode: route.mode,
        });
        if (error instanceof GatewaySafetyError && error.reason === 'backend_active_binding') {
          await withholdServer(route.serverId);
          continue;
        }
        if (error instanceof NetworkObservationError && error.reason === 'container_churn') {
          // A changing Docker inventory is not fresh topology authority. Retain
          // only exact, already committed listeners as local protocol responders;
          // never renew their original lease or permit forwarding/wake effects.
          candidateSnapshot = snapshot;
          for (const current of [...listeners.values()]) {
            const candidate = next.routes.find((value) => value.id === current.route.id);
            current.backendReady = false;
            current.statusOnly = true;
            for (const client of current.forwardingClients) client.destroy();
            for (const key of current.sessions.keys()) dropSession(current, key);
            // Container recreation may change generation/revision before Docker
            // inventory settles. An authenticated waking intent for the exact
            // same endpoint can change only the local response text. It grants
            // no new route, forwarding, wake authority or lease extension.
            const sameWakingTarget =
              candidate?.mode === 'waking' &&
              candidate.id === current.route.id &&
              candidate.serverId === current.route.serverId &&
              candidate.nodeId === current.route.nodeId &&
              candidate.allocationId === current.route.allocationId &&
              candidate.locale === current.route.locale &&
              isDeepStrictEqual(candidate.public, current.route.public) &&
              isDeepStrictEqual(candidate.backend, current.route.backend) &&
              isDeepStrictEqual(candidate.protocol, current.route.protocol);
            if (leased() && (isDeepStrictEqual(candidate, current.route) || sameWakingTarget)) {
              if (sameWakingTarget) current.statusMode = 'waking';
              logRouteTransition(current, 'observer_container_churn');
            } else {
              logRouteTransition(current, 'safety_rejected', false);
              listeners.delete(current.route.id);
              await closeListener(current);
            }
          }
          throw error;
        }
        const unsafe = listeners.get(route.id);
        if (unsafe) {
          logRouteTransition(unsafe, 'safety_rejected', false);
          listeners.delete(route.id);
          await closeListener(unsafe);
        }
        throw error;
      }
    }
    if (stopping || expires <= now()) throw new DomainError('conflict');
    const staged: Listener[] = [];
    try {
      for (const listener of [...listeners.values()]) {
        const route = next.routes.find((candidate) => candidate.id === listener.route.id);
        if (
          !route ||
          withheldServers.has(route.serverId) ||
          !isDeepStrictEqual(route.public, listener.route.public)
        ) {
          logRouteTransition(listener, 'route_withdrawn', false);
          listeners.delete(listener.route.id);
          await closeListener(listener);
        }
      }
      for (const route of next.routes) {
        if (withheldServers.has(route.serverId)) continue;
        if (listeners.has(route.id)) continue;
        // Earlier routes may have spent the entire topology TTL waiting for
        // another role. Refresh evidence directly before each native bind;
        // staged listeners are already ours even before the snapshot commits.
        try {
          await bounded(async () => {
            const verdict = await options.safety.validate(route, [
              ...[...listeners.values()].map((listener) => listener.route.public),
              ...staged.map((listener) => listener.route.public),
            ]);
            readiness.set(route.id, verdict?.backendReady ?? true);
          });
        } catch (error) {
          if (!(error instanceof GatewaySafetyError) || error.reason !== 'backend_active_binding')
            throw error;
          logTiming('gateway.safety_failure', {
            ...routeIdentity(route),
            reason: error.reason,
            routeMode: route.mode,
          });
          await withholdServer(route.serverId, staged);
          continue;
        }
        if (stopping || expires <= now()) throw new DomainError('conflict');
        const listener = await bind(route, readiness.get(route.id) ?? false);
        staged.push(listener);
      }
      if (stopping || expires <= now()) throw new DomainError('conflict');
      for (const listener of staged) listeners.set(listener.route.id, listener);
      for (const route of next.routes) {
        if (withheldServers.has(route.serverId)) continue;
        const listener = listeners.get(route.id);
        if (!listener) throw new DomainError('internal_error');
        if (
          !isDeepStrictEqual(listener.route.backend, route.backend) ||
          listener.route.generation !== route.generation ||
          (listener.route.mode === 'online' && route.mode !== 'online') ||
          (listener.backendReady && !readiness.get(route.id))
        )
          clearSessions(listener);
        listener.route = route;
        listener.backendReady = readiness.get(route.id) ?? false;
        listener.statusOnly = false;
        listener.statusMode = undefined;
      }
      snapshot = next;
      syncStartupWatches();
      syncIdleDeadline();
      for (const [serverId, fence] of quiescence) {
        const { deadline } = fence;
        const currentRoutes = next.routes.filter((route) => route.serverId === serverId);
        const completion = currentRoutes[0]?.completedSleep;
        // Only Core's durable terminal acknowledgement of this exact fenced
        // operation may release early. A sleeping label or route withdrawal alone
        // cannot cancel a report still capable of authorizing a stop.
        const confirmed =
          completion !== undefined &&
          completion.generation === fence.generation &&
          Date.parse(completion.quiescenceUntil) === deadline &&
          Date.parse(completion.completedAt) >= fence.observedAt &&
          Date.parse(completion.completedAt) <= issued &&
          fetchStartedAt >= Date.parse(completion.completedAt) + policy.maxClockSkewMs &&
          currentRoutes.length === fence.routes.length &&
          currentRoutes.every((route) => {
            const previous = fence.routes.find((old) => old.id === route.id);
            return (
              previous !== undefined &&
              route.mode === 'sleeping' &&
              route.wakeJobId === undefined &&
              route.generation === fence.generation &&
              route.revision > previous.revision &&
              route.nodeId === previous.nodeId &&
              route.allocationId === previous.allocationId &&
              isDeepStrictEqual(route.public, previous.public) &&
              isDeepStrictEqual(route.backend, previous.backend) &&
              isDeepStrictEqual(route.protocol, previous.protocol) &&
              isDeepStrictEqual(route.completedSleep, completion)
            );
          });
        // Route withdrawal does not cancel an in-flight idle report. Retain
        // the fence without exact terminal evidence until a post-deadline fetch.
        if (
          confirmed ||
          (fetchStartedAt >= deadline + policy.maxClockSkewMs && issued >= deadline)
        ) {
          quiescence.delete(serverId);
          logTiming('gateway.quiescence_released', {
            serverId,
            reason: confirmed ? 'confirmed_sleep' : 'deadline_reconciled',
            deadline: new Date(deadline).toISOString(),
            fetchStartedAt: new Date(fetchStartedAt).toISOString(),
            issuedAt: next.issuedAt,
            afterDeadlineMs: Math.max(0, now() - deadline),
            maxClockSkewMs: policy.maxClockSkewMs,
          });
        }
      }
      syncSleepWatches();
      controlAvailable = true;
      for (const listener of listeners.values())
        logRouteTransition(
          listener,
          'snapshot_applied',
          active(listener),
          Math.round(performance.now() - applyStarted),
        );
      if (leaseTimer) clearTimeout(leaseTimer);
      leaseTimer = setTimeout(
        () => {
          syncStartupWatches();
          void expire();
        },
        Math.max(1, expires - now()),
      );
      leaseTimer.unref();
      for (const serverId of wakeRequests.keys())
        if (
          !next.routes.some(
            (route) =>
              route.serverId === serverId &&
              (route.mode === 'sleeping' || route.mode === 'blocked'),
          )
        )
          wakeRequests.delete(serverId);
    } catch (error) {
      if (error instanceof GatewayProviderRateLimitedError) {
        candidateSnapshot = snapshot;
        deferProvider(error);
      }
      if (error instanceof GatewayRouteRevisionStaleError) candidateSnapshot = previousCandidate;
      await Promise.all(staged.map((listener) => closeListener(listener)));
      throw error;
    }
  };
  const applySnapshot = (input: unknown, fetchStartedAt = now()) => {
    const result = serial.then(() => apply(input, fetchStartedAt));
    serial = result.catch(() => {});
    return result;
  };
  const refresh = () => {
    if (providerRetryAt > now())
      return Promise.reject(new GatewayProviderRateLimitedError(providerRetryAt - now()));
    if (refreshing) return refreshing;
    const refreshStarted = performance.now();
    refreshing = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const fetchStartedAt = now();
        try {
          const input = await options.control.fetchSnapshot();
          await applySnapshot(input, fetchStartedAt);
          return;
        } catch (error) {
          const transient =
            error instanceof GatewayRouteRevisionStaleError ||
            (error instanceof NetworkObservationError && error.reason === 'container_churn');
          if (!transient || attempt === 1) throw error;
        }
      }
    })()
      .catch((error: unknown) => {
        controlAvailable = false;
        if (error instanceof GatewayProviderRateLimitedError) deferProvider(error);
        counters.snapshotErrors++;
        options.logger?.log('warn', 'gateway.snapshot_unavailable', {
          reason:
            error instanceof GatewayProviderRateLimitedError
              ? 'provider_rate_limited'
              : 'control_unavailable',
        });
        throw error;
      })
      .finally(() => {
        counters.lastSnapshotDurationMs = Math.round(performance.now() - refreshStarted);
        refreshing = undefined;
      });
    return refreshing;
  };
  const syncStartupWatches = () => {
    const watch = options.control.watchStartup;
    const eligible = new Map<string, GatewayRoute>();
    if (watch && !stopping && snapshot && Date.parse(snapshot.expiresAt) > now()) {
      for (const route of snapshot.routes)
        if (
          route.mode === 'waking' &&
          route.wakeJobId &&
          protocol(route)?.startupHint === 'provider_running'
        )
          eligible.set(route.serverId, route);
    }
    for (const [serverId, existing] of startupWatches) {
      const route = eligible.get(serverId);
      if (!route || existing.key !== `${route.generation}:${route.wakeJobId}`) {
        existing.abort.abort();
        startupWatches.delete(serverId);
        observationEpochs.delete(serverId);
      }
    }
    if (!watch) return;
    for (const [serverId, route] of eligible) {
      if (!route.wakeJobId) continue;
      const previous = startupWatches.get(serverId);
      if (previous && (!previous.done || previous.retryAt > now())) continue;
      const state = {
        key: `${route.generation}:${route.wakeJobId}`,
        abort: new AbortController(),
        retryAt: 0,
        done: false,
      };
      startupWatches.set(serverId, state);
      void watch(
        {
          routeId: route.id,
          routeRevision: route.revision,
          generation: route.generation,
          wakeJobId: route.wakeJobId,
        },
        async (receipt) => {
          const current = () =>
            !stopping &&
            !state.abort.signal.aborted &&
            snapshot &&
            Date.parse(snapshot.expiresAt) > now() &&
            snapshot.routes.some(
              (value) =>
                value.serverId === serverId &&
                value.mode === 'waking' &&
                value.generation === route.generation &&
                value.wakeJobId === route.wakeJobId,
            );
          if (!current()) return;
          logTiming('gateway.startup_hint', routeIdentity(route));
          if (receipt && protocol(route)?.readinessSource === 'provider_running' && snapshot) {
            const captured = snapshot;
            observationEpochs.set(serverId, {});
            if (
              await applyReadinessReceipt(receipt.snapshot, captured, serverId, receipt.observedAt)
            )
              return;
            // Lost/racing receipt uses the already committed durable snapshot.
            if (current()) await refresh().catch(() => {});
            return;
          }
          // Supersede only this server: an old negative probe must neither delay
          // the running event nor report after its fresh observation.
          if (current()) await observe(serverId);
        },
        state.abort.signal,
      )
        .catch(() => {
          // Polling remains the authority and recovery path if events are lost.
        })
        .finally(() => {
          state.done = true;
          state.retryAt = now() + 10000;
        });
    }
  };
  const applySleepReceipt = (
    input: unknown,
    serverId: string,
    captured: NonNullable<ReturnType<typeof quiescence.get>>,
  ) => {
    const work = serial.then(() => {
      if (
        stopping ||
        !snapshot ||
        !candidateSnapshot ||
        candidateSnapshot.revision !== snapshot.revision ||
        !isDeepStrictEqual(candidateSnapshot.routes, snapshot.routes) ||
        quiescence.get(serverId) !== captured ||
        [...listeners.values()].some((listener) => listener.statusOnly)
      )
        return false;
      const next = sleepReceipt(snapshot, input, serverId, captured, now(), policy.maxClockSkewMs);
      if (!next || next.routes.some((route) => !listeners.has(route.id))) return false;
      snapshot = next;
      candidateSnapshot = next;
      quiescence.delete(serverId);
      for (const route of next.routes) {
        const listener = listeners.get(route.id);
        if (!listener) throw new DomainError('internal_error');
        listener.route = route;
        if (route.serverId === serverId) {
          clearSessions(listener);
          listener.backendReady = false;
          logRouteTransition(listener, 'sleep_completion_receipt');
        }
      }
      logTiming('gateway.quiescence_released', {
        serverId,
        reason: 'sleep_completion_receipt',
        deadline: new Date(captured.deadline).toISOString(),
      });
      syncStartupWatches();
      syncIdleDeadline();
      syncSleepWatches();
      if (leaseTimer) clearTimeout(leaseTimer);
      leaseTimer = setTimeout(
        () => {
          void expire();
        },
        Math.max(1, Date.parse(next.expiresAt) - now()),
      );
      leaseTimer.unref();
      return true;
    });
    serial = work.then(
      () => {},
      () => {},
    );
    return work;
  };
  const syncSleepWatches = () => {
    for (const [serverId, watch] of sleepWatches) {
      const fence = quiescence.get(serverId);
      if (stopping || !fence || fence.deadline !== watch.deadline || fence.deadline <= now()) {
        watch.abort.abort();
        sleepWatches.delete(serverId);
      }
    }
    const wait = options.control.waitForSleep;
    if (!wait || stopping || !leased()) return;
    for (const [serverId, fence] of quiescence) {
      const route = fence.routes[0];
      if (!route || sleepWatches.has(serverId) || fence.deadline <= now()) continue;
      const state = { abort: new AbortController(), deadline: fence.deadline };
      sleepWatches.set(serverId, state);
      // One attempt per fence: missed notifications/timeouts retain ordinary polling.
      // This callback never creates authority; only the exact durable receipt can.
      void wait(
        {
          routeId: route.id,
          generation: fence.generation,
          quiescenceUntil: new Date(fence.deadline).toISOString(),
        },
        state.abort.signal,
      )
        .then(async (receipt) => {
          if (!receipt || state.abort.signal.aborted || quiescence.get(serverId) !== fence) return;
          const applied = await applySleepReceipt(receipt, serverId, fence);
          if (!applied && !stopping && !state.abort.signal.aborted) {
            await refreshing?.catch(() => {});
            if (!stopping && !state.abort.signal.aborted) await refresh().catch(() => {});
          }
        })
        .catch(() => {
          /* Durable polling remains recovery, without blind retry loops. */
        });
    }
  };
  const applyReadinessReceipt = (
    input: unknown,
    captured: GatewaySnapshot,
    serverId: string,
    observedAt: string,
  ) => {
    const queuedAt = performance.now();
    const work = serial.then(() => {
      const queueMs = Math.round(performance.now() - queuedAt);
      if (
        stopping ||
        !snapshot ||
        quiescence.has(serverId) ||
        [...listeners.values()].some((listener) => listener.statusOnly) ||
        now() - Date.parse(observedAt) > policy.probeTimeoutMs ||
        !candidateSnapshot ||
        !isDeepStrictEqual(candidateSnapshot.routes, captured.routes)
      )
        return false;
      const next = readinessReceipt(
        snapshot,
        captured,
        input,
        serverId,
        now(),
        policy.maxClockSkewMs,
      );
      if (!next || next.routes.some((route) => !listeners.has(route.id))) return false;
      snapshot = next;
      candidateSnapshot = next;
      for (const route of next.routes) {
        const listener = listeners.get(route.id);
        if (!listener) throw new DomainError('internal_error');
        listener.route = route;
        if (route.serverId === serverId) {
          listener.backendReady = true;
          logRouteTransition(listener, 'readiness_receipt');
          logTiming('gateway.readiness_receipt_applied', { ...routeIdentity(route), queueMs });
        }
      }
      syncStartupWatches();
      syncIdleDeadline();
      // A receipt may shorten the expiry after an equivalent renewal raced it.
      // Close existing streams at that original deadline, not a later sweep.
      if (leaseTimer) clearTimeout(leaseTimer);
      leaseTimer = setTimeout(
        () => {
          void expire();
        },
        Math.max(1, Date.parse(next.expiresAt) - now()),
      );
      leaseTimer.unref();
      return true;
    });
    serial = work.then(
      () => {},
      () => {},
    );
    return work;
  };
  // One fresh sample at the authoritative idle deadline avoids waiting for the
  // next periodic observation. This is a scheduling hint only: observe() still
  // proves every role, current lease, zero players/sessions and the stop fence.
  const idleDeadlines = () => {
    const eligible = new Map<string, { key: string; at: number }>();
    if (stopping || !leased() || !snapshot) return eligible;
    const invalid = new Set<string>();
    for (const route of snapshot.routes) {
      const previous = eligible.get(route.serverId);
      const key = `${route.generation}:${route.sleepEligibleAt}`;
      if (
        route.mode !== 'online' ||
        !route.sleepEligibleAt ||
        quiescence.has(route.serverId) ||
        invalid.has(route.serverId) ||
        (previous && previous.key !== key)
      ) {
        eligible.delete(route.serverId);
        invalid.add(route.serverId);
        continue;
      }
      eligible.set(route.serverId, { key, at: Date.parse(route.sleepEligibleAt) });
    }
    return eligible;
  };
  const syncIdleDeadline = () => {
    if (idleDeadlineTimer) clearTimeout(idleDeadlineTimer);
    idleDeadlineTimer = undefined;
    const eligible = idleDeadlines();
    for (const serverId of sampledIdleDeadlines.keys())
      if (!eligible.has(serverId)) sampledIdleDeadlines.delete(serverId);
    const next = [...eligible]
      .filter(([serverId, deadline]) => sampledIdleDeadlines.get(serverId) !== deadline.key)
      .sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) return;
    const [serverId, deadline] = next;
    idleDeadlineTimer = setTimeout(
      () => {
        idleDeadlineTimer = undefined;
        const current = () => idleDeadlines().get(serverId)?.key === deadline.key;
        if (
          !current() ||
          now() < deadline.at ||
          sampledIdleDeadlines.get(serverId) === deadline.key
        ) {
          syncIdleDeadline();
          return;
        }
        // Consume before waiting: equivalent snapshots and already elapsed
        // deadlines must not create a tight loop (including during a 429 cooldown).
        for (const [id, due] of idleDeadlines())
          if (due.at <= now()) sampledIdleDeadlines.set(id, due.key);
        void (async () => {
          // A probe begun before the deadline cannot prove the complete interval.
          await observing?.catch(() => {});
          if (current()) await observe();
        })()
          .catch(() => {})
          .finally(syncIdleDeadline);
      },
      Math.min(2147483647, Math.max(1, deadline.at - now())),
    );
    idleDeadlineTimer.unref();
  };
  const observe = (priorityServerId?: string): Promise<void> => {
    if (providerRetryAt > now()) return Promise.resolve();
    if (priorityServerId) {
      const pending = startupObservations.get(priorityServerId);
      if (pending) return pending;
      observationEpochs.set(priorityServerId, {});
    } else if (observing) return observing;
    const cycleStarted = performance.now();
    let probeDuration = 0;
    let reportDuration = 0;
    const work = (async () => {
      const candidates = candidateSnapshot;
      if (!candidates || Date.parse(candidates.expiresAt) <= now() || stopping) return;
      const servers = new Map<string, GatewayRoute[]>();
      const epochs = new Map(observationEpochs);
      for (const route of candidates.routes) {
        if (priorityServerId && route.serverId !== priorityServerId) continue;
        if (!priorityServerId && startupObservations.has(route.serverId)) continue;
        const routes = servers.get(route.serverId) ?? [];
        routes.push(route);
        servers.set(route.serverId, routes);
      }
      let refreshAfterReadiness = false;
      const orderingTime = now();
      const dueAt = (routes: GatewayRoute[]) => {
        const anchor = routes[0];
        const deadline = anchor?.sleepEligibleAt ? Date.parse(anchor.sleepEligibleAt) : Infinity;
        return anchor?.mode === 'online' && deadline <= orderingTime ? deadline : Infinity;
      };
      // Expiring idle windows must not queue behind unrelated slow probes.
      // Non-due servers keep their stable snapshot order; effects stay serialized.
      const orderedServers = [...servers.values()].sort((a, b) => dueAt(a) - dueAt(b));
      for (const routes of orderedServers) {
        routes.sort((a, b) => a.id.localeCompare(b.id));
        const anchor = routes[0];
        if (!anchor || stopping || routes.some((route) => listeners.get(route.id)?.statusOnly))
          continue;
        if (
          routes.some(
            (route) =>
              route.generation !== anchor.generation ||
              route.wakeJobId !== anchor.wakeJobId ||
              route.mode !== anchor.mode,
          )
        ) {
          counters.observationErrors++;
          options.logger?.log('warn', 'gateway.observation_unavailable', {
            serverId: anchor.serverId,
          });
          continue;
        }
        if (
          anchor.mode === 'waking' &&
          protocol(anchor)?.readinessSource === 'provider_running' &&
          startupWatches.get(anchor.serverId) &&
          !startupWatches.get(anchor.serverId)?.done &&
          !priorityServerId
        )
          continue;
        let ready = true;
        let idle = true;
        const observedAt = new Date(now()).toISOString();
        if (anchor.sleepEligibleAt && Date.parse(anchor.sleepEligibleAt) <= Date.parse(observedAt))
          sampledIdleDeadlines.set(
            anchor.serverId,
            `${anchor.generation}:${anchor.sleepEligibleAt}`,
          );
        const players: (number | undefined)[] = [];
        for (const route of routes) {
          if (providerRetryAt > now()) return;
          const handler = protocol(route);
          if (!handler || stopping) {
            ready = false;
            idle = false;
            players.push(undefined);
            continue;
          }
          const providerOnline =
            route.mode === 'online' &&
            handler.readinessSource === 'provider_running' &&
            leased() &&
            listeners.get(route.id)?.backendReady === true &&
            isDeepStrictEqual(listeners.get(route.id)?.route, route);
          let readinessConfirmed = !!providerOnline;
          let probeStage = 'safety';
          const probeStarted = performance.now();
          try {
            const validated: GatewayProtocolObservation & { coherent: boolean } = await bounded(
              async (signal) => {
                if (providerOnline) {
                  probeStage = 'idle';
                  const sample = handler.observe
                    ? await handler.observe({ route, signal })
                    : { ...(await handler.probeReadiness({ route, signal })), idle: false };
                  return {
                    ready: true,
                    coherent: true,
                    idle: sample.ready && sample.idle === true,
                    playerCount: sample.ready ? sample.playerCount : undefined,
                  };
                }
                const listener = listeners.get(route.id);
                const leasedProbe =
                  (route.mode === 'waking' || route.mode === 'online') &&
                  leased() &&
                  listener &&
                  isDeepStrictEqual(listener.route, route) &&
                  options.safety.probeLeasedBackend;
                probeStage = leasedProbe ? 'leased_backend' : 'full_backend';
                const sample = leasedProbe
                  ? await leasedProbe.call(options.safety, route)
                  : await options.safety.validateBackend(route);
                if (sample) return { ...sample, coherent: true };
                probeStage = 'protocol';
                if (handler.observe)
                  return { ...(await handler.observe({ route, signal })), coherent: true };
                return { ...(await handler.probeReadiness({ route, signal })), coherent: false };
              },
            );
            readinessConfirmed = validated.ready === true;
            ready = ready && readinessConfirmed;
            const probeIdle = handler.probeIdle;
            if (!readinessConfirmed || (!validated.coherent && !probeIdle)) {
              idle = false;
              players.push(undefined);
              continue;
            }
            probeStage = 'idle';
            const observation = validated.coherent
              ? validated
              : probeIdle
                ? await bounded((signal) => probeIdle({ route, signal }))
                : { idle: false, playerCount: undefined };
            const playerCount =
              Number.isSafeInteger(observation.playerCount) &&
              observation.playerCount !== undefined &&
              observation.playerCount >= 0 &&
              observation.playerCount <= 1000000
                ? observation.playerCount
                : undefined;
            players.push(playerCount);
            idle = idle && observation.idle === true && playerCount === 0;
          } catch (error) {
            if (error instanceof GatewayProviderRateLimitedError) {
              deferProvider(error);
              return;
            }
            // An idle-only failure suppresses sleep without discarding the
            // independent readiness proof; unknown readiness cannot advance.
            ready = ready && readinessConfirmed;
            idle = false;
            players.push(undefined);
            counters.observationErrors++;
            logTiming('gateway.observation_failure', {
              ...routeIdentity(route),
              probeStage,
              detail: error instanceof GatewaySafetyError ? error.observationFailure : undefined,
              trigger: priorityServerId ? 'startup_hint' : 'periodic',
              durationMs: Math.round(performance.now() - probeStarted),
              reason:
                error instanceof GatewaySafetyError
                  ? error.reason
                  : error instanceof NetworkObservationError
                    ? `observer_${error.reason}`
                    : error instanceof GatewayRouteRevisionStaleError
                      ? 'route_revision_stale'
                      : 'unclassified',
            });
            options.logger?.log('warn', 'gateway.observation_unavailable', { routeId: route.id });
          } finally {
            probeDuration += performance.now() - probeStarted;
          }
        }
        try {
          if (providerRetryAt > now()) return;
          if (
            observationEpochs.get(anchor.serverId) !== epochs.get(anchor.serverId) ||
            !candidateSnapshot ||
            candidateSnapshot.gatewayId !== candidates.gatewayId ||
            candidateSnapshot.revision !== candidates.revision ||
            !isDeepStrictEqual(candidateSnapshot.routes, candidates.routes) ||
            Date.parse(candidateSnapshot.expiresAt) <= now() ||
            Date.parse(candidates.expiresAt) <= now() ||
            stopping
          ) {
            counters.observationsDiscarded++;
            continue;
          }
          // Equivalent lease renewals must not starve a slower protocol probe.
          // Keep the captured lease/time for this observation and its idle fence;
          // only exactly unchanged route authority may outlive object replacement.
          const activeSessions = [...listeners.values()]
            .filter((listener) => listener.route.serverId === anchor.serverId)
            .reduce(
              (count, listener) => count + listener.forwardingClients.size + listener.sessions.size,
              0,
            );
          const canQuiesce =
            anchor.mode === 'online' &&
            ready &&
            idle &&
            activeSessions === 0 &&
            anchor.sleepEligibleAt !== undefined &&
            routes.every((route) => route.sleepEligibleAt === anchor.sleepEligibleAt) &&
            Date.parse(observedAt) >= Date.parse(anchor.sleepEligibleAt);
          if (canQuiesce && !quiescence.has(anchor.serverId)) {
            quiescence.set(anchor.serverId, {
              deadline: Date.parse(candidates.expiresAt),
              observedAt: Date.parse(observedAt),
              generation: anchor.generation,
              routes: structuredClone(routes),
            });
            syncSleepWatches();
            logTiming('gateway.quiescence_started', {
              ...routeIdentity(anchor),
              observedAt,
              deadline: candidates.expiresAt,
              remainingMs: Math.max(0, Date.parse(candidates.expiresAt) - now()),
              maxClockSkewMs: policy.maxClockSkewMs,
            });
            for (const listener of listeners.values())
              if (listener.route.serverId === anchor.serverId)
                logRouteTransition(listener, 'idle_quiescence');
          }
          const quiescenceUntil = canQuiesce
            ? Math.min(
                quiescence.get(anchor.serverId)?.deadline ?? 0,
                Date.parse(candidates.expiresAt),
              )
            : undefined;
          // A lost report must not perpetually extend a fence. Only a new
          // post-deadline Core fetch can reconcile this promise and re-arm it.
          if (quiescenceUntil !== undefined && quiescenceUntil <= now()) continue;
          const reportStarted = performance.now();
          const receipt = await options.control
            .reportObservation({
              routeId: anchor.id,
              routeRevision: anchor.revision,
              routes: routes.map((route) => ({ routeId: route.id, routeRevision: route.revision })),
              generation: anchor.generation,
              wakeJobId: anchor.wakeJobId,
              observedAt,
              ready,
              idle: ready && idle && activeSessions === 0,
              quiescenceUntil:
                quiescenceUntil === undefined ? undefined : new Date(quiescenceUntil).toISOString(),
              playerCount: players.every((count) => count !== undefined)
                ? Math.max(...(players as number[]))
                : undefined,
              activeSessions,
            })
            .finally(() => {
              const durationMs = performance.now() - reportStarted;
              reportDuration += durationMs;
              if (anchor.mode === 'waking')
                logTiming('gateway.observation_report', {
                  ...routeIdentity(anchor),
                  observedAt,
                  ready,
                  trigger: priorityServerId ? 'startup_hint' : 'periodic',
                  durationMs: Math.round(durationMs),
                });
            });
          if (ready && anchor.mode === 'waking') {
            const applied =
              receipt &&
              (await applyReadinessReceipt(receipt, candidates, anchor.serverId, observedAt));
            if (!applied) refreshAfterReadiness = true;
          }
        } catch (error) {
          if (error instanceof GatewayProviderRateLimitedError) {
            deferProvider(error);
            return;
          }
          counters.observationErrors++;
          options.logger?.log('warn', 'gateway.observation_unavailable', {
            serverId: anchor.serverId,
          });
        }
      }
      // A committed positive wake observation can change route authority. Refresh
      // through the usual full safety path instead of waiting an extra poll period.
      if (refreshAfterReadiness && !stopping) {
        // An existing fetch may predate the observation commit. Wait for it to
        // settle, then fetch again; joining that promise can otherwise leave the
        // newly ready backend behind a waking snapshot until the next timer.
        await refreshing?.catch(() => {});
        if (!stopping) await refresh().catch(() => {});
      }
    })().finally(() => {
      counters.observationCycles++;
      counters.lastObservationDurationMs = Math.round(performance.now() - cycleStarted);
      counters.maximumObservationDurationMs = Math.max(
        counters.maximumObservationDurationMs,
        counters.lastObservationDurationMs,
      );
      counters.lastObservationProbeDurationMs = Math.round(probeDuration);
      counters.lastObservationReportDurationMs = Math.round(reportDuration);
      if (priorityServerId) {
        startupObservations.delete(priorityServerId);
        logTiming('gateway.startup_observation', {
          serverId: priorityServerId,
          durationMs: Math.round(performance.now() - cycleStarted),
          probeDurationMs: Math.round(probeDuration),
          reportDurationMs: Math.round(reportDuration),
        });
      } else observing = undefined;
    });
    if (priorityServerId) startupObservations.set(priorityServerId, work);
    else observing = work;
    return work;
  };
  const start = async () => {
    if (started || stopping) return;
    started = true;
    await refresh().catch(() => {});
    if (stopping) return;
    const poll = async () => {
      if (stopping) return;
      const cycleStarted = performance.now();
      let failed = false;
      await refresh().catch(() => {
        failed = true;
      });
      if (!stopping) {
        pollTimer = setTimeout(
          () => {
            void poll();
          },
          failed
            ? policy.pollIntervalMs
            : Math.max(100, policy.pollIntervalMs - (performance.now() - cycleStarted)),
        );
        pollTimer.unref();
      }
    };
    const observations = async () => {
      if (stopping) return;
      const cycleStarted = performance.now();
      const previousErrors = counters.observationErrors;
      await observe();
      if (!stopping) {
        observationTimer = setTimeout(
          () => {
            void observations();
          },
          counters.observationErrors > previousErrors
            ? policy.observationIntervalMs
            : Math.max(100, policy.observationIntervalMs - (performance.now() - cycleStarted)),
        );
        observationTimer.unref();
      }
    };
    pollTimer = setTimeout(() => {
      void poll();
    }, policy.pollIntervalMs);
    observationTimer = setTimeout(() => {
      void observations();
    }, policy.observationIntervalMs);
    pollTimer.unref();
    observationTimer.unref();
    sweepTimer = setInterval(
      () => {
        for (const listener of listeners.values())
          for (const [key, session] of listener.sessions)
            if (now() - session.lastActivity >= policy.udpIdleTimeoutMs) dropSession(listener, key);
        syncStartupWatches();
        void expire();
      },
      Math.min(policy.udpIdleTimeoutMs, 1000),
    );
    sweepTimer.unref();
  };
  const stop = () => {
    if (shutdown) return shutdown;
    stopping = true;
    for (const watch of startupWatches.values()) watch.abort.abort();
    startupWatches.clear();
    for (const watch of sleepWatches.values()) watch.abort.abort();
    sleepWatches.clear();
    if (pollTimer) clearTimeout(pollTimer);
    if (observationTimer) clearTimeout(observationTimer);
    if (idleDeadlineTimer) clearTimeout(idleDeadlineTimer);
    sampledIdleDeadlines.clear();
    if (leaseTimer) clearTimeout(leaseTimer);
    if (sweepTimer) clearInterval(sweepTimer);
    shutdown = (async () => {
      const current = [...listeners.values()];
      for (const listener of current) logRouteTransition(listener, 'shutdown', false);
      const closing = Promise.all(current.map((listener) => closeListener(listener, false)));
      const timer = setTimeout(() => {
        for (const listener of current) clearSessions(listener);
      }, policy.gracefulShutdownMs);
      timer.unref();
      await closing;
      clearTimeout(timer);
      listeners.clear();
      wakeRequests.clear();
      await Promise.allSettled([serial, refreshing, observing, ...startupObservations.values()]);
      observationEpochs.clear();
    })();
    return shutdown;
  };
  return {
    start,
    stop,
    refresh,
    observe,
    applySnapshot,
    ownedBindings: (): GatewayEndpoint[] =>
      [...listeners.values()].map((listener) => ({ ...listener.route.public })),
    health: () => ({
      ready: leased() && listeners.size === snapshot?.routes.length,
      controlAvailable,
      stopping,
      revision: snapshot?.revision ?? null,
      expiresAt: snapshot?.expiresAt ?? null,
      routes: listeners.size,
      tcpConnections: clientsCount(),
      udpSessions: sessionsCount(),
      quiescentServers: quiescence.size,
    }),
    metrics: () => ({ ...counters }),
  };
}
