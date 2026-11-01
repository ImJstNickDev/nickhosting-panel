import { type AuthContext, authSessionId } from '@nickhosting/core';
import type { ConsoleRelay } from '@nickhosting/pterodactyl-adapter';

/** App-local handles only: no tokens, cross-session reuse, reconnect retries or replay. */
export function createConsoleCommandRelays(limit = 1024) {
  const handles = new Map<string, ConsoleRelay>();
  function key(context: AuthContext, serverId: string, identifier: string, provider: string) {
    const session = context[authSessionId];
    if (!session) return undefined;
    return JSON.stringify([
      session,
      context.actorUserId,
      context.subjectUserId,
      context.sessionType,
      context.support?.id ?? null,
      context.ownerElevation,
      serverId,
      identifier,
      provider,
    ]);
  }
  return {
    register(
      context: AuthContext,
      serverId: string,
      identifier: string,
      provider: string,
      relay: ConsoleRelay,
    ) {
      const id = key(context, serverId, identifier, provider);
      if (!id || (!handles.has(id) && handles.size >= limit)) return () => {};
      handles.set(id, relay);
      return () => {
        if (handles.get(id) === relay) handles.delete(id);
      };
    },
    find(context: AuthContext, serverId: string, identifier: string, provider: string) {
      const id = key(context, serverId, identifier, provider);
      return id ? handles.get(id) : undefined;
    },
  };
}
