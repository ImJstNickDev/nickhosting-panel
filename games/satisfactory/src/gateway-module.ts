import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { connect, isIP } from 'node:net';
import type { GatewayProtocolAdapter, GatewayProtocolContext } from '@nickhosting/game-sdk';
import { acceptSatisfactoryHttps } from './https-gateway.js';
import { supportsSatisfactoryOfflineAuthentication } from './offline-auth-profile.js';
import {
  decodeSatisfactoryPoll,
  decodeSatisfactoryState,
  encodeSatisfactoryPoll,
  encodeSatisfactoryState,
  type SatisfactoryQueryState,
} from './protocol.js';

export interface SatisfactoryGatewayStateStore {
  read(serverId: string): SatisfactoryQueryState | undefined;
  write(serverId: string, state: SatisfactoryQueryState): void;
}
export async function probeSatisfactoryQuery(
  context: GatewayProtocolContext,
): Promise<SatisfactoryQueryState> {
  const cookie = randomBytes(8).readBigUInt64LE();
  const socket = createSocket(isIP(context.route.backend.address) === 6 ? 'udp6' : 'udp4');
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: Error, state?: SatisfactoryQueryState) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      try {
        socket.close();
      } catch {
        /* Socket may not yet be bound. */
      }
      if (error) reject(error);
      else if (state) resolve(state);
    };
    const abort = () => finish(new Error('aborted'));
    const timer = setTimeout(() => finish(new Error('timeout')), 3000);
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) {
      abort();
      return;
    }
    socket.once('error', (error) => finish(error));
    socket.on('message', (bytes) => {
      try {
        const decoded = decodeSatisfactoryState(bytes, cookie);
        finish(undefined, {
          state: decoded.state,
          netCL: decoded.netCL,
          flags: decoded.flags,
          substates: decoded.substates,
          name: decoded.name,
        });
      } catch {
        /* Unrelated or malformed datagrams never establish readiness. */
      }
    });
    socket.connect(context.route.backend.port, context.route.backend.address, () => {
      if (!done)
        socket.send(encodeSatisfactoryPoll(cookie), (error) => {
          if (error) finish(error);
        });
    });
  });
}
export function createSatisfactoryGatewayAdapter(
  store: SatisfactoryGatewayStateStore,
): GatewayProtocolAdapter {
  const loads = new Map<string, { attemptedAt: number; work: Promise<void> }>();
  const observations = new Map<string, { generation: string; at: number; netCL: number }>();
  const applicationSamples = new Map<
    string,
    { generation: string; at: number; playerCount: number; idle: boolean }
  >();
  let pruneAt = 0;
  function prune() {
    const now = Date.now();
    if (now < pruneAt) return;
    pruneAt = now + 5_000;
    for (const [id, observation] of observations)
      if (now - observation.at > 10_000) observations.delete(id);
    for (const [id, observation] of applicationSamples)
      if (now - observation.at > 5_000) applicationSamples.delete(id);
  }
  function boundInsert<T>(map: Map<string, T>, id: string, value: T) {
    if (!map.has(id) && map.size >= 10_000) {
      const oldest = map.keys().next().value;
      if (oldest) map.delete(oldest);
    }
    map.set(id, value);
  }
  async function applicationObservation(
    context: GatewayProtocolContext,
  ): Promise<import('@nickhosting/game-sdk').GatewayProtocolObservation> {
    prune();
    // Startup readiness still comes from the actual native probes. Player-idle
    // sampling cannot authorize sleep during waking and would delay readiness.
    if (context.route.mode === 'waking') {
      applicationSamples.delete(context.route.serverId);
      return { ready: true };
    }
    if (context.route.protocol?.role === 'game' && context.route.public.transport === 'udp') {
      applicationSamples.delete(context.route.serverId);
      try {
        const application = await context.observeApplication?.();
        if (
          application?.ready &&
          application.playerCount !== undefined &&
          Number.isSafeInteger(application.playerCount) &&
          application.playerCount >= 0 &&
          application.playerCount <= 1_000_000
        ) {
          boundInsert(applicationSamples, context.route.serverId, {
            generation: context.route.generation,
            at: Date.now(),
            playerCount: application.playerCount,
            idle: application.idle === true && application.playerCount === 0,
          });
        }
      } catch {
        /* Missing credentials or an unavailable API never prove zero players. */
      }
    }
    const application = applicationSamples.get(context.route.serverId);
    if (
      !application ||
      application.generation !== context.route.generation ||
      Date.now() - application.at > 5_000
    )
      return { ready: true };
    // Keep an unverified build online instead of suspending it into an offline
    // authentication flow it cannot serve. Normal readiness, updates, forwarding
    // and explicit power controls remain independent of this optimization.
    const native = observations.get(context.route.serverId);
    const canAuthenticateOffline =
      native?.generation === context.route.generation &&
      Date.now() - native.at <= 10_000 &&
      supportsSatisfactoryOfflineAuthentication(native.netCL);
    return {
      ready: true,
      idle: application.idle && canAuthenticateOffline,
      playerCount: application.playerCount,
    };
  }
  const adapter: GatewayProtocolAdapter = {
    id: 'satisfactory',
    startupHint: 'provider_running',
    managesTcpActivity: true,
    clientRequestsPreventIdle: true,
    managesTcpForwarding: true,
    isStatusDatagram(input, direction) {
      if (direction === 'client') return decodeSatisfactoryPoll(input) !== undefined;
      try {
        decodeSatisfactoryState(input);
        return true;
      } catch {
        return false;
      }
    },
    validationPriority: (route) =>
      route.protocol?.role === 'reliable' ? 2 : route.public.transport === 'udp' ? 0 : 1,
    supports: (route) =>
      route.protocol?.handlerId === 'satisfactory' &&
      (route.protocol.role === 'game' ||
        (route.protocol.role === 'reliable' && route.public.transport === 'tcp')),
    handlesTcp: (route) => route.protocol?.role === 'game',
    acceptTcp: acceptSatisfactoryHttps,
    classify: (input, context) => ({
      kind:
        context.route.public.transport === 'udp' && decodeSatisfactoryPoll(input)
          ? 'status'
          : 'ignore',
    }),
    async prepareResponse(context) {
      const existing = store.read(context.route.serverId);
      if (existing?.state === 1 || existing?.state === 3 || !context.loadState) return;
      const id = context.route.serverId;
      const current = loads.get(id);
      if (current && Date.now() - current.attemptedAt < 10_000) {
        await current.work;
        return;
      }
      const attemptedAt = Date.now();
      const work = (async () => {
        try {
          const state = await context.loadState?.();
          const latest = store.read(id);
          if (state && !context.signal.aborted && latest?.state !== 1 && latest?.state !== 3)
            store.write(id, { ...state, flags: BigInt(state.flags) });
        } catch {
          // Missing durable status does not invent a build number or readiness.
        }
      })();
      boundInsert(loads, id, { attemptedAt, work });
      await work;
    },
    response(context, mode) {
      const request = context.input && decodeSatisfactoryPoll(context.input);
      const persisted = context.route.protocol?.satisfactory;
      const cached =
        store.read(context.route.serverId) ??
        (persisted ? { ...persisted, flags: BigInt(persisted.flags) } : undefined);
      if (!request || !cached) return undefined;
      // Auto-sleep suspends the known instance, so retain its last native ready
      // presentation for the Server Manager. This does not establish readiness
      // or issue authentication/tickets; an actual join still wakes the backend.
      return encodeSatisfactoryState(request.cookie, {
        ...cached,
        state:
          mode === 'waking'
            ? 2
            : mode === 'sleeping' &&
                context.route.wakeEnabled !== false &&
                (cached.state === 1 || cached.state === 3)
              ? cached.state
              : 0,
      });
    },
    async observe(context) {
      const sample = await adapter.probeReadiness(context);
      if (!sample.ready) {
        applicationSamples.delete(context.route.serverId);
        return { ready: false };
      }
      return applicationObservation(context);
    },
    async probeIdle(context) {
      const sample = await applicationObservation(context);
      return {
        idle: sample?.ready === true && sample.idle === true,
        ...(sample?.ready && sample.playerCount !== undefined
          ? { playerCount: sample.playerCount }
          : {}),
      };
    },
    async probeReadiness(context) {
      prune();
      if (context.route.protocol?.role === 'reliable') {
        const observation = observations.get(context.route.serverId);
        if (
          !observation ||
          observation.generation !== context.route.generation ||
          Date.now() - observation.at > 10_000
        )
          return { ready: false };
        return new Promise((resolve) => {
          const socket = connect({
            host: context.route.backend.address,
            port: context.route.backend.port,
            signal: context.signal,
          });
          const finish = (ready: boolean) => {
            socket.destroy();
            resolve({ ready });
          };
          socket.setTimeout(3000);
          socket.once('connect', () => finish(true));
          socket.once('error', () => finish(false));
          socket.once('timeout', () => finish(false));
        });
      }
      if (context.route.protocol?.role !== 'game') return { ready: false };
      try {
        const state = await probeSatisfactoryQuery(context);
        const ready = state.state === 1 || state.state === 3;
        const previous = store.read(context.route.serverId);
        if (ready || (previous?.state !== 1 && previous?.state !== 3))
          store.write(context.route.serverId, state);
        // Only complete ready snapshots become durable presentation. Transient
        // shutdown/loading responses must not replace the last known instance.
        if (ready && context.route.public.transport === 'udp') {
          try {
            await context.persistState?.({
              ...state,
              flags: state.flags.toString(),
              substates: [...state.substates],
              observedAt: new Date().toISOString(),
            });
          } catch {
            // Persistence availability cannot change the actual protocol reply.
          }
        }
        if (ready)
          boundInsert(observations, context.route.serverId, {
            generation: context.route.generation,
            at: Date.now(),
            netCL: state.netCL,
          });
        else observations.delete(context.route.serverId);
        return { ready };
      } catch {
        observations.delete(context.route.serverId);
        return { ready: false };
      }
    },
  };
  return adapter;
}
const stateCache = new Map<string, SatisfactoryQueryState>();
export const satisfactoryGatewayAdapter = createSatisfactoryGatewayAdapter({
  read: (id) => stateCache.get(id),
  write: (id, state) => {
    if (stateCache.size >= 10_000 && !stateCache.has(id)) {
      const oldest = stateCache.keys().next().value;
      if (oldest) stateCache.delete(oldest);
    }
    stateCache.set(id, state);
  },
});
export default satisfactoryGatewayAdapter;

export const gatewayProtocols = [satisfactoryGatewayAdapter];
