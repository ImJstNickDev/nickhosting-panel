import type { createLogger } from '@nickhosting/core';
import { type createDatabase, getSettings } from '@nickhosting/database';
import {
  refreshFabricCatalog,
  refreshForgeCatalog,
  refreshMinecraftMetadata,
  refreshPaperCatalog,
} from '@nickhosting/server-management';

type DB = ReturnType<typeof createDatabase>['db'];
type Environment = Readonly<Record<string, string | undefined>>;
type Logger = ReturnType<typeof createLogger>;
/** Each provider has its own scheduling loop; one slow discovery cannot delay another. */
async function pollMetadata(
  name: 'minecraft' | 'fabric' | 'paper' | 'forge',
  refresh: typeof refreshMinecraftMetadata,
  db: DB,
  env: Environment,
  logger: Logger,
) {
  try {
    const { values } = await getSettings(db, env);
    const result = await refresh(db, { userAgent: values.contentMetadataUserAgent ?? '' });
    if (result.state === 'failed') logger.log('warn', `${name}.metadata_refresh_failed`);
    else if (result.state !== 'skipped') logger.log('info', `${name}.metadata_refreshed`, result);
  } catch {
    logger.log('warn', `${name}.metadata_refresh_unavailable`);
  }
}
export function pollMinecraftMetadata(db: DB, env: Environment, logger: Logger) {
  return pollMetadata('minecraft', refreshMinecraftMetadata, db, env, logger);
}
export function pollFabricMetadata(db: DB, env: Environment, logger: Logger) {
  return pollMetadata('fabric', refreshFabricCatalog, db, env, logger);
}
export function pollPaperMetadata(db: DB, env: Environment, logger: Logger) {
  return pollMetadata('paper', refreshPaperCatalog, db, env, logger);
}

export function pollForgeMetadata(db: DB, env: Environment, logger: Logger) {
  return pollMetadata('forge', refreshForgeCatalog, db, env, logger);
}
