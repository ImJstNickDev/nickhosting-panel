/** Bounded wire codecs. Protocol detection consumes accumulated bytes, never a TCP chunk. */
export type MinecraftWireCodec = 'netty' | 'legacy-utf16' | 'legacy-modified-utf8';
export type LegacyStatusVariant = 'original' | 'extended';
export type MinecraftInitial =
  | { kind: 'need-more' }
  | { kind: 'invalid' }
  | {
      kind: 'status' | 'join';
      codec: MinecraftWireCodec;
      bytes: number;
      protocolId?: number;
      intent?: 1 | 2 | 3;
      statusVariant?: LegacyStatusVariant;
    };

const invalid = () => new Error('minecraft.invalid_wire');
function byteAt(input: Uint8Array, offset: number): number {
  const byte = input[offset];
  if (byte === undefined) throw invalid();
  return byte;
}
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
type Read<T> = { value: T; bytes: number } | undefined;

export function encodeSignedVarInt(value: number): Buffer {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw invalid();
  const bytes: number[] = [];
  let unsigned = value >>> 0;
  do {
    const next = unsigned & 127;
    unsigned >>>= 7;
    bytes.push(next | (unsigned ? 128 : 0));
  } while (unsigned);
  return Buffer.from(bytes);
}

export function readSignedVarInt(input: Uint8Array, offset = 0): Read<number> {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = input[offset + i];
    if (byte === undefined) return undefined;
    if (i === 4 && (byte & 0xf0) !== 0) throw invalid();
    value |= (byte & 127) << (i * 7);
    if (!(byte & 128)) return { value, bytes: i + 1 };
  }
  throw invalid();
}

export function encodeMinecraftFrame(id: number, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  if (!Number.isInteger(id) || id < 0) throw invalid();
  const body = Buffer.concat([encodeSignedVarInt(id), payload]);
  if (body.length > 2097151) throw invalid();
  return Buffer.concat([encodeSignedVarInt(body.length), body]);
}

export function readMinecraftWireFrame(
  input: Uint8Array,
  maximumBytes = 4096,
): { body: Buffer; bytes: number } | undefined {
  const length = readSignedVarInt(input);
  if (!length) return undefined;
  if (length.value < 1 || length.value > maximumBytes || length.bytes > 3) throw invalid();
  const bytes = length.bytes + length.value;
  return input.length < bytes
    ? undefined
    : { body: Buffer.from(input.subarray(length.bytes, bytes)), bytes };
}

export function encodeUtf8String(value: string, maximumUnits = 32767): Buffer {
  if (value.length > maximumUnits || !value.isWellFormed()) throw invalid();
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeSignedVarInt(bytes.length), bytes]);
}

export function readUtf8String(input: Uint8Array, offset = 0, maximumUnits = 32767): Read<string> {
  const length = readSignedVarInt(input, offset);
  if (!length) return undefined;
  if (length.value < 0 || length.value > maximumUnits * 3) throw invalid();
  const end = offset + length.bytes + length.value;
  if (input.length < end) return undefined;
  const value = utf8.decode(input.subarray(offset + length.bytes, end));
  if (value.length > maximumUnits) throw invalid();
  return { value, bytes: end - offset };
}

function ushort(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
}

/** Truncate at a Unicode scalar boundary while counting Java UTF-16 units. */
export function truncateUtf16(value: string, maximumUnits: number): string {
  if (!Number.isInteger(maximumUnits) || maximumUnits < 0 || maximumUnits > 65535) throw invalid();
  let end = Math.min(value.length, maximumUnits);
  if (end < value.length && end > 0) {
    const last = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  }
  return value.slice(0, end);
}

export function encodeUtf16String(value: string, maximumUnits = 65535): Buffer {
  value = truncateUtf16(value, maximumUnits);
  const bytes = Buffer.alloc(value.length * 2 + 2);
  bytes.writeUInt16BE(value.length);
  for (let i = 0; i < value.length; i++) bytes.writeUInt16BE(value.charCodeAt(i), i * 2 + 2);
  return bytes;
}

