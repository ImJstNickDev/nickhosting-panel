import { lstat, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type ContentHttp,
  type CurseForgeProvider,
  contentStageDirectory,
} from '@nickhosting/content-providers';
import {
  type AuthContext,
  authSessionId,
  contentPolicyValues,
  DomainError,
} from '@nickhosting/core';
import { type Database, getSettings } from '@nickhosting/database';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { resolvePinnedCurseForgeFiles } from '../../content-providers/src/modpack-catalog-curseforge.js';
import { createModpackCatalog } from '../../content-providers/src/modpack-catalog-providers.js';
import { stageModpackRecipe } from '../../content-providers/src/modpack-staging.js';
import { type Environment, lockResources } from './admission.js';
import { assertContentAdmission, contentStorageRoot } from './content-admission.js';
import { currentInteractiveContext } from './interactive-context.js';
import {
  createMinecraftModpacksService,
  hasResumableModpackPublicationJournal,
  hasResumableModpackRuntimeJournal,
  MinecraftModpackBlockedError,
  type MinecraftModpackOperationRow,
} from './minecraft-modpacks.js';
import {
  assertMinecraftModpackPlanCurrent,
  type MinecraftModpackReceipt,
  modpackPlanSchema,
  modpackReceiptSchema,
  type PreparedMinecraftModpack,
  preparedModpackSchema,
} from './minecraft-modpacks-plan.js';
import {
  completeModpackJob,
  createModpackContext,
  withModpackServerLock,
} from './modpack-context.js';
import { inspectModpackFiles } from './modpack-inventory.js';
import { type ModpackPropertiesStage, prepareModpackProperties } from './modpack-properties.js';
import {
  assertModpackRuntimeResumable,
  assertModpackRuntimeVerified,
  configureModpackRuntime,
  resolveModpackRuntime,
} from './modpack-runtime.js';
import { authorizeServer, enqueueServerOperation } from './registry.js';
import type { ManagementRuntime } from './runtime.js';

/** A private session reference, never its bearer token, binds background work to current authority. */
export async function modpackActor(
  db: Kysely<Database>,
  row: MinecraftModpackOperationRow,
  applying: boolean,
  env: Environment,
) {
  const actorId = applying ? row.apply_actor_user_id : row.actor_user_id;
  const subjectId = applying ? row.apply_subject_user_id : row.subject_user_id;
  const supportId = applying ? row.apply_support_session_id : row.support_session_id;
  const sessionId = applying ? row.apply_actor_session_id : row.actor_session_id;
  if (!actorId || !subjectId || !sessionId) throw new DomainError('unauthenticated');
  const user = await db
    .selectFrom('user')
    .select('role')
    .where('id', '=', actorId)
    .executeTakeFirst();
  if (!user) throw new DomainError('unauthenticated');
  const previous: AuthContext = {
    actorUserId: actorId,
    subjectUserId: subjectId,
    role: user.role,
    sessionType: supportId ? 'support' : 'regular',
    ownerElevation: Boolean(supportId),
    [authSessionId]: sessionId,
  };
  if (supportId) {
    const support = await db
      .selectFrom('support_sessions')
      .selectAll()
      .where('id', '=', supportId)
      .executeTakeFirst();
    if (!support) throw new DomainError('support_invalid');
    previous.support = {
      id: support.id,
      startedAt: support.started_at,
      expiresAt: support.expires_at,
      lastActivityAt: support.last_activity_at,
      revokedAt: support.revoked_at,
      reason: support.reason,
    };
  }
  const current = await currentInteractiveContext(db, previous, env);
  const server = await authorizeServer(db, current, row.server_id, 'server:manage');
  if (server.owner_id !== row.resource_owner_id) throw new DomainError('forbidden');
  return current;
}

