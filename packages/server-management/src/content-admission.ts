import { createHash } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { contentStageDirectory } from '@nickhosting/content-providers';
import {
  type AuthContext,
  contentPolicyValues,
  DomainError,
  type PlatformConfig,
  resolveContentStoragePath,
} from '@nickhosting/core';
import {
  assertStoragePolicyIdle,
  type Database,
  getSettings,
  recordAudit,
} from '@nickhosting/database';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { type Environment, lockResources } from './admission.js';
import { minecraftModpackSchemaAvailable } from './minecraft-modpack-schema.js';
import { authorizeServer, parse } from './registry.js';
import { unresolvedTransferBytes } from './transfer-capacity.js';
import { uploadStagingAvailableBytes } from './upload-admission.js';

export interface ContentClaimUsage {
  gameId: string;
  ownerId: string;
  bytes: bigint;
  active: number;
}
export interface ContentDiskSnapshot {
  available: bigint;
  total: bigint;
}
export interface ContentAdmissionOptions {
  /** Isolated tests only; normal admission observes the real configured filesystem. */
  observeDisk?: (root: string) => Promise<ContentDiskSnapshot>;
}
export function contentStorageRoot(setting: string, env: Environment = {}) {
  return resolveContentStoragePath(setting, env);
}
async function observeContentDisk(root: string): Promise<ContentDiskSnapshot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      statfs(root, { bigint: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DomainError('integration_unavailable')), 5000);
      }),
    ]);
    return {
      available: uploadStagingAvailableBytes(snapshot),
      total: snapshot.blocks * snapshot.bsize,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The historical table names remain for durable recovery compatibility. Every
 * integration uses one ledger and one global accounting path, never a game-local
 * copy. Aggregate in PostgreSQL instead of loading every archive into memory. */
export async function readContentClaimUsage(db: Kysely<Database>): Promise<ContentClaimUsage[]> {
  const modpacks = (await minecraftModpackSchemaAvailable(db))
    ? sql`union all select 'minecraft', resource_owner_id, held_bytes, case when state in ('preparing', 'applying', 'uncertain') then 1 else 0 end from minecraft_modpack_operations where held_bytes > 0`
    : sql``;
  const result = await sql<{ game_id: string; owner_id: string; bytes: string; active: string }>`
    select game_id, owner_id, sum(bytes)::text as bytes, sum(active)::text as active from (
      select game_id, owner_user_id as owner_id, reserved_bytes as bytes,
        case when state = 'ready' then 0 else 1 end as active
      from minecraft_sources where state <> 'released'
      union all
      select c.game_id, c.owner_user_id, c.reserved_bytes,
        case when j.state in ('queued', 'running', 'uncertain') then 1 else 0 end
      from minecraft_staging_claims c join operation_jobs j on j.id = c.job_id
      where c.state = 'reserved'
      ${modpacks}
    ) claims group by game_id, owner_id
  `.execute(db);
  return result.rows.map((row) => ({
    gameId: row.game_id,
    ownerId: row.owner_id,
    bytes: BigInt(row.bytes),
    active: Number(row.active),
  }));
}

/** Pure admission computation is shared by source ingestion and expanded jobs.
 * Physical/global ceilings apply across all games, local overrides to one game.
 * Ready archives still occupy bytes; uncertain work keeps its concurrency slot. */
export function assertContentCapacity(
  config: PlatformConfig,
  claims: readonly ContentClaimUsage[],
  input: { gameId: string; ownerId: string; bytes: bigint; active?: number },
) {
  if (input.bytes < 0n || !Number.isSafeInteger(input.active ?? 1) || (input.active ?? 1) < 0)
    throw new DomainError('validation_failed');
  const local = contentPolicyValues(config, input.gameId);
  const scopes = [
    {
      rows: claims,
      bytes: config.contentSourceGlobalBytes,
      active: config.contentSourceConcurrent,
    },
    {
      rows: claims.filter((r) => r.ownerId === input.ownerId),
      bytes: config.contentSourceUserBytes,
      active: config.contentSourceUserConcurrent,
    },
    {
      rows: claims.filter((r) => r.gameId === input.gameId),
      bytes: local.sourceGlobalBytes,
      active: local.sourceConcurrent,
    },
    {
      rows: claims.filter((r) => r.gameId === input.gameId && r.ownerId === input.ownerId),
      bytes: local.sourceUserBytes,
      active: local.sourceUserConcurrent,
    },
  ];
  for (const scope of scopes) {
    if (
      scope.rows.reduce((sum, row) => sum + row.bytes, 0n) + input.bytes > BigInt(scope.bytes) ||
      scope.rows.reduce((sum, row) => sum + row.active, 0) + (input.active ?? 1) > scope.active
    )
      throw new DomainError('resources_unavailable');
  }
}

/** Caller holds the existing shared resource lock and commits its claim in the
 * same transaction. No filesystem or provider effects are performed here. */
export async function assertContentAdmission(
  db: Kysely<Database>,
  config: PlatformConfig,
  input: { gameId: string; ownerId: string; bytes: bigint; root: string; active?: number },
  options: ContentAdmissionOptions = {},
) {
  assertContentCapacity(config, await readContentClaimUsage(db), input);
  const disk = await (options.observeDisk ?? observeContentDisk)(input.root);
  const policy = contentPolicyValues(config, input.gameId);
  const percent = (disk.total * BigInt(Math.ceil(policy.sourceFreePercent * 100))) / 10000n;
  const margin =
    percent > BigInt(policy.sourceFreeBytes) ? percent : BigInt(policy.sourceFreeBytes);
  // Keep the shared M2 upload accounting: distinct configured paths are not proof
  // of distinct disks. Outstanding reservations remain charged conservatively.
  if (disk.available < (await unresolvedTransferBytes(db)) + input.bytes + margin)
    throw new DomainError('content_storage_unavailable');
}

/** Shared durable-worker reservation. Game identity is read from the immutable
 * server mapping, never supplied by the browser. Existing job/authorization and
 * storage-transition fences remain authoritative. */
export async function reserveContentStaging(
  db: Kysely<Database>,
  context: AuthContext,
  jobId: string,
  serverId: string,
  expandedBytes: number,
  env: Environment = {},
  options: ContentAdmissionOptions = {},
) {
  parse(z.uuid(), jobId);
  parse(z.uuid(), serverId);
  if (
    !Number.isSafeInteger(expandedBytes) ||
    expandedBytes < 0 ||
    expandedBytes > Number.MAX_SAFE_INTEGER - 65536
  )
    throw new DomainError('validation_failed');
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    await assertStoragePolicyIdle(tx);
    const job = await tx
      .selectFrom('operation_jobs as job')
      .innerJoin('server_operations as operation', 'operation.job_id', 'job.id')
      .innerJoin('managed_servers as server', 'server.id', 'operation.server_id')
      .innerJoin('runtime_egg_mappings as mapping', 'mapping.id', 'server.mapping_id')
      .select([
        'job.actor_id',
        'job.subject_id',
        'job.resource_owner_id',
        'job.state',
        'server.id',
        'server.active_operation_id',
        'operation.action',
        'mapping.game_id',
      ])
      .where('job.id', '=', jobId)
      .where('server.id', '=', serverId)
      .where('server.deleted_at', 'is', null)
      .executeTakeFirst();
    if (
      !job ||
      job.actor_id !== context.actorUserId ||
      job.subject_id !== context.subjectUserId ||
      job.state !== 'running' ||
      job.active_operation_id !== jobId ||
      !['provision', 'minecraft-content', 'reinstall', 'wipe'].includes(job.action)
    )
      throw new DomainError('forbidden');
    await authorizeServer(tx, context, serverId, 'server:manage');
    const { values } = await getSettings(tx, env);
    const root = contentStorageRoot(values.contentWorkRoot, env);
    const bytes = BigInt(expandedBytes) + 65536n;
    // Keep the established digest shape so an in-flight pre-migration job resumes.
    const identity = createHash('sha256')
      .update(JSON.stringify({ jobId, serverId, bytes: String(bytes), root }))
      .digest('hex');
    const existing = await tx
      .selectFrom('minecraft_staging_claims')
      .selectAll()
      .where('job_id', '=', jobId)
      .executeTakeFirst();
    if (existing) {
      if (existing.identity_digest !== identity || existing.state !== 'reserved')
        throw new DomainError('conflict');
      return { jobId, identityDigest: identity, reservedBytes: Number(bytes) };
    }
    await contentStageDirectory(root);
    await assertContentAdmission(
      tx,
      values,
      { gameId: job.game_id, ownerId: job.resource_owner_id, bytes, root },
      options,
    );
    await tx
      .insertInto('minecraft_staging_claims')
      .values({
        job_id: jobId,
        server_id: serverId,
        game_id: job.game_id,
        owner_user_id: job.resource_owner_id,
        actor_user_id: context.actorUserId,
        reserved_bytes: String(bytes),
        storage_root: root,
        identity_digest: identity,
      })
      .execute();
    await recordAudit(tx, context, 'content.staging.reserved', {
      gameId: job.game_id,
      jobId,
      serverId,
      reservedBytes: Number(bytes),
      identityDigest: identity,
    });
    return { jobId, identityDigest: identity, reservedBytes: Number(bytes) };
  });
}
