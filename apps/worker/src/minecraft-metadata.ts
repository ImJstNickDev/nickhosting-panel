import type { createLogger } from '@nickhosting/core';
import {
  type createDatabase,
  getSettings,
  type JobNotificationPool,
  listenForMinecraftCatalogRequests,
} from '@nickhosting/database';
import {
  readMinecraftCatalogSchedule,
  refreshFabricCatalog,
  refreshFoliaCatalog,
  refreshForgeCatalog,
  refreshMinecraftMetadata,
  refreshNeoForgeCatalog,
  refreshPaperCatalog,
  refreshPurpurCatalog,
  refreshQuiltCatalog,
} from '@nickhosting/server-management';

const refresh = {
  mojang: refreshMinecraftMetadata,
  fabric: refreshFabricCatalog,
  quilt: refreshQuiltCatalog,
  paper: refreshPaperCatalog,
  folia: refreshFoliaCatalog,
  purpur: refreshPurpurCatalog,
  forge: refreshForgeCatalog,
  neoforge: refreshNeoForgeCatalog,
};
type Provider = keyof typeof refresh;

/** The database owns next checks and leases. LISTEN wakes the worker for manual
 * requests; the fallback also recovers external edits, missed hints and expired leases. */
export function startMinecraftMetadataLoop(
  db: ReturnType<typeof createDatabase>['db'],
  notificationPool: JobNotificationPool,
  env: Readonly<Record<string, string | undefined>>,
  logger: ReturnType<typeof createLogger>,
) {
  let listener: Awaited<ReturnType<typeof listenForMinecraftCatalogRequests>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking: Promise<void> | undefined;
  let again = false;
  let closed = false;
  const active = new Map<Provider, Promise<void>>();

  async function run(id: Provider, loadUserAgent: () => Promise<string>) {
    const name = id === 'mojang' ? 'minecraft' : id;
    try {
      const result = await refresh[id](db, { loadUserAgent });
      if (result.state === 'failed') logger.log('warn', `${name}.metadata_refresh_failed`);
      else if (result.state !== 'skipped') logger.log('info', `${name}.metadata_refreshed`, result);
    } catch {
      logger.log('warn', `${name}.metadata_refresh_unavailable`);
    }
  }
  async function check() {
    if (!listener) {
      try {
        listener = await listenForMinecraftCatalogRequests(notificationPool, wake, () => {
          listener = undefined;
          wake();
        });
      } catch {
        // Continue polling even with the notification transport unavailable.
      }
    }
    if (closed) return;
    let wait = listener ? 60_000 : 5000;
    try {
      const rows = await readMinecraftCatalogSchedule(db);
      if (closed) return;
      const now = Date.now();
      const deadlines = new Map<Provider, number>([['mojang', now]]);
      for (const row of rows)
        deadlines.set(
          row.id,
          Math.max(row.next_check_at.getTime(), row.lease_until?.getTime() ?? 0),
        );
      // Only a successful database claim reads settings, shared by this group of due jobs.
      let userAgent: Promise<string> | undefined;
      const loadUserAgent = () =>
        (userAgent ??= getSettings(db, env).then(
          ({ values }) => values.contentMetadataUserAgent ?? '',
        ));
      for (const [id, deadline] of deadlines) {
        if (active.has(id)) continue;
        if (deadline > now) {
          wait = Math.min(wait, deadline - now);
        } else {
          active.set(
            id,
            run(id, loadUserAgent).finally(() => active.delete(id)),
          );
        }
      }
    } catch {
      wait = 5000;
      logger.log('warn', 'minecraft.metadata_schedule_unavailable');
    }
    return wait;
  }
  function wake() {
    if (closed) return;
    clearTimeout(timer);
    if (checking) {
      again = true;
      return;
    }
    checking = check().then((wait) => {
      checking = undefined;
      if (!closed) timer = setTimeout(wake, again ? 0 : wait);
      again = false;
    });
  }
  wake();
  return {
    async close() {
      closed = true;
      clearTimeout(timer);
      await checking;
      listener?.close();
      await Promise.all(active.values());
    },
  };
}
