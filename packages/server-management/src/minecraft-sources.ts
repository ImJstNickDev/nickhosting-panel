import { createHash, randomUUID } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ContentArtifact,
  type ContentFileVerification,
  type ContentHttp,
  contentFileUnchanged,
  contentStageDirectory,
  hashesSchema,
  ModrinthProvider,
  SafeContentHttp,
} from '@nickhosting/content-providers';
import { type AuthContext, contentPolicyValues, DomainError } from '@nickhosting/core';
import {
  assertStoragePolicyIdle,
  type Database,
  getSettings,
  recordAudit,
} from '@nickhosting/database';
import { type Kysely, type Selectable, sql } from 'kysely';
import { z } from 'zod';
import { type Environment, lockResources } from './admission.js';
import {
  assertContentAdmission,
  contentStorageRoot,
  reserveContentStaging,
} from './content-admission.js';
import { currentInteractiveContext } from './interactive-context.js';
import { authorizeServer, ownerOnly, parse } from './registry.js';

type Source = Selectable<Database['minecraft_sources']>;
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const statInteger = z.string().regex(/^[0-9]+$/);
const sourceFileIdentitySchema = z.strictObject({
  dev: statInteger,
  ino: statInteger,
  mode: statInteger,
  uid: statInteger,
  gid: statInteger,
  nlink: z.literal('1'),
  size: statInteger,
  mtimeNs: z.string().regex(/^-?[0-9]+$/),
  ctimeNs: z.string().regex(/^-?[0-9]+$/),
});
const sourceDirectoryIdentitySchema = sourceFileIdentitySchema.pick({
  dev: true,
  ino: true,
  mode: true,
  uid: true,
  gid: true,
});
const sourceSealSchema = z.strictObject({
  version: z.literal(1),
  sourceId: z.uuid(),
  identityDigest: digest,
  sha256: digest,
  file: sourceFileIdentitySchema,
  directory: sourceDirectoryIdentitySchema,
});
type SourceSeal = z.infer<typeof sourceSealSchema>;
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
function sourceDirectoryIdentity(info: BigIntStats) {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    mode: String(info.mode),
    uid: String(info.uid),
    gid: String(info.gid),
  };
}
function sourceFileIdentity(info: BigIntStats) {
  return {
    ...sourceDirectoryIdentity(info),
    nlink: String(info.nlink),
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
  };
}
function sameIdentity(actual: Record<string, string>, expected: Record<string, string>) {
  return Object.keys(expected).every((key) => actual[key] === expected[key]);
}

/** A seal is server-owned storage evidence, never the client's claimed digest.
 * The sole writer owns an exclusive generated file in a private directory. It
 * hashes the bytes it writes, closes its writer, then makes the file read-only
 * and syncs both file and directory before the DB can publish the seal. Ordinary
 * edits, chmod/chown, hard links or replacement invalidate the stored identity.
 * Host administrators and storage corruption are outside this trust boundary;
 * outgoing world streams still verify every file against the extracted manifest.
 */
