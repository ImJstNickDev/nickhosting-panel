import { gunzipSync } from 'node:zlib';
import { DomainError } from '@nickhosting/core';
import { parseUncompressed } from 'prismarine-nbt';

function fail(reason: string): never {
  throw new DomainError('validation_failed', 400, { reason: `minecraft_world_${reason}` });
}
export interface MinecraftNbtLimits {
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxDepth: number;
  maxTags: number;
  maxArrayElements: number;
}
export function nbtLimits(input: Partial<MinecraftNbtLimits> = {}): MinecraftNbtLimits {
  const limits = {
    maxCompressedBytes: 8 * 1024 ** 2,
    maxUncompressedBytes: 16 * 1024 ** 2,
    maxDepth: 32,
    maxTags: 100_000,
    maxArrayElements: 1_000_000,
    ...input,
  };
  if (
    Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 1) ||
    limits.maxCompressedBytes > 64 * 1024 ** 2 ||
    limits.maxUncompressedBytes > 64 * 1024 ** 2 ||
    limits.maxDepth > 64 ||
    limits.maxTags > 100_000 ||
    limits.maxArrayElements > 1_000_000
  )
    fail('nbt_limits');
  return limits;
}
/** A bounded structural validation pass precedes the upstream object decoder. */
function preflightNbt(buffer: Buffer, limits: MinecraftNbtLimits): void {
  let offset = 0;
  let tags = 0;
  let elements = 0;
  const take = (length: number) => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > buffer.length)
      fail('nbt_truncated');
    const start = offset;
    offset += length;
    return start;
  };
  const byte = () => buffer.readUInt8(take(1));
  const length = () => {
    const value = buffer.readInt32BE(take(4));
    if (value < 0) fail('nbt_negative_length');
    return value;
  };
  const string = (name: boolean) => {
    const size = buffer.readUInt16BE(take(2));
    const start = take(size);
    if (!name) return '';
    if (size > 1024) fail('nbt_name');
    let value: string;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(start, start + size),
      );
    } catch {
      return fail('nbt_name');
    }
    if (['__proto__', 'constructor', 'prototype'].includes(value) || value.includes('\0'))
      fail('nbt_name');
    return value;
  };
  const payload = (type: number, depth: number): void => {
    if (++tags > limits.maxTags || depth > limits.maxDepth) fail('nbt_complexity');
    switch (type) {
      case 1:
        take(1);
        return;
      case 2:
        take(2);
        return;
      case 3:
      case 5:
        take(4);
        return;
      case 4:
      case 6:
        take(8);
        return;
      case 7:
      case 11:
      case 12: {
        const count = length();
        elements += count;
        if (elements > limits.maxArrayElements) fail('nbt_complexity');
        take(count * (type === 7 ? 1 : type === 11 ? 4 : 8));
        return;
      }
      case 8:
        string(false);
        return;
      case 9: {
        const subtype = byte();
        const count = length();
        if (subtype > 12 || (subtype === 0 && count !== 0) || count > limits.maxTags - tags)
          fail('nbt_list');
        for (let i = 0; i < count; i++) payload(subtype, depth + 1);
        return;
      }
      case 10: {
        const names = new Set<string>();
        for (;;) {
          const subtype = byte();
          if (subtype === 0) return;
          const name = string(true);
          if (names.has(name)) fail('nbt_duplicate');
          names.add(name);
          payload(subtype, depth + 1);
        }
      }
      default:
        fail('nbt_tag');
    }
  };
  if (byte() !== 10) fail('nbt_root');
  string(true);
  payload(10, 0);
  if (offset !== buffer.length) fail('nbt_trailing');
}
export function decodeMinecraftNbt(input: Uint8Array, options?: Partial<MinecraftNbtLimits>) {
  const limits = nbtLimits(options);
  if (input.byteLength < 4 || input.byteLength > limits.maxCompressedBytes) fail('level_data');
  const compressed = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let bytes: Buffer;
  try {
    bytes =
      compressed[0] === 0x1f && compressed[1] === 0x8b
        ? gunzipSync(compressed, { maxOutputLength: limits.maxUncompressedBytes })
        : compressed;
  } catch {
    return fail('nbt_compression');
  }
  if (bytes.byteLength > limits.maxUncompressedBytes) fail('nbt_size');
  preflightNbt(bytes, limits);
  let parsed: ReturnType<typeof parseUncompressed>;
  try {
    parsed = parseUncompressed(bytes, 'big');
  } catch {
    return fail('nbt_invalid');
  }
  return { root: parsed, bytes, compressed };
}
