import { createHash, randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { type Database, recordAudit } from '@nickhosting/database';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { type Environment, lockResources } from './admission.js';
import { resolveHostOverride } from './configuration.js';
import { currentInteractiveContext } from './interactive-context.js';
import { ownerOnly, parse } from './registry.js';
import { effectiveUploadPolicy, uploadMultipartAllowanceBytes } from './upload-policy.js';

export async function assertNoPendingUpload(db: Kysely<Database>, serverId: string) {
  const claim = await db
    .selectFrom('upload_ingestion_claims')
    .select('id')
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  if (claim) throw new DomainError('operation_uncertain');
}
export interface UploadAdmissionOptions {
  /** Isolated tests only; production reads the Owner-selected local filesystem. */
  availableBytes?: (path: string) => Promise<bigint>;
}
export function uploadStagingAvailableBytes(snapshot: {
  bavail: bigint;
  bsize: bigint;
  type: bigint;
}): bigint {
  const type = BigInt.asUintN(32, snapshot.type);
  // Multipart staging must be disk-backed; RAM-backed mounts need a separate
  // physical-memory policy and are deliberately unsupported here.
  if (snapshot.bavail < 0n || snapshot.bsize <= 0n || type === 0x01021994n || type === 0x858458f6n)
    throw new DomainError('configuration_invalid');
  return snapshot.bavail * snapshot.bsize;
}
async function availableBytes(path: string): Promise<bigint> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      statfs(path, { bigint: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('observation timeout')), 5000);
      }),
    ]);
    return uploadStagingAvailableBytes(result);
  } catch {
    throw new DomainError('integration_unavailable');
  } finally {
    clearTimeout(timer);
  }
}
function lockKey(id: string) {
  return `:nickhosting:upload:${id}`;
}