async function withSourceFile<T>(
  row: Source,
  work: (
    file: Awaited<ReturnType<typeof open>>,
    directory: Awaited<ReturnType<typeof open>>,
    directoryIdentity: BigIntStats,
  ) => Promise<T>,
): Promise<T> {
  await contentStageDirectory(row.storage_root);
  const path = join(row.storage_root, row.id);
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const info = await directory.stat({ bigint: true });
    if (!info.isDirectory() || (info.mode & 0o077n) !== 0n) throw new DomainError('conflict');
    const file = await open(sourcePath(row), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const result = await work(file, directory, info);
      const current = await lstat(path, { bigint: true });
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        !sameIdentity(sourceDirectoryIdentity(current), sourceDirectoryIdentity(info))
      )
        throw new DomainError('conflict');
      return result;
    } finally {
      await file.close();
    }
  } finally {
    await directory.close();
  }
}
async function sealSource(row: Source, verified: ContentFileVerification): Promise<SourceSeal> {
  return withSourceFile(row, async (file, directory, directoryIdentity) => {
    const before = await file.stat({ bigint: true });
    if (
      verified.path !== sourcePath(row) ||
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size !== BigInt(row.declared_bytes) ||
      before.uid !== directoryIdentity.uid ||
      !sameIdentity(sourceFileIdentity(before), sourceFileIdentity(verified.identity))
    )
      throw new DomainError('conflict');
    if ((before.mode & 0o7777n) !== 0o400n) await file.chmod(0o400);
    await file.sync();
    await directory.sync();
    const identity = await file.stat({ bigint: true });
    if (!(await contentFileUnchanged(sourcePath(row), identity))) throw new DomainError('conflict');
    return sourceSealSchema.parse({
      version: 1,
      sourceId: row.id,
      identityDigest: row.identity_digest,
      sha256: verified.sha256,
      file: sourceFileIdentity(identity),
      directory: sourceDirectoryIdentity(directoryIdentity),
    });
  });
}
async function verifySourceSeal(row: Source): Promise<ContentFileVerification> {
  const parsed = sourceSealSchema.safeParse(row.source_seal);
  if (
    !parsed.success ||
    parsed.data.sourceId !== row.id ||
    parsed.data.identityDigest !== row.identity_digest ||
    parsed.data.sha256 !== row.actual_sha256
  )
    throw new DomainError('conflict');
  const seal = parsed.data;
  return withSourceFile(row, async (file, _directory, directoryIdentity) => {
    const identity = await file.stat({ bigint: true });
    if (
      !identity.isFile() ||
      identity.nlink !== 1n ||
      identity.size !== BigInt(row.declared_bytes) ||
      (identity.mode & 0o7777n) !== 0o400n ||
      !sameIdentity(sourceFileIdentity(identity), seal.file) ||
      !sameIdentity(sourceDirectoryIdentity(directoryIdentity), seal.directory) ||
      !(await contentFileUnchanged(sourcePath(row), identity))
    )
      throw new DomainError('conflict');
    return { path: sourcePath(row), sha256: seal.sha256, identity };
  });
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
    .where('game_id', '=', 'minecraft')
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
const sourceAuthorizationIntervalMs = 500;
/** One authority check per time window, shared by streaming and the stalled-body
 * timer. Boundaries force a fresh check; archive chunks never each query SQL. */
function sourceAuthorization(check: () => Promise<unknown>, signal?: AbortSignal) {
  let checkedAt = performance.now();
  let checking: Promise<void> | undefined;
  return async (force = false): Promise<void> => {
    signal?.throwIfAborted();
    if (checking) return checking;
    if (!force && performance.now() - checkedAt < sourceAuthorizationIntervalMs) return;
    checking = (async () => {
      await check();
      signal?.throwIfAborted();
      checkedAt = performance.now();
    })().finally(() => {
      checking = undefined;
    });
    return checking;
  };
}
async function hashSource(
  row: Source,
  authorize: (force?: boolean) => Promise<void>,
): Promise<ContentFileVerification> {
  await authorize();
  await contentStageDirectory(row.storage_root);
  const directory = join(row.storage_root, row.id);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new DomainError('conflict');
  const file = await open(sourcePath(row), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(row.declared_bytes))
      throw new DomainError('conflict');
    const hashes = hashesSchema.parse(row.expected_hashes);
    const checks = Object.fromEntries(
      Object.keys({ ...hashes, sha256: '' }).map((name) => [name, createHash(name)]),
    );
    let bytes = 0;
    // Local source hashing benefits from larger bounded reads. This does not
    // change browser/provider upload buffering or authority refresh intervals.
    for await (const chunk of file.createReadStream({
      autoClose: false,
      highWaterMark: 1024 ** 2,
    })) {
      await authorize();
      bytes += chunk.length;
      if (bytes > Number(row.declared_bytes)) throw new DomainError('conflict');
      for (const hash of Object.values(checks)) hash.update(chunk);
    }
    const actual = Object.fromEntries(
      Object.entries(checks).map(([key, hash]) => [key, hash.digest('hex')]),
    );
    if (
      bytes !== Number(row.declared_bytes) ||
      !(await contentFileUnchanged(sourcePath(row), before)) ||
      Object.entries(hashes).some(([key, value]) => actual[key] !== value) ||
      (row.actual_sha256 !== null && actual.sha256 !== row.actual_sha256)
    )
      throw new DomainError('conflict');
    await authorize(true);
    return { path: sourcePath(row), sha256: actual.sha256 as string, identity: before };
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

/** Compatibility export for existing Minecraft worker composition. */
export const reserveMinecraftStaging = reserveContentStaging;

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
        .where('game_id', '=', 'minecraft')
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
      const root = contentStorageRoot(values.contentSourceRoot);
      await contentStageDirectory(root);
      await assertStoragePolicyIdle(tx);
      const bytes = BigInt(input.bytes) + 65536n;
      await assertContentAdmission(
        tx,
        values,
        { gameId: 'minecraft', ownerId, bytes, root },
        options,
      );
      const row = await tx
        .insertInto('minecraft_sources')
        .values({
          id: randomUUID(),
          game_id: 'minecraft',
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
    transfer: (
      row: Source,
      signal: AbortSignal,
      authorize: () => Promise<void>,
    ) => Promise<ContentFileVerification | undefined>,
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
      // The exact source and actor were checked above under this source lock.
      const authorize = sourceAuthorization(
        async () => ownedSource(connection, await reauthorize(connection), reference),
        abort,
      );
      // Revocation must interrupt stalled provider/raw uploads too, rather than
      // waiting indefinitely for another body chunk. At most one query is in flight.
      let checking: Promise<void> | undefined;
      const timer = setInterval(() => {
        if (!checking)
          checking = authorize(true)
            .catch(() => controller.abort(new DomainError('forbidden')))
            .finally(() => {
              checking = undefined;
            });
      }, sourceAuthorizationIntervalMs);
      timer.unref();
      try {
        await contentStageDirectory(join(row.storage_root, row.id));
        // Direct uploads return the server's digest of the successful writes.
        // Provider acquisition retains its full-file verification fallback.
        const verified =
          (await transfer(row, abort, authorize)) ?? (await hashSource(row, authorize));
        const seal = await sealSource(row, verified);
        const { sha256 } = verified;
        // Do not let the background check share this pinned connection with the
        // final transaction. The transaction reauthorizes once more before ready.
        clearInterval(timer);
        await checking;
        abort.throwIfAborted();
        await connection.transaction().execute(async (tx) => {
          await lockResources(tx);
          const currentActor = await reauthorize(tx);
          await ownedSource(tx, currentActor, reference);
          await tx
            .updateTable('minecraft_sources')
            .set({
              state: 'ready',
              actual_sha256: sha256,
              source_seal: JSON.stringify(seal),
              updated_at: new Date(),
            })
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
        clearInterval(timer);
        controller.abort(error);
        await checking;
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
      let row = await ownedSource(connection, await reauthorize(connection), reference, serverId);
      if (row.state !== 'ready' || row.kind !== kind || (!serverId && row.server_id))
        throw new DomainError('conflict');
      const authorize = sourceAuthorization(async () =>
        ownedSource(connection, await reauthorize(connection), reference, serverId),
      );
      if (row.source_seal == null) {
        // Old sources have no publication seal. Verify their actual bytes once
        // under the source lock before upgrading; a bad non-null seal never
        // falls back to recertifying changed storage.
        const previous = await hashSource(row, authorize);
        const seal = await sealSource(row, previous);
        await authorize(true);
        row = await connection
          .updateTable('minecraft_sources')
          .set({ source_seal: JSON.stringify(seal), updated_at: new Date() })
          .where('id', '=', row.id)
          .where('state', '=', 'ready')
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      const verified = await verifySourceSeal(row);
      // A seal removes byte passes, never a current session/job/scope check.
      await authorize(true);
      return {
        path: verified.path,
        sha256: verified.sha256,
        // Only world staging consumes this in-process proof. It is not stored
        // in a job plan or exposed by the public source metadata projection.
        ...(kind === 'world' ? { verified } : {}),
      };
    });
  }
  return {
    async ownerInventory() {
      ownerOnly(await reauthorize());
      const sources = await db
        .selectFrom('minecraft_sources')
        .selectAll()
        .where('game_id', '=', 'minecraft')
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
        .where('game_id', '=', 'minecraft')
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
          const hash = createHash('sha256');
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
                hash.update(chunk.value.subarray(offset, offset + result.bytesWritten));
                offset += result.bytesWritten;
              }
            }
            await authorize();
            if (received !== bytes) throw new DomainError('validation_failed');
            const sha256 = hash.digest('hex');
            if (sha256 !== hashesSchema.parse(source.expected_hashes).sha256)
              throw new DomainError('conflict');
            const identity = await file.stat({ bigint: true });
            if (
              !identity.isFile() ||
              identity.nlink !== 1n ||
              identity.size !== BigInt(bytes) ||
              !(await contentFileUnchanged(sourcePath(source), identity))
            )
              throw new DomainError('conflict');
            return { path: sourcePath(source), sha256, identity };
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
      const policy = contentPolicyValues(values, 'minecraft');
      if (!options.http && !values.contentMetadataUserAgent)
        throw new DomainError('configuration_invalid');
      const http =
        options.http ??
        new SafeContentHttp({
          allowedOrigins: ['https://api.modrinth.com', ...policy.downloadOrigins],
          userAgent: values.contentMetadataUserAgent as string,
          maxDownloadBytes: Math.min(policy.sourceGlobalBytes, policy.sourceUserBytes),
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
          return undefined;
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
          .where('game_id', '=', 'minecraft')
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
            .where('game_id', '=', 'minecraft')
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
