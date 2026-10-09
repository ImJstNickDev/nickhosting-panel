import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, statfs } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  type ContentArtifact,
  type ContentHttp,
  contentStageDirectory,
  hashesSchema,
  ModrinthProvider,
  SafeContentHttp,
} from '@nickhosting/content-providers';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { type Database, getSettings, recordAudit } from '@nickhosting/database';
import { type Kysely, type Selectable, sql } from 'kysely';
import { z } from 'zod';
import { type Environment, lockResources } from './admission.js';
import { currentInteractiveContext } from './interactive-context.js';
import { authorizeServer, ownerOnly, parse } from './registry.js';
import { unresolvedTransferBytes } from './transfer-capacity.js';
import { uploadStagingAvailableBytes } from './upload-admission.js';

type Source = Selectable<Database['minecraft_sources']>;
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const minecraftSourceUploadSchema = z.strictObject({
  kind: z.enum(['world', 'modpack']),
  serverId: z.uuid().optional(),
  idempotencyKey: identifier,
  bytes: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER - 65536),
  sha256: digest,
});
export const minecraftSourceModrinthSchema = z.strictObject({
  projectId: identifier,
  versionId: identifier,
  serverId: z.uuid().optional(),
  idempotencyKey: identifier,
});
export interface MinecraftSourceOptions {
  /** Internal worker composition only. Must revalidate the exact durable job. */
  authorize?: (db: Kysely<Database>, previous: AuthContext) => Promise<AuthContext>;
  /** Isolated tests can substitute provider HTTP, never a browser input. */
  http?: ContentHttp;
  /** Only test snapshots; production observes the real configured filesystem. */
  observeDisk?: (directory: string) => Promise<{ available: bigint; total: bigint }>;
}

