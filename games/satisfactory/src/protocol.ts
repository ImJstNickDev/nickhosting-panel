import { DomainError } from '@nickhosting/core';

export const satisfactoryQueryMagic = 0xf6d5;
export type SatisfactoryServerState = 0 | 1 | 2 | 3;
export interface SatisfactoryQueryState {
  state: SatisfactoryServerState;
  netCL: number;
  flags: bigint;
  substates: readonly { id: number; version: number }[];
  name: string;
}
function invalid(): never {
  throw new DomainError('validation_failed', 400, { reason: 'satisfactory_query_invalid' });
}
function uint(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= max;
}
export function encodeSatisfactoryPoll(cookie: bigint): Uint8Array {
  if (cookie < 0n || cookie > 0xffffffffffffffffn) invalid();
  const bytes = Buffer.alloc(13);
  bytes.writeUInt16LE(satisfactoryQueryMagic, 0);
  bytes[3] = 1;
  bytes.writeBigUInt64LE(cookie, 4);
  bytes[12] = 1;
  return bytes;
}
export function decodeSatisfactoryPoll(input: Uint8Array): { cookie: bigint } | undefined {
  const bytes = Buffer.from(input);
  if (
    bytes.length !== 13 ||
    bytes.readUInt16LE(0) !== satisfactoryQueryMagic ||
    bytes[2] !== 0 ||
    bytes[3] !== 1 ||
    bytes[12] !== 1
  )
    return undefined;
  return { cookie: bytes.readBigUInt64LE(4) };
}
export function encodeSatisfactoryState(cookie: bigint, state: SatisfactoryQueryState): Uint8Array {
  if (
    !uint(state.state, 3) ||
    !uint(state.netCL, 0xffffffff) ||
    state.flags < 0n ||
    state.flags > 0xffffffffffffffffn ||
    state.substates.length > 255 ||
    cookie < 0n ||
    cookie > 0xffffffffffffffffn ||
    state.substates.some((s) => !uint(s.id, 255) || !uint(s.version, 65535)) ||
    new Set(state.substates.map((s) => s.id)).size !== state.substates.length
  )
    invalid();
  const name = Buffer.from(state.name, 'utf8');
  if (name.length > 1024) invalid();
  const bytes = Buffer.alloc(29 + state.substates.length * 3 + name.length);
  bytes.writeUInt16LE(satisfactoryQueryMagic, 0);
  bytes[2] = 1;
  bytes[3] = 1;
  bytes.writeBigUInt64LE(cookie, 4);
  bytes[12] = state.state;
  bytes.writeUInt32LE(state.netCL, 13);
  bytes.writeBigUInt64LE(state.flags, 17);
  bytes[25] = state.substates.length;
  let offset = 26;
  for (const substate of state.substates) {
    bytes[offset++] = substate.id;
    bytes.writeUInt16LE(substate.version, offset);
    offset += 2;
  }
  bytes.writeUInt16LE(name.length, offset);
  name.copy(bytes, offset + 2);
  bytes[bytes.length - 1] = 1;
  return bytes;
}
export function decodeSatisfactoryState(
  input: Uint8Array,
  expectedCookie?: bigint,
): SatisfactoryQueryState & { cookie: bigint } {
  const bytes = Buffer.from(input);
  if (
    bytes.length < 29 ||
    bytes.length > 1818 ||
    bytes.readUInt16LE(0) !== satisfactoryQueryMagic ||
    bytes[2] !== 1 ||
    bytes[3] !== 1 ||
    bytes.at(-1) !== 1
  )
    invalid();
  const cookie = bytes.readBigUInt64LE(4);
  if (expectedCookie !== undefined && cookie !== expectedCookie) invalid();
  const state = bytes[12] as SatisfactoryServerState;
  if (state > 3) invalid();
  const count = bytes.readUInt8(25);
  let offset = 26;
  if (bytes.length < 29 + count * 3) invalid();
  const substates: { id: number; version: number }[] = [];
  for (let i = 0; i < count; i++) {
    substates.push({ id: bytes.readUInt8(offset), version: bytes.readUInt16LE(offset + 1) });
    offset += 3;
  }
  const length = bytes.readUInt16LE(offset);
  if (
    length > 1024 ||
    bytes.length !== offset + 3 + length ||
    new Set(substates.map((s) => s.id)).size !== count
  )
    invalid();
  let name: string;
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(offset + 2, offset + 2 + length),
    );
  } catch {
    return invalid();
  }
  return {
    cookie,
    state,
    netCL: bytes.readUInt32LE(13),
    flags: bytes.readBigUInt64LE(17),
    substates,
    name,
  };
}
