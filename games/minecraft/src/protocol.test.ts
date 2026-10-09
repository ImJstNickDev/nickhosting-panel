import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import type { GatewayProtocolContext, GatewayProtocolSession } from '@nickhosting/game-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMinecraftProtocolAdapter,
  encodeMinecraftVarInt,
  frameMinecraftPacket,
  type MinecraftProtocolVersion,
  probeMinecraftStatus,
  readMinecraftFrame,
} from './protocol.js';

const versions: MinecraftProtocolVersion[] = [
  { release: '1.5.2', protocolId: 61, family: 'legacy', transfer: false },
  { release: '1.7.2', protocolId: 4, family: 'netty', transfer: false },
  { release: '1.20.4', protocolId: 765, family: 'netty', transfer: false },
  { release: '1.20.5', protocolId: 766, family: 'netty', transfer: true },
  { release: '26.1', protocolId: 775, family: 'netty', transfer: true },
];
const adapter = createMinecraftProtocolAdapter({
  versions,
  supportedReleases: ['1.20.4', '1.20.5', '26.1'],
});
function context(release = '1.20.5', locale: 'en' | 'it' = 'en'): GatewayProtocolContext {
  return {
    route: {
      id: randomUUID(),
      serverId: randomUUID(),
      nodeId: randomUUID(),
      allocationId: randomUUID(),
      revision: 1,
      generation: randomUUID(),
      public: { address: '127.0.0.1', port: 25565, transport: 'tcp' },
      backend: { address: '127.0.0.1', allocationAddress: '127.0.0.1', port: 25565 },
      protocol: { handlerId: 'minecraft-java', gameVersion: release, role: 'game' },
      mode: 'sleeping',
      locale,
    },
    signal: new AbortController().signal,
  };
}
function encodedString(text: string) {
  const bytes = Buffer.from(text);
  return Buffer.concat([encodeMinecraftVarInt(bytes.length), bytes]);
}
function handshake(protocol = 766, intent = 1, host = 'localhost') {
  return frameMinecraftPacket(
    0,
    Buffer.concat([
      encodeMinecraftVarInt(protocol),
      encodedString(host),
      Buffer.from([0x63, 0xdd]),
      encodeMinecraftVarInt(intent),
    ]),
  );
}
function session(ctx = context()): GatewayProtocolSession {
  const result = adapter.createSession?.(ctx);
  if (!result) throw new Error('session missing');
  return result;
}
function decodeJson(bytes: Uint8Array | undefined) {
  if (!bytes) throw new Error('response missing');
  const frame = readMinecraftFrame(bytes, 262144);
  if (frame?.body[0] !== 0) throw new Error('response invalid');
  let offset = 1;
  while ((frame.body[offset++] ?? 0) & 0x80) {
    /* Skip bounded string length. */
  }
  return JSON.parse(frame.body.subarray(offset).toString());
}

