import { randomUUID } from 'node:crypto';
import { createSocket, Socket as DatagramSocket } from 'node:dgram';
import { once } from 'node:events';
import { connect, createServer, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError } from '@nickhosting/core';
import type {
  GatewayControl,
  GatewayMode,
  GatewayProtocolAdapter,
  GatewayRoute,
  GatewaySafety,
  GatewaySnapshot,
} from '@nickhosting/game-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMinecraftProtocolAdapter,
  encodeMinecraftVarInt,
  frameMinecraftPacket,
  readMinecraftFrame,
} from '../../../games/minecraft/src/protocol.js';
import { GatewayRouteRevisionStaleError } from './control-client.js';
import { createGatewayDataPlane, type GatewayDataPlanePolicy } from './data-plane.js';

const policy: GatewayDataPlanePolicy = {
  maximumLeaseMs: 60000,
  maxClockSkewMs: 1000,
  pollIntervalMs: 60000,
  observationIntervalMs: 60000,
  probeTimeoutMs: 1000,
  tcpConnectTimeoutMs: 1000,
  tcpIdleTimeoutMs: 2000,
  classificationTimeoutMs: 500,
  maxClassificationBytes: 1024,
  maxProtocolResponseBytes: 1024,
  maxTcpConnections: 100,
  maxUdpSessions: 100,
  udpIdleTimeoutMs: 200,
  maxUdpQueuedBytes: 65536,
  wakeRetryMs: 500,
  gracefulShutdownMs: 50,
};
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function tcpFixture(host = '127.0.0.2', handler?: (socket: Socket) => void) {
  const clients = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    clients.add(socket);
    socket.once('close', () => clients.delete(socket));
    socket.on('error', () => {});
    if (handler) handler(socket);
    else socket.pipe(socket);
  });
  server.listen(0, host);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture listener missing');
  cleanups.push(async () => {
    for (const socket of clients) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: address.port, server };
}
async function udpFixture(port = 0, host = '127.0.0.2') {
  const socket = createSocket('udp4');
  socket.bind(port, host);
  await once(socket, 'listening');
  socket.on('message', (bytes, remote) => socket.send(bytes, remote.port, remote.address));
  cleanups.push(async () => new Promise<void>((resolve) => socket.close(() => resolve())));
  return { port: socket.address().port, socket };
}
function route(
  port: number,
  transport: 'tcp' | 'udp' = 'tcp',
  mode: GatewayMode = 'online',
): GatewayRoute {
  return {
    id: randomUUID(),
    serverId: randomUUID(),
    nodeId: randomUUID(),
    allocationId: randomUUID(),
    revision: 1,
    generation: randomUUID(),
    public: { address: '127.0.0.1', port, transport },
    backend: { allocationAddress: '127.0.0.1', address: '127.0.0.2', port },
    mode,
    locale: 'en',
    protocol: { handlerId: 'fixture', gameVersion: '1', role: 'game' },
  };
}
function fixtureProtocol(overrides: Partial<GatewayProtocolAdapter> = {}): GatewayProtocolAdapter {
  return {
    id: 'fixture',
    supports: () => true,
    classify(bytes) {
      const input = Buffer.from(bytes).toString();
      if (!input.endsWith('\n')) return { kind: 'need-more' };
      return {
        kind: input === 'STATUS\n' ? 'status' : input === 'JOIN\n' ? 'join' : 'unsupported',
      };
    },
    response: (_, state) => Buffer.from(`${state}\n`),
    probeReadiness: async () => ({ ready: true }),
    ...overrides,
  };
}
function plane(
  routes: GatewayRoute[],
  options: {
    control?: Partial<GatewayControl>;
    safety?: Partial<GatewaySafety>;
    protocols?: GatewayProtocolAdapter[];
    policy?: Partial<GatewayDataPlanePolicy>;
    lease?: number;
    now?: () => number;
  } = {},
) {
  const gatewayId = randomUUID();
  const snapshot = (
    nextRoutes = routes,
    revision = 1,
    lease = options.lease ?? 60000,
  ): GatewaySnapshot => {
    const timestamp = (options.now ?? Date.now)();
    return {
      gatewayId,
      revision,
      issuedAt: new Date(timestamp).toISOString(),
      expiresAt: new Date(timestamp + lease).toISOString(),
      routes: nextRoutes,
    };
  };
  const control: GatewayControl = {
    fetchSnapshot: vi.fn(async () => snapshot()),
    requestWake: vi.fn(async () => ({ mode: 'waking' as const })),
    reportObservation: vi.fn(async () => {}),
    ...options.control,
  };
  const safety = {
    validate: vi.fn(async () => {}),
    validateBackend: vi.fn(async () => {}),
    ...options.safety,
  };
  const gateway = createGatewayDataPlane({
    gatewayId,
    control,
    safety,
    protocols: options.protocols ?? [fixtureProtocol()],
    policy: { ...policy, ...options.policy },
    now: options.now,
  });
  cleanups.push(() => gateway.stop());
  return { gateway, snapshot, control, safety };
}
async function exchange(
  port: number,
  data: Uint8Array | string,
  fragments = false,
  host = '127.0.0.1',
) {
  const socket = connect({ host, port });
  const chunks: Buffer[] = [];
  socket.on('data', (bytes: Buffer) => chunks.push(bytes));
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  await once(socket, 'connect');
  if (fragments) {
    socket.write(Buffer.from(data).subarray(0, 2));
    await delay(15);
    socket.end(Buffer.from(data).subarray(2));
  } else socket.end(data);
  await closed;
  return Buffer.concat(chunks);
}
async function datagram(port: number, data: string, client?: DatagramSocket) {
  const socket = client ?? createSocket('udp4');
  if (!client)
    cleanups.push(async () => new Promise<void>((resolve) => socket.close(() => resolve())));
  const response = once(socket, 'message', { signal: AbortSignal.timeout(3000) });
  socket.send(data, port, '127.0.0.1');
  return (await response)[0] as Buffer;
}
async function refuses(port: number) {
  await expect(
    new Promise<void>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', reject);
    }),
  ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
}