function publicSource(row: Source) {
  return {
    id: row.id,
    serverId: row.server_id,
    kind: row.kind,
    origin: row.origin,
    state: row.state,
    bytes: Number(row.declared_bytes),
    sha256: row.actual_sha256,
    identityDigest: row.identity_digest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
/** A single fixed, generated filename: no archive name, URL or path is accepted. */
function sourcePath(source: Source): string {
  parse(z.uuid(), source.id);
  return join(source.storage_root, source.id, 'archive.bin');
}
function sourceRoot(setting: string): string {
  const root = resolve(setting);
  const mountdata = `${resolve('./mountdata')}${sep}`;
  if (!root.startsWith(mountdata) || root === mountdata || /[\0\r\n]/.test(root))
    throw new DomainError('configuration_invalid');
  return root;
}
async function observeDisk(directory: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      statfs(directory, { bigint: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DomainError('integration_unavailable')), 5000);
      }),
    ]);
    return { available: uploadStagingAvailableBytes(result), total: result.blocks * result.bsize };
  } finally {
    clearTimeout(timer);
  }
}
async function current(
  db: Kysely<Database>,
  context: AuthContext,
  env: Environment,
  options: MinecraftSourceOptions,
) {
  return options.authorize
    ? options.authorize(db, context)
    : currentInteractiveContext(db, context, env);
}
async function authorizeScope(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string | undefined,
) {
  if (!serverId) {
    if (context.sessionType !== 'regular') throw new DomainError('forbidden');
    return context.subjectUserId;
  }
  return (await authorizeServer(db, context, serverId, 'server:manage')).owner_id;
}
async function ownedSource(
  db: Kysely<Database>,
  context: AuthContext,
  reference: string,
  serverId?: string,
) {
  parse(z.uuid(), reference);
  const row = await db
    .selectFrom('minecraft_sources')
    .selectAll()
    .where('id', '=', reference)
    .executeTakeFirst();
  if (!row) throw new DomainError('not_found');
  // Project managers may prepare sources for that server, but never reuse them
  // outside its exact scope; unbound wizard sources are private to the subject.
  if (row.server_id) {
    if (serverId !== undefined && row.server_id !== serverId) throw new DomainError('forbidden');
    if ((await authorizeScope(db, context, row.server_id)) !== row.owner_user_id)
      throw new DomainError('forbidden');
  } else {
    if (serverId !== undefined) {
      const binding = await db
        .selectFrom('minecraft_source_bindings')
        .select('source_id')
        .where('source_id', '=', row.id)
        .where('server_id', '=', serverId)
        .executeTakeFirst();
      if (!binding || (await authorizeScope(db, context, serverId)) !== row.owner_user_id)
        throw new DomainError('forbidden');
    } else if (row.owner_user_id !== context.subjectUserId || context.sessionType !== 'regular')
      throw new DomainError('forbidden');
  }
  return row;
}
async function rowLock<T>(
  db: Kysely<Database>,
  reference: string,
  run: (db: Kysely<Database>) => Promise<T>,
) {
  parse(z.uuid(), reference);
  return db.connection().execute(async (connection) => {
    const key = `:minecraft-source:${reference}`;
    const result = await sql<{
      acquired: boolean;
    }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${key},0)) as acquired`.execute(
      connection,
    );
    if (!result.rows[0]?.acquired) throw new DomainError('conflict');
    try {
      return await run(connection);
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${key},0))`.execute(
        connection,
      );
    }
  });
}
async function hashSource(row: Source, authorize: () => Promise<unknown>) {
  await contentStageDirectory(row.storage_root);
  const directory = join(row.storage_root, row.id);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new DomainError('conflict');
  const file = await open(sourcePath(row), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== Number(row.declared_bytes))
      throw new DomainError('conflict');
    const hashes = hashesSchema.parse(row.expected_hashes);
    const checks = Object.fromEntries(
      Object.keys({ ...hashes, sha256: '' }).map((name) => [name, createHash(name)]),
    );
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
      await authorize();
      bytes += chunk.length;
      if (bytes > Number(row.declared_bytes)) throw new DomainError('conflict');
      for (const hash of Object.values(checks)) hash.update(chunk);
    }
    const actual = Object.fromEntries(
      Object.entries(checks).map(([key, hash]) => [key, hash.digest('hex')]),
    );
    const after = await file.stat();
    if (
      bytes !== Number(row.declared_bytes) ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      Object.entries(hashes).some(([key, value]) => actual[key] !== value) ||
      (row.actual_sha256 !== null && actual.sha256 !== row.actual_sha256)
    )
      throw new DomainError('conflict');
    return actual.sha256 as string;
  } finally {
    await file.close();
  }
}

/** Caller may pass its already locked creation transaction, so binding commits
 * atomically with the new managed server and its immutable job inputs. */
export async function bindMinecraftSource(
  db: Kysely<Database>,
  context: AuthContext,
  reference: string,
  serverId: string,
  env: Environment = {},
  options: MinecraftSourceOptions = {},
) {
  const actor = await current(db, context, env, options);
  const row = await ownedSource(db, actor, reference);
  const server = await authorizeServer(db, actor, serverId, 'server:manage');
  if (
    row.state !== 'ready' ||
    row.owner_user_id !== server.owner_id ||
    (row.server_id && row.server_id !== serverId)
  )
    throw new DomainError('conflict');
  await db
    .insertInto('minecraft_source_bindings')
    .values({ source_id: reference, server_id: serverId })
    .onConflict((c) => c.columns(['source_id', 'server_id']).doNothing())
    .execute();
  await recordAudit(db, actor, 'minecraft.source.bound', { sourceId: reference, serverId });
}

/** Durable workers call this after their normal authorization and before any
 * expanded output/download. No second lifecycle or job system is introduced. */
