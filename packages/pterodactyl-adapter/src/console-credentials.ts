import { createHash } from 'node:crypto';
import type { PrivateTransferCache } from './adapter.js';
import { PterodactylError, type Transport, type TransportOptions } from './transport.js';

export interface ConsoleCredentials {
  token: string;
  socket: string;
}
export type ConsoleCredentialOptions = TransportOptions & {
  webSocketOrigins?: string[];
  fileDownloadBinding?: string;
  transferCache?: PrivateTransferCache;
};
interface Entry {
  value?: ConsoleCredentials;
  expiresAt: number;
  pending?: Promise<ConsoleCredentials>;
  generation: number;
  sharedInvalidatedUntil: number;
}
const contexts = new WeakMap<object, Map<string, Entry>>();
const REUSE_MS = 120_000;

/** JWT claims are only an expiry hint here, never proof of permission. Wings
 * validates the signature/scopes and the relay rechecks NickHosting authorization. */
function reusableUntil(value: ConsoleCredentials): number {
  try {
    const parts = value.token.split('.');
    if (parts.length !== 3) return 0;
    const claims = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(claims.exp)) return 0;
    return Math.min(claims.exp * 1000 - 30_000, Date.now() + REUSE_MS);
  } catch {
    return 0;
  }
}

/** Short reuse avoids Panel's five token issuances/minute/server on reconnects
 * and internal observers. The existing encrypted cache shares grants across
 * processes; single-flight stays process-local (no new distributed lock). */
export function createConsoleCredentials(
  transport: Transport,
  options: ConsoleCredentialOptions,
  path: string,
  serverUUID: string,
  read: () => Promise<ConsoleCredentials>,
  validate: (value: unknown) => ConsoleCredentials,
) {
  const identity = createHash('sha256')
    .update(
      JSON.stringify([
        new URL(options.baseURL).href,
        options.clientKey,
        options.fileDownloadBinding,
        serverUUID,
        path,
        options.webSocketOrigins,
      ]),
    )
    .digest('hex');
  const key = `console-credentials:v1:${identity}`;
  const context = options.coordinator ?? transport;
  let entries = contexts.get(context);
  if (!entries) {
    entries = new Map();
    contexts.set(context, entries);
  }
  const cache = entries;
  function entry(): Entry {
    const existing = cache.get(key);
    if (existing) return existing;
    if (cache.size >= 1024) {
      for (const [candidate, value] of cache) {
        if (!value.pending && value.sharedInvalidatedUntil <= Date.now()) {
          cache.delete(candidate);
          break;
        }
      }
    }
    // Invalidation fences must survive the lifetime of the shared values they
    // reject, even if Redis deletion is delayed or unavailable.
    if (cache.size >= 1024) throw new PterodactylError('unavailable', 'client', 'rejected');
    const value: Entry = { expiresAt: 0, generation: 0, sharedInvalidatedUntil: 0 };
    cache.set(key, value);
    return value;
  }
  return {
    async read(previousToken?: string): Promise<ConsoleCredentials> {
      const state = entry();
      if (state.value && state.expiresAt > Date.now() && state.value.token !== previousToken)
        return validate(state.value);
      if (state.pending) return state.pending;
      const load = async () => {
        const cachedGeneration = state.generation;
        if (options.transferCache && state.sharedInvalidatedUntil <= Date.now()) {
          try {
            const encoded = await options.transferCache.get(key);
            if (encoded) {
              const stored = JSON.parse(encoded);
              const value = validate(stored.value);
              // Respect the originally granted reuse window; do not extend it on reads.
              const expiresAt = Math.min(stored.expiresAt, reusableUntil(value));
              if (
                state.generation === cachedGeneration &&
                state.sharedInvalidatedUntil <= Date.now() &&
                expiresAt > Date.now() &&
                value.token !== previousToken
              ) {
                state.value = value;
                state.expiresAt = expiresAt;
                return value;
              }
            }
          } catch {
            // Cache availability/invalid entries must not manufacture authorization.
            // Obtain a fresh grant through the normal authenticated Panel endpoint.
          }
        }
        const generation = state.generation;
        const value = validate(await read());
        if (state.generation !== generation)
          throw new PterodactylError('unavailable', 'client', 'rejected');
        const expiresAt = reusableUntil(value);
        if (expiresAt > Date.now()) {
          state.value = value;
          state.expiresAt = expiresAt;
          if (options.transferCache)
            await options.transferCache
              .put(key, JSON.stringify({ value, expiresAt }), expiresAt - Date.now())
              .catch(() => {});
        }
        if (state.generation !== generation) {
          // A put that raced invalidation may have completed after its delete.
          void options.transferCache?.delete(key).catch(() => {});
          throw new PterodactylError('unavailable', 'client', 'rejected');
        }
        return value;
      };
      state.pending = load();
      try {
        return await state.pending;
      } finally {
        state.pending = undefined;
      }
    },
    invalidate(token: string) {
      let state = cache.get(key);
      if (!state) {
        try {
          state = entry();
        } catch {
          // All entries are fenced/in flight: read() already fails closed. An
          // evicted relay's timeout cleanup must still finish without throwing.
        }
      }
      if (state) {
        state.generation++;
        // Immediate local fence: cleanup is best-effort, never the authority for
        // reusing a rejected JWT. Fresh Panel grants remain cacheable locally.
        state.sharedInvalidatedUntil = Date.now() + REUSE_MS;
        if (state.value?.token === token) {
          state.value = undefined;
          state.expiresAt = 0;
        }
      }
      // A rejected JWT (including a Wings restart) must not loop on cached auth.
      // Deletion may discard a concurrent refresh, which costs one safe reissue.
      void options.transferCache?.delete(key).catch(() => {});
    },
  };
}
