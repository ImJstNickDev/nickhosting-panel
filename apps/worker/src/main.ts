import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, DomainError, encryptionKeyFromBase64, SecretCodec } from '@nickhosting/core';
import { createDatabase, getSecret, getSettings } from '@nickhosting/database';
import { createPrivateTransferCache, processJob, startJobWorker } from '@nickhosting/jobs';
import {
  createDirectoryIdentityCache,
  createInstallationCollector,
  createManagementRuntime,
  createManagementTransportCoordinator,
  ensureInstallationFeedLink,
  ensureProviderAccounts,
  reconcileOpenworldPublications,
  recordWorkerHeartbeat,
  refreshHostObservations,
  wakeInstallationOperation,
} from '@nickhosting/server-management';
import { nginxProxyManager } from '../../../packages/external-services/src/nginx-proxy-manager.js';
import { minecraftModpackSchemaAvailable } from '../../../packages/server-management/src/minecraft-modpack-schema.js';
import { minecraftContentProviders } from '../../../packages/server-management/src/minecraft-world-catalog.js';
import { createMinecraftModpackBridge } from '../../../packages/server-management/src/modpack-bridge.js';
import { startDashboardPublicationLoop } from './dashboard-publications.js';
import { startHostObservationLoop } from './host-observations.js';
import { startMinecraftMetadataLoop } from './minecraft-metadata.js';
import { startMinecraftModpackLoop } from './minecraft-modpacks.js';
import { startMinecraftWorldIndexLoop } from './minecraft-worlds.js';
import { refreshProviderFeeds, startProviderFeedLoop } from './provider-feed.js';
import { reconcileServers } from './reconcile.js';
import { pollSchedules } from './schedules.js';