describe('persistent Gateway fixture forwarding', () => {
  it('runs actual Minecraft status/ping dialogue without wakes and distinguishes compatible joins', async () => {
    const backend = await tcpFixture();
    const minecraft = createMinecraftProtocolAdapter({
      versions: [
        { release: '1.20.4', protocolId: 765, family: 'netty', transfer: false },
        { release: '1.20.5', protocolId: 766, family: 'netty', transfer: true },
      ],
      supportedReleases: ['1.20.5'],
    });
    const gameRoute = route(backend.port, 'tcp', 'sleeping');
    gameRoute.protocol = {
      handlerId: 'minecraft-java',
      gameVersion: '1.20.5',
      role: 'game',
      minecraft: {
        release: '1.20.5',
        protocolId: 766,
        family: 'netty',
        transfer: true,
        acceptsTransfers: false,
        choiceId: randomUUID(),
        choiceDigest: 'a'.repeat(64),
        evidenceRunId: randomUUID(),
        evidenceExpiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    };
    const f = plane([gameRoute], { protocols: [minecraft] });
    await f.gateway.start();
    const handshake = (intent: number, version = 766) =>
      frameMinecraftPacket(
        0,
        Buffer.concat([
          encodeMinecraftVarInt(version),
          Buffer.from([9]),
          Buffer.from('localhost'),
          Buffer.from([0x63, 0xdd, intent]),
        ]),
      );
    const probes = await Promise.all(
      Array.from({ length: 16 }, async (_, index) => {
        const nonce = Buffer.alloc(8, index);
        const response = await exchange(
          backend.port,
          Buffer.concat([handshake(1), frameMinecraftPacket(0), frameMinecraftPacket(1, nonce)]),
          true,
        );
        const status = readMinecraftFrame(response, 1024);
        expect(status?.body[0]).toBe(0);
        expect(status?.body.toString()).toContain('sleeping');
        expect(response.subarray(status?.bytes)).toEqual(frameMinecraftPacket(1, nonce));
      }),
    );
    expect(probes).toHaveLength(16);
    expect(f.control.requestWake).not.toHaveBeenCalled();
    expect((await exchange(backend.port, handshake(2, 765))).toString()).toContain(
      'version selected',
    );
    expect((await exchange(backend.port, handshake(3))).toString()).toContain('directly');
    expect(await exchange(backend.port, handshake(2, 999999))).toHaveLength(0);
    expect(f.control.requestWake).not.toHaveBeenCalled();
    const joins = await Promise.all(
      Array.from({ length: 16 }, () => exchange(backend.port, handshake(2))),
    );
    expect(joins.every((bytes) => bytes.toString().includes('starting'))).toBe(true);
    expect(f.control.requestWake).toHaveBeenCalledTimes(1);
    const stopped = { ...gameRoute, revision: 2, mode: 'manually_stopped' as const };
    await f.gateway.applySnapshot(f.snapshot([stopped], 2));
    expect((await exchange(backend.port, handshake(2))).toString()).toContain(
      'Start it from the panel',
    );
    expect(f.control.requestWake).toHaveBeenCalledTimes(1);
  });
  it('isolates stateful offline conversations, retaining status sockets for ping without waking', async () => {
    const backend = await tcpFixture();
    const signals: AbortSignal[] = [];
    const protocol = fixtureProtocol({
      classify: () => {
        throw new Error('stateless fallback used');
      },
      createSession(context) {
        signals.push(context.signal);
        let first = true;
        let echo = '';
        return {
          classify(input) {
            const text = Buffer.from(input).toString();
            const newline = text.indexOf('\n');
            if (newline < 0) return { kind: 'need-more', consumedBytes: 0 };
            const line = text.slice(0, newline);
            echo = line;
            const kind =
              first && line === 'STATUS'
                ? 'status'
                : !first && line.startsWith('PING:')
                  ? 'status'
                  : 'unsupported';
            first = false;
            return { kind, consumedBytes: newline + 1 };
          },
          response(mode) {
            return {
              bytes: Buffer.from(`${echo === 'STATUS' ? mode : echo}\n`),
              close: echo !== 'STATUS',
            };
          },
        };
      },
    });
    const f = plane([route(backend.port, 'tcp', 'sleeping')], { protocols: [protocol] });
    await f.gateway.start();
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        exchange(backend.port, `STATUS\nPING:${index}\n`, true),
      ),
    );
    expect(responses.map((value) => value.toString())).toEqual(
      Array.from({ length: 12 }, (_, index) => `sleeping\nPING:${index}\n`),
    );
    expect(f.control.requestWake).not.toHaveBeenCalled();
    expect(signals).toHaveLength(12);
    await delay(10);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
  it('bounds the entire stateful conversation and refuses invalid consumption instead of looping', async () => {
    const backend = await tcpFixture();
    const protocol = fixtureProtocol({
      createSession() {
        return {
          classify: (bytes) => ({ kind: 'status', consumedBytes: bytes.length }),
          response: () => ({ bytes: Buffer.from('reply'), close: false }),
        };
      },
    });
    const f = plane([route(backend.port, 'tcp', 'sleeping')], {
      protocols: [protocol],
      policy: { maxProtocolResponseBytes: 4 },
    });
    await f.gateway.start();
    expect(await exchange(backend.port, 'STATUS')).toHaveLength(0);
    expect(f.control.requestWake).not.toHaveBeenCalled();
    await f.gateway.stop();
    for (const consumedBytes of [0, -1, 1000, Number.NaN]) {
      const invalid = plane([route(backend.port, 'tcp', 'sleeping')], {
        protocols: [
          fixtureProtocol({
            createSession: () => ({
              classify: () => ({ kind: 'continue', consumedBytes }),
              response: () => ({ close: false }),
            }),
          }),
        ],
      });
      await invalid.gateway.start();
      expect(await exchange(backend.port, 'request')).toHaveLength(0);
      await invalid.gateway.stop();
    }
  });
  it('deduplicates stateful joins and rejects explicit incompatible intents without waking', async () => {
    const backend = await tcpFixture();
    const protocol = fixtureProtocol({
      createSession: () => ({
        classify: (bytes) => ({
          kind: Buffer.from(bytes).toString() === 'JOIN' ? 'join' : 'reject',
          consumedBytes: bytes.length,
        }),
        response: (mode) => ({ bytes: Buffer.from(mode), close: true }),
      }),
    });
    const f = plane([route(backend.port, 'tcp', 'sleeping')], { protocols: [protocol] });
    await f.gateway.start();
    expect((await exchange(backend.port, 'MISMATCH')).toString()).toBe('sleeping');
    expect(f.control.requestWake).not.toHaveBeenCalled();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => exchange(backend.port, 'JOIN')),
    );
    expect(results.every((bytes) => bytes.toString() === 'waking')).toBe(true);
    expect(f.control.requestWake).toHaveBeenCalledTimes(1);
  });
  it('preserves online opaque forwarding even when a stateful game parser would reject it', async () => {
    const backend = await tcpFixture();
    const createSession = vi.fn(() => {
      throw new Error('must not parse ready traffic');
    });
    const f = plane([route(backend.port)], { protocols: [fixtureProtocol({ createSession })] });
    await f.gateway.start();
    const encrypted = Buffer.alloc(65536, 0xff);
    expect(await exchange(backend.port, encrypted)).toEqual(encrypted);
    expect(createSession).not.toHaveBeenCalled();
  });
  it('streams binary TCP with half-close and concurrent clients on the same numeric port at distinct addresses', async () => {
    const backend = await tcpFixture();
    const f = plane([route(backend.port)]);
    await f.gateway.start();
    const payload = Buffer.alloc(2 * 1024 * 1024, 0xa5);
    const results = await Promise.all([
      exchange(backend.port, payload),
      ...Array.from({ length: 24 }, (_, i) => exchange(backend.port, `client-${i}`)),
    ]);
    expect(results[0]).toEqual(payload);
    expect(results.slice(1).map((bytes) => bytes.toString())).toEqual(
      Array.from({ length: 24 }, (_, i) => `client-${i}`),
    );
    // Full validation includes backend proof, once initially and once directly
    // before binding; an extra standalone proof would duplicate both inspections.
    expect(f.safety.validate).toHaveBeenCalledTimes(2);
    expect(f.safety.validateBackend).not.toHaveBeenCalled();
    expect(f.control.requestWake).not.toHaveBeenCalled();
    expect(f.gateway.metrics().tcpBytesToClient).toBeGreaterThanOrEqual(payload.length);
  });
  it('forwards UDP for multiple roles and concurrent clients, with idle session cleanup', async () => {
    const game = await udpFixture();
    const query = await udpFixture();
    const a = route(game.port, 'udp');
    const b = { ...route(query.port, 'udp'), serverId: a.serverId };
    const f = plane([a, b]);
    await f.gateway.start();
    const result = await Promise.all(
      Array.from({ length: 20 }, (_, i) => datagram(i % 2 ? query.port : game.port, `packet-${i}`)),
    );
    expect(result.map((value) => value.toString())).toEqual(
      Array.from({ length: 20 }, (_, i) => `packet-${i}`),
    );
    expect(f.gateway.health().udpSessions).toBe(20);
    await delay(450);
    expect(f.gateway.health().udpSessions).toBe(0);
    expect(f.gateway.metrics().udpBytesToClient).toBeGreaterThan(100);
  });
  it('supports both transports on the same numerical endpoint without merging sessions', async () => {
    const tcp = await tcpFixture();
    await udpFixture(tcp.port);
    const a = route(tcp.port);
    const b = { ...route(tcp.port, 'udp'), serverId: a.serverId };
    const f = plane([a, b]);
    await f.gateway.start();
    expect((await exchange(tcp.port, 'tcp')).toString()).toBe('tcp');
    expect((await datagram(tcp.port, 'udp')).toString()).toBe('udp');
  });
  it('accepts UDP replies only from the connected backend endpoint', async () => {
    const backend = await udpFixture();
    const f = plane([route(backend.port, 'udp')]);
    await f.gateway.start();
    const client = createSocket('udp4');
    cleanups.push(async () => new Promise<void>((resolve) => client.close(() => resolve())));
    const received: string[] = [];
    client.on('message', (bytes) => received.push(bytes.toString()));
    const observed = once(backend.socket, 'message');
    await datagram(backend.port, 'genuine', client);
    const [, remote] = (await observed) as [Buffer, { address: string; port: number }];
    const attacker = createSocket('udp4');
    attacker.send('forged', remote.port, remote.address);
    await delay(40);
    attacker.close();
    expect(received).toEqual(['genuine']);
    expect((await datagram(backend.port, 'still-genuine', client)).toString()).toBe(
      'still-genuine',
    );
  });
  it('refuses collisions without taking an already bound unrelated endpoint', async () => {
    const direct = await tcpFixture('127.0.0.1');
    const f = plane([route(direct.port)]);
    await f.gateway.start();
    expect(f.gateway.health().routes).toBe(0);
    expect(f.gateway.metrics().snapshotErrors).toBe(1);
    expect((await exchange(direct.port, 'direct')).toString()).toBe('direct');
  });
  it('requires fresh safety verification before opening any listener or accepting an online backend', async () => {
    const backend = await tcpFixture();
    const validate = vi.fn<GatewaySafety['validate']>(async () => {
      throw new DomainError('provenance_mismatch');
    });
    const f = plane([route(backend.port)], { safety: { validate } });
    await f.gateway.start();
    await refuses(backend.port);
    expect(f.safety.validateBackend).not.toHaveBeenCalled();
    validate.mockResolvedValue(undefined);
    // The complete safety contract rejects an online route whose backend
    // binding or namespace protocol reachability cannot be proved.
    validate.mockRejectedValueOnce(new DomainError('integration_unavailable'));
    await expect(f.gateway.refresh()).rejects.toThrow('integration_unavailable');
    await refuses(backend.port);
    await f.gateway.refresh();
    expect((await exchange(backend.port, 'verified')).toString()).toBe('verified');
  });
  it('rolls back all staged listeners when a later bind collides', async () => {
    const backend = await tcpFixture();
    const direct = await tcpFixture('127.0.0.1');
    const f = plane([route(backend.port), route(direct.port)]);
    await f.gateway.start();
    expect(f.gateway.health().routes).toBe(0);
    await refuses(backend.port);
    expect((await exchange(direct.port, 'still-direct')).toString()).toBe('still-direct');
  });
  it('refreshes topology immediately before binding after another route exhausts the earlier evidence TTL', async () => {
    const first = await tcpFixture();
    const second = await tcpFixture();
    const a = route(first.port);
    const b = route(second.port);
    const calls: string[] = [];
    let changed = false;
    const validate = vi.fn<GatewaySafety['validate']>(async (current) => {
      calls.push(current.id);
      if (current.id === b.id) {
        await delay(30);
        changed = true;
      }
      if (current.id === a.id && changed) throw new DomainError('allocation_unavailable');
    });
    const f = plane([a, b], { safety: { validate } });
    await f.gateway.start();
    expect(calls).toEqual([a.id, b.id, a.id]);
    expect(f.gateway.health().routes).toBe(0);
    await refuses(first.port);
    await refuses(second.port);
  });
  it('includes newly staged endpoints in each subsequent pre-bind topology verification', async () => {
    const first = await tcpFixture();
    const second = await tcpFixture();
    const a = route(first.port);
    const b = route(second.port);
    // Reserving ephemeral backend ports on 127.0.0.2 does not reserve those
    // numbers on 127.0.0.1. Other unit files bind independent ephemeral HTTP
    // listeners there, so give this successful-bind fixture its own address.
    const publicAddress = '127.0.0.70';
    a.public.address = publicAddress;
    b.public.address = publicAddress;
    const f = plane([a, b]);
    // Preserve native bind errors in a setup failure instead of start()'s
    // deliberate unavailable-control handling hiding their diagnostic cause.
    await f.gateway.applySnapshot(f.snapshot());
    expect(f.safety.validate).toHaveBeenCalledTimes(4);
    expect(vi.mocked(f.safety.validate).mock.calls[3]).toEqual([b, [a.public]]);
    expect((await exchange(first.port, 'first', false, publicAddress)).toString()).toBe('first');
    expect((await exchange(second.port, 'second', false, publicAddress)).toString()).toBe('second');
  });
  it('preserves an occupied public endpoint when a two-route fixture fails its first native bind', async () => {
    const direct = await tcpFixture('127.0.0.1');
    const backend = await tcpFixture();
    const first = route(direct.port);
    const second = route(backend.port);
    const f = plane([first, second]);
    await expect(f.gateway.applySnapshot(f.snapshot())).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    // Both route preflights and only the first immediate pre-bind check run.
    expect(f.safety.validate).toHaveBeenCalledTimes(3);
    expect(f.gateway.health().routes).toBe(0);
    expect((await exchange(direct.port, 'unrelated fixture')).toString()).toBe('unrelated fixture');
  });
});

