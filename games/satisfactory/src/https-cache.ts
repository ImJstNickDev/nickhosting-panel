import { createHash } from 'node:crypto';
import { z } from 'zod';

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
const maxBodyBytes = 64 * 1024;
const entrySchema = z.strictObject({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  tokenKey: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().finite(),
  responses: z.record(z.string(), z.string().max(maxBodyBytes)),
});
export const satisfactoryHttpsCacheSchema = z.array(entrySchema).max(maxEntries);
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
  constructor(private readonly now: () => number = Date.now) {}
  restore(snapshot: unknown): void {
    for (const entry of satisfactoryHttpsCacheSchema.parse(snapshot)) {
      if (entry.expiresAt <= this.now() || entry.expiresAt > this.now() + authorizationLifetimeMs)
        continue;
      if (Object.keys(entry.responses).some((fn) => !satisfactoryCachedFunctions.has(fn))) continue;
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
    }));
  }
  reject(authorization: string | undefined, _playerId: string | undefined): void {
    const tokenKey = credentialKey(authorization, undefined);
    if (!tokenKey) return;
    for (const [key, entry] of this.entries)
      if (entry.tokenKey === tokenKey) this.entries.delete(key);
  }
  clear(): void {
    this.entries.clear();
  }
  private trim(): void {
    for (const [key, entry] of this.entries)
      if (entry.expiresAt <= this.now()) this.entries.delete(key);
    while (
      this.entries.size > maxEntries ||
      Buffer.byteLength(JSON.stringify([...this.entries.values()])) > 200 * 1024
    ) {
      const first = this.entries.keys().next().value;
      if (first) this.entries.delete(first);
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
    if (!key || !satisfactoryCachedFunctions.has(fn) || Buffer.byteLength(body) > maxBodyBytes)
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
    this.trim();
    const entry = this.entries.get(key) ?? {
      key,
      tokenKey: credentialKey(authorization, undefined) as string,
      expiresAt: 0,
      responses: {},
    };
    entry.expiresAt = this.now() + authorizationLifetimeMs;
    entry.responses[fn] = body;
    this.entries.set(key, entry);
    this.trim();
  }
}
