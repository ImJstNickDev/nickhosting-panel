import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createServer, type Socket } from 'node:net';
import type { GatewayProtocolContext } from '@nickhosting/game-sdk';
import minecraftProtocol from 'minecraft-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createMinecraftProtocolAdapter, type MinecraftProtocolVersion } from './protocol.js';
import {
  detectMinecraftInitial,
  encodeMinecraftFrame,
  encodeModifiedUtf8String,
  encodeSignedVarInt,
  encodeUtf8String,
  encodeUtf16String,
  legacyKickPacket,
  legacyStatusPacket,
  readMinecraftWireFrame,
  readModifiedUtf8String,
  readUtf8String,
  readUtf16String,
} from './protocol-codecs.js';
import registryFixture from './protocol-registry.fixture.json' with { type: 'json' };
import { defaultMinecraftProtocolSource, fetchMinecraftProtocols } from './releases.js';

const modernVersions = [
  ['1.7.2', 4],
  ['1.7.10', 5],
  ['1.8.9', 47],
  ['1.12.2', 340],
  ['1.16.5', 754],
  ['1.20.4', 765],
  ['26.1', 775],
  ['26.2', 776],
  ['26.3', 777],
] as const;
const legacyVersions = [
  ['a1.0.15', 13, 'legacy-modified-utf8'],
  ['a1.0.16', 14, 'legacy-modified-utf8'],
  ['a1.0.17', 1, 'legacy-modified-utf8'],
  ['a1.1.2_01', 2, 'legacy-modified-utf8'],
  ['a1.2.1_01', 3, 'legacy-modified-utf8'],
  ['a1.2.2', 4, 'legacy-modified-utf8'],
  ['a1.2.3_04', 5, 'legacy-modified-utf8'],
  ['a1.2.6', 6, 'legacy-modified-utf8'],
  ['b1.0', 7, 'legacy-modified-utf8'],
  ['b1.1_02', 8, 'legacy-modified-utf8'],
  ['b1.2_02', 8, 'legacy-modified-utf8'],
  ['b1.3_01', 9, 'legacy-modified-utf8'],
  ['b1.4_01', 10, 'legacy-modified-utf8'],
  ['b1.5_01', 11, 'legacy-utf16'],
  ['b1.6.6', 13, 'legacy-utf16'],
  ['b1.7.3', 14, 'legacy-utf16'],
  ['b1.8.1', 17, 'legacy-utf16'],
  ['1.0', 22, 'legacy-utf16'],
  ['1.1', 23, 'legacy-utf16'],
  ['1.2.5', 29, 'legacy-utf16'],
  ['1.3.2', 39, 'legacy-utf16'],
  ['1.4.7', 51, 'legacy-utf16'],
  ['1.5.2', 61, 'legacy-utf16'],
  ['1.6.4', 78, 'legacy-utf16'],
] as const;

