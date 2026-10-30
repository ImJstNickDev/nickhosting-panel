import { describe, expect, it } from 'vitest';
import {
  detectMinecraftInitial,
  encodeMinecraftFrame,
  encodeModifiedUtf8String,
  encodeSignedVarInt,
  encodeUtf8String,
  encodeUtf16String,
  formattingToComponents,
  legacyKickPacket,
  legacyStatusPacket,
  readMinecraftWireFrame,
  readModifiedUtf8String,
  readSignedVarInt,
  readUtf8String,
  readUtf16String,
} from './protocol-codecs.js';

function modern(protocolId = -1, intent = 1, hostname = 'localhost') {
  return encodeMinecraftFrame(
    0,
    Buffer.concat([
      encodeSignedVarInt(protocolId),
      encodeUtf8String(hostname),
      Buffer.from([0x63, 0xdd]),
      encodeSignedVarInt(intent),
    ]),
  );
}

function pingHost(host = 'localhost', port = 25565) {
  const portBytes = Buffer.alloc(4);
  portBytes.writeInt32BE(port);
  const payload = Buffer.concat([Buffer.from([74]), encodeUtf16String(host), portBytes]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length);
  return Buffer.concat([
    Buffer.from([254, 1, 250]),
    encodeUtf16String('MC|PingHost'),
    length,
    payload,
  ]);
}

function fragmented(packet: Buffer, expected: object) {
  for (let i = 0; i < packet.length; i++) {
    expect(detectMinecraftInitial(packet.subarray(0, i)), `prefix ${i}`).toEqual({
      kind: 'need-more',
    });
  }
  expect(detectMinecraftInitial(packet)).toMatchObject(expected);
}

describe('bounded Minecraft wire codecs', () => {
  it.each([-2147483648, -1, 0, 127, 128, 2147483647])('round trips signed VarInt %i', (value) => {
    const bytes = encodeSignedVarInt(value);
    expect(readSignedVarInt(bytes)).toEqual({ value, bytes: bytes.length });
    for (let i = 0; i < bytes.length; i++)
      expect(readSignedVarInt(bytes.subarray(0, i))).toBeUndefined();
  });

  it('rejects overflow, negative frame lengths and oversized frame prefixes', () => {
    expect(() => readSignedVarInt(Buffer.from([255, 255, 255, 255, 31]))).toThrow();
    expect(() => readSignedVarInt(Buffer.from([128, 128, 128, 128, 128]))).toThrow();
    expect(() => encodeSignedVarInt(2147483648)).toThrow();
    expect(() => readMinecraftWireFrame(encodeSignedVarInt(-1))).toThrow();
    expect(() => readMinecraftWireFrame(Buffer.from([129, 128, 128, 0, 0]))).toThrow();
  });

  it('strictly handles UTF-8, preserving BOM, NUL and supplementary characters', () => {
    const text = '\ufeffCiao\0世界😀';
    expect(readUtf8String(encodeUtf8String(text))?.value).toBe(text);
    expect(() => encodeUtf8String('\ud800')).toThrow();
    for (const bytes of [
      [2, 0xc0, 0x80],
      [3, 0xed, 0xa0, 0x80],
      [1, 255],
    ])
      expect(() => readUtf8String(Buffer.from(bytes))).toThrow();
    expect(() => readUtf8String(encodeSignedVarInt(-1))).toThrow();
    expect(readUtf8String(Buffer.from([2, 0xc3]))).toBeUndefined();
  });

  it('matches Java Modified UTF encoding, including NUL and surrogate pairs', () => {
    const text = 'A\0é😀';
    const encoded = encodeModifiedUtf8String(text);
    expect(encoded.toString('hex')).toBe('000b41c080c3a9eda0bdedb880');
    expect(readModifiedUtf8String(encoded)?.value).toBe(text);
    for (let i = 0; i < encoded.length; i++)
      expect(readModifiedUtf8String(encoded.subarray(0, i))).toBeUndefined();
    expect(readModifiedUtf8String(encodeModifiedUtf8String('a😀z', 6))?.value).toBe('a');
    expect(readModifiedUtf8String(encodeModifiedUtf8String('a😀z', 7))?.value).toBe('a😀');
    expect(encodeModifiedUtf8String('a'.repeat(70000)).length).toBe(65537);
    for (const bytes of [
      [0, 1, 0],
      [0, 2, 0xc0, 0x81],
      [0, 3, 0xe0, 0x80, 0x80],
      [0, 4, 0xf0, 0x9f, 0x98, 0x80],
    ])
      expect(() => readModifiedUtf8String(Buffer.from(bytes))).toThrow();
  });

  it('counts UTF-16 units and truncates without splitting a surrogate pair', () => {
    const encoded = encodeUtf16String('A😀é');
    expect(encoded.toString('hex')).toBe('00040041d83dde0000e9');
    expect(readUtf16String(encoded)?.value).toBe('A😀é');
    expect(readUtf16String(encodeUtf16String('A😀é', 2))?.value).toBe('A');
    expect(readUtf16String(encodeUtf16String('A😀é', 3))?.value).toBe('A😀');
    expect(() => readUtf16String(encoded, 0, 3)).toThrow();
  });

  it('serializes kicks in the actual detected encoding', () => {
    const text = 'Ciao\0😀';
    expect(readModifiedUtf8String(legacyKickPacket('legacy-modified-utf8', text), 1)?.value).toBe(
      text,
    );
    expect(readUtf16String(legacyKickPacket('legacy-utf16', text), 1)?.value).toBe(text);
    expect(legacyKickPacket('legacy-utf16', text)[0]).toBe(255);
  });

  it('keeps legacy status separators intact and strips formatting only for original pings', () => {
    const status = { protocolId: 78, version: '1.6.4', motd: '§aCiao§r 😀', online: 0, max: 20 };
    expect(readUtf16String(legacyStatusPacket('original', status), 1)?.value).toBe('Ciao 😀§0§20');
    expect(readUtf16String(legacyStatusPacket('extended', status), 1)?.value).toBe(
      ['§1', '78', '1.6.4', '§aCiao§r 😀', '0', '20'].join('\0'),
    );
    const long = legacyStatusPacket('extended', { ...status, motd: '😀'.repeat(40000) });
    expect(readUtf16String(long, 1)?.value.endsWith('\0' + '0' + '\0' + '20')).toBe(true);
  });

  it('maps formatting to sibling JSON components with color/reset clearing styles', () => {
    expect(formattingToComponents('a§lbold§cred§rplain§z?')).toEqual({
      text: '',
      extra: [
        { text: 'a' },
        { text: 'bold', bold: true },
        { text: 'red', color: 'red' },
        { text: 'plain§z?' },
      ],
    });
  });
});

