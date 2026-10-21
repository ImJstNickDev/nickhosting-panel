import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { assertStoragePolicyIdle, type Database } from '@nickhosting/database';
import { type Kysely, sql } from 'kysely';
import { buildModpackTransferArchive } from '../../content-providers/src/modpack-transfer.js';
import { type Environment, lockResources } from './admission.js';
import { createFilemanJobServices } from './fileman-transfers.js';
import { reconcileGatewayState } from './gateway-orchestration.js';
import { type GameLifecycleContext, verifyManagedIdentity } from './lifecycle.js';
import type { MinecraftModpackOperationRow } from './minecraft-modpacks.js';
import { modpackDigest } from './minecraft-modpacks-plan.js';
import { createModpackPublication } from './modpack-publication.js';
import { authorizeServer } from './registry.js';
import type { ManagementRuntime } from './runtime.js';
import { assertNoPendingUpload } from './upload-admission.js';

export async function withModpackServerLock<T>(
  db: Kysely<Database>,
  serverId: string,
  work: (db: Kysely<Database>) => Promise<T>,
) {
  return db.connection().execute(async (connection) => {
    const result = await sql<{
      acquired: boolean;
    }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${`:nickhosting:server:${serverId}`},0)) as acquired`.execute(
      connection,
    );
    if (!result.rows[0]?.acquired) throw new DomainError('operation_busy');
    try {
      return await work(connection);
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${`:nickhosting:server:${serverId}`},0))`.execute(
        connection,
      );
    }
  });
}