describe('sleep protocol handling and observations', () => {
  it('answers fragmented passive status without waking and coalesces burst intentional joins', async () => {
    const backend = await tcpFixture();
    const r = route(backend.port, 'tcp', 'sleeping');
    const f = plane([r], {
      control: {
        requestWake: vi.fn(async () => {
          await delay(30);
          return { mode: 'waking' as const };
        }),
      },
    });
    await f.gateway.start();
    expect((await exchange(backend.port, 'STATUS\n', true)).toString()).toBe('sleeping\n');
    expect(f.control.requestWake).not.toHaveBeenCalled();
    const result = await Promise.all(
      Array.from({ length: 30 }, () => exchange(backend.port, 'JOIN\n')),
    );
    expect(result.every((value) => value.toString() === 'waking\n')).toBe(true);
    expect(f.control.requestWake).toHaveBeenCalledOnce();
  });
  it('coalesces an in-flight wake even when the retry cooldown has elapsed', async () => {
    const backend = await tcpFixture();
    const f = plane([route(backend.port, 'tcp', 'sleeping')], {
      policy: { wakeRetryMs: 5 },
      control: {
        requestWake: vi.fn(async () => {
          await delay(60);
          return { mode: 'waking' as const };
        }),
      },
    });
    await f.gateway.start();
    const first = exchange(backend.port, 'JOIN\n');
    await delay(20);
    const second = exchange(backend.port, 'JOIN\n');
    expect((await Promise.all([first, second])).map((bytes) => bytes.toString())).toEqual([
      'waking\n',
      'waking\n',
    ]);
    expect(f.control.requestWake).toHaveBeenCalledOnce();
  });
  it.each(['manually_stopped', 'maintenance', 'waking'] as const)(
    'suppresses automatic wake in %s mode',
    async (mode) => {
      const backend = await tcpFixture();
      const f = plane([route(backend.port, 'tcp', mode)]);
      await f.gateway.start();
      expect((await exchange(backend.port, 'JOIN\n')).toString()).toBe(`${mode}\n`);
      expect(f.control.requestWake).not.toHaveBeenCalled();
    },
  );
  it('returns immediate resource denial and never queues retries or stops another server', async () => {
    const backend = await tcpFixture();
    const f = plane([route(backend.port, 'tcp', 'sleeping')], {
      control: {
        requestWake: vi.fn(async () => ({
          mode: 'blocked' as const,
          reasonKey: 'errors.resources_unavailable',
        })),
      },
    });
    await f.gateway.start();
    expect((await exchange(backend.port, 'JOIN\n')).toString()).toBe('blocked\n');
    expect(f.control.requestWake).toHaveBeenCalledOnce();
    await delay(50);
    expect(f.control.requestWake).toHaveBeenCalledOnce();
  });
  it('retries a blocked intentional join after capacity recovers without waking on passive status', async () => {
    const backend = await tcpFixture();
    const requestWake = vi
      .fn<GatewayControl['requestWake']>()
      .mockResolvedValueOnce({ mode: 'blocked', reasonKey: 'errors.resources_unavailable' })
      .mockResolvedValueOnce({ mode: 'waking' });
    const f = plane([route(backend.port, 'tcp', 'blocked')], {
      policy: { wakeRetryMs: 10 },
      control: { requestWake },
    });
    await f.gateway.start();
    expect((await exchange(backend.port, 'STATUS\n')).toString()).toBe('blocked\n');
    expect(requestWake).not.toHaveBeenCalled();
    expect((await exchange(backend.port, 'JOIN\n')).toString()).toBe('blocked\n');
    await delay(15);
    expect((await exchange(backend.port, 'JOIN\n')).toString()).toBe('waking\n');
    expect(requestWake).toHaveBeenCalledTimes(2);
  });
  it('does not wake on unknown protocols, oversized classifications or missing adapters', async () => {
    const backend = await tcpFixture();
    const f = plane([route(backend.port, 'tcp', 'sleeping')]);
    await f.gateway.start();
    expect((await exchange(backend.port, '???\n')).length).toBe(0);
    expect((await exchange(backend.port, 'X'.repeat(1025))).length).toBe(0);
    expect(f.control.requestWake).not.toHaveBeenCalled();
    await f.gateway.stop();
    const other = plane([route(backend.port, 'tcp', 'sleeping')], { protocols: [] });
    await other.gateway.start();
    expect((await exchange(backend.port, 'JOIN\n')).length).toBe(0);
    expect(other.control.requestWake).not.toHaveBeenCalled();
  });
  it('distinguishes UDP status from joins with the same wake coalescing rules', async () => {
    const backend = await udpFixture();
    const f = plane([route(backend.port, 'udp', 'sleeping')]);
    await f.gateway.start();
    expect((await datagram(backend.port, 'STATUS\n')).toString()).toBe('sleeping\n');
    expect(f.control.requestWake).not.toHaveBeenCalled();
    const result = await Promise.all(
      Array.from({ length: 10 }, () => datagram(backend.port, 'JOIN\n')),
    );
    expect(result.every((bytes) => bytes.toString() === 'waking\n')).toBe(true);
    expect(f.control.requestWake).toHaveBeenCalledOnce();
  });
  it('shares a bounded pending offline UDP work budget across all listeners', async () => {
    const first = await udpFixture();
    const second = await udpFixture();
    const releases: (() => void)[] = [];
    const requestWake = vi.fn<GatewayControl['requestWake']>(
      async () => new Promise((resolve) => releases.push(() => resolve({ mode: 'waking' }))),
    );
    const f = plane([route(first.port, 'udp', 'sleeping'), route(second.port, 'udp', 'sleeping')], {
      policy: { maxUdpSessions: 2 },
      control: { requestWake },
    });
    await f.gateway.start();
    const client = createSocket('udp4');
    cleanups.push(async () => new Promise<void>((resolve) => client.close(() => resolve())));
    client.send('JOIN\n', first.port, '127.0.0.1');
    client.send('JOIN\n', second.port, '127.0.0.1');
    await vi.waitFor(() => expect(requestWake).toHaveBeenCalledTimes(2));
    client.send('STATUS\n', first.port, '127.0.0.1');
    client.send('STATUS\n', second.port, '127.0.0.1');
    await vi.waitFor(() => expect(f.gateway.metrics().udpDropped).toBe(2));
    for (const release of releases) release();
    await delay(20);
    expect((await datagram(second.port, 'STATUS\n', client)).toString()).toBe('sleeping\n');
  });
  it('drops offline protocol responses when the UDP response queue is saturated', async () => {
    const backend = await udpFixture();
    const f = plane([route(backend.port, 'udp', 'sleeping')], {
      policy: { maxUdpQueuedBytes: 32 },
    });
    await f.gateway.start();
    const client = createSocket('udp4');
    cleanups.push(async () => new Promise<void>((resolve) => client.close(() => resolve())));
    const received: Buffer[] = [];
    client.on('message', (bytes) => received.push(bytes));
    const queue = vi.spyOn(DatagramSocket.prototype, 'getSendQueueSize').mockReturnValue(32);
    try {
      client.send('STATUS\n', backend.port, '127.0.0.1');
      await vi.waitFor(() => expect(f.gateway.metrics().udpDropped).toBe(1));
      expect(received).toHaveLength(0);
    } finally {
      queue.mockRestore();
    }
    expect((await datagram(backend.port, 'STATUS\n', client)).toString()).toBe('sleeping\n');
  });
  it('reports real fixture protocol readiness and only explicit protocol idleness', async () => {
    let ready = false;
    const backend = await tcpFixture('127.0.0.2', (socket) =>
      socket.once('data', () => socket.end(ready ? 'READY' : 'LOADING')),
    );
    const r = { ...route(backend.port, 'tcp', 'waking'), wakeJobId: randomUUID() };
    const handler = fixtureProtocol({
      probeReadiness: async ({ route: current, signal }) => {
        const socket = connect({
          host: current.backend.address,
          port: current.backend.port,
          signal,
        });
        const result = once(socket, 'data');
        socket.end('PROBE');
        const [bytes] = await result;
        socket.destroy();
        return { ready: (bytes as Buffer).toString() === 'READY' };
      },
      probeIdle: async () => ({ idle: true, playerCount: 0 }),
    });
    const f = plane([r], { protocols: [handler] });
    await f.gateway.start();
    await f.gateway.observe();
    expect(f.control.reportObservation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ready: false,
        idle: false,
        generation: r.generation,
        wakeJobId: r.wakeJobId,
      }),
    );
    ready = true;
    await f.gateway.observe();
    expect(f.control.reportObservation).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: true, idle: true, playerCount: 0, activeSessions: 0 }),
    );
  });
  it('bounds failed/hung protocol observations and permits subsequent recovery', async () => {
    const backend = await tcpFixture();
    const handler = fixtureProtocol({
      probeReadiness: vi.fn(async () => new Promise<{ ready: boolean }>(() => {})),
    });
    const f = plane([route(backend.port, 'tcp', 'waking')], {
      protocols: [handler],
      policy: { probeTimeoutMs: 30 },
    });
    await f.gateway.start();
    await f.gateway.observe();
    expect(f.control.reportObservation).toHaveBeenCalledWith(
      expect.objectContaining({ ready: false, idle: false }),
    );
    expect(f.gateway.metrics().observationErrors).toBe(1);
    vi.mocked(handler.probeReadiness).mockResolvedValue({ ready: true });
    await f.gateway.observe();
    expect(f.control.reportObservation).toHaveBeenCalledTimes(2);
  });
  it.each(['waking', 'online'] as const)(
    'completes a slow %s observation across repeated equivalent lease renewals with its original deadline',
    async (mode) => {
      const backend = await tcpFixture();
      let clock = Date.now();
      const initial = clock;
      const entered = Promise.withResolvers<void>();
      const readiness = Promise.withResolvers<{ ready: boolean }>();
      const r = {
        ...route(backend.port, 'tcp', mode),
        sleepEligibleAt: mode === 'online' ? new Date(clock - 1000).toISOString() : undefined,
      };
      const f = plane([r], {
        now: () => clock,
        lease: 1000,
        protocols: [
          fixtureProtocol({
            probeReadiness: async () => {
              entered.resolve();
              return readiness.promise;
            },
            probeIdle: async () => ({ idle: true, playerCount: 0 }),
          }),
        ],
      });
      await f.gateway.start();
      const observing = f.gateway.observe();
      await entered.promise;
      for (let renewal = 1; renewal <= 5; renewal++) {
        clock = initial + renewal * 50;
        await f.gateway.applySnapshot(f.snapshot([r], 1, 10000));
      }
      expect(f.control.reportObservation).not.toHaveBeenCalled();
      readiness.resolve({ ready: true });
      await observing;
      expect(f.control.reportObservation).toHaveBeenCalledOnce();
      expect(f.control.reportObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          routeId: r.id,
          routeRevision: r.revision,
          generation: r.generation,
          ready: true,
          idle: true,
          observedAt: new Date(initial).toISOString(),
          quiescenceUntil: mode === 'online' ? new Date(initial + 1000).toISOString() : undefined,
        }),
      );
      expect(f.gateway.health().expiresAt).toBe(new Date(clock + 10000).toISOString());
      expect(f.gateway.metrics().observationsDiscarded).toBe(0);
    },
  );
  it.each([
    'revision',
    'generation',
    'mode',
    'protocol',
    'backend',
    'new-role',
    'revoked',
  ] as const)(
    'discards a slow observation when %s authority changes during its probe',
    async (change) => {
      const backend = await tcpFixture();
      const extra = await tcpFixture();
      const entered = Promise.withResolvers<void>();
      const readiness = Promise.withResolvers<{ ready: boolean }>();
      const r = route(backend.port, 'tcp', 'waking');
      const f = plane([r], {
        protocols: [
          fixtureProtocol({
            probeReadiness: async () => {
              entered.resolve();
              return readiness.promise;
            },
            probeIdle: async () => ({ idle: true, playerCount: 0 }),
          }),
        ],
      });
      await f.gateway.start();
      const observing = f.gateway.observe();
      await entered.promise;
      const updated = {
        ...r,
        revision: 2,
        ...(change === 'generation' ? { generation: randomUUID() } : {}),
        ...(change === 'mode' ? { mode: 'maintenance' as const } : {}),
        ...(change === 'protocol'
          ? { protocol: { handlerId: 'fixture', role: 'game', gameVersion: '2' } }
          : {}),
        ...(change === 'backend' ? { backend: { ...r.backend, port: extra.port } } : {}),
      };
      const next =
        change === 'revoked'
          ? []
          : change === 'new-role'
            ? [
                updated,
                {
                  ...route(extra.port, 'tcp', 'waking'),
                  serverId: r.serverId,
                  generation: r.generation,
                },
              ]
            : [updated];
      await f.gateway.applySnapshot(f.snapshot(next, 2));
      readiness.resolve({ ready: true });
      await observing;
      expect(f.control.reportObservation).not.toHaveBeenCalled();
      expect(f.gateway.health().quiescentServers).toBe(0);
      expect(f.gateway.metrics()).toMatchObject({ observationsDiscarded: 1, observationErrors: 0 });
    },
  );
  it.each(['original', 'renewed'] as const)(
    'discards a slow observation when the %s lease expires despite equivalent routes',
    async (expired) => {
      const backend = await tcpFixture();
      let clock = Date.now();
      const initial = clock;
      const entered = Promise.withResolvers<void>();
      const readiness = Promise.withResolvers<{ ready: boolean }>();
      const r = route(backend.port, 'tcp', 'waking');
      const f = plane([r], {
        now: () => clock,
        lease: 100,
        protocols: [
          fixtureProtocol({
            probeReadiness: async () => {
              entered.resolve();
              return readiness.promise;
            },
          }),
        ],
      });
      await f.gateway.start();
      const observing = f.gateway.observe();
      await entered.promise;
      clock = initial + 10;
      await f.gateway.applySnapshot(f.snapshot([r], 1, expired === 'original' ? 1000 : 10));
      clock = initial + (expired === 'original' ? 110 : 30);
      readiness.resolve({ ready: true });
      await observing;
      expect(f.control.reportObservation).not.toHaveBeenCalled();
      expect(f.gateway.metrics()).toMatchObject({ observationsDiscarded: 1, observationErrors: 0 });
    },
  );
  it('probes and reports first-run readiness even while the listener remains unsafe to bind', async () => {
    const backend = await tcpFixture();
    const r = route(backend.port, 'tcp', 'waking');
    const f = plane([r], {
      safety: {
        validate: vi.fn(async () => {
          throw new DomainError('integration_unavailable');
        }),
      },
    });
    await f.gateway.start();
    expect(f.gateway.health().routes).toBe(0);
    await refuses(backend.port);
    await f.gateway.observe();
    expect(f.control.reportObservation).toHaveBeenCalledWith(
      expect.objectContaining({ routeId: r.id, ready: true, activeSessions: 0 }),
    );
    expect(f.safety.validateBackend).toHaveBeenCalledTimes(2);
  });
  it('counts active sessions across every port before reporting protocol idleness', async () => {
    const tcp = await tcpFixture();
    const udp = await udpFixture();
    const first = route(tcp.port);
    const second = {
      ...route(udp.port, 'udp'),
      serverId: first.serverId,
      generation: first.generation,
    };
    const f = plane([first, second], {
      protocols: [fixtureProtocol({ probeIdle: async () => ({ idle: true, playerCount: 0 }) })],
    });
    await f.gateway.start();
    const socket = connect(tcp.port, '127.0.0.1');
    await once(socket, 'connect');
    cleanups.push(async () => {
      socket.destroy();
    });
    await datagram(udp.port, 'active');
    await f.gateway.observe();
    expect(f.control.reportObservation).toHaveBeenCalledOnce();
    for (const [observation] of vi.mocked(f.control.reportObservation).mock.calls)
      expect(observation).toMatchObject({ activeSessions: 2, idle: false });
  });
  it.each([
    'loading',
    'missing-adapter',
    'failed-readiness',
    'missing-idle',
    'failed-idle',
    'busy',
    'unknown-player-count',
  ] as const)(
    'cannot mark a multiport server asleep or falsely ready with a %s sibling role',
    async (condition) => {
      const first = await tcpFixture();
      const second = await udpFixture();
      const a = route(first.port, 'tcp', 'waking');
      const b: GatewayRoute = {
        ...route(second.port, 'udp', 'waking'),
        serverId: a.serverId,
        generation: a.generation,
        protocol: { handlerId: 'secondary', gameVersion: '1', role: 'query' },
      };
      const primary = fixtureProtocol({ probeIdle: async () => ({ idle: true, playerCount: 0 }) });
      const secondary = fixtureProtocol({
        id: 'secondary',
        probeReadiness: async () => {
          if (condition === 'failed-readiness') throw new Error('fixture');
          return { ready: condition !== 'loading' };
        },
        probeIdle:
          condition === 'missing-idle'
            ? undefined
            : async () => {
                if (condition === 'failed-idle') throw new Error('fixture');
                return {
                  idle: condition !== 'busy',
                  playerCount:
                    condition === 'unknown-player-count' ? undefined : condition === 'busy' ? 2 : 0,
                };
              },
      });
      const f = plane([a, b], {
        protocols: condition === 'missing-adapter' ? [primary] : [primary, secondary],
      });
      await f.gateway.start();
      await f.gateway.observe();
      expect(f.control.reportObservation).toHaveBeenCalledOnce();
      const observation = vi.mocked(f.control.reportObservation).mock.calls[0]?.[0];
      expect(observation?.idle).toBe(false);
      if (['loading', 'missing-adapter', 'failed-readiness'].includes(condition))
        expect(observation?.ready).toBe(false);
      else expect(observation?.ready).toBe(true);
      expect(observation?.routes).toEqual(
        [a, b]
          .sort((x, y) => x.id.localeCompare(y.id))
          .map((r) => ({ routeId: r.id, routeRevision: r.revision })),
      );
    },
  );
  it('reports one deterministic complete-server observation only after all roles are ready and explicitly idle', async () => {
    const first = await tcpFixture();
    const second = await udpFixture();
    const a = route(first.port, 'tcp', 'waking');
    const b = {
      ...route(second.port, 'udp', 'waking'),
      serverId: a.serverId,
      generation: a.generation,
    };
    const f = plane([b, a], {
      protocols: [fixtureProtocol({ probeIdle: async () => ({ idle: true, playerCount: 0 }) })],
    });
    await f.gateway.start();
    await f.gateway.observe();
    const ordered = [a, b].sort((x, y) => x.id.localeCompare(y.id));
    expect(f.control.reportObservation).toHaveBeenCalledOnce();
    expect(f.control.reportObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        routeId: ordered[0]?.id,
        ready: true,
        idle: true,
        playerCount: 0,
        routes: ordered.map((r) => ({ routeId: r.id, routeRevision: r.revision })),
      }),
    );
  });
  it('reports the oldest included probe start even when a later role finishes much later', async () => {
    const first = await tcpFixture();
    const second = await udpFixture();
    let clock = Date.now();
    const started = clock;
    const a = { ...route(first.port), id: '00000000-0000-4000-8000-000000000001' };
    const b = {
      ...route(second.port, 'udp'),
      id: '00000000-0000-4000-8000-000000000002',
      serverId: a.serverId,
      generation: a.generation,
    };
    const f = plane([a, b], {
      now: () => clock,
      protocols: [
        fixtureProtocol({
          probeReadiness: async ({ route: current }) => {
            if (current.id === b.id) clock += 5000;
            return { ready: true };
          },
        }),
      ],
    });
    await f.gateway.start();
    await f.gateway.observe();
    expect(f.control.reportObservation).toHaveBeenCalledWith(
      expect.objectContaining({ observedAt: new Date(started).toISOString(), ready: true }),
    );
    expect(clock - started).toBe(5000);
  });
  it('synchronously fences every role before a held idle report, refusing a real concurrent TCP/UDP join', async () => {
    const tcp = await tcpFixture();
    const udp = await udpFixture();
    const a = { ...route(tcp.port), sleepEligibleAt: new Date(Date.now() - 1000).toISOString() };
    const b = {
      ...route(udp.port, 'udp'),
      serverId: a.serverId,
      generation: a.generation,
      sleepEligibleAt: a.sleepEligibleAt,
    };
    let finish: (() => void) | undefined;
    const reportObservation = vi.fn<GatewayControl['reportObservation']>(
      async () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const f = plane([a, b], {
      control: { reportObservation },
      protocols: [fixtureProtocol({ probeIdle: async () => ({ idle: true, playerCount: 0 }) })],
    });
    await f.gateway.start();
    const observing = f.gateway.observe();
    await vi.waitFor(() => expect(reportObservation).toHaveBeenCalledOnce());
    expect(f.gateway.health().quiescentServers).toBe(1);
    expect((await exchange(tcp.port, 'late-player').catch(() => Buffer.alloc(0))).length).toBe(0);
    const client = createSocket('udp4');
    client.send('late-datagram', udp.port, '127.0.0.1');
    await delay(20);
    client.close();
    expect(f.gateway.metrics()).toMatchObject({ tcpBytesToBackend: 0, udpBytesToBackend: 0 });
    expect(f.control.requestWake).not.toHaveBeenCalled();
    expect(reportObservation.mock.calls[0]?.[0]).toMatchObject({
      ready: true,
      idle: true,
      activeSessions: 0,
      quiescenceUntil: f.gateway.health().expiresAt,
    });
    await f.gateway.applySnapshot(f.snapshot([], 2));
    expect(f.gateway.health().quiescentServers).toBe(1);
    await f.gateway.applySnapshot(f.snapshot([a, b], 3));
    expect(f.gateway.health().quiescentServers).toBe(1);
    expect(
      (await exchange(tcp.port, 're-enabled-player').catch(() => Buffer.alloc(0))).length,
    ).toBe(0);
    const secondClient = createSocket('udp4');
    secondClient.send('re-enabled-datagram', udp.port, '127.0.0.1');
    await delay(20);
    secondClient.close();
    expect(f.gateway.metrics()).toMatchObject({ tcpBytesToBackend: 0, udpBytesToBackend: 0 });
    finish?.();
    await observing;
  });
  it.each(['disabled', 'before-idle-timeout', 'waking', 'inconsistent-role-eligibility'] as const)(
    'does not fence ordinary idle measurements when %s',
    async (condition) => {
      const first = await tcpFixture();
      const second = await udpFixture();
      const a: GatewayRoute = {
        ...route(first.port, 'tcp', condition === 'waking' ? 'waking' : 'online'),
        sleepEligibleAt:
          condition === 'disabled'
            ? undefined
            : new Date(
                Date.now() + (condition === 'before-idle-timeout' ? 60000 : -1000),
              ).toISOString(),
      };
      const b = {
        ...route(second.port, 'udp', a.mode),
        serverId: a.serverId,
        generation: a.generation,
        sleepEligibleAt:
          condition === 'inconsistent-role-eligibility' ? undefined : a.sleepEligibleAt,
      };
      const f = plane([a, b], {
        protocols: [fixtureProtocol({ probeIdle: async () => ({ idle: true, playerCount: 0 }) })],
      });
      await f.gateway.start();
      await f.gateway.observe();
      expect(f.gateway.health().quiescentServers).toBe(0);
      expect(f.control.reportObservation).toHaveBeenCalledWith(
        expect.objectContaining({ idle: true, quiescenceUntil: undefined }),
      );
      if (a.mode === 'online')
        expect((await exchange(first.port, 'playable')).toString()).toBe('playable');
    },
  );
  it('retains a fence after a lost report and deadline expiry until a genuinely post-deadline fetch proves state', async () => {
    const backend = await tcpFixture();
    let clock = Date.now();
    const initial = clock;
    const r = { ...route(backend.port), sleepEligibleAt: new Date(clock - 1000).toISOString() };
    const f = plane([r], {
      now: () => clock,
      lease: 200,
      policy: { maxClockSkewMs: 10 },
      control: {
        reportObservation: vi.fn(async () => {
          throw new Error('lost-response');
        }),
      },
      protocols: [fixtureProtocol({ probeIdle: async () => ({ idle: true, playerCount: 0 }) })],
    });
    await f.gateway.start();
    await f.gateway.observe();
    expect(f.gateway.health().quiescentServers).toBe(1);
    clock = initial + 50;
    await f.gateway.applySnapshot(f.snapshot([r], 1, 1000));
    expect(f.gateway.health().quiescentServers).toBe(1);
    await f.gateway.observe();
    expect(f.control.reportObservation).toHaveBeenLastCalledWith(
      expect.objectContaining({ quiescenceUntil: new Date(initial + 200).toISOString() }),
    );
    let release: ((value: GatewaySnapshot) => void) | undefined;
    vi.mocked(f.control.fetchSnapshot).mockImplementationOnce(
      async () =>
        new Promise<GatewaySnapshot>((resolve) => {
          release = resolve;
        }),
    );
    const delayed = f.gateway.refresh();
    clock = initial + 220;
    release?.(f.snapshot([r], 1, 1000));
    await delayed;
    expect(f.gateway.health().quiescentServers).toBe(1);
    expect((await exchange(backend.port, 'still-fenced').catch(() => Buffer.alloc(0))).length).toBe(
      0,
    );
    await f.gateway.observe();
    expect(f.control.reportObservation).toHaveBeenCalledTimes(2);
    const replay = { ...f.snapshot([r], 1, 1000), issuedAt: new Date(initial + 10).toISOString() };
    await expect(f.gateway.applySnapshot(replay)).rejects.toThrow('conflict');
    expect(f.gateway.health().quiescentServers).toBe(1);
    await f.gateway.refresh();
    expect(f.gateway.health().quiescentServers).toBe(0);
    expect((await exchange(backend.port, 'fresh-online')).toString()).toBe('fresh-online');
  });
  it.each(['generation', 'wakeJobId', 'mode'] as const)(
    'does not combine server routes with inconsistent %s',
    async (field) => {
      const first = await tcpFixture();
      const second = await udpFixture();
      const a = route(first.port, 'tcp', 'waking');
      const b = {
        ...route(second.port, 'udp', 'waking'),
        serverId: a.serverId,
        generation: a.generation,
        [field]: field === 'mode' ? 'sleeping' : randomUUID(),
      } as GatewayRoute;
      const f = plane([a, b]);
      await f.gateway.start();
      await f.gateway.observe();
      expect(f.control.reportObservation).not.toHaveBeenCalled();
      expect(f.gateway.metrics().observationErrors).toBe(1);
    },
  );
  it('performs protocol readiness over a real UDP fixture in the Gateway namespace', async () => {
    const backend = await udpFixture();
    const r = route(backend.port, 'udp', 'waking');
    const f = plane([r], {
      protocols: [
        fixtureProtocol({
          probeReadiness: async ({ route: current, signal }) => {
            const socket = createSocket('udp4');
            try {
              const reply = once(socket, 'message', { signal });
              socket.send('FIXTURE-READY', current.backend.port, current.backend.address);
              return { ready: ((await reply)[0] as Buffer).toString() === 'FIXTURE-READY' };
            } finally {
              socket.close();
            }
          },
        }),
      ],
    });
    await f.gateway.start();
    await f.gateway.observe();
    expect(f.control.reportObservation).toHaveBeenCalledWith(
      expect.objectContaining({ routeId: r.id, ready: true, idle: false }),
    );
  });
});

