import type { createDatabase } from '@nickhosting/database';
import type { ManagementRuntime } from '@nickhosting/server-management';
import {
  claimOpenworldCaptureScans,
  createOpenworldCaptureCollector,
} from '../../../packages/server-management/src/openworld-capture-index.js';
import { resolveOpenworldDashboardTarget } from '../../../packages/server-management/src/openworld-dashboard.js';
import { createOpenworldSkinCollector } from '../../../packages/server-management/src/openworld-player-skins.js';
import { createOpenworldNativeConnection } from '../../../packages/server-management/src/openworld-telemetry.js';

export function startOpenworldScreenshotLoop(
  db: ReturnType<typeof createDatabase>['db'],
  management: () => Promise<ManagementRuntime>,
  enabled: boolean,
  failed: (serverId?: string) => void,
) {
  const options = {
    db,
    target: async (id: string) =>
      resolveOpenworldDashboardTarget(db, (await management()).adapter, id),
  };
  const native = createOpenworldNativeConnection(options);
  const scan = createOpenworldCaptureCollector(options, native);
  const skins = createOpenworldSkinCollector(options, native);
  const active = new Set<Promise<void>>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tick: Promise<void>;
  async function run() {
    let delay = 1500;
    try {
      const capacity = 4 - active.size;
      if (!enabled || !capacity) return;
      const leases = await claimOpenworldCaptureScans(db, capacity);
      if (stopped) return;
      if (leases.length === 0) delay = 4000;
      for (const lease of leases) {
        const task = scan(lease)
          .then(async (observation) => {
            if (observation && !stopped) await skins(observation.scope, observation.sessions);
          })
          .catch(() => failed(lease.server_id))
          .finally(() => active.delete(task));
        active.add(task);
      }
    } catch {
      if (!stopped) failed();
      delay = 15_000;
    } finally {
      if (enabled && !stopped)
        timer = setTimeout(() => {
          tick = run();
        }, delay);
    }
  }
  tick = run();
  return {
    async close() {
      stopped = true;
      clearTimeout(timer);
      await tick;
      await Promise.allSettled(active);
    },
  };
}
