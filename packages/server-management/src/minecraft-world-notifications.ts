import { setTimeout as delay } from 'node:timers/promises';
import { type JobNotificationPool, listenForMinecraftWorldScans } from '@nickhosting/database';

type Session = {
  subscribers: Map<string, Set<() => void>>;
  ready: Promise<void>;
  listener?: { close(): void };
};

// Only requests waiting on another scan use a listener. All servers sharing a pool
// share this connection; the last waiter releases it, including after setup failure.
const sessions = new WeakMap<JobNotificationPool, Session>();

export function subscribeWorldScan(pool: JobNotificationPool, serverId: string) {
  let session = sessions.get(pool);
  if (!session) {
    const entry: Session = { subscribers: new Map(), ready: Promise.resolve() };
    sessions.set(pool, entry);
    entry.ready = listenForMinecraftWorldScans(
      pool,
      (id) => {
        for (const changed of entry.subscribers.get(id) ?? []) changed();
      },
      () => {
        entry.listener = undefined;
        if (sessions.get(pool) === entry) sessions.delete(pool);
        for (const group of entry.subscribers.values()) for (const changed of group) changed();
      },
    )
      .then((listener) => {
        if (entry.subscribers.size) entry.listener = listener;
        else listener.close();
      })
      .catch(() => {
        if (sessions.get(pool) === entry) sessions.delete(pool);
      });
    session = entry;
  }
  const current = session;
  const group = current.subscribers.get(serverId) ?? new Set();
  current.subscribers.set(serverId, group);
  let changed = false;
  let wake: (() => void) | undefined;
  function signal() {
    changed = true;
    wake?.();
  }
  group.add(signal);
  return {
    ready: current.ready,
    connected: () => Boolean(current.listener),
    async wait(ms: number, stop: AbortSignal) {
      stop.throwIfAborted();
      if (!changed) {
        const event = Promise.withResolvers<void>();
        const timer = new AbortController();
        wake = event.resolve;
        try {
          await Promise.race([
            event.promise,
            delay(ms, undefined, { signal: AbortSignal.any([stop, timer.signal]) }),
          ]);
        } finally {
          timer.abort();
          wake = undefined;
        }
      }
      changed = false;
    },
    close() {
      group.delete(signal);
      if (!group.size) current.subscribers.delete(serverId);
      if (!current.subscribers.size) {
        current.listener?.close();
        if (sessions.get(pool) === current) sessions.delete(pool);
      }
    },
  };
}
