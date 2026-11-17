import { createHash } from 'node:crypto';
import { gatewayPrivateStateMaxBytes } from '@nickhosting/game-sdk';
import { z } from 'zod';
import {
  satisfactoryEnumerationMaxBytes,
  satisfactoryResponseMaxBytes,
} from './response-limits.js';

/** Read-only API calls declared by Coffee Stain's public dedicated-server controllers. */
export const satisfactoryCachedFunctions = new Set([
  'QueryServerState',
  'GetServerOptions',
  'GetAdvancedGameSettings',
  'EnumerateSessions',
]);
export const satisfactoryJoinFunction = 'JoinGameRequest';
const authorizationLifetimeMs = 5 * 60_000;
const maxEntries = 128;
const entrySchema = z.strictObject({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  tokenKey: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().finite(),
  responses: z
    .record(z.string(), z.string().max(satisfactoryEnumerationMaxBytes))
    .refine((responses) =>
      Object.entries(responses).every(
        ([operation, body]) =>
          satisfactoryCachedFunctions.has(operation) &&
          Buffer.byteLength(body) <= satisfactoryResponseMaxBytes(operation),
      ),
    ),
  observedAt: z.record(z.string(), z.number().finite()).optional(),
});
export const satisfactoryHttpsCacheSchema = z
  .array(entrySchema)
  .max(maxEntries)
  .refine((entries) => Buffer.byteLength(JSON.stringify(entries)) <= gatewayPrivateStateMaxBytes);
export type SatisfactoryHttpsCacheSnapshot = z.infer<typeof satisfactoryHttpsCacheSchema>;
function credentialKey(
  authorization: string | undefined,
  playerId: string | undefined,
): string | undefined {
  if (
    !authorization ||
    !/^Bearer [\x21-\x7e]{1,8192}$/.test(authorization) ||
    (playerId && !/^[a-fA-F0-9]{2,2048}$/.test(playerId))
  )
    return undefined;
  return createHash('sha256')
    .update(authorization)
    .update('\0')
    .update(playerId ?? '')
    .digest('hex');
}
/** Syntax only: this is an ingress intent discriminator, never authentication.
 * Only the backend can validate the fingerprint and player binding. */
export function satisfactoryPlayerCredential(authorization: string | undefined): boolean {
  if (!authorization?.startsWith('Bearer ') || authorization.length > 8199) return false;
  try {
    const parts = authorization.slice(7).split('.');
    if (parts.length !== 2) return false;
    const [token, fingerprint] = parts;
    if (!token || !fingerprint || !/^[a-fA-F0-9]{128}$/.test(fingerprint)) return false;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token) || (token.includes('=') && token.length % 4 !== 0))
      return false;
    const decoded = Buffer.from(token, 'base64');
    if (decoded.toString('base64').replace(/=+$/, '') !== token.replace(/=+$/, '')) return false;
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
    return z.object({ pl: z.enum(['Client', 'Administrator']) }).safeParse(payload).success;
  } catch {
    return false;
  }
}
export class SatisfactoryHttpsCache {
  private readonly entries = new Map<string, SatisfactoryHttpsCacheSnapshot[number]>();
  private storedBytes = 0;
  get byteLength(): number {
    return this.storedBytes;
  }
  constructor(private readonly now: () => number = Date.now) {}
  restore(snapshot: unknown): void {
    const now = this.now();
    if (!Number.isFinite(now)) return;
    for (const entry of satisfactoryHttpsCacheSchema.parse(snapshot)) {
      if (entry.expiresAt <= now || entry.expiresAt > now + authorizationLifetimeMs) continue;
      if (Object.keys(entry.responses).some((fn) => !satisfactoryCachedFunctions.has(fn))) continue;
      if (
        Object.entries(entry.observedAt ?? {}).some(
          ([fn, observedAt]) =>
            observedAt > now ||
            !satisfactoryCachedFunctions.has(fn) ||
            !Object.hasOwn(entry.responses, fn),
        )
      )
        continue;
      if ((this.entries.get(entry.key)?.expiresAt ?? 0) <= entry.expiresAt)
        this.entries.set(entry.key, entry);
    }
    this.trim();
  }
  snapshot(): SatisfactoryHttpsCacheSnapshot {
    this.trim();
    return [...this.entries.values()].map((entry) => ({
      ...entry,
      responses: { ...entry.responses },
      ...(entry.observedAt ? { observedAt: { ...entry.observedAt } } : {}),
    }));
  }
  reject(authorization: string | undefined, _playerId: string | undefined): void {
    const tokenKey = credentialKey(authorization, undefined);
    if (!tokenKey) return;
    for (const [key, entry] of this.entries)
      if (entry.tokenKey === tokenKey) this.entries.delete(key);
    this.trim();
  }
  clear(): void {
    this.entries.clear();
    this.storedBytes = 0;
  }
  private trim(): void {
    for (const [key, entry] of this.entries)
      if (entry.expiresAt <= this.now()) this.entries.delete(key);
    this.storedBytes = Buffer.byteLength(JSON.stringify([...this.entries.values()]));
    while (this.entries.size > maxEntries || this.byteLength > gatewayPrivateStateMaxBytes) {
      const first = this.entries.keys().next().value;
      if (first) this.entries.delete(first);
      this.storedBytes = Buffer.byteLength(JSON.stringify([...this.entries.values()]));
    }
  }
  authorize(authorization: string | undefined, playerId: string | undefined): boolean {
    const key = credentialKey(authorization, playerId);
    return (
      key !== undefined &&
      ((this.entries.get(key)?.expiresAt ?? 0) > this.now() ||
        (playerId !== undefined &&
          (this.entries.get(credentialKey(authorization, undefined) ?? '')?.expiresAt ?? 0) >
            this.now()))
    );
  }
  read(
    fn: string,
    authorization: string | undefined,
    playerId: string | undefined,
  ): string | undefined {
    const key = credentialKey(authorization, playerId);
    return key && this.authorize(authorization, playerId)
      ? (this.entries.get(key) ?? this.entries.get(credentialKey(authorization, undefined) ?? ''))
          ?.responses[fn]
      : undefined;
  }
  remember(
    fn: string,
    authorization: string | undefined,
    playerId: string | undefined,
    body: string,
  ): void {
    const key = credentialKey(authorization, playerId);
    if (
      !key ||
      !satisfactoryCachedFunctions.has(fn) ||
      Buffer.byteLength(body) > satisfactoryResponseMaxBytes(fn)
    )
      return;
    let response: unknown;
    try {
      response = JSON.parse(body);
    } catch {
      return;
    }
    if (
      !z
        .object({ data: z.record(z.string(), z.unknown()), errorCode: z.never().optional() })
        .safeParse(response).success
    )
      return;
    const now = this.now();
    if (!Number.isFinite(now)) return;
    this.trim();
    const entry = this.entries.get(key) ?? {
      key,
      tokenKey: credentialKey(authorization, undefined) as string,
      expiresAt: 0,
      responses: {},
    };
    // A legacy entry has one inferred observation time. Preserve that time before
    // refreshing the shared retention window for a different function.
    entry.observedAt = Object.fromEntries(
      Object.keys(entry.responses).map((name) => [
        name,
        entry.observedAt?.[name] ?? entry.expiresAt - authorizationLifetimeMs,
      ]),
    );
    entry.observedAt[fn] = now;
    entry.expiresAt = now + authorizationLifetimeMs;
    entry.responses[fn] = body;
    this.entries.set(key, entry);
    this.trim();
  }
}