export function readUtf16String(input: Uint8Array, offset = 0, maximumUnits = 65535): Read<string> {
  if (input.length < offset + 2) return undefined;
  const length = byteAt(input, offset) * 256 + byteAt(input, offset + 1);
  if (length > maximumUnits) throw invalid();
  const bytes = 2 + length * 2;
  if (input.length < offset + bytes) return undefined;
  let value = '';
  for (let i = offset + 2; i < offset + bytes; i += 2)
    value += String.fromCharCode(byteAt(input, i) * 256 + byteAt(input, i + 1));
  return { value, bytes };
}

/** Java DataOutput.writeUTF: NUL is C0 80; supplementary scalars use two triples. */
export function encodeModifiedUtf8String(value: string, maximumBytes = 65535): Buffer {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 65535) throw invalid();
  const output: number[] = [];
  for (const scalar of value) {
    const encoded: number[] = [];
    for (let i = 0; i < scalar.length; i++) {
      const unit = scalar.charCodeAt(i);
      if (unit > 0 && unit <= 127) encoded.push(unit);
      else if (unit <= 2047) encoded.push(0xc0 | (unit >> 6), 0x80 | (unit & 63));
      else encoded.push(0xe0 | (unit >> 12), 0x80 | ((unit >> 6) & 63), 0x80 | (unit & 63));
    }
    if (output.length + encoded.length > maximumBytes) break;
    output.push(...encoded);
  }
  return Buffer.concat([ushort(output.length), Buffer.from(output)]);
}

export function readModifiedUtf8String(
  input: Uint8Array,
  offset = 0,
  maximumBytes = 65535,
): Read<string> {
  if (input.length < offset + 2) return undefined;
  const length = byteAt(input, offset) * 256 + byteAt(input, offset + 1);
  if (length > maximumBytes) throw invalid();
  const end = offset + 2 + length;
  if (input.length < end) return undefined;
  let value = '';
  for (let i = offset + 2; i < end; ) {
    const first = byteAt(input, i++);
    if (first > 0 && first < 128) {
      value += String.fromCharCode(first);
      continue;
    }
    const count = (first & 0xe0) === 0xc0 ? 2 : (first & 0xf0) === 0xe0 ? 3 : 0;
    if (!count || i + count - 1 > end) throw invalid();
    let unit = first & (count === 2 ? 31 : 15);
    for (let j = 1; j < count; j++) {
      const continuation = byteAt(input, i++);
      if ((continuation & 0xc0) !== 0x80) throw invalid();
      unit = (unit << 6) | (continuation & 63);
    }
    if ((count === 2 && unit < 128 && unit !== 0) || (count === 3 && unit < 2048)) throw invalid();
    value += String.fromCharCode(unit);
  }
  return { value, bytes: length + 2 };
}

export function legacyKickPacket(
  codec: Exclude<MinecraftWireCodec, 'netty'>,
  text: string,
): Buffer {
  return Buffer.concat([
    Buffer.from([255]),
    codec === 'legacy-modified-utf8'
      ? encodeModifiedUtf8String(text, 65535)
      : encodeUtf16String(text, 32767),
  ]);
}

export function legacyStatusPacket(
  variant: LegacyStatusVariant,
  status: { protocolId: number; version: string; motd: string; online: number; max: number },
): Buffer {
  if (![status.online, status.max].every((n) => Number.isSafeInteger(n) && n >= 0)) throw invalid();
  const clean = (text: string) => text.replaceAll('\0', '');
  const suffix =
    variant === 'original'
      ? `§${status.online}§${status.max}`
      : `\0${status.online}\0${status.max}`;
  const prefix =
    variant === 'original'
      ? ''
      : `§1\0${status.protocolId}\0${truncateUtf16(clean(status.version), 128)}\0`;
  const motd =
    variant === 'original'
      ? clean(status.motd)
          .replace(/§[0-9a-fk-or]/gi, '')
          .replaceAll('§', '')
      : clean(status.motd);
  return legacyKickPacket(
    'legacy-utf16',
    prefix + truncateUtf16(motd, 32767 - prefix.length - suffix.length) + suffix,
  );
}

export interface MinecraftTextComponent {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underlined?: boolean;
  strikethrough?: boolean;
  obfuscated?: boolean;
}