describe('Minecraft exact-registry offline protocol sessions (fixtures, not real compatibility evidence)', () => {
  it('accepts bounded padded VarInts in framing, fields and status/ping packet IDs', () => {
    const padded = (value: number) => {
      const bytes = [...encodeMinecraftVarInt(value)];
      bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) | 0x80;
      return Buffer.from([...bytes, 0]);
    };
    const wrap = (body: Buffer) => Buffer.concat([padded(body.length), body]);
    const request = (intent: number) =>
      wrap(
        Buffer.concat([
          padded(0),
          padded(766),
          padded(9),
          Buffer.from('localhost'),
          Buffer.from([0x63, 0xdd]),
          padded(intent),
        ]),
      );
    expect(session().classify(request(2)).kind).toBe('join');
    const current = session();
    expect(current.classify(request(1)).kind).toBe('continue');
    expect(current.classify(wrap(padded(0))).kind).toBe('status');
    expect(current.response('sleeping').close).toBe(false);
    const nonce = Buffer.from('12345678');
    expect(current.classify(wrap(Buffer.concat([padded(1), nonce]))).kind).toBe('status');
    const response = current.response('sleeping').bytes;
    if (!response) throw new Error('Expected ping response bytes');
    expect(readMinecraftFrame(response, 1024)?.body.subarray(1)).toEqual(nonce);
    expect(() => readMinecraftFrame(Buffer.from([0x81, 0x80, 0x80, 0, 0]), 1024)).toThrow();
  });
  it('does not infer modern support from legacy IDs, unknown releases, or future IDs', () => {
    expect(adapter.supports(context('1.5.2').route)).toBe(false);
    expect(adapter.supports(context('future').route)).toBe(false);
    expect(
      adapter.supports({
        ...context().route,
        public: { ...context().route.public, transport: 'udp' },
      }),
    ).toBe(false);
    for (const protocol of [61, 2000000000])
      expect(session().classify(handshake(protocol, 2)).kind).toBe('unsupported');
    expect(adapter.classify(handshake(), context()).kind).toBe('unsupported');
    expect(adapter.response(context(), 'sleeping')).toBeUndefined();
  });
  it('requires valid reviewed registry data and explicit enabled releases', () => {
    for (const invalid of [
      [...versions, versions[0] as MinecraftProtocolVersion],
      [{ release: 'unknown', protocolId: -1, family: 'netty' as const, transfer: false }],
      [{ release: '1.20.4', protocolId: 765, family: 'netty' as const, transfer: true }],
    ])
      expect(() =>
        createMinecraftProtocolAdapter({ versions: invalid, supportedReleases: [] }),
      ).toThrow();
    expect(() =>
      createMinecraftProtocolAdapter({ versions, supportedReleases: ['1.5.2'] }),
    ).toThrow();
  });
  it('handles every partial handshake prefix without classification or consumption', () => {
    const value = handshake();
    const current = session();
    for (let length = 0; length < value.length; length++)
      expect(current.classify(value.subarray(0, length))).toEqual({
        kind: 'need-more',
        consumedBytes: 0,
      });
    expect(current.classify(value)).toEqual({ kind: 'continue', consumedBytes: value.length });
  });
  it('only replies to a status request after the handshake; echoes signed 64-bit ping unchanged', () => {
    const current = session();
    expect(current.classify(handshake()).kind).toBe('continue');
    expect(current.classify(frameMinecraftPacket(0)).kind).toBe('status');
    const response = current.response('sleeping');
    expect(response.close).toBe(false);
    expect(decodeJson(response.bytes)).toMatchObject({
      version: { name: '1.20.5', protocol: 766 },
      description: { text: expect.stringContaining('sleeping') },
    });
    const payload = Buffer.from('ffffffffffffffff', 'hex');
    const ping = frameMinecraftPacket(1, payload);
    expect(current.classify(ping).kind).toBe('status');
    expect(current.response('sleeping')).toEqual({ bytes: ping, close: true });
  });
  it('preserves coalesced frame offsets and bounded Forge hostname suffixes', () => {
    const current = session();
    const first = handshake(766, 1, 'minecraft.example\0FML3\0');
    const input = Buffer.concat([
      first,
      frameMinecraftPacket(0),
      frameMinecraftPacket(1, Buffer.alloc(8)),
    ]);
    const result = current.classify(input);
    expect(result).toEqual({ kind: 'continue', consumedBytes: first.length });
    expect(current.classify(input.subarray(result.consumedBytes))).toEqual({
      kind: 'status',
      consumedBytes: 2,
    });
  });
  it('recognizes only matching intentional login and returns localized login JSON disconnect', () => {
    const current = session(context('26.1', 'it'));
    expect(current.classify(handshake(775, 2)).kind).toBe('join');
    expect(decodeJson(current.response('waking').bytes)).toEqual({
      text: 'Server in avvio. Riconnettiti tra poco.',
    });
    const mismatch = session();
    expect(mismatch.classify(handshake(765, 2)).kind).toBe('reject');
    expect(decodeJson(mismatch.response('sleeping').bytes).text).toContain('version');
  });
  it('returns actual configured status version to known mismatched clients without a join', () => {
    const current = session();
    expect(current.classify(handshake(4, 1)).kind).toBe('continue');
    expect(current.classify(frameMinecraftPacket(0)).kind).toBe('status');
    expect(decodeJson(current.response('blocked').bytes).version).toEqual({
      name: '1.20.5',
      protocol: 766,
    });
  });
  it('requires both exact transfer capability and explicit transfer consent', () => {
    expect(session().classify(handshake(765, 3)).kind).toBe('unsupported');
    const refused = session();
    expect(refused.classify(handshake(766, 3)).kind).toBe('reject');
    expect(decodeJson(refused.response('sleeping').bytes).text).toContain('directly');
    const allowed = createMinecraftProtocolAdapter({
      versions,
      supportedReleases: ['1.20.5'],
      acceptsTransfers: true,
    });
    expect(allowed.createSession?.(context()).classify(handshake(766, 3)).kind).toBe('join');
  });
  it('keeps cross-client status, login, locale and ping state isolated', () => {
    const first = session();
    const second = session(context('26.1', 'it'));
    first.classify(handshake());
    first.classify(frameMinecraftPacket(0));
    second.classify(handshake(775, 2));
    expect(decodeJson(second.response('blocked').bytes).text).toContain('Impossibile');
    expect(decodeJson(first.response('sleeping').bytes).version.protocol).toBe(766);
    const nonce = Buffer.from('0102030405060708', 'hex');
    first.classify(frameMinecraftPacket(1, nonce));
    expect(first.response('sleeping').bytes).toEqual(frameMinecraftPacket(1, nonce));
    expect(second.response('sleeping').bytes).toBeUndefined();
  });
  it('fails closed on abort, legacy bytes, malformed framing, invalid strings and surplus fields', () => {
    const badHost = handshake();
    badHost[5] = 0xff;
    for (const input of [
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]),
      Buffer.from([0x80, 0x00]),
      encodeMinecraftVarInt(5000),
      frameMinecraftPacket(0, Buffer.alloc(0)),
      handshake(766, 4),
      handshake(766, 1, 'a'.repeat(262)),
      badHost,
      frameMinecraftPacket(0, Buffer.concat([handshake().subarray(2), Buffer.from([0])])),
    ])
      expect(session().classify(input).kind).toBe('unsupported');
    // A legacy prefix is also a possible partial modern length; it receives no
    // response and no wake, then the Gateway classification deadline closes it.
    expect(session().classify(Buffer.from([0xfe, 0x01, 0xfa])).kind).toBe('need-more');
    const controller = new AbortController();
    const current = session({ ...context(), signal: controller.signal });
    current.classify(handshake(766, 2));
    controller.abort();
    expect(current.response('waking')).toEqual({ close: true });
  });
  it('does not turn status-state login packets, repeat status or invalid ping lengths into joins', () => {
    for (const input of [
      handshake(766, 2),
      frameMinecraftPacket(1, Buffer.alloc(7)),
      frameMinecraftPacket(0),
    ]) {
      const current = session();
      current.classify(handshake());
      current.classify(frameMinecraftPacket(0));
      current.response('sleeping');
      expect(current.classify(input).kind).toBe('unsupported');
    }
  });
  it('generates all offline state messages without protocol IDs in the user message', () => {
    for (const mode of [
      'sleeping',
      'waking',
      'blocked',
      'maintenance',
      'manually_stopped',
    ] as const) {
      const current = session();
      current.classify(handshake(766, 2));
      const text = decodeJson(current.response(mode).bytes).text;
      expect(text).not.toContain('766');
      expect(text.length).toBeGreaterThan(10);
    }
  });
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function statusFixture(
  status: unknown,
  options: { badPing?: boolean; silent?: boolean; partial?: boolean } = {},
) {
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.once('close', () => clients.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let state = 0;
    socket.on('data', (chunk) => {
      if (options.silent) return;
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        const frame = readMinecraftFrame(buffer, 8192);
        if (!frame) return;
        buffer = buffer.subarray(frame.bytes);
        if (state === 1) {
          const response = frameMinecraftPacket(0, encodedString(JSON.stringify(status)));
          if (options.partial) {
            socket.write(response.subarray(0, 3));
            setTimeout(() => socket.write(response.subarray(3)), 5);
          } else socket.write(response);
        }
        if (state === 2)
          socket.end(
            frameMinecraftPacket(1, options.badPing ? Buffer.alloc(8) : frame.body.subarray(1)),
          );
        state++;
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address');
  cleanups.push(async () => {
    for (const socket of clients) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const ctx = context();
  ctx.route.backend.port = address.port;
  return ctx;
}
describe('actual socket Minecraft status probes against isolated protocol fixtures', () => {
  it('requires matching protocol status plus nonce echo and reports explicit zero player count', async () => {
    const ctx = await statusFixture(
      { version: { protocol: 766 }, players: { online: 0 } },
      { partial: true },
    );
    expect(await adapter.probeReadiness(ctx)).toEqual({ ready: true, playerCount: 0 });
    expect(await adapter.probeIdle?.(ctx)).toEqual({ idle: true, playerCount: 0 });
  });
  it('never treats missing or invalid player count as zero, including privacy-restricted status', async () => {
    for (const players of [undefined, {}, { online: -1 }, { online: '0' }, { online: 0.5 }]) {
      const ctx = await statusFixture({ version: { protocol: 766 }, players });
      expect(await adapter.probeReadiness(ctx)).toEqual({ ready: true });
      expect(await adapter.probeIdle?.(ctx)).toEqual({ idle: false });
    }
    const busy = await statusFixture({ version: { protocol: 766 }, players: { online: 2 } });
    expect(await adapter.probeIdle?.(busy)).toEqual({ idle: false, playerCount: 2 });
  });
  it('rejects responsive sockets with wrong protocol, arbitrary JSON, or wrong ping', async () => {
    for (const value of [null, {}, { version: { protocol: 765 }, players: { online: 0 } }]) {
      expect(await adapter.probeReadiness(await statusFixture(value))).toEqual({ ready: false });
    }
    const ctx = await statusFixture({ version: { protocol: 766 } }, { badPing: true });
    expect(await adapter.probeReadiness(ctx)).toEqual({ ready: false });
  });
  it('bounds time, aborts open sockets and rejects oversized status', async () => {
    const ctx = await statusFixture({ version: { protocol: 766 } }, { silent: true });
    const version = versions[3] as MinecraftProtocolVersion;
    expect(await probeMinecraftStatus(ctx, version, { timeoutMs: 25 })).toEqual({ ready: false });
    const controller = new AbortController();
    const pending = probeMinecraftStatus({ ...ctx, signal: controller.signal }, version);
    controller.abort();
    expect(await pending).toEqual({ ready: false });
    const large = await statusFixture({
      version: { protocol: 766 },
      description: 'x'.repeat(4096),
    });
    expect(await probeMinecraftStatus(large, version, { maximumBytes: 256 })).toEqual({
      ready: false,
    });
  });
});