export async function reserveMinecraftStaging(
  db: Kysely<Database>,
  context: AuthContext,
  jobId: string,
  serverId: string,
  expandedBytes: number,
  env: Environment = {},
  options: Pick<MinecraftSourceOptions, 'observeDisk'> = {},
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
    const job = await tx
      .selectFrom('operation_jobs as job')
      .innerJoin('server_operations as operation', 'operation.job_id', 'job.id')
      .innerJoin('managed_servers as server', 'server.id', 'operation.server_id')
      .select([
        'job.actor_id',
        'job.subject_id',
        'job.resource_owner_id',
        'job.state',
        'server.id',
        'server.active_operation_id',
        'operation.action',
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
    const root = sourceRoot(values.minecraftContentRoot);
    const bytes = BigInt(expandedBytes) + 65536n;
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
    const sources = await tx
      .selectFrom('minecraft_sources')
      .select(['owner_user_id', 'reserved_bytes'])
      .where('state', '!=', 'released')
      .execute();
    const stages = await tx
      .selectFrom('minecraft_staging_claims')
      .select(['owner_user_id', 'reserved_bytes'])
      .where('state', '=', 'reserved')
      .execute();
    const total = [...sources, ...stages].reduce(
      (sum, row) => sum + BigInt(row.reserved_bytes),
      0n,
    );
    const user = [...sources, ...stages]
      .filter((row) => row.owner_user_id === job.resource_owner_id)
      .reduce((sum, row) => sum + BigInt(row.reserved_bytes), 0n);
    if (
      total + bytes > BigInt(values.minecraftSourceGlobalBytes) ||
      user + bytes > BigInt(values.minecraftSourceUserBytes)
    )
      throw new DomainError('resources_unavailable');
    const disk = await (options.observeDisk ?? observeDisk)(root);
    const percent =
      (disk.total * BigInt(Math.ceil(values.minecraftSourceFreePercent * 100))) / 10000n;
    const margin =
      percent > BigInt(values.minecraftSourceFreeBytes)
        ? percent
        : BigInt(values.minecraftSourceFreeBytes);
    if (disk.available < (await unresolvedTransferBytes(tx)) + bytes + margin)
      throw new DomainError('resources_unavailable');
    await tx
      .insertInto('minecraft_staging_claims')
      .values({
        job_id: jobId,
        server_id: serverId,
        owner_user_id: job.resource_owner_id,
        actor_user_id: context.actorUserId,
        reserved_bytes: String(bytes),
        storage_root: root,
        identity_digest: identity,
      })
      .execute();
    await recordAudit(tx, context, 'minecraft.staging.reserved', {
      jobId,
      serverId,
      reservedBytes: Number(bytes),
      identityDigest: identity,
    });
    return { jobId, identityDigest: identity, reservedBytes: Number(bytes) };
  });
}

