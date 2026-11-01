import { DomainError } from '@nickhosting/core';
import { getSettings } from '@nickhosting/database';
import type { DB, Environment } from './admission.js';

type StorageServer = {
  id: string;
  limits: { disk: number };
  feature_limits: { backups: number };
  pterodactyl_id: number | null;
};

/** Finite disks retain their durable reservations. Unlimited disks never count as
 * empty: use recent provider observations, or a bootstrap working reservation
 * before the provider server exists. These are admission estimates, not a cap on
 * independent game writes; physical free-space/headroom checks remain mandatory. */
export async function storageCommitments(db: DB, servers: StorageServer[], env: Environment = {}) {
  const unlimited = servers.filter((server) => server.limits.disk === 0);
  const { values } = await getSettings(db, env);
  const observations = unlimited.length
    ? await db
        .selectFrom('server_metrics')
        .select(['server_id', 'disk_bytes', 'backup_bytes', 'observed_at'])
        .where(
          'server_id',
          'in',
          unlimited.map((server) => server.id),
        )
        .where('observed_at', '>=', new Date(Date.now() - values.observationMaxAgeSeconds * 1000))
        .orderBy('server_id')
        .orderBy('observed_at', 'desc')
        .execute()
    : [];
  return new Map(
    servers.map((server) => {
      let diskMiB = server.limits.disk;
      let occupiedBackupMiB = 0;
      if (diskMiB === 0) {
        const observation = observations.find((item) => item.server_id === server.id);
        if (!server.pterodactyl_id) diskMiB = values.defaultServerStorageMiB;
        else {
          if (
            !observation ||
            Date.now() - observation.observed_at.getTime() >
              values.observationMaxAgeSeconds * 1000 ||
            observation.observed_at.getTime() > Date.now() ||
            !Number.isSafeInteger(Number(observation.disk_bytes)) ||
            Number(observation.disk_bytes) < 0
          )
            throw new DomainError('integration_unavailable');
          diskMiB = Math.ceil(Number(observation.disk_bytes) / 1048576);
          const backup = observations.find(
            (item) => item.server_id === server.id && item.backup_bytes !== null,
          );
          if (
            !backup ||
            backup.observed_at.getTime() > Date.now() ||
            !Number.isSafeInteger(Number(backup.backup_bytes)) ||
            Number(backup.backup_bytes) < 0
          )
            throw new DomainError('integration_unavailable');
          occupiedBackupMiB = Math.ceil(Number(backup.backup_bytes) / 1048576);
        }
      }
      return [
        server.id,
        diskMiB + Math.max(diskMiB * server.feature_limits.backups, occupiedBackupMiB),
      ] as const;
    }),
  );
}