export function createMinecraftModpackBridge(options: {
  db: Kysely<Database>;
  runtime: ManagementRuntime;
  env?: Environment;
  http?: ContentHttp;
  curseforge?: CurseForgeProvider;
}) {
  const { db, runtime, env = {} } = options;
  const operation = (id: string) =>
    db
      .selectFrom('minecraft_modpack_operations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const active = (serverId: string) =>
    db
      .selectFrom('minecraft_modpack_operations')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('state', 'in', [
        'queued',
        'preparing',
        'ready',
        'apply_queued',
        'applying',
        'uncertain',
      ])
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
  const binding = async (serverId: string) => {
    const profile = await db
      .selectFrom('minecraft_server_profiles')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    const server = await db
      .selectFrom('managed_servers')
      .select('mapping_id')
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    const manifest = z.array(z.object({ path: z.string() })).safeParse(profile.installed_manifest);
    return {
      combinationId: profile.combination_id,
      mappingId: server.mapping_id,
      protectedPaths: [
        ...new Set([
          'server.jar',
          'libraries',
          'versions',
          ...(manifest.success ? manifest.data.map((file) => file.path) : []),
        ]),
      ],
    };
  };
  const inspect = async (
    serverId: string,
    prepared: PreparedMinecraftModpack,
    receipt: MinecraftModpackReceipt | null,
  ) => {
    const row = await active(serverId);
    const actor = await modpackActor(db, row, row.state === 'applying', env);
    return runtime.fileReadScope(actor, serverId, async (files) =>
      inspectModpackFiles(files, prepared, receipt, await binding(serverId)),
    );
  };
  const getRuntime = async (
    row: MinecraftModpackOperationRow,
    target: PreparedMinecraftModpack['target'],
  ) =>
    resolveModpackRuntime({
      db,
      adapter: runtime.adapter,
      context: await modpackActor(db, row, row.state === 'applying', env),
      serverId: row.server_id,
      target,
      env,
    });
  return createMinecraftModpacksService({
    db,
    env,
    hooks: {
      authorize: async (row, applying) => {
        await modpackActor(db, row, applying, env);
      },
      async prepare(input) {
        const { http, curseforge } = options;
        if (!http?.downloadModpack) throw new DomainError('integration_unavailable');
        const download = http.downloadModpack.bind(http);
        const { values } = await getSettings(db, env);
        const policy = contentPolicyValues(values, 'minecraft');
        const root = join(contentStorageRoot(values.contentWorkRoot, env), 'modpacks');
        await contentStageDirectory(root);
        const directory = join(
          root,
          z.uuid().parse(input.operation.id),
          z.uuid().parse(input.attemptId),
        );
        const host = await db
          .selectFrom('managed_servers as server')
          .innerJoin('managed_nodes as node', 'node.id', 'server.node_id')
          .select('node.physical_host_id')
          .where('server.id', '=', input.operation.server_id)
          .executeTakeFirstOrThrow();
        let lastStageBytes = 0;
        let overheadBytes = 1024 * 1024;
        const reserve = async (bytes: number) => {
          // Also charge the one STORE ZIP needed for bulk publication; no unaccounted duplicate of a large pack.
          const held = bytes * 2 + overheadBytes;
          if (!Number.isSafeInteger(held)) throw new DomainError('validation_failed');
          lastStageBytes = bytes;
          await db.transaction().execute(async (tx) => {
            await lockResources(tx);
            const row = await operation(input.operation.id);
            const extra = BigInt(held) - BigInt(row.held_bytes);
            await assertContentAdmission(tx, values, {
              gameId: 'minecraft',
              ownerId: row.resource_owner_id,
              bytes: extra > 0n ? extra : 0n,
              active: BigInt(row.held_bytes) > 0n ? 0 : 1,
              root,
            });
            await input.reservation({
              physicalHostId: host.physical_host_id,
              bytes: held,
              stagingRoot: directory,
            });
          });
        };
        await input.progress('resolving', null);
        const recipe = await createModpackCatalog(input.selection.provider, {
          http,
          curseforge,
        }).resolve(input.selection.projectId, input.selection.versionId, input.signal);
        if (recipe.kind === 'unavailable')
          throw new MinecraftModpackBlockedError([{ reason: recipe.reason }]);
        await reserve(0);
        const stagingBudget = Math.floor(
          (Math.min(policy.sourceGlobalBytes, policy.sourceUserBytes) - 1024 * 1024) / 2,
        );
        const staged = await stageModpackRecipe(recipe, {
          directory,
          signal: input.signal,
          reserve,
          limits: {
            maxArchiveBytes: stagingBudget,
            maxExpandedBytes: stagingBudget,
            maxFileBytes: stagingBudget,
          },
          download: (artifact, destination, signal, options) =>
            download(artifact, destination, { ...options, signal }),
          ...(curseforge
            ? {
                resolveCurseForgeFiles: (
                  files: { projectId: number; fileId: number }[],
                  signal?: AbortSignal,
                ) => resolvePinnedCurseForgeFiles(curseforge, files, signal),
              }
            : {}),
          checkTarget: async (target) => {
            if (!(await getRuntime(input.operation, target)))
              throw new MinecraftModpackBlockedError([{ reason: 'runtime' }]);
          },
          progress: (value) =>
            input.progress('downloading', {
              completedFiles: value.files,
              totalFiles: value.totalFiles,
              completedBytes: value.bytes,
              totalBytes: value.totalBytes,
            }),
        }).catch((error: unknown) => {
          if (
            error instanceof DomainError &&
            error.details?.contentReason === 'modpack_target_unresolved'
          )
            throw new MinecraftModpackBlockedError([{ reason: 'unresolved' }]);
          throw error;
        });
        // ZIP headers are byte-sized metadata, including the generated remote prefix twice.
        overheadBytes =
          1024 * 1024 +
          staged.files.reduce((sum, file) => sum + 320 + 2 * Buffer.byteLength(file.path), 0) +
          (staged.files.some((file) => file.path === 'server.properties') ? 2 * 1024 * 1024 : 0);
        await reserve(lastStageBytes);
        const sanitized: ModpackPropertiesStage = staged.files.some(
          (file) => file.path === 'server.properties',
        )
          ? await runtime.fileReadScope(
              await modpackActor(db, input.operation, false, env),
              input.operation.server_id,
              (files) => prepareModpackProperties(staged, files),
            )
          : staged;
        const {
          description: _description,
          descriptionFormat: _format,
          ...project
        } = recipe.project;
        return {
          pack: { project, version: recipe.version },
          target: staged.target,
          stagingKey: sanitized.directory,
          files: sanitized.files,
          ...('propertiesMerged' in sanitized
            ? {
                propertiesMerged: sanitized.propertiesMerged,
                propertiesSource: sanitized.propertiesSource,
              }
            : {}),
          blockers: [],
        };
      },
      inspect,
      resolveRuntime: async (serverId, prepared) =>
        getRuntime(await active(serverId), prepared.target),
      withServerLock: (row, work) =>
        withModpackServerLock(db, row.server_id, async (connection) => {
          const currentAuth = () => modpackActor(connection, row, true, env);
          const host = await createModpackContext({
            db: connection,
            runtime,
            operation: row,
            env,
            currentAuth,
          });
          return work({
            inspect: async (prepared, receipt) =>
              inspectModpackFiles(
                host.readScope(),
                prepared,
                receipt,
                await binding(row.server_id),
              ),
            stop: host.stop,
            backup: host.backup,
            assertRuntimeResumable: async (plan) => {
              if (!plan.runtime || !hasResumableModpackRuntimeJournal(await operation(row.id)))
                throw new DomainError('operation_uncertain');
              await assertModpackRuntimeResumable({
                db: connection,
                adapter: runtime.adapter,
                context: await currentAuth(),
                serverId: row.server_id,
                operationId: row.id,
                binding: plan.runtime,
                sourceMappingId: plan.sourceMappingId,
                sourceCombinationId: plan.sourceCombinationId,
                env,
                authorize: host.context.authorize,
                assertStopped: host.assertStopped,
                readTransition: async () => (await operation(row.id)).runtime_transition,
              });
            },
            assertPublicationResumable: async (prepared, plan) => {
              if (!plan.runtime || !hasResumableModpackPublicationJournal(await operation(row.id)))
                throw new DomainError('operation_uncertain');
              await assertModpackRuntimeVerified({
                db: connection,
                adapter: runtime.adapter,
                context: await currentAuth(),
                serverId: row.server_id,
                operationId: row.id,
                binding: plan.runtime,
                sourceMappingId: plan.sourceMappingId,
                sourceCombinationId: plan.sourceCombinationId,
                env,
                authorize: host.context.authorize,
                assertStopped: host.assertStopped,
                readTransition: async () => (await operation(row.id)).runtime_transition,
              });
              await host.publication.assertResumable(prepared, plan);
            },
            resumePublication: host.publication.resume,
            configureRuntime: async (target) =>
              configureModpackRuntime({
                db: connection,
                adapter: runtime.adapter,
                context: await currentAuth(),
                serverId: row.server_id,
                operationId: row.id,
                binding: target,
                env,
                authorize: host.context.authorize,
                assertStopped: host.assertStopped,
                contentOptions: await runtime.minecraftOptions(),
                readTransition: async () => (await operation(row.id)).runtime_transition,
                saveTransition: async (value) => {
                  await db
                    .updateTable('minecraft_modpack_operations')
                    .set({ runtime_transition: JSON.stringify(value) })
                    .where('id', '=', row.id)
                    .execute();
                },
              }),
            publish: host.publication.publish,
            verify: host.publication.verify,
          });
        }),
      async restoreRunningState(row) {
        const op = await db
          .selectFrom('server_operations')
          .select('plan')
          .where('job_id', '=', row.id)
          .executeTakeFirst();
        try {
          await withModpackServerLock(db, row.server_id, async (connection) => {
            const host = await createModpackContext({
              db: connection,
              runtime,
              operation: row,
              env,
              currentAuth: () => modpackActor(connection, row, true, env),
              recovery: true,
            });
            await host.publication.cleanup(
              preparedModpackSchema.parse(row.prepared),
              modpackPlanSchema.parse(row.plan),
              { applied: true },
            );
          });
        } finally {
          await completeModpackJob(db, row);
        }
        if (!op?.plan.wasRunning) return true;
        const actor = await modpackActor(db, row, true, env);
        const accepted = await enqueueServerOperation(
          db,
          actor,
          row.server_id,
          { action: 'start', idempotencyKey: `modpack-resume-${row.id}` },
          env,
        );
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline) {
          await runtime.process(accepted.jobId);
          const job = await db
            .selectFrom('operation_jobs')
            .select('state')
            .where('id', '=', accepted.jobId)
            .executeTakeFirstOrThrow();
          if (job.state === 'succeeded') return true;
          if (job.state === 'failed') return false;
          await delay(500);
        }
        return false;
      },
      recover: (row, prepared, plan, caller) =>
        withModpackServerLock(db, row.server_id, async (connection) => {
          const actor = await currentInteractiveContext(connection, caller, env);
          const server = await authorizeServer(connection, actor, row.server_id, 'server:manage');
          if (server.owner_id !== row.resource_owner_id) throw new DomainError('forbidden');
          const job = await connection
            .selectFrom('server_operations')
            .select('job_id')
            .where('job_id', '=', row.id)
            .executeTakeFirst();
          // The synthetic job commits before any game effect. A crash before
          // that boundary needs no provider operation and must not invent a job.
          if (!job)
            return {
              state:
                Array.isArray(row.journal) &&
                row.journal.length === 0 &&
                row.runtime_transition === null &&
                row.publication === null
                  ? ('unchanged' as const)
                  : ('unknown' as const),
            };
          const host = await createModpackContext({
            db: connection,
            runtime,
            operation: row,
            env,
            currentAuth: () => currentInteractiveContext(connection, caller, env),
            recovery: true,
          });
          const transition = row.runtime_transition as { state?: string } | null;
          if (transition && transition.state !== 'verified') {
            if (!plan.runtime || !hasResumableModpackRuntimeJournal(row))
              return { state: 'unknown' as const };
            await assertModpackRuntimeResumable({
              db: connection,
              adapter: runtime.adapter,
              context: actor,
              serverId: row.server_id,
              operationId: row.id,
              binding: plan.runtime,
              sourceMappingId: plan.sourceMappingId,
              sourceCombinationId: plan.sourceCombinationId,
              env,
              authorize: host.context.authorize,
              assertStopped: host.assertStopped,
              readTransition: async () => row.runtime_transition,
            });
            const previous = await connection
              .selectFrom('minecraft_modpack_receipts')
              .select(['operation_id', 'receipt'])
              .where('server_id', '=', row.server_id)
              .executeTakeFirst();
            if ((previous?.operation_id ?? null) !== plan.previousOperationId)
              throw new DomainError('conflict');
            const observed = await inspectModpackFiles(
              host.readScope(),
              prepared,
              previous ? modpackReceiptSchema.parse(previous.receipt) : null,
              await binding(row.server_id),
            );
            assertMinecraftModpackPlanCurrent(plan, {
              ...observed,
              combinationId: plan.sourceCombinationId,
              mappingId: plan.sourceMappingId,
            });
            return { state: 'resume-runtime' as const };
          }
          const result = await host.publication.recover(prepared, plan);
          if (result.state === 'resume-publication') {
            if (!plan.runtime || !hasResumableModpackPublicationJournal(row))
              return { state: 'unknown' as const };
            await assertModpackRuntimeVerified({
              db: connection,
              adapter: runtime.adapter,
              context: actor,
              serverId: row.server_id,
              operationId: row.id,
              binding: plan.runtime,
              sourceMappingId: plan.sourceMappingId,
              sourceCombinationId: plan.sourceCombinationId,
              env,
              authorize: host.context.authorize,
              assertStopped: host.assertStopped,
              readTransition: async () => row.runtime_transition,
            });
            const previous = await connection
              .selectFrom('minecraft_modpack_receipts')
              .select(['operation_id', 'receipt'])
              .where('server_id', '=', row.server_id)
              .executeTakeFirst();
            if ((previous?.operation_id ?? null) !== plan.previousOperationId)
              throw new DomainError('conflict');
            const observed = await inspectModpackFiles(
              host.readScope(),
              prepared,
              previous ? modpackReceiptSchema.parse(previous.receipt) : null,
              await binding(row.server_id),
            );
            assertMinecraftModpackPlanCurrent(plan, {
              ...observed,
              combinationId: plan.sourceCombinationId,
              mappingId: plan.sourceMappingId,
            });
          }
          if (result.state === 'applied') await completeModpackJob(connection, row);
          return result;
        }),
      async cleanup(row) {
        if (row.state === 'applied') await completeModpackJob(db, row);
        if (row.state === 'failed')
          await db.transaction().execute(async (tx) => {
            await lockResources(tx);
            await tx
              .updateTable('operation_jobs')
              .set({
                state: 'failed',
                completed_at: new Date(),
                error_code: row.error ?? 'integration_unavailable',
              })
              .where('id', '=', row.id)
              .execute();
            await tx
              .updateTable('managed_servers')
              .set({ active_operation_id: null, updated_at: new Date() })
              .where('id', '=', row.server_id)
              .where('active_operation_id', '=', row.id)
              .execute();
          });
        // Only local operation-owned staging is reclaimed here; remote originals are reclaimed after verified publication.
        if (!row.staging_root) return;
        const { values } = await getSettings(db, env);
        const parent = join(
          contentStorageRoot(values.contentWorkRoot, env),
          'modpacks',
          z.uuid().parse(row.id),
        );
        const path = resolve(row.staging_root);
        if (
          dirname(path) !== resolve(parent) ||
          !z.uuid().safeParse(path.split('/').at(-1)).success
        )
          throw new DomainError('provenance_mismatch');
        try {
          const info = await lstat(path);
          if (!info.isDirectory() || info.isSymbolicLink())
            throw new DomainError('provenance_mismatch');
          await rm(path, { recursive: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      },
    },
  });
}