export function createMinecraftSourceStore(
  db: Kysely<Database>,
  context: AuthContext,
  env: Environment = {},
  options: MinecraftSourceOptions = {},
) {
  const reauthorize = (connection = db) => current(connection, context, env, options);
  async function reserve(input: {
    kind: Source['kind'];
    origin: Source['origin'];
    serverId?: string;
    idempotencyKey: string;
    bytes: number;
    hashes: unknown;
    projectId?: string;
    versionId?: string;
  }) {
    const identity = createHash('sha256')
      .update(
        JSON.stringify({
          kind: input.kind,
          origin: input.origin,
          serverId: input.serverId ?? null,
          bytes: input.bytes,
          hashes: hashesSchema.parse(input.hashes),
          projectId: input.projectId ?? null,
          versionId: input.versionId ?? null,
        }),
      )
      .digest('hex');
    return db.transaction().execute(async (tx) => {
      await lockResources(tx);
      const actor = await reauthorize(tx);
      const ownerId = await authorizeScope(tx, actor, input.serverId);
      const existing = await tx
        .selectFrom('minecraft_sources')
        .selectAll()
        .where('owner_user_id', '=', ownerId)
        .where((eb) =>
          eb.or([
            eb('idempotency_key', '=', input.idempotencyKey),
            eb.and([eb('identity_digest', '=', identity), eb('state', '!=', 'released')]),
          ]),
        )
        .execute();
      if (existing.length) {
        if (
          existing.length !== 1 ||
          existing[0]?.identity_digest !== identity ||
          existing[0].state === 'released'
        )
          throw new DomainError('conflict');
        await ownedSource(tx, actor, existing[0].id, input.serverId);
        return existing[0];
      }
      const { values } = await getSettings(tx, env);
      const root = sourceRoot(values.minecraftSourceRoot);
      await contentStageDirectory(root);
      const claims = await tx
        .selectFrom('minecraft_sources')
        .select(['owner_user_id', 'reserved_bytes', 'state'])
        .where('state', '!=', 'released')
        .execute();
      const expansions = await tx
        .selectFrom('minecraft_staging_claims')
        .select(['owner_user_id', 'reserved_bytes'])
        .where('state', '=', 'reserved')
        .execute();
      const total = [...claims, ...expansions].reduce(
        (sum, row) => sum + BigInt(row.reserved_bytes),
        0n,
      );
      const owned = claims.filter((row) => row.owner_user_id === ownerId);
      const userBytes = [
        ...owned,
        ...expansions.filter((row) => row.owner_user_id === ownerId),
      ].reduce((sum, row) => sum + BigInt(row.reserved_bytes), 0n);
      const pending = (rows: typeof claims) => rows.filter((row) => row.state !== 'ready').length;
      const bytes = BigInt(input.bytes) + 65536n;
      if (
        total + bytes > BigInt(values.minecraftSourceGlobalBytes) ||
        userBytes + bytes > BigInt(values.minecraftSourceUserBytes) ||
        pending(claims) >= values.minecraftSourceConcurrent ||
        pending(owned) >= values.minecraftSourceUserConcurrent
      )
        throw new DomainError('resources_unavailable');
      // Fresh under the shared resource lock. All claims remain charged even if
      // statfs already reflects their bytes; conservative double accounting is intentional.
      const disk = await (options.observeDisk ?? observeDisk)(root);
      const percent =
        (disk.total * BigInt(Math.ceil(values.minecraftSourceFreePercent * 100))) / 10000n;
      const margin =
        percent > BigInt(values.minecraftSourceFreeBytes)
          ? percent
          : BigInt(values.minecraftSourceFreeBytes);
      if (disk.available < (await unresolvedTransferBytes(tx)) + bytes + margin)
        throw new DomainError('resources_unavailable');
      const row = await tx
        .insertInto('minecraft_sources')
        .values({
          id: randomUUID(),
          actor_user_id: actor.actorUserId,
          owner_user_id: ownerId,
          server_id: input.serverId ?? null,
          idempotency_key: input.idempotencyKey,
          identity_digest: identity,
          kind: input.kind,
          origin: input.origin,
          declared_bytes: String(input.bytes),
          reserved_bytes: String(bytes),
          expected_hashes: JSON.stringify(input.hashes),
          actual_sha256: null,
          storage_root: root,
          provider_project_id: input.projectId ?? null,
          provider_version_id: input.versionId ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await recordAudit(tx, actor, 'minecraft.source.reserved', {
        sourceId: row.id,
        serverId: row.server_id,
        kind: row.kind,
        origin: row.origin,
        bytes: input.bytes,
        identityDigest: identity,
      });
      return row;
    });
  }
  async function executeTransfer(
    reference: string,
    transfer: (row: Source, signal: AbortSignal, authorize: () => Promise<void>) => Promise<void>,
    signal?: AbortSignal,
  ) {
    return rowLock(db, reference, async (connection) => {
      let row = await ownedSource(connection, await reauthorize(connection), reference);
      if (row.state === 'ready') return publicSource(row);
      if (row.state !== 'reserved') throw new DomainError('operation_uncertain');
      const actor = await reauthorize(connection);
      const claimed = await connection
        .updateTable('minecraft_sources')
        .set({ state: 'receiving', updated_at: new Date() })
        .where('id', '=', row.id)
        .where('state', '=', 'reserved')
        .returningAll()
        .executeTakeFirst();
      if (!claimed) throw new DomainError('conflict');
      row = claimed;
      const controller = new AbortController();
      const abort = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const authorize = async () => {
        abort.throwIfAborted();
        await ownedSource(connection, await reauthorize(connection), reference);
      };
      // Revocation must interrupt stalled provider/raw uploads too, rather than
      // waiting indefinitely for another body chunk. At most one query is in flight.
      let checking: Promise<void> | undefined;
      const timer = setInterval(() => {
        if (!checking)
          checking = authorize()
            .catch(() => controller.abort(new DomainError('forbidden')))
            .finally(() => {
              checking = undefined;
            });
      }, 500);
      timer.unref();
      try {
        await contentStageDirectory(join(row.storage_root, row.id));
        await transfer(row, abort, authorize);
        await authorize();
        const sha256 = await hashSource(row, authorize);
        await connection.transaction().execute(async (tx) => {
          await lockResources(tx);
          const currentActor = await reauthorize(tx);
          await ownedSource(tx, currentActor, reference);
          await tx
            .updateTable('minecraft_sources')
            .set({ state: 'ready', actual_sha256: sha256, updated_at: new Date() })
            .where('id', '=', row.id)
            .execute();
          await recordAudit(tx, currentActor, 'minecraft.source.ready', {
            sourceId: row.id,
            sha256,
            bytes: Number(row.declared_bytes),
          });
        });
        return publicSource({
          ...row,
          state: 'ready',
          actual_sha256: sha256,
          updated_at: new Date(),
        });
      } catch (error) {
        // Even when the provider removed its partial file, keep the claim. A
        // crashed process cannot assert filesystem cleanup on a future retry.
        await connection
          .updateTable('minecraft_sources')
          .set({ state: 'uncertain', updated_at: new Date() })
          .where('id', '=', row.id)
          .where('state', '=', 'receiving')
          .execute();
        await recordAudit(connection, actor, 'minecraft.source.uncertain', { sourceId: row.id });
        throw error;
      } finally {
        clearInterval(timer);
        controller.abort();
        await checking;
      }
    });
  }
  async function resolveSource(reference: string, kind: Source['kind'], serverId?: string) {
    return rowLock(db, reference, async (connection) => {
      const row = await ownedSource(connection, await reauthorize(connection), reference, serverId);
      if (row.state !== 'ready' || row.kind !== kind || (!serverId && row.server_id))
        throw new DomainError('conflict');
      const sha256 = await hashSource(row, async () =>
        ownedSource(connection, await reauthorize(connection), reference, serverId),
      );
      return { path: sourcePath(row), sha256 };
    });
  }
  return {
    async ownerInventory() {
      ownerOnly(await reauthorize());
      const sources = await db
        .selectFrom('minecraft_sources')
        .selectAll()
        .where('state', '!=', 'released')
        .orderBy('created_at', 'asc')
        .limit(500)
        .execute();
      const stages = await db
        .selectFrom('minecraft_staging_claims')
        .select([
          'job_id as jobId',
          'server_id as serverId',
          'reserved_bytes as reservedBytes',
          'identity_digest as identityDigest',
          'state',
        ])
        .where('state', '=', 'reserved')
        .orderBy('created_at', 'asc')
        .limit(500)
        .execute();
      return { sources: sources.map(publicSource), stages };
    },
    async reserveUpload(input: unknown) {
      const value = parse(minecraftSourceUploadSchema, input);
      return publicSource(
        await reserve({ ...value, origin: 'upload', hashes: { sha256: value.sha256 } }),
      );
    },
    async inspect(reference: string) {
      return publicSource(await ownedSource(db, await reauthorize(), reference));
    },
    async upload(
      reference: string,
      body: ReadableStream<Uint8Array>,
      bytes: number,
      signal?: AbortSignal,
    ) {
      if (!Number.isSafeInteger(bytes) || bytes < 1) throw new DomainError('validation_failed');
      const row = await ownedSource(db, await reauthorize(), reference);
      if (row.origin !== 'upload' || Number(row.declared_bytes) !== bytes)
        throw new DomainError('conflict');
      return executeTransfer(
        reference,
        async (source, abort, authorize) => {
          const file = await open(
            sourcePath(source),
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          const reader = body.getReader();
          const cancel = () => {
            void reader.cancel().catch(() => {});
          };
          abort.addEventListener('abort', cancel, { once: true });
          let received = 0;
          try {
            for (;;) {
              await authorize();
              const chunk = await reader.read();
              if (chunk.done) break;
              received += chunk.value.byteLength;
              if (received > bytes) throw new DomainError('validation_failed', 413);
              let offset = 0;
              while (offset < chunk.value.length) {
                const result = await file.write(chunk.value, offset, chunk.value.length - offset);
                if (result.bytesWritten === 0) throw new DomainError('integration_unavailable');
                offset += result.bytesWritten;
              }
            }
            await authorize();
            if (received !== bytes) throw new DomainError('validation_failed');
            await file.sync();
          } finally {
            abort.removeEventListener('abort', cancel);
            await reader.cancel().catch(() => {});
            reader.releaseLock();
            await file.close();
          }
        },
        signal,
      );
    },
    async acquireModrinth(input: unknown, signal?: AbortSignal) {
      const value = parse(minecraftSourceModrinthSchema, input);
      await authorizeScope(db, await reauthorize(), value.serverId);
      const { values } = await getSettings(db, env);
      if (!options.http && !values.minecraftMetadataUserAgent)
        throw new DomainError('configuration_invalid');
      const http =
        options.http ??
        new SafeContentHttp({
          allowedOrigins: ['https://api.modrinth.com', ...values.minecraftDownloadOrigins],
          userAgent: values.minecraftMetadataUserAgent as string,
          maxDownloadBytes: Math.min(
            values.minecraftSourceGlobalBytes,
            values.minecraftSourceUserBytes,
          ),
        });
      const artifact = await new ModrinthProvider(http).modpackArchive(
        value.projectId,
        value.versionId,
      );
      if (
        !Number.isSafeInteger(artifact.size) ||
        artifact.size < 1 ||
        artifact.size > Number.MAX_SAFE_INTEGER - 65536
      )
        throw new DomainError('validation_failed');
      const row = await reserve({
        ...value,
        kind: 'modpack',
        origin: 'modrinth',
        bytes: artifact.size,
        hashes: artifact.hashes,
        projectId: artifact.projectId,
        versionId: artifact.versionId,
      });
      return executeTransfer(
        row.id,
        async (source, abort) => {
          // Reuse the audited provider downloader: SSRF protection, identity URL
          // allowlists, streaming, hash verification, timeouts and bounded retries.
          await http.download(artifact as ContentArtifact, sourcePath(source), { signal: abort });
        },
        signal,
      );
    },
    archiveResolver: async (reference: string, serverId: string) =>
      (await resolveSource(reference, 'modpack', serverId)).path,
    worldArchiveResolver: (reference: string, serverId: string) =>
      resolveSource(reference, 'world', serverId),
    resolveForCreation: (reference: string) => resolveSource(reference, 'modpack'),
    resolveForServer: (reference: string, serverId: string) =>
      resolveSource(reference, 'modpack', serverId),
    bindSource: (reference: string, serverId: string) =>
      db.transaction().execute(async (tx) => {
        await lockResources(tx);
        return bindMinecraftSource(tx, context, reference, serverId, env, options);
      }),
    async recoverStaging(jobId: string, input: unknown) {
      parse(z.uuid(), jobId);
      const value = parse(
        z.strictObject({
          confirm: z.literal(true),
          identityDigest: digest,
          filesRemoved: z.literal(true),
          workerStopped: z.literal(true),
          reason: z.string().trim().min(10).max(1000),
          evidence: z.string().trim().min(20).max(4000),
        }),
        input,
      );
      return db.transaction().execute(async (tx) => {
        await lockResources(tx);
        const actor = await reauthorize(tx);
        ownerOnly(actor);
        const row = await tx
          .selectFrom('minecraft_staging_claims')
          .selectAll()
          .where('job_id', '=', jobId)
          .executeTakeFirst();
        if (!row) throw new DomainError('not_found');
        const job = await tx
          .selectFrom('operation_jobs')
          .select('state')
          .where('id', '=', jobId)
          .executeTakeFirstOrThrow();
        const server = await tx
          .selectFrom('managed_servers')
          .select('active_operation_id')
          .where('id', '=', row.server_id)
          .executeTakeFirstOrThrow();
        if (
          row.state !== 'reserved' ||
          row.identity_digest !== value.identityDigest ||
          ['queued', 'running'].includes(job.state) ||
          server.active_operation_id === jobId
        )
          throw new DomainError('conflict');
        // Both existing content stagers use generated job directories. Check
        // every relevant root; a failed stage may have left either kind behind.
        for (const directory of ['content-staging', 'world-staging']) {
          try {
            await lstat(join(row.storage_root, directory, jobId));
            throw new DomainError('conflict');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        await tx
          .updateTable('minecraft_staging_claims')
          .set({ state: 'released' })
          .where('job_id', '=', jobId)
          .execute();
        await recordAudit(tx, actor, 'minecraft.staging.released', { jobId, ...value });
      });
    },
    /** No filesystem mutation. The Owner provides evidence of unused/scoped
     * cleanup, and we independently require the exact path to be absent. */
    async recover(reference: string, input: unknown) {
      const value = parse(
        z.strictObject({
          confirm: z.literal(true),
          identityDigest: digest,
          unusedByJobs: z.literal(true),
          filesRemoved: z.literal(true),
          transferStopped: z.literal(true),
          reason: z.string().trim().min(10).max(1000),
          evidence: z.string().trim().min(20).max(4000),
        }),
        input,
      );
      return rowLock(db, reference, (connection) =>
        connection.transaction().execute(async (tx) => {
          await lockResources(tx);
          const actor = await reauthorize(tx);
          ownerOnly(actor);
          const row = await tx
            .selectFrom('minecraft_sources')
            .selectAll()
            .where('id', '=', reference)
            .executeTakeFirst();
          if (!row) throw new DomainError('not_found');
          if (row.identity_digest !== value.identityDigest || row.state === 'released')
            throw new DomainError('conflict');
          const active = await tx
            .selectFrom('managed_servers')
            .select('id')
            .where('active_operation_id', 'is not', null)
            .where((eb) =>
              eb.or([
                eb('id', '=', row.server_id ?? reference),
                eb(
                  'id',
                  'in',
                  eb
                    .selectFrom('minecraft_source_bindings')
                    .select('server_id')
                    .where('source_id', '=', reference),
                ),
              ]),
            )
            .executeTakeFirst();
          if (active) throw new DomainError('conflict');
          // A symlink or any surviving directory (even empty) fails closed. This
          // method never chooses which files an operator may safely remove.
          try {
            await lstat(join(row.storage_root, row.id));
            throw new DomainError('conflict');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          await recordAudit(tx, actor, 'minecraft.source.released', { sourceId: row.id, ...value });
          await tx
            .updateTable('minecraft_sources')
            .set({ state: 'released', updated_at: new Date() })
            .where('id', '=', row.id)
            .execute();
        }),
      );
    },
  };
}