function context(release: string): GatewayProtocolContext {
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
      locale: 'en',
    },
    signal: new AbortController().signal,
  };
}
function adapterFor(version: MinecraftProtocolVersion) {
  return createMinecraftProtocolAdapter({
    versions: [version],
    supportedReleases: [version.release],
    probeTimeoutMs: 100,
    responses: {
      motd: { sleeping: { en: '§aSleeping 😀\nJoin to start.', it: '§aIn sospensione 😀' } },
      disconnect: { waking: { en: 'Starting 😀\nReconnect.', it: 'In avvio 😀' } },
    },
  });
}
function modernHandshake(protocolId: number, intent: number) {
  return encodeMinecraftFrame(
    0,
    Buffer.concat([
      encodeSignedVarInt(protocolId),
      encodeUtf8String('localhost'),
      Buffer.from([0x63, 0xdd]),
      encodeSignedVarInt(intent),
    ]),
  );
}
function jsonPacket(bytes: Uint8Array | undefined) {
  if (!bytes) throw new Error('missing packet');
  const frame = readMinecraftWireFrame(bytes, 262144);
  if (frame?.body[0] !== 0) throw new Error('invalid packet');
  const value = readUtf8String(frame.body, 1);
  if (!value) throw new Error('invalid text');
  return JSON.parse(value.value);
}
function requiredBytes(bytes: Uint8Array | undefined): Uint8Array {
  if (!bytes) throw new Error('missing bytes');
  return bytes;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function listen(handler: (socket: Socket) => void) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    handler(socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('invalid address');
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return address.port;
}

describe('multiprotocol endpoint wire fixtures; not real Minecraft runtime evidence', () => {
  it.each(modernVersions)('status and login are distinct for %s (%i)', (release, protocolId) => {
    const version: MinecraftProtocolVersion = {
      release,
      protocolId,
      family: 'netty',
      transfer: protocolId >= 766,
    };
    const adapter = adapterFor(version);
    const status = adapter.createSession?.(context(release));
    const handshake = modernHandshake(protocolId, 1);
    for (let i = 0; i < handshake.length; i++)
      expect(status?.classify(handshake.subarray(0, i)).kind).toBe('need-more');
    expect(status?.classify(handshake).kind).toBe('continue');
    expect(status?.classify(encodeMinecraftFrame(0)).kind).toBe('status');
    const response = jsonPacket(status?.response('sleeping').bytes);
    expect(response.version.protocol).toBe(protocolId);
    expect(response.description).toEqual({
      text: '',
      extra: [{ text: 'Sleeping 😀\nJoin to start.', color: 'green' }],
    });
    const nonce = Buffer.from('80000000ffffffff', 'hex');
    expect(status?.classify(encodeMinecraftFrame(1, nonce)).kind).toBe('status');
    expect(status?.response('sleeping').bytes).toEqual(encodeMinecraftFrame(1, nonce));

    const joining = adapter.createSession?.(context(release));
    expect(joining?.classify(modernHandshake(protocolId, 2)).kind).toBe('continue');
    expect(joining?.response('waking').bytes).toBeUndefined();
    const login = encodeMinecraftFrame(
      0,
      Buffer.concat([
        encodeUtf8String('FixturePlayer'),
        ...(protocolId >= 764 ? [Buffer.alloc(16)] : []),
      ]),
    );
    for (let i = 0; i < login.length; i++)
      expect(joining?.classify(login.subarray(0, i)).kind).toBe('need-more');
    expect(joining?.classify(login).kind).toBe('join');
    expect(jsonPacket(joining?.response('waking').bytes)).toEqual({
      text: '',
      extra: [{ text: 'Starting 😀\nReconnect.' }],
    });
  });

  it('mirrors unknown nonnegative status IDs and uses target fallback for -1', () => {
    const adapter = adapterFor({
      release: '26.3',
      protocolId: 777,
      family: 'netty',
      transfer: true,
    });
    for (const [client, announced] of [
      [2147483647, 2147483647],
      [-1, 777],
    ]) {
      const session = adapter.createSession?.(context('26.3'));
      expect(session?.classify(modernHandshake(client ?? 0, 1)).kind).toBe('continue');
      expect(session?.classify(encodeMinecraftFrame(0)).kind).toBe('status');
      expect(jsonPacket(session?.response('sleeping').bytes).version.protocol).toBe(announced);
    }
  });

  it.each(legacyVersions)(
    'returns a bounded matching legacy kick for %s (%i, %s)',
    (release, protocolId, codec) => {
      const adapter = adapterFor({ release, protocolId, family: 'legacy', transfer: false });
      const session = adapter.createSession?.(context(release));
      let packet: Buffer;
      if (release === 'a1.0.15' || release === 'a1.0.16') {
        const header = Buffer.alloc(5);
        header[0] = 1;
        header.writeInt32BE(protocolId, 1);
        packet = Buffer.concat([
          header,
          encodeModifiedUtf8String('FixturePlayer'),
          encodeModifiedUtf8String(''),
        ]);
      } else if (protocolId >= 39) {
        packet = Buffer.concat([
          Buffer.from([2, protocolId]),
          encodeUtf16String('FixturePlayer'),
          encodeUtf16String('localhost'),
          Buffer.from([0, 0, 0x63, 0xdd]),
        ]);
      } else {
        const encode =
          codec === 'legacy-modified-utf8' ? encodeModifiedUtf8String : encodeUtf16String;
        packet = Buffer.concat([Buffer.from([2]), encode('FixturePlayer')]);
      }
      for (let i = 0; i < packet.length; i++)
        expect(session?.classify(packet.subarray(0, i)).kind).toBe('need-more');
      expect(session?.classify(packet).kind).toBe('join');
      const response = session?.response('waking');
      expect(response?.close).toBe(true);
      const read = codec === 'legacy-modified-utf8' ? readModifiedUtf8String : readUtf16String;
      const text = read(requiredBytes(response?.bytes), 1)?.value;
      expect(text).toBe(protocolId < 39 ? 'Starting 😀 | Reconnect.' : 'Starting 😀\nReconnect.');
    },
  );

  it.each([[254], [254, 1]])(
    'defers ambiguous legacy ping %j until explicit finalization, never joins',
    (...prefix) => {
      const session = adapterFor({
        release: '1.6.4',
        protocolId: 78,
        family: 'legacy',
        transfer: false,
      }).createSession?.(context('1.6.4'));
      const bytes = Buffer.from(prefix);
      expect(session?.classify(bytes).kind).toBe('need-more');
      expect(session?.response('sleeping').bytes).toBeUndefined();
      expect(session?.finalize?.(bytes).kind).toBe('status');
      const text = readUtf16String(requiredBytes(session?.response('sleeping').bytes), 1)?.value;
      expect(text).toBe(
        prefix.length === 1
          ? 'Sleeping 😀\nJoin to start.§0§0'
          : ['§1', '78', '1.6.4', '§aSleeping 😀\nJoin to start.', '0', '0'].join('\0'),
      );
    },
  );

  it('uses authoritative target multiline support for unversioned UTF16 on configured 1.3', () => {
    const adapter = adapterFor({
      release: '1.3.2',
      protocolId: 39,
      family: 'legacy',
      transfer: false,
    });
    const session = adapter.createSession?.(context('1.3.2'));
    expect(
      session?.classify(
        Buffer.concat([Buffer.from([2]), encodeUtf16String('FixturePlayer;localhost:25565')]),
      ).kind,
    ).toBe('join');
    expect(readUtf16String(requiredBytes(session?.response('waking').bytes), 1)?.value).toBe(
      'Starting 😀\nReconnect.',
    );
  });
});

describe('legacy readiness uses isolated TCP protocol fixtures', () => {
  it.each([
    ['b1.8.1', 17, 'original'],
    ['1.2.5', 29, 'original'],
    ['1.5.2', 61, 'extended'],
    ['1.6.4', 78, 'extended'],
  ] as const)(
    'queries %s with the correct status dialect',
    async (release, protocolId, variant) => {
      const requests: Buffer[] = [];
      const response = legacyStatusPacket(variant, {
        protocolId,
        version: release,
        motd: 'Fixture',
        online: 0,
        max: 20,
      });
      const port = await listen((socket) => {
        socket.once('data', (request) => {
          requests.push(request);
          socket.write(response.subarray(0, 4));
          setTimeout(() => socket.end(response.subarray(4)), 2);
        });
      });
      const adapter = adapterFor({ release, protocolId, family: 'legacy', transfer: false });
      const ctx = context(release);
      ctx.route.backend.port = port;
      expect(await adapter.observe?.(ctx)).toEqual({ ready: true, idle: true, playerCount: 0 });
      expect(requests).toHaveLength(1);
      const request = requests[0];
      if (!request) throw new Error('missing request');
      if (release === '1.6.4')
        expect(detectMinecraftInitial(request)).toMatchObject({
          kind: 'status',
          protocolId,
          statusVariant: 'extended',
        });
      else expect(request).toEqual(Buffer.from(variant === 'original' ? [254] : [254, 1]));
    },
  );

  it.each(['missing', 'negative', 'not-number', 'mismatch', 'surplus'] as const)(
    'unknown/invalid count or protocol never permits idle: %s',
    async (failure) => {
      const parts = [
        '§1',
        failure === 'mismatch' ? '77' : '78',
        '1.6.4',
        'Fixture',
        failure === 'negative' ? '-1' : failure === 'not-number' ? 'unknown' : '0',
        '20',
      ];
      if (failure === 'missing') parts.splice(4, 1);
      const response = legacyKickPacket('legacy-utf16', parts.join('\0'));
      const port = await listen((socket) =>
        socket.once('data', () =>
          socket.end(
            failure === 'surplus' ? Buffer.concat([response, Buffer.from([0])]) : response,
          ),
        ),
      );
      const ctx = context('1.6.4');
      ctx.route.backend.port = port;
      expect(
        await adapterFor({
          release: '1.6.4',
          protocolId: 78,
          family: 'legacy',
          transfer: false,
        }).observe?.(ctx),
      ).toEqual({ ready: false, idle: false });
    },
  );

  it('pre-status Alpha/Beta has no player-count readiness claim or network probe', async () => {
    let requests = 0;
    const port = await listen((socket) => {
      requests++;
      socket.destroy();
    });
    for (const release of ['a1.2.6', 'b1.7.3']) {
      const ctx = context(release);
      ctx.route.backend.port = port;
      expect(
        await adapterFor({ release, protocolId: 14, family: 'legacy', transfer: false }).observe?.(
          ctx,
        ),
      ).toEqual({ ready: false, idle: false });
    }
    expect(requests).toBe(0);
  });
});

describe('installed headless library fixtures and complete metadata coverage', () => {
  it.each(modernVersions.filter(([release]) => !['1.7.2', '26.2', '26.3'].includes(release)))(
    'minecraft-protocol headless status client reads %s',
    async (release, protocolId) => {
      const adapter = adapterFor({
        release,
        protocolId,
        family: 'netty',
        transfer: protocolId >= 766,
      });
      const classifications: string[] = [];
      const port = await listen((socket) => {
        const session = adapter.createSession?.(context(release));
        let buffer = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          while (buffer.length && session) {
            const classified = session.classify(buffer);
            classifications.push(classified.kind);
            if (classified.kind === 'need-more') break;
            buffer = buffer.subarray(classified.consumedBytes);
            if (classified.kind === 'continue') continue;
            const reply = session.response('sleeping');
            if (reply.close) {
              if (reply.bytes) socket.end(reply.bytes);
              else socket.end();
            } else if (reply.bytes) socket.write(reply.bytes);
          }
        });
      });
      const status = await minecraftProtocol.ping({
        host: '127.0.0.1',
        port,
        version: release,
        closeTimeout: 1000,
        noPongTimeout: 1000,
      });
      if (typeof status.version === 'string') throw new Error('Expected version metadata');
      expect(status.version.protocol).toBe(protocolId);
      expect(classifications.filter((kind) => kind === 'status')).toHaveLength(2);
      expect(classifications).not.toContain('join');
    },
  );

  it('records headless serializer limitations instead of claiming library coverage', () => {
    const require = createRequire(import.meta.url);
    const dependency = createRequire(require.resolve('minecraft-protocol'));
    const data = dependency('minecraft-data');
    expect(data('1.7.2').version.version).toBe(5);
    expect(data('26.2')).toBeNull();
    expect(data('26.3')).toBeNull();
  });

  it('exercises the full pinned metadata fixture offline and identifies historical exclusions', async () => {
    expect(registryFixture.source.sha256).toBe(defaultMinecraftProtocolSource.sha256);
    expect(registryFixture.source.url).toContain(defaultMinecraftProtocolSource.commit);
    // Trimmed rows retain only wire metadata. Their synthetic fetch digest is
    // distinct from the original upstream document digest recorded above.
    const bytes = Buffer.from(JSON.stringify(registryFixture.rows));
    const source = {
      commit: '0'.repeat(40),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const catalog = await fetchMinecraftProtocols(source, async () => new Response(bytes));
    expect(catalog.releases.size).toBe(839);
    const adapter = adapterFor({
      release: '26.3',
      protocolId: 777,
      family: 'netty',
      transfer: true,
    });
    const counts = { modern: 0, legacyStable: 0, legacySnapshot: 0 };
    for (const entry of catalog.releases.values()) {
      if (entry.family === 'legacy') {
        if (!/^1\.\d+(?:\.\d+)?$/.test(entry.release)) {
          counts.legacySnapshot++;
        } else {
          counts.legacyStable++;
        }
        const legacy = adapterFor(entry);
        const status = legacy.createSession?.(context(entry.release));
        const variant = entry.protocolId < 47 ? 'original' : 'extended';
        const request = Buffer.from(variant === 'original' ? [254] : [254, 1]);
        expect(status?.finalize?.(request).kind, entry.release).toBe('status');
        expect(
          readUtf16String(requiredBytes(status?.response('sleeping').bytes), 1)?.value,
        ).toContain('Sleeping');
        const login = legacy.createSession?.(context(entry.release));
        const initial =
          entry.protocolId >= 39
            ? Buffer.concat([
                Buffer.from([2, entry.protocolId]),
                encodeUtf16String('FixturePlayer'),
                encodeUtf16String('localhost'),
                Buffer.from([0, 0, 0x63, 0xdd]),
              ])
            : Buffer.concat([Buffer.from([2]), encodeUtf16String('FixturePlayer')]);
        expect(login?.classify(initial).kind, entry.release).toBe('join');
        expect(readUtf16String(requiredBytes(login?.response('waking').bytes), 1)?.value).toContain(
          'Starting',
        );
        continue;
      }
      counts.modern++;
      const session = adapter.createSession?.(context('26.3'));
      expect(session?.classify(modernHandshake(entry.protocolId, 1)).kind, entry.release).toBe(
        'continue',
      );
      expect(session?.classify(encodeMinecraftFrame(0)).kind, entry.release).toBe('status');
      expect(jsonPacket(session?.response('sleeping').bytes).version.protocol, entry.release).toBe(
        entry.protocolId,
      );
      const login = adapter.createSession?.(context('26.3'));
      expect(login?.classify(modernHandshake(entry.protocolId, 2)).kind, entry.release).toBe(
        'continue',
      );
      expect(
        login?.classify(
          encodeMinecraftFrame(
            0,
            Buffer.concat([encodeUtf8String('FixturePlayer'), Buffer.alloc(16)]),
          ),
        ).kind,
        entry.release,
      ).toBe(entry.protocolId === 777 ? 'join' : 'reject');
      expect(
        jsonPacket(login?.response('waking').bytes).extra.length,
        entry.release,
      ).toBeGreaterThan(0);
    }
    expect(counts.modern).toBe(771);
    expect(counts.legacyStable).toBe(20);
    expect(counts.legacySnapshot).toBe(48);
    // Classic/Alpha/Beta do not occur in this upstream registry; early Alpha
    // and Beta layouts are covered by the separately sourced explicit tuples.
  });
});