describe('lease, reconciliation and shutdown safety', () => {
  it('revalidates one fresh snapshot after a revision race without interrupting committed TCP sessions', async () => {
    const backend = await tcpFixture();
    const r = route(backend.port);
    const f = plane([r]);
    await f.gateway.start();
    const socket = connect(backend.port, '127.0.0.1');
    cleanups.push(async () => {
      socket.destroy();
    });
    await once(socket, 'connect');
    const first = once(socket, 'data');
    socket.write('before');
    expect((await first)[0].toString()).toBe('before');
    vi.mocked(f.control.fetchSnapshot)
      .mockReset()
      .mockResolvedValueOnce(f.snapshot([{ ...r, revision: 2 }], 2))
      .mockResolvedValueOnce(f.snapshot([{ ...r, revision: 3 }], 3));
    vi.mocked(f.safety.validate)
      .mockClear()
      .mockRejectedValueOnce(new GatewayRouteRevisionStaleError());
    await f.gateway.refresh();
    expect(f.control.fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(f.safety.validate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.safety.validate).mock.calls[1]?.[0].revision).toBe(3);
    expect(f.gateway.health()).toMatchObject({ revision: 3, controlAvailable: true, routes: 1 });
    const second = once(socket, 'data');
    socket.write('after');
    expect((await second)[0].toString()).toBe('after');
  });
  it.each(['revoked', 'collision'] as const)(
    'closes committed sessions when revision retry reveals %s',
    async (reason) => {
      const backend = await tcpFixture();
      const r = route(backend.port);
      const f = plane([r]);
      await f.gateway.start();
      const socket = connect(backend.port, '127.0.0.1');
      await once(socket, 'connect');
      const closed = once(socket, 'close');
      vi.mocked(f.control.fetchSnapshot)
        .mockReset()
        .mockResolvedValueOnce(f.snapshot([{ ...r, revision: 2 }], 2))
        .mockResolvedValueOnce(f.snapshot(reason === 'revoked' ? [] : [{ ...r, revision: 3 }], 3));
      vi.mocked(f.safety.validate).mockRejectedValueOnce(new GatewayRouteRevisionStaleError());
      if (reason === 'collision') {
        vi.mocked(f.safety.validate).mockRejectedValueOnce(
          new DomainError('allocation_unavailable'),
        );
        await expect(f.gateway.refresh()).rejects.toThrow('allocation_unavailable');
      } else await f.gateway.refresh();
      await closed;
      expect(f.gateway.health().routes).toBe(0);
      await refuses(backend.port);
    },
  );
  it('does not extend committed or observation leases during repeated revision races', async () => {
    const backend = await tcpFixture();
    const r = route(backend.port);
    const f = plane([r], { lease: 150 });
    await f.gateway.start();
    const originalLease = f.gateway.health().expiresAt;
    vi.mocked(f.control.fetchSnapshot)
      .mockReset()
      .mockResolvedValue(f.snapshot([{ ...r, revision: 2 }], 2, 60000));
    vi.mocked(f.safety.validate).mockRejectedValue(new GatewayRouteRevisionStaleError());
    await expect(f.gateway.refresh()).rejects.toBeInstanceOf(GatewayRouteRevisionStaleError);
    expect(f.control.fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(f.gateway.health()).toMatchObject({
      revision: 1,
      expiresAt: originalLease,
      controlAvailable: false,
    });
    expect((await exchange(backend.port, 'original lease')).toString()).toBe('original lease');
    await delay(200);
    vi.mocked(f.control.reportObservation).mockClear();
    await f.gateway.observe();
    expect(f.control.reportObservation).not.toHaveBeenCalled();
    await refuses(backend.port);
    expect(f.gateway.metrics().leaseExpirations).toBe(1);
  });
  it('never binds a first listener from repeatedly stale candidates', async () => {
    const backend = await tcpFixture();
    const f = plane([route(backend.port)], {
      safety: {
        validate: vi.fn(async () => {
          throw new GatewayRouteRevisionStaleError();
        }),
      },
    });
    await f.gateway.start();
    expect(f.control.fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(f.gateway.health()).toMatchObject({ routes: 0, revision: null, expiresAt: null });
    await f.gateway.observe();
    expect(f.control.reportObservation).not.toHaveBeenCalled();
    await refuses(backend.port);
  });
  it('rolls back staged new listeners when the final pre-bind check detects a stale revision', async () => {
    const first = await tcpFixture();
    const second = await tcpFixture();
    const f = plane([route(first.port), route(second.port)]);
    vi.mocked(f.safety.validate)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new GatewayRouteRevisionStaleError());
    await expect(f.gateway.applySnapshot(f.snapshot())).rejects.toBeInstanceOf(
      GatewayRouteRevisionStaleError,
    );
    await refuses(first.port);
    await refuses(second.port);
    await f.gateway.observe();
    expect(f.control.reportObservation).not.toHaveBeenCalled();
    expect(f.gateway.health()).toMatchObject({ routes: 0, revision: null, expiresAt: null });
  });
  it('rejects stale/replayed or same-revision changed routes without replacing a valid cache', async () => {
    const backend = await tcpFixture();
    const r = route(backend.port);
    const f = plane([r]);
    await f.gateway.start();
    await expect(f.gateway.applySnapshot(f.snapshot([{ ...r, mode: 'sleeping' }]))).rejects.toThrow(
      'conflict',
    );
    await expect(
      f.gateway.applySnapshot({ ...f.snapshot(), gatewayId: randomUUID() }),
    ).rejects.toThrow('conflict');
    await expect(f.gateway.applySnapshot(f.snapshot([], 1))).rejects.toThrow('conflict');
    expect((await exchange(backend.port, 'unchanged')).toString()).toBe('unchanged');
    await f.gateway.applySnapshot(f.snapshot([{ ...r, revision: 2 }], 2));
    await expect(f.gateway.applySnapshot(f.snapshot([r], 1))).rejects.toThrow('conflict');
  });
  it('removes revoked routes, closes existing sessions, and restarts from a fresh authorized snapshot', async () => {
    const backend = await tcpFixture();
    const r = route(backend.port);
    const f = plane([r]);
    await f.gateway.start();
    const socket = connect(backend.port, '127.0.0.1');
    await once(socket, 'connect');
    const closed = once(socket, 'close');
    await f.gateway.applySnapshot(f.snapshot([], 2));
    await closed;
    await refuses(backend.port);
    await f.gateway.stop();
    const fresh = plane([r]);
    await fresh.gateway.start();
    expect((await exchange(backend.port, 'restart')).toString()).toBe('restart');
    expect(fresh.safety.validate).toHaveBeenCalledTimes(2);
  });
  it('keeps authorized forwarding briefly during API loss, then closes on lease expiry and recovers', async () => {
    const backend = await tcpFixture();
    const r = route(backend.port);
    const f = plane([r], { lease: 150 });
    await f.gateway.start();
    vi.mocked(f.control.fetchSnapshot).mockRejectedValue(
      new DomainError('integration_unavailable'),
    );
    await expect(f.gateway.refresh()).rejects.toThrow();
    expect(f.gateway.health().controlAvailable).toBe(false);
    expect((await exchange(backend.port, 'cached')).toString()).toBe('cached');
    await delay(200);
    expect(f.gateway.health().ready).toBe(false);
    await refuses(backend.port);
    expect(f.gateway.metrics().leaseExpirations).toBe(1);
    vi.mocked(f.control.fetchSnapshot).mockImplementation(async () => f.snapshot());
    await f.gateway.refresh();
    expect((await exchange(backend.port, 'restored')).toString()).toBe('restored');
  });
  it('starts with no listeners when Core is unavailable and closes connections within shutdown grace', async () => {
    const backend = await tcpFixture();
    const f = plane([route(backend.port)], {
      control: {
        fetchSnapshot: vi.fn(async () => {
          throw new DomainError('integration_unavailable');
        }),
      },
    });
    await f.gateway.start();
    expect(f.gateway.health().ready).toBe(false);
    await refuses(backend.port);
    vi.mocked(f.control.fetchSnapshot).mockImplementation(async () => f.snapshot());
    await f.gateway.refresh();
    const socket = connect(backend.port, '127.0.0.1');
    await once(socket, 'connect');
    const closed = once(socket, 'close');
    await f.gateway.stop();
    await closed;
    await refuses(backend.port);
  });
  it('immediately closes a route when fresh topology verification fails and refuses older candidates', async () => {
    const backend = await tcpFixture();
    const r = route(backend.port);
    const f = plane([r]);
    await f.gateway.start();
    vi.mocked(f.safety.validate).mockRejectedValueOnce(new DomainError('allocation_unavailable'));
    await expect(f.gateway.applySnapshot(f.snapshot([{ ...r, revision: 2 }], 2))).rejects.toThrow(
      'allocation_unavailable',
    );
    await refuses(backend.port);
    await expect(f.gateway.applySnapshot(f.snapshot([r], 1))).rejects.toThrow('conflict');
    await f.gateway.applySnapshot(f.snapshot([{ ...r, revision: 2 }], 2));
    expect((await exchange(backend.port, 'fresh')).toString()).toBe('fresh');
  });
  it('closes held TCP connections when the routing lease expires', async () => {
    const backend = await tcpFixture();
    const f = plane([route(backend.port)], { lease: 100 });
    await f.gateway.start();
    const socket = connect(backend.port, '127.0.0.1');
    await once(socket, 'connect');
    await once(socket, 'close');
    expect(f.gateway.health().tcpConnections).toBe(0);
    await refuses(backend.port);
  });
  it('rejects expired, excessively long, and future-issued routing leases before binding', async () => {
    const backend = await tcpFixture();
    const f = plane([route(backend.port)]);
    for (const bad of [
      { ...f.snapshot(), expiresAt: new Date(Date.now() - 1).toISOString() },
      f.snapshot(undefined, 1, 120000),
      { ...f.snapshot(), issuedAt: new Date(Date.now() + 10000).toISOString() },
    ])
      await expect(f.gateway.applySnapshot(bad)).rejects.toThrow();
    await refuses(backend.port);
  });
  it('applies independent TCP/UDP capacity and datagram queue bounds without unbounded sessions', async () => {
    const tcp = await tcpFixture();
    const udp = await udpFixture();
    const f = plane([route(tcp.port), route(udp.port, 'udp')], {
      policy: { maxTcpConnections: 1, maxUdpSessions: 1, maxUdpQueuedBytes: 32 },
    });
    await f.gateway.start();
    const socket = connect(tcp.port, '127.0.0.1');
    await once(socket, 'connect');
    cleanups.push(async () => {
      socket.destroy();
    });
    const refused = connect(tcp.port, '127.0.0.1');
    await once(refused, 'close');
    expect(f.gateway.metrics().tcpRejected).toBe(1);
    expect((await datagram(udp.port, 'first')).toString()).toBe('first');
    const second = createSocket('udp4');
    second.send('second', udp.port, '127.0.0.1');
    await delay(20);
    second.close();
    expect(f.gateway.health().udpSessions).toBe(1);
    expect(f.gateway.metrics().udpDropped).toBeGreaterThanOrEqual(1);
  });
});
