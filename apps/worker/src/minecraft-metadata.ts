import type { createLogger } from '@nickhosting/core';
import { type createDatabase, getSettings } from '@nickhosting/database';
import { refreshFabricCatalog, refreshMinecraftMetadata } from '@nickhosting/server-management';

/** Independent from lifecycle reconciliation so a provider outage does not stop
 * manifest refresh and a slow metadata fetch never delays job/admission polling. */
export async function pollMinecraftMetadata(
  db: ReturnType<typeof createDatabase>['db'],
  env: Readonly<Record<string, string | undefined>>,
  logger: ReturnType<typeof createLogger>,
) {
  try {
    const { values } = await getSettings(db, env);
    await Promise.all(
      [
        ['minecraft', refreshMinecraftMetadata] as const,
        ['fabric', refreshFabricCatalog] as const,
      ].map(async ([name, refresh]) => {
        try {
          const result = await refresh(db, { userAgent: values.contentMetadataUserAgent ?? '' });
          if (result.state === 'failed') logger.log('warn', `${name}.metadata_refresh_failed`);
          else if (result.state !== 'skipped')
            logger.log('info', `${name}.metadata_refreshed`, result);
        } catch {
          logger.log('warn', `${name}.metadata_refresh_unavailable`);
        }
      }),
    );
  } catch {
    logger.log('warn', 'minecraft.metadata_refresh_unavailable');
  }
}
