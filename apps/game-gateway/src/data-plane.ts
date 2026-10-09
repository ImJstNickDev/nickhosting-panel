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
  type GatewayRoute,
  type GatewaySafety,
  type GatewaySnapshot,
  gatewaySnapshotSchema,
} from '@nickhosting/game-sdk';
import { z } from 'zod';
import { GatewayRouteRevisionStaleError } from './control-client.js';

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
      level: 'info' | 'warn' | 'error',
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
  tcp?: Server;
  udp?: DatagramSocket;
  clients: Set<Socket>;
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
    { at: number; promise: Promise<GatewayMode>; inFlight: boolean }
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
    snapshotErrors: 0,
    leaseExpirations: 0,
  };
  let snapshot: GatewaySnapshot | undefined;
  // Authenticated candidates may be probed before they are safe to bind. This
  // breaks first-start readiness bootstrap without granting forwarding rights.
  let candidateSnapshot: GatewaySnapshot | undefined;
  let controlAvailable = false;
  let stopping = false;
  let started = false;
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let observationTimer: ReturnType<typeof setTimeout> | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let serial: Promise<void> = Promise.resolve();
  let refreshing: Promise<void> | undefined;
  let observing: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;
  let pendingUdpIntents = 0;
  let pendingUdpResponseBytes = 0;
  const quiescence = new Map<string, number>();
  const bounded = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new DomainError('integration_unavailable'));
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
  const response = (route: GatewayRoute, mode: GatewayMode) => {
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
  const wake = (route: GatewayRoute): Promise<GatewayMode> => {
    const previous = wakeRequests.get(route.serverId);
    if (previous && (previous.inFlight || now() - previous.at < policy.wakeRetryMs))
      return previous.promise;
    if (!leased() || quiescence.has(route.serverId)) return Promise.resolve('blocked');
    counters.wakeRequests++;
    const promise: Promise<GatewayMode> = options.control
      .requestWake({ routeId: route.id, routeRevision: route.revision, requestId: randomUUID() })
      .then((result) => result.mode)
      .catch(() => {
        counters.wakeErrors++;
        return 'blocked' as const;
      })
      .finally(() => {
        const current = wakeRequests.get(route.serverId);
        if (current?.promise === promise) current.inFlight = false;
      });
    wakeRequests.set(route.serverId, { at: now(), promise, inFlight: true });
    return promise;
  };
  const processIntent = async (
    listener: Listener,
    input: Uint8Array,
  ): Promise<{ pending?: boolean; bytes?: Uint8Array }> => {
    if (!active(listener) || quiescence.has(listener.route.serverId)) return {};
    const route = listener.route;
    const handler = protocol(route);
    if (!handler) return {};
    try {
      const intent = handler.classify(input, {
        route,
        signal: AbortSignal.timeout(policy.classificationTimeoutMs),
      });
      if (intent.kind === 'need-more') return { pending: true };
      if (intent.kind === 'status') return { bytes: response(route, route.mode) };
      if (intent.kind !== 'join') return {};
      const mode =
        route.mode === 'sleeping' || route.mode === 'blocked' ? await wake(route) : route.mode;
      return active(listener) && listener.route === route ? { bytes: response(route, mode) } : {};
    } catch {
      return {};
    }
  };
  const accept = (listener: Listener, socket: Socket) => {
    socket.on('error', () => socket.destroy());
    if (
      !active(listener) ||
      quiescence.has(listener.route.serverId) ||
      clientsCount() >= policy.maxTcpConnections
    ) {
      counters.tcpRejected++;
      socket.destroy();
      return;
    }
    counters.tcpAccepted++;
    listener.clients.add(socket);
    socket.once('close', () => listener.clients.delete(socket));
    socket.setNoDelay(true);
    socket.setTimeout(policy.tcpIdleTimeoutMs, () => socket.destroy());
    if (listener.route.mode === 'online') {
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
        session = handler.createSession({ route: sessionRoute, signal: controller.signal });
      } catch {
        controller.abort();
        socket.destroy();
        return;
      }
      let buffered = Buffer.alloc(0);
      let inputBytes = 0;
      let outputBytes = 0;
      const timer = setTimeout(() => socket.destroy(), policy.classificationTimeoutMs);
      timer.unref();
      socket.once('close', () => {
        clearTimeout(timer);
        controller.abort();
      });
      const valid = () =>
        !socket.destroyed &&
        !controller.signal.aborted &&
        active(listener) &&
        listener.route.revision === sessionRoute.revision &&
        !quiescence.has(sessionRoute.serverId);
      const consume = async () => {
        while (buffered.length && valid()) {
          const intent = session.classify(buffered);
          if (
            !Number.isSafeInteger(intent.consumedBytes) ||
            intent.consumedBytes < 0 ||
            intent.consumedBytes > buffered.length ||
            (intent.kind === 'need-more' ? intent.consumedBytes !== 0 : intent.consumedBytes === 0)
          )
            return void socket.destroy();
          if (intent.kind === 'need-more') return;
          buffered = buffered.subarray(intent.consumedBytes);
          if (intent.kind === 'unsupported') return void socket.destroy();
          if (intent.kind === 'continue') continue;
          const state =
            intent.kind === 'join' &&
            (sessionRoute.mode === 'sleeping' || sessionRoute.mode === 'blocked')
              ? await wake(sessionRoute)
              : sessionRoute.mode;
          if (!valid()) return void socket.destroy();
          const result = session.response(state);
          outputBytes += result.bytes?.byteLength ?? 0;
          if (outputBytes > policy.maxProtocolResponseBytes) return void socket.destroy();
          if (result.close) {
            if (result.bytes) socket.end(result.bytes);
            else socket.end();
            return;
          }
          if (result.bytes?.byteLength)
            await new Promise<void>((resolve, reject) =>
              socket.write(result.bytes as Uint8Array, (error) =>
                error ? reject(error) : resolve(),
              ),
            );
        }
        if (!valid()) socket.destroy();
      };
      socket.on('data', (chunk: Buffer) => {
        inputBytes += chunk.length;
        if (inputBytes > policy.maxClassificationBytes) return void socket.destroy();
        buffered = Buffer.concat([buffered, chunk]);
        socket.pause();
        void consume()
          .then(() => {
            if (!socket.destroyed && !socket.writableEnded) socket.resume();
          })
          .catch(() => socket.destroy());
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
    if (!active(listener) || quiescence.has(listener.route.serverId)) {
      counters.udpDropped++;
      return;
    }
    if (listener.route.mode !== 'online') {
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
  const bind = async (route: GatewayRoute): Promise<Listener> => {
    const listener: Listener = {
      route,
      clients: new Set(),
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
    listeners.clear();
    wakeRequests.clear();
    if (expired.length) counters.leaseExpirations++;
    await Promise.all(expired.map((listener) => closeListener(listener)));
  };
  const apply = async (input: unknown, fetchStartedAt: number) => {
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
    for (const route of next.routes) {
      if (stopping) throw new DomainError('integration_unavailable');
      try {
        await bounded(async () => {
          if (!listeners.has(route.id) && route.mode !== 'online') {
            // A running manually started backend can establish its first proof.
            // Offline failure is expected; listener validation still fails closed.
            await options.safety.validateBackend(route).catch(() => {});
          }
          await options.safety.validate(route, owned);
        });
      } catch (error) {
        // Core may advance a route while fresh inventory/protocol evidence is
        // collected. This candidate never becomes authoritative; the already
        // committed route keeps only its original lease during a bounded retry.
        if (error instanceof GatewayRouteRevisionStaleError) {
          candidateSnapshot = previousCandidate;
          throw error;
        }
        const unsafe = listeners.get(route.id);
        if (unsafe) {
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
        if (!route || !isDeepStrictEqual(route.public, listener.route.public)) {
          listeners.delete(listener.route.id);
          await closeListener(listener);
        }
      }
      for (const route of next.routes) {
        if (listeners.has(route.id)) continue;
        // Earlier routes may have spent the entire topology TTL waiting for
        // another role. Refresh evidence directly before each native bind;
        // staged listeners are already ours even before the snapshot commits.
        await bounded(async () => {
          await options.safety.validate(route, [
            ...[...listeners.values()].map((listener) => listener.route.public),
            ...staged.map((listener) => listener.route.public),
          ]);
        });
        if (stopping || expires <= now()) throw new DomainError('conflict');
        const listener = await bind(route);
        staged.push(listener);
      }
      if (stopping || expires <= now()) throw new DomainError('conflict');
      for (const listener of staged) listeners.set(listener.route.id, listener);
      for (const route of next.routes) {
        const listener = listeners.get(route.id);
        if (!listener) throw new DomainError('internal_error');
        if (
          !isDeepStrictEqual(listener.route.backend, route.backend) ||
          listener.route.generation !== route.generation ||
          (listener.route.mode === 'online' && route.mode !== 'online')
        )
          clearSessions(listener);
        listener.route = route;
      }
      snapshot = next;
      for (const [serverId, deadline] of quiescence) {
        // Route withdrawal does not cancel an in-flight idle report. Retain
        // the fence across disable/re-enable until a post-deadline fetch.
        if (fetchStartedAt >= deadline + policy.maxClockSkewMs && issued >= deadline)
          quiescence.delete(serverId);
      }
      controlAvailable = true;
      if (leaseTimer) clearTimeout(leaseTimer);
      leaseTimer = setTimeout(
        () => {
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
    if (refreshing) return refreshing;
    refreshing = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const fetchStartedAt = now();
        try {
          const input = await options.control.fetchSnapshot();
          await applySnapshot(input, fetchStartedAt);
          return;
        } catch (error) {
          if (!(error instanceof GatewayRouteRevisionStaleError) || attempt === 1) throw error;
        }
      }
    })()
      .catch((error: unknown) => {
        controlAvailable = false;
        counters.snapshotErrors++;
        options.logger?.log('warn', 'gateway.snapshot_unavailable');
        throw error;
      })
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  };
  const observe = () => {
    if (observing) return observing;
    observing = (async () => {
      const candidates = candidateSnapshot;
      if (!candidates || Date.parse(candidates.expiresAt) <= now() || stopping) return;
      const servers = new Map<string, GatewayRoute[]>();
      for (const route of candidates.routes) {
        const routes = servers.get(route.serverId) ?? [];
        routes.push(route);
        servers.set(route.serverId, routes);
      }
      for (const routes of servers.values()) {
        routes.sort((a, b) => a.id.localeCompare(b.id));
        const anchor = routes[0];
        if (!anchor || stopping) continue;
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
        let ready = true;
        let idle = true;
        const observedAt = new Date(now()).toISOString();
        const players: (number | undefined)[] = [];
        for (const route of routes) {
          const handler = protocol(route);
          if (!handler || stopping) {
            ready = false;
            idle = false;
            players.push(undefined);
            continue;
          }
          let readinessConfirmed = false;
          try {
            const readiness = await bounded(async (signal) => {
              await options.safety.validateBackend(route);
              return handler.probeReadiness({ route, signal });
            });
            readinessConfirmed = readiness.ready === true;
            ready = ready && readinessConfirmed;
            if (readiness.ready !== true || !handler.probeIdle) {
              idle = false;
              players.push(undefined);
              continue;
            }
            const probeIdle = handler.probeIdle;
            const observation = await bounded((signal) => probeIdle({ route, signal }));
            const playerCount =
              Number.isSafeInteger(observation.playerCount) &&
              observation.playerCount !== undefined &&
              observation.playerCount >= 0 &&
              observation.playerCount <= 1000000
                ? observation.playerCount
                : undefined;
            players.push(playerCount);
            idle = idle && observation.idle === true && playerCount === 0;
          } catch {
            // An idle-only failure suppresses sleep without discarding the
            // independent readiness proof; unknown readiness cannot advance.
            ready = ready && readinessConfirmed;
            idle = false;
            players.push(undefined);
            counters.observationErrors++;
            options.logger?.log('warn', 'gateway.observation_unavailable', { routeId: route.id });
          }
        }
        try {
          if (
            candidateSnapshot !== candidates ||
            Date.parse(candidates.expiresAt) <= now() ||
            stopping
          )
            continue;
          const activeSessions = [...listeners.values()]
            .filter((listener) => listener.route.serverId === anchor.serverId)
            .reduce((count, listener) => count + listener.clients.size + listener.sessions.size, 0);
          const canQuiesce =
            anchor.mode === 'online' &&
            ready &&
            idle &&
            activeSessions === 0 &&
            anchor.sleepEligibleAt !== undefined &&
            routes.every((route) => route.sleepEligibleAt === anchor.sleepEligibleAt) &&
            Date.parse(observedAt) >= Date.parse(anchor.sleepEligibleAt);
          if (canQuiesce && !quiescence.has(anchor.serverId))
            quiescence.set(anchor.serverId, Date.parse(candidates.expiresAt));
          const quiescenceUntil = canQuiesce
            ? Math.min(quiescence.get(anchor.serverId) ?? 0, Date.parse(candidates.expiresAt))
            : undefined;
          // A lost report must not perpetually extend a fence. Only a new
          // post-deadline Core fetch can reconcile this promise and re-arm it.
          if (quiescenceUntil !== undefined && quiescenceUntil <= now()) continue;
          await options.control.reportObservation({
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
          });
        } catch {
          counters.observationErrors++;
          options.logger?.log('warn', 'gateway.observation_unavailable', {
            serverId: anchor.serverId,
          });
        }
      }
    })().finally(() => {
      observing = undefined;
    });
    return observing;
  };
  const start = async () => {
    if (started || stopping) return;
    started = true;
    await refresh().catch(() => {});
    if (stopping) return;
    const poll = async () => {
      if (stopping) return;
      await refresh().catch(() => {});
      if (!stopping) {
        pollTimer = setTimeout(() => {
          void poll();
        }, policy.pollIntervalMs);
        pollTimer.unref();
      }
    };
    const observations = async () => {
      if (stopping) return;
      await observe();
      if (!stopping) {
        observationTimer = setTimeout(() => {
          void observations();
        }, policy.observationIntervalMs);
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
        void expire();
      },
      Math.min(policy.udpIdleTimeoutMs, 1000),
    );
    sweepTimer.unref();
  };
  const stop = () => {
    if (shutdown) return shutdown;
    stopping = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (observationTimer) clearTimeout(observationTimer);
    if (leaseTimer) clearTimeout(leaseTimer);
    if (sweepTimer) clearInterval(sweepTimer);
    shutdown = (async () => {
      const current = [...listeners.values()];
      const closing = Promise.all(current.map((listener) => closeListener(listener, false)));
      const timer = setTimeout(() => {
        for (const listener of current) clearSessions(listener);
      }, policy.gracefulShutdownMs);
      timer.unref();
      await closing;
      clearTimeout(timer);
      listeners.clear();
      wakeRequests.clear();
      await Promise.allSettled([serial, refreshing, observing]);
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