describe('incremental initial Minecraft packet detection', () => {
  it.each([1, 2, 3])(
    'recognizes signed modern protocol and intent %i at every byte boundary',
    (intent) => {
      fragmented(modern(-1, intent, '世界😀\0FML\0'), {
        kind: intent === 1 ? 'status' : 'join',
        codec: 'netty',
        protocolId: -1,
        intent,
      });
    },
  );

  it('does not confuse a modern frame starting FE01 with a legacy ping', () => {
    const packet = modern(47, 1, 'a'.repeat(247));
    expect(packet.subarray(0, 2)).toEqual(Buffer.from([254, 1]));
    fragmented(packet, { kind: 'status', codec: 'netty', protocolId: 47 });
  });

  it('requires explicit finalization for ambiguous FE / FE01 and parses complete PingHost', () => {
    expect(detectMinecraftInitial(Buffer.from([254]))).toEqual({ kind: 'need-more' });
    expect(detectMinecraftInitial(Buffer.from([254, 1]))).toEqual({ kind: 'need-more' });
    expect(detectMinecraftInitial(Buffer.from([254]), { finalize: true })).toMatchObject({
      kind: 'status',
      statusVariant: 'original',
    });
    expect(detectMinecraftInitial(Buffer.from([254, 1]), { finalize: true })).toMatchObject({
      kind: 'status',
      statusVariant: 'extended',
    });
    fragmented(pingHost(), {
      kind: 'status',
      codec: 'legacy-utf16',
      protocolId: 74,
      statusVariant: 'extended',
    });
    expect(detectMinecraftInitial(pingHost('host', 0), { finalize: true }).kind).not.toBe('status');
    expect(detectMinecraftInitial(pingHost().subarray(0, 8), { finalize: true })).toEqual({
      kind: 'need-more',
    });
    expect(detectMinecraftInitial(modern().subarray(0, 8), { finalize: true })).toEqual({
      kind: 'need-more',
    });
  });

  it.each(['legacy-modified-utf8', 'legacy-utf16'] as const)(
    'recognizes unversioned %s handshake at every boundary',
    (codec) => {
      const string = codec === 'legacy-utf16' ? encodeUtf16String : encodeModifiedUtf8String;
      fragmented(Buffer.concat([Buffer.from([2]), string('Player_1')]), { kind: 'join', codec });
    },
  );

  it('recognizes Alpha initial login only after complete bounded structure', () => {
    for (const protocolId of [13, 14]) {
      const header = Buffer.alloc(5);
      header[0] = 1;
      header.writeInt32BE(protocolId, 1);
      fragmented(
        Buffer.concat([header, encodeModifiedUtf8String('Player'), encodeModifiedUtf8String('')]),
        {
          kind: 'join',
          codec: 'legacy-modified-utf8',
          protocolId,
        },
      );
    }
  });

  it('accepts the old username;host:port handshake without treating host as routing data', () => {
    fragmented(Buffer.concat([Buffer.from([2]), encodeUtf16String('Player;host.example:25565')]), {
      kind: 'join',
      codec: 'legacy-utf16',
    });
    fragmented(pingHost('世界😀'), {
      kind: 'status',
      codec: 'legacy-utf16',
      protocolId: 74,
    });
  });

  it('recognizes explicit 1.3–1.6 legacy join and rejects invalid port', () => {
    const header = Buffer.concat([
      Buffer.from([2, 78]),
      encodeUtf16String('Player'),
      encodeUtf16String('host'),
    ]);
    fragmented(Buffer.concat([header, Buffer.from([0, 0, 0x63, 0xdd])]), {
      kind: 'join',
      codec: 'legacy-utf16',
      protocolId: 78,
    });
    expect(
      detectMinecraftInitial(Buffer.concat([header, Buffer.alloc(4)]), { finalize: true }),
    ).toEqual({ kind: 'invalid' });
  });

  it('rejects malformed modern structure, oversized input and invalid initial text', () => {
    expect(detectMinecraftInitial(modern(47, 4), { finalize: true })).toEqual({ kind: 'invalid' });
    expect(detectMinecraftInitial(modern(47, 1, ''), { finalize: true })).toEqual({
      kind: 'invalid',
    });
    expect(detectMinecraftInitial(Buffer.alloc(4097))).toEqual({ kind: 'invalid' });
    expect(detectMinecraftInitial(Buffer.from([2, 0, 0]), { finalize: true })).toEqual({
      kind: 'invalid',
    });
  });
});
