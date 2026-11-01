import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { connect, isIP } from 'node:net';
import type { GatewayProtocolAdapter, GatewayProtocolContext } from '@nickhosting/game-sdk';
import { acceptSatisfactoryHttps } from './https-gateway.js';
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
        finish(undefined, decodeSatisfactoryState(bytes, cookie));
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
  const observations = new Map<string, number>();
  return {
    id: 'satisfactory',
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
    response(context, mode) {
      const request = context.input && decodeSatisfactoryPoll(context.input);
      const persisted = context.route.protocol?.satisfactory;
      const cached =
        store.read(context.route.serverId) ??
        (persisted ? { ...persisted, flags: BigInt(persisted.flags) } : undefined);
      if (!request || !cached) return undefined;
      // Offline is an actual documented protocol state; never advertise Playing
      // for a backend unable to issue authentication or multiplayer tickets.
      return encodeSatisfactoryState(request.cookie, {
        ...cached,
        state: mode === 'waking' ? 2 : 0,
      });
    },
    async probeReadiness(context) {
      if (context.route.protocol?.role === 'reliable') {
        const observedAt = observations.get(context.route.serverId);
        if (!observedAt || Date.now() - observedAt > 10_000) return { ready: false };
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
        store.write(context.route.serverId, state);
        if (context.route.public.transport === 'udp')
          await context.persistState?.({
            ...state,
            flags: state.flags.toString(),
            substates: [...state.substates],
            observedAt: new Date().toISOString(),
          });
        if (state.state === 1 || state.state === 3)
          observations.set(context.route.serverId, Date.now());
        else observations.delete(context.route.serverId);
        return { ready: state.state === 1 || state.state === 3 };
      } catch {
        return { ready: false };
      }
    },
  };
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
