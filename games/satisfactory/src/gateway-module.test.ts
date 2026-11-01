import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { GatewayProtocolContext } from '@nickhosting/game-sdk';
import { describe, expect, it, vi } from 'vitest';
import { createSatisfactoryGatewayAdapter } from './gateway-module.js';
import {
  decodeSatisfactoryPoll,
  decodeSatisfactoryState,
  encodeSatisfactoryPoll,
  encodeSatisfactoryState,
} from './protocol.js';

const persisted = {
  state: 3 as const,
  netCL: 12345,
  flags: '1',
  substates: [{ id: 0, version: 9 }],
  name: 'Factory',
  observedAt: '2026-11-01T00:00:00Z',
};
function context(input: Uint8Array): GatewayProtocolContext {
  return {
    signal: new AbortController().signal,
    input,
    route: {
      id: '11111111-1111-4111-8111-111111111111',
      serverId: '22222222-2222-4222-8222-222222222222',
      nodeId: '33333333-3333-4333-8333-333333333333',
      allocationId: '44444444-4444-4444-8444-444444444444',
      revision: 1,
      generation: '55555555-5555-4555-8555-555555555555',
      public: { address: '127.0.0.1', port: 7777, transport: 'udp' },
      backend: { address: '127.0.0.2', allocationAddress: '127.0.0.2', port: 7777 },
      protocol: {
        handlerId: 'satisfactory',
        gameVersion: 'public',
        role: 'game',
        satisfactory: persisted,
      },
      mode: 'sleeping',
      locale: 'en',
    },
  };
}
describe('Satisfactory gateway', () => {
  const adapter = createSatisfactoryGatewayAdapter({ read: () => undefined, write: () => {} });
  it('persists query state as JSON without retaining the per-request bigint cookie', async () => {
    const backend = createSocket('udp4');
    await new Promise<void>((resolve) => backend.bind(0, '127.0.0.1', resolve));
    backend.on('message', (bytes, remote) => {
      const poll = decodeSatisfactoryPoll(bytes);
      if (poll)
        backend.send(
          encodeSatisfactoryState(poll.cookie, { ...persisted, flags: 1n }),
          remote.port,
          remote.address,
        );
    });
    const c = context(new Uint8Array());
    c.route = {
      ...c.route,
      backend: {
        address: '127.0.0.1',
        allocationAddress: '127.0.0.1',
        port: backend.address().port,
      },
    };
    let serialized = '';
    c.persistState = async (state) => {
      serialized = JSON.stringify(state);
    };
    try {
      expect(await adapter.probeReadiness?.(c)).toEqual({ ready: true });
      const state = JSON.parse(serialized);
      expect(state).not.toHaveProperty('cookie');
      expect(state).toMatchObject({
        state: 3,
        netCL: 12345,
        flags: '1',
        substates: [{ id: 0, version: 9 }],
        name: 'Factory',
      });
    } finally {
      backend.close();
    }
  });
  it('hydrates offline query state through the bounded control read without putting it in route authority', async () => {
    const states = new Map<string, import('./protocol.js').SatisfactoryQueryState>();
    const current = createSatisfactoryGatewayAdapter({
      read: (id) => states.get(id),
      write: (id, state) => {
        states.set(id, state);
      },
    });
    const c = context(encodeSatisfactoryPoll(42n));
    delete c.route.protocol?.satisfactory;
    const original = structuredClone(c.route);
    c.loadState = vi.fn(async () => persisted);
    await Promise.all([current.prepareResponse?.(c), current.prepareResponse?.(c)]);
    expect(c.loadState).toHaveBeenCalledOnce();
    expect(c.route).toEqual(original);
    expect(
      decodeSatisfactoryState(current.response(c, 'sleeping') ?? new Uint8Array(), 42n),
    ).toMatchObject({ state: 3, netCL: persisted.netCL, name: persisted.name });
    await current.prepareResponse?.(c);
    expect(c.loadState).toHaveBeenCalledOnce();
  });
  it('bounds failed or empty cache reads and never manufactures offline query data', async () => {
    const current = createSatisfactoryGatewayAdapter({ read: () => undefined, write: () => {} });
    const c = context(encodeSatisfactoryPoll(42n));
    delete c.route.protocol?.satisfactory;
    c.loadState = vi.fn(async () => undefined);
    await current.prepareResponse?.(c);
    await current.prepareResponse?.(c);
    expect(c.loadState).toHaveBeenCalledOnce();
    expect(current.response(c, 'sleeping')).toBeUndefined();
  });
  it('echoes each request cookie from persistent metadata after a restart without waking', () => {
    for (const cookie of [0n, 42n, 0xffffffffffffffffn]) {
      const c = context(encodeSatisfactoryPoll(cookie));
      expect(adapter.classify(c.input ?? new Uint8Array(), c)).toEqual({ kind: 'status' });
      const response = adapter.response(c, 'sleeping');
      expect(response).toBeDefined();
      expect(decodeSatisfactoryState(response ?? new Uint8Array(), cookie)).toEqual({
        cookie,
        state: 3,
        netCL: 12345,
        flags: 1n,
        substates: [{ id: 0, version: 9 }],
        name: 'Factory',
      });
    }
  });
  it.each([0, 1, 2, 3] as const)(
    'replays only observed ready state %s during automatic sleep',
    (nativeState) => {
      const c = context(encodeSatisfactoryPoll(5n));
      if (!c.route.protocol) throw new Error('Missing protocol');
      c.route.protocol.satisfactory = { ...persisted, state: nativeState };
      for (const mode of [
        'sleeping',
        'waking',
        'manually_stopped',
        'maintenance',
        'blocked',
        'stopping',
        'online',
      ] as const) {
        const reply = decodeSatisfactoryState(adapter.response(c, mode) ?? new Uint8Array(), 5n);
        expect(reply.state).toBe(
          mode === 'waking'
            ? 2
            : mode === 'sleeping' && (nativeState === 1 || nativeState === 3)
              ? nativeState
              : 0,
        );
        expect(reply.netCL).toBe(persisted.netCL);
      }
    },
  );
  it('keeps an explicitly disabled automatic wake offline despite a saved loaded world', () => {
    const c = context(encodeSatisfactoryPoll(7n));
    c.route = { ...c.route, wakeEnabled: false };
    expect(
      decodeSatisfactoryState(adapter.response(c, 'sleeping') ?? new Uint8Array(), 7n).state,
    ).toBe(0);
  });
  it('preserves the whole ready snapshot across transient probes while still rejecting readiness', async () => {
    let nativeState: 0 | 1 | 2 | 3 = 3;
    const backend = createSocket('udp4');
    await new Promise<void>((resolve) => backend.bind(0, '127.0.0.1', resolve));
    backend.on('message', (bytes, remote) => {
      const poll = decodeSatisfactoryPoll(bytes);
      if (poll)
        backend.send(
          encodeSatisfactoryState(poll.cookie, {
            ...persisted,
            state: nativeState,
            flags: 1n,
            netCL: nativeState === 3 ? 12345 : 99999,
            name: nativeState === 3 ? 'Factory' : 'Transient',
          }),
          remote.port,
          remote.address,
        );
    });
    const states = new Map<string, import('./protocol.js').SatisfactoryQueryState>();
    const current = createSatisfactoryGatewayAdapter({
      read: (id) => states.get(id),
      write: (id, state) => {
        states.set(id, state);
      },
    });
    const c = context(encodeSatisfactoryPoll(42n));
    delete c.route.protocol?.satisfactory;
    c.route = {
      ...c.route,
      backend: {
        address: '127.0.0.1',
        allocationAddress: '127.0.0.1',
        port: backend.address().port,
      },
    };
    c.persistState = vi.fn(async () => {});
    try {
      nativeState = 0;
      expect(await current.probeReadiness(c)).toEqual({ ready: false });
      expect(
        decodeSatisfactoryState(current.response(c, 'sleeping') ?? new Uint8Array(), 42n).state,
      ).toBe(0);
      expect(c.persistState).not.toHaveBeenCalled();
      nativeState = 3;
      expect(await current.probeReadiness(c)).toEqual({ ready: true });
      for (const transient of [0, 2] as const) {
        nativeState = transient;
        expect(await current.probeReadiness(c)).toEqual({ ready: false });
        expect(
          decodeSatisfactoryState(current.response(c, 'sleeping') ?? new Uint8Array(), 42n),
        ).toMatchObject({ state: 3, netCL: 12345, name: 'Factory' });
      }
      expect(c.persistState).toHaveBeenCalledTimes(1);
      nativeState = 1;
      expect(await current.probeReadiness(c)).toEqual({ ready: true });
      expect(
        decodeSatisfactoryState(current.response(c, 'sleeping') ?? new Uint8Array(), 42n).state,
      ).toBe(1);
      expect(c.persistState).toHaveBeenCalledTimes(2);
    } finally {
      backend.close();
    }
  });
  it('reports loading only during wake and never fabricates a NetCL without cached state', () => {
    const c = context(encodeSatisfactoryPoll(1n));
    expect(decodeSatisfactoryState(adapter.response(c, 'waking') ?? new Uint8Array()).state).toBe(
      2,
    );
    delete c.route.protocol?.satisfactory;
    expect(adapter.response(c, 'sleeping')).toBeUndefined();
  });
  it('does not treat arbitrary gameplay or TLS bytes as authenticated join intent', () => {
    const c = context(new Uint8Array([1, 2, 3]));
    expect(adapter.classify(c.input ?? new Uint8Array(), c)).toEqual({ kind: 'ignore' });
  });
});