/** The caller must retain its existing server lock and pinned connection. */
export async function reserveUploadIngestion(
  connection: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  declaredBytes: number,
  env: Environment = {},
  options: UploadAdmissionOptions = {},
) {
  if (
    !Number.isSafeInteger(declaredBytes) ||
    declaredBytes < 0 ||
    declaredBytes > Math.floor((Number.MAX_SAFE_INTEGER - uploadMultipartAllowanceBytes) / 2)
  )
    throw new DomainError('validation_failed', 413);
  const claimId = randomUUID();
  let locked = false;
  try {
    await connection.transaction().execute(async (tx) => {
      await lockResources(tx);
      const server = await tx
        .selectFrom('managed_servers')
        .selectAll()
        .where('id', '=', serverId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!server?.pterodactyl_id || !server.pterodactyl_uuid || server.active_operation_id)
        throw new DomainError('conflict');
      const node = await tx
        .selectFrom('managed_nodes')
        .selectAll()
        .where('id', '=', server.node_id)
        .executeTakeFirstOrThrow();
      const stored = await tx
        .selectFrom('physical_hosts')
        .selectAll()
        .where('id', '=', node.physical_host_id)
        .executeTakeFirstOrThrow();
      const host = resolveHostOverride(stored, env);
      const policy = effectiveUploadPolicy(host, env);
      if (
        !node.enabled ||
        !host.enabled ||
        !policy ||
        !env.NH_OBSERVER_ID ||
        env.NH_OBSERVER_ID !== host.observer_id
      )
        throw new DomainError('configuration_invalid');
      if (declaredBytes > policy.providerMaxFileBytes)
        throw new DomainError('validation_failed', 413);
      const existing = await tx
        .selectFrom('upload_ingestion_claims')
        .select('id')
        .where('physical_host_id', '=', host.id)
        .executeTakeFirst();
      if (existing) throw new DomainError('conflict');
      const reservedBytes = 2 * declaredBytes + uploadMultipartAllowanceBytes;
      if (reservedBytes > policy.temporaryDiskBudgetBytes)
        throw new DomainError('validation_failed', 413);
      const observe = options.availableBytes ?? availableBytes;
      const [free, destinationFree] = await Promise.all([
        observe(policy.temporaryDiskPath),
        observe(host.local_disk_path),
      ]);
      const stagingHeadroom = BigInt(policy.temporaryDiskHeadroomBytes);
      const configuredDestinationHeadroom = BigInt(host.disk_headroom_mib) * 1024n ** 2n;
      const destinationHeadroom =
        stagingHeadroom > configuredDestinationHeadroom
          ? stagingHeadroom
          : configuredDestinationHeadroom;
      if (
        free < BigInt(reservedBytes) + stagingHeadroom ||
        destinationFree < BigInt(reservedBytes) + destinationHeadroom
      )
        throw new DomainError('resources_unavailable');
      const scope = {
        observerId: host.observer_id,
        nodeId: node.id,
        pterodactylNodeId: node.pterodactyl_node_id,
        pterodactylServerId: server.pterodactyl_id,
        pterodactylServerUuid: server.pterodactyl_uuid,
        externalId: server.external_id,
        policy,
      };
      const scopeHash = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
      const result = await sql<{
        acquired: boolean;
      }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${lockKey(claimId)},0)) as acquired`.execute(
        tx,
      );
      if (!result.rows[0]?.acquired) throw new DomainError('conflict');
      locked = true;
      await tx
        .insertInto('upload_ingestion_claims')
        .values({
          id: claimId,
          physical_host_id: host.id,
          server_id: server.id,
          actor_user_id: context.actorUserId,
          declared_bytes: String(declaredBytes),
          reserved_bytes: String(reservedBytes),
          scope: JSON.stringify(scope),
          scope_hash: scopeHash,
        })
        .execute();
      await recordAudit(tx, context, 'server.upload.reserved', {
        claimId,
        serverId,
        hostId: host.id,
        declaredBytes,
        reservedBytes,
        scopeHash,
      });
    });
  } catch (error) {
    if (locked)
      await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${lockKey(claimId)},0))`.execute(
        connection,
      );
    throw error;
  }
  let released = false;
  return {
    id: claimId,
    async complete() {
      if (released) throw new DomainError('conflict');
      await connection.transaction().execute(async (tx) => {
        await lockResources(tx);
        const claim = await tx
          .deleteFrom('upload_ingestion_claims')
          .where('id', '=', claimId)
          .where('server_id', '=', serverId)
          .returning('id')
          .executeTakeFirst();
        if (!claim) throw new DomainError('conflict');
        await recordAudit(tx, context, 'server.upload.confirmed', { claimId, serverId });
      });
    },
    /** Failure, cancellation or process loss must leave the durable claim intact. */
    async unlock() {
      if (released) return;
      released = true;
      await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${lockKey(claimId)},0))`.execute(
        connection,
      );
    },
  };
}

/** Owner attests external completion and staging cleanup; this never performs
 * filesystem/provider deletion, infers completion from time, or changes scope. */
export async function recoverUploadIngestion(
  db: Kysely<Database>,
  context: AuthContext,
  claimId: string,
  input: unknown,
  env: Environment = {},
) {
  ownerOnly(context);
  parse(z.uuid(), claimId);
  const value = parse(
    z.strictObject({
      confirm: z.literal(true),
      remoteTransferFinished: z.literal(true),
      temporaryFilesRemoved: z.literal(true),
      scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
      reason: z.string().trim().min(10).max(1000),
      evidence: z.string().trim().min(20).max(4000),
    }),
    input,
  );
  return db.connection().execute(async (connection) => {
    const result = await sql<{
      acquired: boolean;
    }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${lockKey(claimId)},0)) as acquired`.execute(
      connection,
    );
    if (!result.rows[0]?.acquired) throw new DomainError('conflict');
    try {
      await connection.transaction().execute(async (tx) => {
        await lockResources(tx);
        const current = await currentInteractiveContext(tx, context, env);
        ownerOnly(current);
        const claim = await tx
          .selectFrom('upload_ingestion_claims')
          .selectAll()
          .where('id', '=', claimId)
          .executeTakeFirst();
        if (!claim) throw new DomainError('not_found');
        if (claim.scope_hash !== value.scopeHash) throw new DomainError('conflict');
        await recordAudit(tx, current, 'server.upload.recovered', {
          claimId,
          serverId: claim.server_id,
          hostId: claim.physical_host_id,
          scopeHash: claim.scope_hash,
          reason: value.reason,
          evidence: value.evidence,
          remoteTransferFinished: true,
          temporaryFilesRemoved: true,
        });
        await tx.deleteFrom('upload_ingestion_claims').where('id', '=', claimId).execute();
      });
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${lockKey(claimId)},0))`.execute(
        connection,
      );
    }
  });
}
