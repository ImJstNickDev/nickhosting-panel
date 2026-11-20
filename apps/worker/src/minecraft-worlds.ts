import type { createDatabase } from '@nickhosting/database';
import type { ManagementRuntime } from '@nickhosting/server-management';
import {
  dueMinecraftWorldIndexes,
  reconcileDueMinecraftWorldIndex,
} from '../../../packages/server-management/src/minecraft-world-index.js';

/** Only the small due index is polled locally. A slow provider occupies one slot;
 * the remaining slots continue serving other servers on their individual phases. */
export function startMinecraftWorldIndexLoop(
  db: ReturnType<typeof createDatabase>['db'],
  management: () => Promise<ManagementRuntime>,
  env: Readonly<Record<string, string | undefined>>,
  failed: (serverId?: string) => void,
) {
  const stop = new AbortController();
  const active = new Set<Promise<void>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tick: Promise<void>;
  async function dispatch() {
    let interval = 1000;
    try {
      const capacity = 4 - active.size;
      if (!capacity || !env.NH_SECRETS_MASTER_KEY) return;
      const servers = await dueMinecraftWorldIndexes(db, capacity);
      if (!servers.length || stop.signal.aborted) return;
      const runtime = await management();
      if (stop.signal.aborted) return;
      for (const id of servers) {
        const scan = reconcileDueMinecraftWorldIndex(db, id, runtime, env, stop.signal)
          .catch(() => {
            if (!stop.signal.aborted) failed(id);
          })
          .finally(() => active.delete(scan));
        active.add(scan);
      }
    } catch {
      interval = 10000;
      if (!stop.signal.aborted) failed();
    } finally {
      if (!stop.signal.aborted)
        timer = setTimeout(() => {
          tick = dispatch();
        }, interval);
    }
  }
  tick = dispatch();
  return {
    async close() {
      stop.abort();
      clearTimeout(timer);
      await tick;
      await Promise.allSettled(active);
    },
  };
}