describe('authenticated Satisfactory player observations', () => {
  function observedAdapter() {
    const adapter = createSatisfactoryGatewayAdapter({ read: () => undefined, write: () => {} });
    adapter.probeReadiness = async () => ({ ready: true });
    return adapter;
  }
  it('preserves independent readiness when no application credential or API response exists', async () => {
    const adapter = observedAdapter(),
      c = context(encodeSatisfactoryPoll(1n));
    expect(await adapter.observe?.(c)).toEqual({ ready: true });
    c.observeApplication = async () => {
      throw new Error('no token');
    };
    expect(await adapter.observe?.(c)).toEqual({ ready: true });
  });
  it('propagates a fresh authenticated player count across ordered roles in the same generation', async () => {
    const adapter = observedAdapter(),
      c = context(encodeSatisfactoryPoll(1n));
    c.observeApplication = async () => ({ ready: true, idle: true, playerCount: 0 });
    expect(await adapter.observe?.(c)).toEqual({ ready: true, idle: true, playerCount: 0 });
    const reliable = {
      ...c,
      route: {
        ...c.route,
        public: { ...c.route.public, transport: 'tcp' as const },
        protocol: { handlerId: 'satisfactory', gameVersion: 'public', role: 'reliable' },
      },
    };
    reliable.observeApplication = async () => {
      throw new Error('must not call API from reliable role');
    };
    expect(await adapter.observe?.(reliable)).toEqual({ ready: true, idle: true, playerCount: 0 });
    expect(
      await adapter.observe?.({
        ...reliable,
        route: { ...reliable.route, generation: '99999999-9999-4999-8999-999999999999' },
      }),
    ).toEqual({ ready: true });
  });
  it('never turns invalid, unavailable, or active-player samples into an idle claim', async () => {
    const adapter = observedAdapter(),
      c = context(encodeSatisfactoryPoll(1n));
    c.observeApplication = async () => ({ ready: true, idle: false, playerCount: 2 });
    expect(await adapter.observe?.(c)).toEqual({ ready: true, idle: false, playerCount: 2 });
    c.observeApplication = async () => ({ ready: false, idle: true, playerCount: 0 });
    expect(await adapter.observe?.(c)).toEqual({ ready: true });
    c.observeApplication = async () => ({ ready: true, idle: true, playerCount: Number.NaN });
    expect(await adapter.observe?.(c)).toEqual({ ready: true });
  });
});

