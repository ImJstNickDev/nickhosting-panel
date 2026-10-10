import type { createLogger } from '@nickhosting/core';
import { type createDatabase, getSettings } from '@nickhosting/database';
import { refreshMinecraftMetadata } from '@nickhosting/server-management';

/** Independent from lifecycle reconciliation so a provider outage does not stop
 * manifest refresh and a slow metadata fetch never delays job/admission polling. */
export async function pollMinecraftMetadata(
  db: ReturnType<typeof createDatabase>['db'],
  env: Readonly<Record<string, string | undefined>>,
  logger: ReturnType<typeof createLogger>,
) {
  try {
    const { values } = await getSettings(db, env);
    const result = await refreshMinecraftMetadata(db, {
      userAgent: values.minecraftMetadataUserAgent ?? '',
    });
    if (result.state === 'failed') logger.log('warn', 'minecraft.metadata_refresh_failed');
    else if (result.state !== 'skipped') logger.log('info', 'minecraft.metadata_refreshed', result);
  } catch {
    logger.log('warn', 'minecraft.metadata_refresh_unavailable');
  }
}
