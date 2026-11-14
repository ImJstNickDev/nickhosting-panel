import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { NativeSatisfactoryCredentials } from './native-credentials.js';

export type NativePlayerPrivilege = 'Client' | 'Administrator';
export interface NativePlayerIdentity {
  provider: number;
  replicationData: Uint8Array;
}
const privilegeBytes = { Client: 2, Administrator: 3 } as const;
/** Native wire representation is provider byte followed by registry replication
 * bytes (the length is added only for fingerprint serialization). Only proven
 * registry encodings are accepted; unknown providers never become anonymous. */
export function decodeNativePlayerIdentity(value?: string): NativePlayerIdentity | undefined {
  if (value === undefined || value.toUpperCase() === 'INVALID')
    return { provider: 0, replicationData: new Uint8Array() };
  if (/^01[a-f\d]{64}$/i.test(value)) {
    const replicationData = Buffer.from(value.slice(2), 'hex');
    if (
      !/^[a-f\d]{32}$/i.test(replicationData.toString('ascii')) ||
      replicationData.some((byte) => byte > 127)
    )
      return undefined;
    return { provider: 1, replicationData };
  }
  if (!/^06[a-f\d]{16}$/i.test(value)) return undefined;
  const replicationData = Buffer.from(value.slice(2), 'hex');
  if (replicationData.every((byte) => byte === 0)) return undefined;
  return { provider: 6, replicationData };
}
function equalHex(first: string, second: string): boolean {
  if (!/^[a-f\d]{128}$/i.test(first) || !/^[a-f\d]{128}$/i.test(second)) return false;
  return timingSafeEqual(Buffer.from(first, 'hex'), Buffer.from(second, 'hex'));
}
function asciiString(value: string): Buffer {
  const bytes = Buffer.from(value, 'ascii');
  const result = Buffer.alloc(5 + bytes.length);
  result.writeInt32LE(bytes.length + 1);
  bytes.copy(result, 4);
  return result;
}
/** Persistent native tokens, never multiplayer entry tickets. This profile is
 * accepted only after native build/credential decoding and player normalization. */
export function nativeAuthenticationFingerprint(
  credentials: NativeSatisfactoryCredentials,
  privilege: NativePlayerPrivilege,
  player: NativePlayerIdentity,
): string {
  if (
    credentials.build !== 513885 ||
    !/^[a-f\d]{512}$/i.test(credentials.serverSecret) ||
    !Number.isInteger(player.provider) ||
    player.provider < 0 ||
    player.provider > 255 ||
    player.replicationData.byteLength > 1024 ||
    (privilege !== 'Client' && privilege !== 'Administrator')
  )
    throw new Error('Unsupported native authentication');
  const password =
    privilege === 'Administrator' ? credentials.adminPassword : credentials.clientPassword;
  const hash = password?.hash ?? '';
  if (hash && !/^[a-f\d]{128}$/i.test(hash)) throw new Error('Invalid native credentials');
  const header = Buffer.alloc(5);
  header[0] = player.provider;
  header.writeInt32LE(player.replicationData.byteLength, 1);
  return (
    createHmac('sha512', Buffer.from(credentials.serverSecret, 'hex'))
      .update(header)
      .update(player.replicationData)
      .update(Buffer.from([privilegeBytes[privilege]]))
      // FString serializes an empty value as a zero length, without a terminator.
      .update(hash ? asciiString(hash) : Buffer.alloc(4))
      .digest('hex')
      .toUpperCase()
  );
}
export function nativePasswordMatches(
  stored: NativeSatisfactoryCredentials['adminPassword'],
  password: string,
): boolean {
  if (typeof password !== 'string' || password.length > 4096 || password.includes('\0'))
    return false;
  if (!stored?.hash) return password.length === 0;
  if (!/^[a-f\d]{64}$/i.test(stored.salt)) return false;
  const hash = createHash('sha512')
    .update(Buffer.from(stored.salt, 'hex'))
    .update(Buffer.from(password, 'utf8'))
    .digest('hex');
  return equalHex(stored.hash, hash);
}
export function createNativeAuthenticationToken(
  credentials: NativeSatisfactoryCredentials,
  privilege: NativePlayerPrivilege,
  player: NativePlayerIdentity,
): string {
  const payload = Buffer.from(JSON.stringify({ pl: privilege })).toString('base64');
  return `${payload}.${nativeAuthenticationFingerprint(credentials, privilege, player)}`;
}
export function verifyNativeAuthenticationToken(
  credentials: NativeSatisfactoryCredentials,
  token: string,
  minimumPrivilege: NativePlayerPrivilege,
  player: NativePlayerIdentity,
): NativePlayerPrivilege | undefined {
  if (
    typeof token !== 'string' ||
    token.length > 8192 ||
    (minimumPrivilege !== 'Client' && minimumPrivilege !== 'Administrator')
  )
    return undefined;
  const parts = token.split('.');
  if (parts.length !== 2) return undefined;
  const [payload, fingerprint] = parts;
  if (!payload || !fingerprint || !/^[A-Za-z\d+/]+={0,2}$/.test(payload)) return undefined;
  try {
    const decoded = Buffer.from(payload, 'base64');
    if (decoded.toString('base64').replace(/=+$/, '') !== payload.replace(/=+$/, ''))
      return undefined;
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1
    )
      return undefined;
    const privilege = (parsed as { pl?: unknown }).pl;
    if (privilege !== 'Client' && privilege !== 'Administrator') return undefined;
    if (minimumPrivilege === 'Administrator' && privilege !== 'Administrator') return undefined;
    return equalHex(fingerprint, nativeAuthenticationFingerprint(credentials, privilege, player))
      ? privilege
      : undefined;
  } catch {
    return undefined;
  }
}