export function formattingToComponents(text: string): {
  text: '';
  extra: MinecraftTextComponent[];
} {
  const colors = [
    'black',
    'dark_blue',
    'dark_green',
    'dark_aqua',
    'dark_red',
    'dark_purple',
    'gold',
    'gray',
    'dark_gray',
    'blue',
    'green',
    'aqua',
    'red',
    'light_purple',
    'yellow',
    'white',
  ];
  const formats = {
    k: 'obfuscated',
    l: 'bold',
    m: 'strikethrough',
    n: 'underlined',
    o: 'italic',
  } as const;
  const extra: MinecraftTextComponent[] = [];
  let style: Omit<MinecraftTextComponent, 'text'> = {};
  let part = '';
  const flush = () => {
    if (part) extra.push({ text: part, ...style });
    part = '';
  };
  for (let i = 0; i < text.length; i++) {
    const code = text[i] === '§' ? text[i + 1]?.toLowerCase() : undefined;
    if (code && /^[0-9a-fk-or]$/.test(code)) {
      flush();
      i++;
      if (code === 'r') style = {};
      else if (/^[0-9a-f]$/.test(code))
        style = { color: colors[Number.parseInt(code, 16)] ?? 'white' };
      else style = { ...style, [formats[code as keyof typeof formats]]: true };
    } else part += text[i];
  }
  flush();
  return { text: '', extra };
}

function modernInitial(input: Buffer, maximumBytes: number): MinecraftInitial {
  const frame = readMinecraftWireFrame(input, maximumBytes);
  if (!frame) return { kind: 'need-more' };
  let offset = 0;
  const integer = () => {
    const read = readSignedVarInt(frame.body, offset);
    if (!read) throw invalid();
    offset += read.bytes;
    return read.value;
  };
  if (integer() !== 0) throw invalid();
  const protocolId = integer();
  const host = readUtf8String(frame.body, offset, 261);
  if (!host?.value.length) throw invalid();
  offset += host.bytes;
  if (offset + 2 > frame.body.length || frame.body.readUInt16BE(offset) === 0) throw invalid();
  offset += 2;
  const intent = integer();
  if (offset !== frame.body.length || (intent !== 1 && intent !== 2 && intent !== 3))
    throw invalid();
  return {
    kind: intent === 1 ? 'status' : 'join',
    codec: 'netty',
    protocolId,
    intent,
    bytes: frame.bytes,
  };
}

const validLegacyText = (text: string) =>
  text.length > 0 &&
  [...text].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
const validLegacyHandshake = (text: string) =>
  validLegacyText(text) && /^[A-Za-z0-9_]{1,16}(?:;.+)?$/.test(text);

/** Historical layouts are documented by ViaLegacy's serverbound packet tables:
 * Initial Alpha1.0.15/16 login has protocol + two readUtf strings;
 * later Alpha/Beta1.4 handshake uses readUtf; Beta1.5 uses readString; Release1.6.4
 * CLIENT_PROTOCOL contains byte protocol, username, host and int32 port.
 * No release is inferred from an unversioned pre-1.3 handshake. */