export async function main(env: NodeJS.ProcessEnv = process.env) {
  if (!env.DATABASE_URL || !env.REDIS_URL || !env.NH_JOB_PREFIX)
    throw new DomainError('configuration_invalid');
  const { db, pool } = createDatabase(env.DATABASE_URL);
  const transportCoordinator = createManagementTransportCoordinator();
  let directoryIdentityCache: ReturnType<typeof createDirectoryIdentityCache> | undefined;
  let transferCache: ReturnType<typeof createPrivateTransferCache> | undefined;
  try {
    const settings = await getSettings(db, env);
    const logger = createLogger((record) => process.stdout.write(`${JSON.stringify(record)}\n`), {
      level: settings.values.logLevel,
    });
    let installations: ReturnType<typeof createInstallationCollector> | undefined;
    const management = async () => {
      if (!env.NH_SECRETS_MASTER_KEY) throw new DomainError('configuration_invalid');
      const keyId = env.NH_SECRETS_KEY_ID ?? 'primary';
      const codec = new SecretCodec({
        activeKeyId: keyId,
        keys: { [keyId]: encryptionKeyFromBase64(env.NH_SECRETS_MASTER_KEY) },
      });
      transferCache ??= createPrivateTransferCache({
        redisUrl: env.REDIS_URL as string,
        prefix: env.NH_JOB_PREFIX as string,
        databaseUrl: env.DATABASE_URL as string,
        codec,
        logger,
      });
      directoryIdentityCache ??= createDirectoryIdentityCache(undefined, transferCache);
      return createManagementRuntime({
        db,
        worldNotificationPool: pool.options.max === 1 ? undefined : pool,
        env,
        logger,
        transportCoordinator,
        transferCache,
        directoryIdentityCache,
        codec,
        onInstallationAvailable: (jobId, serverId) => installations?.ensure(jobId, serverId),
      });
    };
    const runtime = await startJobWorker({
      db,
      notificationPool: pool,
      redisUrl: env.REDIS_URL,
      prefix: env.NH_JOB_PREFIX,
      logger,
      processor: async (jobId) => {
        const row = await db
          .selectFrom('server_operations')
          .select(['job_id', 'plan'])
          .where('job_id', '=', jobId)
          .executeTakeFirst();
        if (typeof row?.plan.modpackOperationId === 'string') return 'modpack-owned';
        return row ? (await management()).process(jobId) : processJob(db, jobId);
      },
    });
    // Reuse the job Redis connection and deployment/database namespace for replica leases.
    const redis = await runtime.queue.getBackend().client;
    redis.defineCommand('nhInstallationLease', {
      numberOfKeys: 1,
      lua: `
      if ARGV[2] == 'claim' then
        if redis.call('SET',KEYS[1],ARGV[1],'PX',15000,'NX') then return 1 else return 0 end
      end
      if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
      if ARGV[2] == 'renew' then return redis.call('PEXPIRE',KEYS[1],15000) end
      return redis.call('DEL',KEYS[1])
    `,
    });
    const leasePrefix = `${env.NH_JOB_PREFIX}:installation:{${createHash('sha256')
      .update(JSON.stringify([env.NH_JOB_PREFIX, env.DATABASE_URL]))
      .digest('hex')}}`;
    if (env.NH_SECRETS_MASTER_KEY) {
      const keyId = env.NH_SECRETS_KEY_ID ?? 'primary';
      const installCodec = new SecretCodec({
        activeKeyId: keyId,
        keys: { [keyId]: encryptionKeyFromBase64(env.NH_SECRETS_MASTER_KEY ?? '') },
      });
      transferCache ??= createPrivateTransferCache({
        redisUrl: env.REDIS_URL,
        prefix: env.NH_JOB_PREFIX,
        databaseUrl: env.DATABASE_URL,
        codec: installCodec,
        logger,
      });
      if (transferCache)
        installations = createInstallationCollector({
          db,
          cache: transferCache,
          adapter: async () => (await management()).adapter,
          prepare: (serverId) =>
            ensureInstallationFeedLink(db, installCodec, env, serverId, transportCoordinator),
          wake: (jobId) => wakeInstallationOperation(db, jobId),
          leaseKey: (jobId) => `${leasePrefix}:${jobId}`,
          async lease(jobId, token, operation) {
            const key = `${leasePrefix}:${jobId}`;
            const result = await redis.runCommand('nhInstallationLease', [key, token, operation]);
            return result === 1;
          },
        });
    }
    const recoverInstallations = async () => {
      const rows = await db
        .selectFrom('server_operations as o')
        .innerJoin('managed_servers as s', 's.active_operation_id', 'o.job_id')
        .select(['o.job_id', 's.id'])
        .where('o.action', 'in', ['provision', 'reinstall'])
        .where('s.deleted_at', 'is', null)
        .where('s.pterodactyl_identifier', 'is not', null)
        .where('s.installation_state', 'in', ['pending', 'installing'])
        .limit(32)
        .execute();
      for (const row of rows) installations?.ensure(row.job_id, row.id);
    };
    const dashboards = startDashboardPublicationLoop(
      pool,
      () => {
        // One snapshot binds the configured destination to its matching credential.
        // Resolve it only for a due operation and share it within that worker batch.
        let provider: ReturnType<typeof nginxProxyManager> | undefined;
        const load = async () => {
          const keyId = env.NH_SECRETS_KEY_ID ?? 'primary';
          const codec = new SecretCodec({
            activeKeyId: keyId,
            keys: { [keyId]: encryptionKeyFromBase64(env.NH_SECRETS_MASTER_KEY ?? '') },
          });
          const settings = await db
            .transaction()
            .setIsolationLevel('repeatable read')
            .execute(async (tx) => {
              const { values } = await getSettings(tx, env);
              const bearer = await getSecret(tx, codec, 'npmAccessToken', env);
              if (!values.npmApiUrl || !values.npmAcmeEmail || !bearer)
                throw new DomainError('configuration_invalid');
              return { apiUrl: values.npmApiUrl, acmeEmail: values.npmAcmeEmail, bearer };
            });
          const dev = env.NH_DEPLOYMENT_ENV === 'development',
            prod = env.NH_DEPLOYMENT_ENV === 'production';
          const prefix = dev ? 'NH_DEV_NPM_' : prod ? 'NH_PROD_NPM_' : 'NH_NPM_';
          const forwardHost =
            env[`${prefix}DASHBOARD_FORWARD_HOST`] ??
            (dev ? 'nickhosting-dev-web' : prod ? 'nickhosting-prod-web' : '');
          const forwardPort = Number(env[`${prefix}DASHBOARD_FORWARD_PORT`] ?? 8081);
          return nginxProxyManager({ ...settings, forwardHost, forwardPort });
        };
        return reconcileOpenworldPublications(
          db,
          () => (provider ??= load()),
          (id) => logger.log('warn', 'dashboard.publication_unavailable', { id }),
        );
      },
      () => logger.log('warn', 'dashboard.reconciliation_unavailable'),
    );
    const observations = startHostObservationLoop(
      async () => {
        await refreshHostObservations(db, env, { force: true });
      },
      () => logger.log('warn', 'host.observation_unavailable'),
    );
    const providerAccounts = startProviderFeedLoop(
      async () => {
        if (!env.NH_SECRETS_MASTER_KEY) return;
        const keyId = env.NH_SECRETS_KEY_ID ?? 'primary';
        const codec = new SecretCodec({
          activeKeyId: keyId,
          keys: { [keyId]: encryptionKeyFromBase64(env.NH_SECRETS_MASTER_KEY) },
        });
        await ensureProviderAccounts(db, codec, env, { coordinator: transportCoordinator });
      },
      () => logger.log('warn', 'provider.enrollment_unavailable'),
    );
    const providerFeeds = startProviderFeedLoop(
      async () => {
        if (!env.NH_SECRETS_MASTER_KEY) return;
        const keyId = env.NH_SECRETS_KEY_ID ?? 'primary';
        const codec = new SecretCodec({
          activeKeyId: keyId,
          keys: { [keyId]: encryptionKeyFromBase64(env.NH_SECRETS_MASTER_KEY) },
        });
        await refreshProviderFeeds(db, codec, env, transportCoordinator);
      },
      () => logger.log('warn', 'provider.feed_unavailable'),
    );
    const worldIndexes = startMinecraftWorldIndexLoop(db, management, env, (serverId) =>
      logger.log('warn', 'minecraft.world_index_unavailable', { serverId }),
    );
    const modpacks = startMinecraftModpackLoop({
      notificationPool: pool,
      unavailable: () => logger.log('warn', 'minecraft.modpack_worker_unavailable'),
      service: async () => {
        if (!(await minecraftModpackSchemaAvailable(db))) return null;
        if (!env.NH_SECRETS_MASTER_KEY) return null;
        const keyId = env.NH_SECRETS_KEY_ID ?? 'primary';
        const codec = new SecretCodec({
          activeKeyId: keyId,
          keys: { [keyId]: encryptionKeyFromBase64(env.NH_SECRETS_MASTER_KEY) },
        });
        const [runtime, content] = await Promise.all([
          management(),
          minecraftContentProviders(db, codec, env),
        ]);
        return createMinecraftModpackBridge({ db, runtime, env, ...content.providers });
      },
    });
    let stopping = false;
    let schedulesHealthy = true;
    const workerInstanceId = randomUUID();
    const heartbeat = async (state: 'running' | 'degraded' | 'stopped') => {
      try {
        await recordWorkerHeartbeat(db, workerInstanceId, env.NH_JOB_PREFIX ?? '', state);
      } catch {
        logger.log('warn', 'worker.heartbeat_unavailable');
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reconciliation: Promise<void> | undefined;
    const poll = async () => {
      let successful = false;
      try {
        await recoverInstallations();
        await reconcileServers(db, management, logger, env);
        successful =
          schedulesHealthy &&
          runtime.worker.isRunning() &&
          (await runtime.queue.getBackend().client).status === 'ready';
      } catch {
        logger.log('warn', 'servers.reconciliation_failed');
      } finally {
        await heartbeat(successful ? 'running' : 'degraded');
        if (!stopping)
          timer = setTimeout(() => {
            reconciliation = poll();
          }, 5000);
      }
    };
    let scheduleTimer: ReturnType<typeof setTimeout> | undefined;
    let schedulePoll: Promise<void> | undefined;
    const pollAutomation = async () => {
      const result = await pollSchedules(db, env, logger);
      schedulesHealthy = result !== null && !result.failures;
      if (!stopping)
        scheduleTimer = setTimeout(() => {
          schedulePoll = pollAutomation();
        }, 1000);
    };
    schedulePoll = pollAutomation();
    const catalogs = startMinecraftMetadataLoop(db, pool, env, logger);
    reconciliation = poll();
    logger.log('info', 'worker.started');
    let closed: Promise<void> | undefined;
    const close = () => {
      closed ??= (async () => {
        stopping = true;
        if (timer) clearTimeout(timer);
        if (scheduleTimer) clearTimeout(scheduleTimer);
        await Promise.all([
          reconciliation,
          catalogs.close(),
          schedulePoll,
          observations.close(),
          dashboards.close(),
          providerFeeds.close(),
          providerAccounts.close(),
          modpacks.close(),
          worldIndexes.close(),
        ]);
        try {
          await installations?.close();
          await runtime.close();
        } finally {
          directoryIdentityCache?.close();
          await transferCache?.close();
          await heartbeat('stopped');
          await db.destroy();
        }
        logger.log('info', 'worker.stopped');
      })();
      return closed;
    };
    const stop = () => {
      void close().catch(() => {
        logger.log('error', 'worker.shutdown_failed');
        process.exitCode = 1;
      });
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    return {
      async close() {
        process.removeListener('SIGTERM', stop);
        process.removeListener('SIGINT', stop);
        await close();
      },
    };
  } catch (error) {
    directoryIdentityCache?.close();
    await transferCache?.close();
    await db.destroy();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({ level: 'error', event: 'worker.start_failed' })}\n`);
    process.exitCode = 1;
  });
}