/** Durable host context gives the pack publisher the same Fileman services as other game jobs. */
export async function createModpackContext(options: {
  db: Kysely<Database>;
  runtime: ManagementRuntime;
  operation: MinecraftModpackOperationRow;
  env: Environment;
  currentAuth(): Promise<AuthContext>;
  recovery?: boolean;
}) {
  const { db, runtime, env, operation: pack } = options;
  const actor = await options.currentAuth();
  let server = await authorizeServer(db, actor, pack.server_id, 'server:manage');
  if (
    !server.pterodactyl_id ||
    !server.pterodactyl_identifier ||
    !server.pterodactyl_uuid ||
    !runtime.containerObserver
  )
    throw new DomainError('integration_unavailable');
  const observer = runtime.containerObserver;
  const uuid = server.pterodactyl_uuid;
  const identifier = server.pterodactyl_identifier;
  const applicationId = server.pterodactyl_id;
  const nodeId = server.node_id;
  if (server.active_operation_id && server.active_operation_id !== pack.id)
    throw new DomainError('operation_busy');
  await assertStoragePolicyIdle(db);
  if (!options.recovery) await assertNoPendingUpload(db, server.id);
  const remote = await runtime.adapter.getApplicationServer(server.pterodactyl_id);
  await verifyManagedIdentity(db, server, remote);
  if (!options.recovery) {
    await db.transaction().execute(async (tx) => {
      await lockResources(tx);
      const latest = await authorizeServer(tx, actor, server.id, 'server:manage');
      if (latest.active_operation_id && latest.active_operation_id !== pack.id)
        throw new DomainError('operation_busy');
      await tx
        .insertInto('operation_jobs')
        .values({
          id: pack.id,
          actor_id: actor.actorUserId,
          subject_id: actor.subjectUserId,
          resource_owner_id: server.owner_id,
          support_session_id: actor.support?.id ?? null,
          idempotency_key: `modpack:${pack.id}`,
          command_hash: modpackDigest({ modpackOperationId: pack.id }),
          command: JSON.stringify({
            type: 'server.operation',
            version: 1,
            payload: { serverId: server.id, operationId: pack.id },
          }),
          policy_snapshot: JSON.stringify({
            role: actor.role,
            sessionType: actor.sessionType,
            ownerElevation: actor.ownerElevation,
          }),
          state: 'running',
          max_attempts: 1,
          error_code: null,
          completed_at: null,
        })
        .onConflict((c) => c.column('id').doNothing())
        .execute();
      await tx
        .insertInto('server_operations')
        .values({
          job_id: pack.id,
          server_id: server.id,
          action: 'reinstall',
          plan: JSON.stringify({ modpackOperationId: pack.id, priorIntent: server.intent }),
          effect_started_at: null,
          lease_until: null,
          lease_token: null,
        })
        .onConflict((c) => c.column('job_id').doNothing())
        .execute();
      await tx
        .updateTable('managed_servers')
        .set({ active_operation_id: pack.id, updated_at: new Date() })
        .where('id', '=', server.id)
        .execute();
    });
  }
  let operation = await db
    .selectFrom('server_operations')
    .selectAll()
    .where('job_id', '=', pack.id)
    .executeTakeFirstOrThrow();
  const authorize = async () => {
    const current = await options.currentAuth();
    if (!options.recovery) {
      const currentOperation = await db
        .selectFrom('minecraft_modpack_operations')
        .select(['state', 'lease_token', 'lease_until'])
        .where('id', '=', pack.id)
        .executeTakeFirst();
      if (
        !pack.lease_token ||
        currentOperation?.state !== 'applying' ||
        currentOperation.lease_token !== pack.lease_token ||
        !currentOperation.lease_until ||
        currentOperation.lease_until <= new Date()
      )
        throw new DomainError('operation_uncertain');
    }
    const latest = await authorizeServer(db, current, server.id, 'server:manage');
    if (
      latest.owner_id !== pack.resource_owner_id ||
      latest.active_operation_id !== pack.id ||
      latest.pterodactyl_id !== applicationId ||
      latest.pterodactyl_uuid !== uuid ||
      latest.pterodactyl_identifier !== identifier ||
      latest.node_id !== nodeId
    )
      throw new DomainError('conflict');
    server = latest;
    return current;
  };
  const assertStopped = async () => {
    if (!(await observer.stopped(uuid, 'server')) || !(await observer.stopped(uuid, 'installer')))
      throw new DomainError('conflict');
  };
  const update: GameLifecycleContext['update'] = async (patch) => {
    const { plan, ...rest } = patch;
    operation = await db
      .updateTable('server_operations')
      .set({ ...rest, ...(plan ? { plan: JSON.stringify(plan) } : {}), updated_at: new Date() })
      .where('job_id', '=', pack.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  };
  const stop = async () => {
    await authorize();
    const stopped = await observer.stopped(uuid, 'server');
    await update({ plan: { ...operation.plan, wasRunning: !stopped } });
    if (!stopped) {
      const result = await runtime.adapter.stopWithConfirmation(applicationId, identifier, {
        verifiedServer: remote,
        authorize: async () => {
          try {
            await authorize();
            return true;
          } catch {
            return false;
          }
        },
        beforePower: async () => {
          await authorize();
        },
        onConfirmed: () => update({ plan: { ...operation.plan, stopped: true } }),
      });
      if (!result.confirmed) throw new DomainError('operation_uncertain');
    }
    await assertStopped();
    await db.transaction().execute(async (tx) => {
      await lockResources(tx);
      await tx.deleteFrom('resource_reservations').where('server_id', '=', server.id).execute();
      await tx
        .updateTable('managed_servers')
        .set({ runtime_state: 'offline', readiness: 'unknown', last_observed_at: new Date() })
        .where('id', '=', server.id)
        .execute();
    });
    if (
      server.connection_mode === 'gateway' &&
      (await db
        .selectFrom('gateway_server_states')
        .select('server_id')
        .where('server_id', '=', server.id)
        .executeTakeFirst())
    )
      await reconcileGatewayState(db, server.id, { env });
  };
  const backup = async (): Promise<string> => {
    await authorize();
    await assertStopped();
    if (operation.plan.backupDispatched) throw new DomainError('operation_uncertain');
    const since = new Date();
    await update({ plan: { ...operation.plan, backupDispatched: since.toISOString() } });
    const created = await runtime.adapter.createBackup(identifier, {
      name: `nickhosting-modpack-${pack.id}`,
    });
    await update({ plan: { ...operation.plan, backupId: created.uuid } });
    let nextSnapshot =
      Date.now() + ((await runtime.lifecycle.backupEventsEnabled(db, server.id)) ? 60000 : 0);
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline) {
      await authorize();
      const event = await runtime.lifecycle.readBackupCompletion(
        db,
        server.id,
        created.uuid,
        'backup.completed',
        since,
      );
      if (event) {
        if (!event.backup.isSuccessful) throw new DomainError('integration_unavailable');
        return created.uuid;
      }
      if (Date.now() >= nextSnapshot) {
        const value = await runtime.adapter.getBackup(identifier, created.uuid);
        if (value.completed_at) {
          if (!value.is_successful) throw new DomainError('integration_unavailable');
          return created.uuid;
        }
        nextSnapshot = Date.now() + 60_000;
      }
      await delay(1000);
    }
    throw new DomainError('operation_uncertain');
  };
  const context: GameLifecycleContext = {
    db,
    get server() {
      return server;
    },
    adapter: runtime.adapter,
    operation: () => operation,
    authorize: async () => {
      await authorize();
    },
    assertStopped,
    update,
    effect: async (phase, perform, patch) => {
      if (operation.effect_state === 'uncertain') throw new DomainError('operation_uncertain');
      await authorize();
      await update({ phase, effect_state: 'uncertain', effect_started_at: new Date() });
      const result = await perform();
      await update({ effect_state: 'confirmed', plan: { ...operation.plan, ...patch?.(result) } });
      return true;
    },
    event: async (messageKey, data = {}) => {
      await db
        .insertInto('server_events')
        .values({
          server_id: server.id,
          job_id: pack.id,
          actor_id: actor.actorUserId,
          subject_id: actor.subjectUserId,
          support_session_id: actor.support?.id ?? null,
          message_key: messageKey,
          data: JSON.stringify(data),
        })
        .execute();
    },
    backup: async () => {
      await backup();
      return true;
    },
  };
  const fileman = createFilemanJobServices(context, {
    env,
    authorize,
    listDirectories: (paths) => runtime.fileDirectoryBatch(identifier, server, paths),
  });
  context.fileman = fileman;
  const readScope = fileman.readScope;
  if (!readScope) throw new DomainError('integration_unavailable');
  const publication = createModpackPublication({
    operationId: pack.id,
    identifier: server.pterodactyl_identifier,
    fileman,
    adapter: runtime.adapter,
    authorize,
    async archive(prepared, files, destinationRoot) {
      const archive = await buildModpackTransferArchive({
        directory: prepared.stagingKey,
        files,
        stagingRoot: destinationRoot,
        destination: join(prepared.stagingKey, '..', 'publication.zip'),
      });
      if (!archive) throw new DomainError('conflict');
      let stream: Readable | undefined;
      return {
        sourceSha256: archive.archiveSha256,
        contentLength: archive.archiveBytes,
        files: archive.files,
        open: () => {
          stream = createReadStream(archive.archivePath);
          return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
        },
        completion: Promise.resolve({ bytes: archive.expandedBytes, files: archive.files }),
        cancel: () => {
          stream?.destroy();
        },
      };
    },
    readJournal: async () =>
      (
        await db
          .selectFrom('minecraft_modpack_operations')
          .select('publication')
          .where('id', '=', pack.id)
          .executeTakeFirstOrThrow()
      ).publication,
    saveJournal: async (value) => {
      await db
        .updateTable('minecraft_modpack_operations')
        .set({ publication: JSON.stringify(value) })
        .where('id', '=', pack.id)
        .execute();
    },
  });
  return { context, publication, stop, backup, assertStopped, authorize, readScope };
}

/** Release only after publication has been proved, retaining all private recovery journals. */
export async function completeModpackJob(db: Kysely<Database>, row: MinecraftModpackOperationRow) {
  await db.transaction().execute(async (tx) => {
    await lockResources(tx);
    await tx
      .updateTable('operation_jobs')
      .set({ state: 'succeeded', completed_at: new Date(), error_code: null })
      .where('id', '=', row.id)
      .execute();
    await tx
      .updateTable('server_operations')
      .set({ phase: 'complete', effect_state: 'confirmed' })
      .where('job_id', '=', row.id)
      .execute();
    await tx
      .updateTable('managed_servers')
      .set({ active_operation_id: null, updated_at: new Date() })
      .where('id', '=', row.server_id)
      .where('active_operation_id', '=', row.id)
      .execute();
  });
}