function legacyJoin(input: Buffer): MinecraftInitial {
  if (input[0] === 1) {
    if (input.length < 5) return { kind: 'need-more' };
    const protocolId = input.readInt32BE(1);
    // Initial Alpha login is accepted only for the explicitly understood layouts.
    if (protocolId !== 13 && protocolId !== 14) throw invalid();
    const username = readModifiedUtf8String(input, 5, 48);
    if (!username) return { kind: 'need-more' };
    if (!validLegacyText(username.value) || username.value.length > 16) throw invalid();
    const password = readModifiedUtf8String(input, 5 + username.bytes, 256);
    if (!password) return { kind: 'need-more' };
    const bytes = 5 + username.bytes + password.bytes;
    if (input.length < bytes) return { kind: 'need-more' };
    return { kind: 'join', codec: 'legacy-modified-utf8', protocolId, bytes };
  }
  if (input[0] !== 2) throw invalid();
  if (input.length < 2) return { kind: 'need-more' };
  // 1.3–1.6 carry a protocol byte; old short strings begin with a zero high byte.
  if (byteAt(input, 1) >= 39 && byteAt(input, 1) <= 78) {
    const username = readUtf16String(input, 2, 16);
    if (!username) return { kind: 'need-more' };
    if (!validLegacyText(username.value)) throw invalid();
    const host = readUtf16String(input, 2 + username.bytes, 255);
    if (!host) return { kind: 'need-more' };
    if (!validLegacyText(host.value)) throw invalid();
    const offset = 2 + username.bytes + host.bytes;
    if (input.length < offset + 4) return { kind: 'need-more' };
    const port = input.readInt32BE(offset);
    if (port < 1 || port > 65535) throw invalid();
    return { kind: 'join', codec: 'legacy-utf16', protocolId: input[1], bytes: offset + 4 };
  }
  let pending = false;
  const matches: MinecraftInitial[] = [];
  for (const codec of ['legacy-modified-utf8', 'legacy-utf16'] as const) {
    try {
      // Usernames begin with ASCII in these protocols. Inspect the first code
      // unit's high byte so a short Modified UTF string cannot be mistaken for
      // an incomplete UTF-16 string (or vice versa) at a fragmentation boundary.
      if (input.length > 3 && (codec === 'legacy-utf16' ? input[3] !== 0 : input[3] === 0))
        continue;
      const read =
        codec === 'legacy-modified-utf8'
          ? readModifiedUtf8String(input, 1, 255)
          : readUtf16String(input, 1, 255);
      if (!read) {
        pending = true;
        continue;
      }
      if (validLegacyHandshake(read.value))
        matches.push({ kind: 'join', codec, bytes: 1 + read.bytes });
    } catch {
      /* The other encoding may still be valid. */
    }
  }
  if (matches.length === 1 && matches[0]) return matches[0];
  if (pending) return { kind: 'need-more' };
  throw invalid();
}

function legacyStatus(input: Buffer, finalize: boolean): MinecraftInitial {
  if (input.length === 1)
    return finalize
      ? { kind: 'status', codec: 'legacy-utf16', statusVariant: 'original', bytes: 1 }
      : { kind: 'need-more' };
  if (input[1] !== 1) throw invalid();
  if (input.length === 2)
    return finalize
      ? { kind: 'status', codec: 'legacy-utf16', statusVariant: 'extended', bytes: 2 }
      : { kind: 'need-more' };
  if (input[2] !== 250) throw invalid();
  const channel = readUtf16String(input, 3, 11);
  if (!channel) return { kind: 'need-more' };
  if (channel.value !== 'MC|PingHost') throw invalid();
  const offset = 3 + channel.bytes;
  if (input.length < offset + 3) return { kind: 'need-more' };
  const payloadLength = input.readUInt16BE(offset);
  if (payloadLength < 7 || payloadLength > 517) throw invalid();
  const end = offset + 2 + payloadLength;
  if (input.length < end) return { kind: 'need-more' };
  const protocolId = byteAt(input, offset + 2);
  const host = readUtf16String(input.subarray(0, end), offset + 3, 255);
  if (!host || !validLegacyText(host.value) || offset + 3 + host.bytes + 4 !== end) throw invalid();
  const port = input.readInt32BE(end - 4);
  if (port < 1 || port > 65535 || input.length !== end) throw invalid();
  return {
    kind: 'status',
    codec: 'legacy-utf16',
    statusVariant: 'extended',
    protocolId,
    bytes: end,
  };
}

/** Call with finalize only at the caller's explicit ambiguity deadline.
 * A bare FE or FE01 never completes merely because a TCP chunk ended. */
export function detectMinecraftInitial(
  bytes: Uint8Array,
  options: { finalize?: boolean; maximumBytes?: number } = {},
): MinecraftInitial {
  const maximum = options.maximumBytes ?? 4096;
  const input = Buffer.from(bytes);
  if (input.length > maximum) return { kind: 'invalid' };
  if (!input.length) return { kind: 'need-more' };
  let modern: MinecraftInitial;
  try {
    modern = modernInitial(input, maximum);
  } catch {
    modern = { kind: 'invalid' };
  }
  if (modern.kind === 'join' || modern.kind === 'status') return modern;
  let legacy: MinecraftInitial;
  try {
    legacy = input[0] === 254 ? legacyStatus(input, options.finalize ?? false) : legacyJoin(input);
  } catch {
    legacy = { kind: 'invalid' };
  }
  if (legacy.kind === 'join' || legacy.kind === 'status') return legacy;
  if (modern.kind === 'need-more' || legacy.kind === 'need-more') return { kind: 'need-more' };
  return { kind: 'invalid' };
}