it('expires cached application observations without inventing zero players', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const adapter = createSatisfactoryGatewayAdapter({ read: () => undefined, write: () => {} });
    adapter.probeReadiness = async () => ({ ready: true });
    const c = context(encodeSatisfactoryPoll(1n));
    c.observeApplication = async () => ({ ready: true, idle: true, playerCount: 0 });
    expect(await adapter.observe?.(c)).toMatchObject({ idle: true, playerCount: 0 });
    now.mockReturnValue(6001);
    const reliable = {
      ...c,
      route: {
        ...c.route,
        public: { ...c.route.public, transport: 'tcp' as const },
        protocol: { handlerId: 'satisfactory', gameVersion: 'public', role: 'reliable' },
      },
    };
    expect(await adapter.observe?.(reliable)).toEqual({ ready: true });
  } finally {
    now.mockRestore();
  }
});

it('never reuses readiness from another process generation for Reliable Messaging', async () => {
  const udp = createSocket('udp4');
  udp.bind(0, '127.0.0.1');
  await once(udp, 'listening');
  const tcp = createServer((socket) => socket.destroy());
  tcp.listen(0, '127.0.0.1');
  await once(tcp, 'listening');
  udp.on('message', (bytes, remote) => {
    const poll = decodeSatisfactoryPoll(bytes);
    if (poll)
      udp.send(
        encodeSatisfactoryState(poll.cookie, {
          state: 3,
          netCL: 123,
          flags: 0n,
          substates: [],
          name: 'Factory',
        }),
        remote.port,
        remote.address,
      );
  });
  try {
    const adapter = createSatisfactoryGatewayAdapter({ read: () => undefined, write: () => {} });
    const c = context(encodeSatisfactoryPoll(1n));
    c.route = {
      ...c.route,
      backend: { address: '127.0.0.1', allocationAddress: '127.0.0.1', port: udp.address().port },
    };
    expect(await adapter.probeReadiness(c)).toEqual({ ready: true });
    const address = tcp.address();
    if (!address || typeof address === 'string') throw new Error('bind');
    const reliable = {
      ...c,
      route: {
        ...c.route,
        public: { ...c.route.public, transport: 'tcp' as const },
        backend: { ...c.route.backend, port: address.port },
        protocol: { handlerId: 'satisfactory', gameVersion: 'public', role: 'reliable' },
      },
    };
    expect(await adapter.probeReadiness(reliable)).toEqual({ ready: true });
    expect(
      await adapter.probeReadiness({
        ...reliable,
        route: { ...reliable.route, generation: '99999999-9999-4999-8999-999999999999' },
      }),
    ).toEqual({ ready: false });
  } finally {
    udp.close();
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
  }
});
