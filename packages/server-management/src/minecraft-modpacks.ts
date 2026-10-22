import { randomUUID } from 'node:crypto';
import { type AuthContext, authSessionId, type createLogger, DomainError } from '@nickhosting/core';
import { type Database, notifyJobOutbox, recordAudit } from '@nickhosting/database';
import { type Kysely, type Selectable, sql, type Updateable } from 'kysely';
import { z } from 'zod';
import {
  type MinecraftModpackBlocker,
  type MinecraftModpackPhase,
  type MinecraftModpackProgress,
  type MinecraftModpackSelection,
  type MinecraftModpacksSnapshot,
  minecraftModpackApplySchema,
  minecraftModpackBlockerSchema,
  minecraftModpackPhaseSchema,
  minecraftModpackPrepareSchema,
  minecraftModpackProgressSchema,
} from '../../../games/minecraft/src/modpack-contracts.js';
import { type Environment, lockResources } from './admission.js';
import { currentInteractiveContext } from './interactive-context.js';
import {
  assertMinecraftModpackPlanCurrent,
  type MinecraftModpackFile,
  type MinecraftModpackObservation,
  type MinecraftModpackPlan,
  type MinecraftModpackReceipt,
  type MinecraftModpackRuntimeBinding,
  modpackDigest,
  modpackFileSchema,
  modpackPlanSchema,
  modpackReceiptSchema,
  modpackRuntimeBindingSchema,
  type PreparedMinecraftModpack,
  planMinecraftModpack,
  preparedModpackSchema,
} from './minecraft-modpacks-plan.js';
import { createOperationTiming } from './operation-timing.js';
import { authorizeServer, parse } from './registry.js';

export type MinecraftModpackOperationRow = Selectable<Database['minecraft_modpack_operations']>;
/** Provider/runtime refusals are reviewable blockers, not successful preparation. */
export class MinecraftModpackBlockedError extends DomainError {
  readonly blockers: MinecraftModpackBlocker[];
  constructor(blockers: MinecraftModpackBlocker[]) {
    super('integration_unavailable');
    this.blockers = z.array(minecraftModpackBlockerSchema).min(1).max(20000).parse(blockers);
  }
}
export interface MinecraftModpackApplyScope {
  /** Fresh batched inventory under the exclusive existing lifecycle lock. */
  inspect(
    prepared: PreparedMinecraftModpack,
    receipt: MinecraftModpackReceipt | null,
  ): Promise<MinecraftModpackObservation>;
  /** Check the exact archive and shared upload capacity before lifecycle effects. */
  preflightPublication(
    prepared: PreparedMinecraftModpack,
    plan: MinecraftModpackPlan,
  ): Promise<void>;
  /** Stage only operation-owned bytes; safe to overlap runtime installation. */
  stagePublication?(prepared: PreparedMinecraftModpack, plan: MinecraftModpackPlan): Promise<void>;
  /** Return only after independently confirming the physical process is stopped. */
  stop(): Promise<void>;
  /** Return only a completed, successful backup receipt; submission is insufficient. */
  backup(): Promise<string>;
  /** Read-only proof after a worker restart; never dispatches an installer. */
  assertPreparedRuntime?(
    binding: MinecraftModpackRuntimeBinding,
    source: { sourceMappingId: string; sourceCombinationId: string },
  ): Promise<void>;
  /** Exact pinned combination; the bridge must not select a newer loader. */
  configureRuntime(binding: MinecraftModpackRuntimeBinding): Promise<void>;
  /** Re-prove the exact stopped, pre-installer transition before a resumed worker acts. */
  assertRuntimeResumable?(plan: MinecraftModpackPlan): Promise<void>;
  /** Re-prove completed runtime and the exact untouched publication stage. */
  assertPublicationResumable?(
    prepared: PreparedMinecraftModpack,
    plan: MinecraftModpackPlan,
  ): Promise<void>;
  resumePublication?(prepared: PreparedMinecraftModpack, plan: MinecraftModpackPlan): Promise<void>;
  /** Reuse staged bytes and Fileman streams/bulk operations; do not refetch providers. */
  publish(prepared: PreparedMinecraftModpack, plan: MinecraftModpackPlan): Promise<void>;
  /** Return observed receipts for every written file, or null when proof is incomplete. */
  verify(
    prepared: PreparedMinecraftModpack,
    plan: MinecraftModpackPlan,
  ): Promise<MinecraftModpackFile[] | null>;
}
export interface MinecraftModpackHooks {
  /** Post-commit wake hint. Durable pending() rows remain the queue authority. */
  wake?(): void;
  /** Recheck persisted actor/support authority on every worker phase. */
  authorize(operation: MinecraftModpackOperationRow, applying: boolean): Promise<void>;
  prepare(input: {
    operation: MinecraftModpackOperationRow;
    attemptId: string;
    selection: MinecraftModpackSelection;
    signal: AbortSignal;
    /** Start the authorized install branch once the immutable manifest target is resolved. */
    runtimeReady?(binding: MinecraftModpackRuntimeBinding): Promise<void>;
    /** Await before live file reads: native provider file APIs reject an active installer. */
    beforeInventory?(): Promise<void>;
    progress(
      phase: 'resolving' | 'downloading' | 'inspecting',
      value: MinecraftModpackProgress | null,
    ): Promise<void>;
    /** Caller reserves under existing content-admission lock before acquiring bytes. */
    reservation(value: {
      physicalHostId: string;
      bytes: number;
      stagingRoot: string;
    }): Promise<void>;
  }): Promise<PreparedMinecraftModpack>;
  inspect(
    serverId: string,
    prepared: PreparedMinecraftModpack,
    receipt: MinecraftModpackReceipt | null,
  ): Promise<MinecraftModpackObservation>;
  resolveRuntime(
    serverId: string,
    prepared: PreparedMinecraftModpack,
  ): Promise<MinecraftModpackRuntimeBinding | null>;
  /** Host retains authorization, identity, pending-upload fences and the existing server lock. */
  withServerLock<T>(
    operation: MinecraftModpackOperationRow,
    work: (scope: MinecraftModpackApplyScope) => Promise<T>,
  ): Promise<T>;
  /** Called after receipt commit and release of the publication lock/guard.
   * Restore prior intent through ordinary lifecycle admission. True means no
   * further restart is needed; failures preserve the applied receipt. */
  restoreRunningState?(operation: MinecraftModpackOperationRow): Promise<boolean>;
  /** Read-only reconciliation. Resume results only authorize queueing the same
   * worker after exact retained-effect proof; this hook never mutates game files. */
  recover(
    operation: MinecraftModpackOperationRow,
    prepared: PreparedMinecraftModpack,
    plan: MinecraftModpackPlan,
    context: AuthContext,
  ): Promise<
    | { state: 'applied'; files: MinecraftModpackFile[]; restartRequired?: boolean }
    | { state: 'unchanged' | 'partial' | 'unknown' | 'resume-runtime' | 'resume-publication' }
  >;
  /** Delete only operation-owned private staging, then return. Failed cleanup retains its reservation. */
  cleanup?(operation: MinecraftModpackOperationRow): Promise<void>;
}

const active = ['queued', 'preparing', 'ready', 'apply_queued', 'applying', 'uncertain'] as const;
const cancellable = ['queued', 'preparing', 'ready', 'blocked', 'failed'] as const;
const journalSchema = z.array(
  z.object({
    phase: minecraftModpackPhaseSchema,
    state: z.enum(['dispatched', 'confirmed']),
    at: z.iso.datetime(),
  }),
);
const runtimePreparationSchema = z
  .object({
    binding: modpackRuntimeBindingSchema,
    sourceCombinationId: z.uuid(),
    sourceMappingId: z.uuid(),
    state: z.enum(['preparing', 'ready']),
  })
  .strict();
function canAbandonPreparedRuntime(row: MinecraftModpackOperationRow): boolean {
  const checkpoint = runtimePreparationSchema.safeParse(row.runtime_preparation);
  const journal = journalSchema.safeParse(row.journal);
  return (
    row.state === 'uncertain' &&
    row.lease_token === null &&
    row.publication === null &&
    checkpoint.success &&
    checkpoint.data.state === 'ready' &&
    journal.success &&
    journal.data.some((entry) => entry.phase === 'runtime' && entry.state === 'confirmed') &&
    journal.data.every(
      (entry) =>
        ['stopping', 'backup', 'runtime'].includes(entry.phase) &&
        (entry.state === 'confirmed' ||
          journal.data.some((other) => other.phase === entry.phase && other.state === 'confirmed')),
    )
  );
}
function canCancelUnstartedRuntime(row: MinecraftModpackOperationRow): boolean {
  return (
    runtimePreparationSchema.safeParse(row.runtime_preparation).success &&
    row.state === 'uncertain' &&
    row.lease_token === null &&
    row.publication === null &&
    row.runtime_transition === null &&
    Array.isArray(row.journal) &&
    row.journal.length === 0
  );
}
const leaseMs = 60_000;
const errorCode = (error: unknown) =>
  error instanceof DomainError ? error.code : 'integration_unavailable';
const terminal = ['applied', 'failed', 'cancelled', 'blocked'];

/** Only this exact durable prefix can resume. Stop/backup already succeeded;
 * neither an installer nor publication may have been dispatched. */
export function hasResumableModpackRuntimeJournal(row: MinecraftModpackOperationRow): boolean {
  const request = minecraftModpackApplySchema.safeParse(row.apply_request);
  const journal = journalSchema.safeParse(row.journal);
  const transition = z
    .object({ state: z.enum(['startup-dispatched', 'startup-confirmed']) })
    .safeParse(row.runtime_transition);
  if (
    !request.success ||
    request.data.operationId !== row.id ||
    !journal.success ||
    !transition.success ||
    row.publication !== null ||
    (request.data.backupBefore && !row.backup_id)
  )
    return false;
  const expected = [
    'stopping:dispatched',
    'stopping:confirmed',
    ...(request.data.backupBefore ? ['backup:dispatched', 'backup:confirmed'] : []),
    'runtime:dispatched',
  ];
  return (
    journal.data.length === expected.length &&
    journal.data.every((entry, index) => `${entry.phase}:${entry.state}` === expected[index])
  );
}
/** Publication recovery starts only after a fully confirmed runtime, before any
 * retirement/publication rename. It never replays earlier lifecycle effects. */
export function hasResumableModpackPublicationJournal(row: MinecraftModpackOperationRow): boolean {
  const request = minecraftModpackApplySchema.safeParse(row.apply_request);
  const journal = journalSchema.safeParse(row.journal);
  const transition = z.object({ state: z.literal('verified') }).safeParse(row.runtime_transition);
  const publication = z
    .object({
      state: z.enum(['staging', 'staged']),
      batches: z.array(z.unknown()).length(0),
      rollbackCreated: z.literal(false),
    })
    .safeParse(row.publication);
  if (
    !request.success ||
    request.data.operationId !== row.id ||
    !journal.success ||
    !transition.success ||
    !publication.success ||
    (request.data.backupBefore && !row.backup_id)
  )
    return false;
  const expected = [
    'stopping:dispatched',
    'stopping:confirmed',
    ...(request.data.backupBefore ? ['backup:dispatched', 'backup:confirmed'] : []),
    'runtime:dispatched',
    'runtime:confirmed',
    'publishing:dispatched',
  ];
  // Hidden staging overlaps the installer and precedes the publishing effect.
  // A completed early runtime plus untouched stage is also a resumable prefix.
  if (
    runtimePreparationSchema.safeParse(row.runtime_preparation).success &&
    journal.data.length === expected.length - 1 &&
    journal.data.every((entry, index) => `${entry.phase}:${entry.state}` === expected[index])
  )
    return true;
  return (
    journal.data.length === expected.length &&
    journal.data.every((entry, index) => `${entry.phase}:${entry.state}` === expected[index])
  );
}
function verifiedFiles(plan: MinecraftModpackPlan, verified: MinecraftModpackFile[]) {
  const files = z.array(modpackFileSchema).max(20000).parse(verified);
  const byPath = new Map(files.map((file) => [file.path, file]));
  if (
    files.length !== plan.write.length ||
    byPath.size !== files.length ||
    plan.write.some(
      (expected) =>
        byPath.get(expected.path)?.size !== expected.size ||
        byPath.get(expected.path)?.sha256 !== expected.sha256,
    )
  )
    throw new DomainError('operation_uncertain');
  return files;
}

/** Durable orchestration; provider/runtime effects are reachable only through the trusted bridge. */
export function createMinecraftModpacksService(options: {
  db: Kysely<Database>;
  hooks: MinecraftModpackHooks;
  logger?: ReturnType<typeof createLogger>;
  env?: Environment;
}) {
  const { db, hooks, env = {} } = options;
  async function authorized(
    context: AuthContext,
    serverId: string,
    write = false,
    connection = db,
  ) {
    const current = await currentInteractiveContext(connection, context, env);
    const server = await authorizeServer(
      connection,
      current,
      serverId,
      write ? 'game.minecraft.modpacks.write' : 'game.minecraft.modpacks.read',
    );
    const profile = await connection
      .selectFrom('minecraft_server_profiles')
      .select('server_id')
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (!profile) throw new DomainError('integration_unavailable');
    return { current, server };
  }
  const get = async (id: string, connection = db) => {
    const row = await connection
      .selectFrom('minecraft_modpack_operations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new DomainError('not_found');
    return row;
  };
  async function receipt(serverId: string, connection = db) {
    const row = await connection
      .selectFrom('minecraft_modpack_receipts')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    return row
      ? {
          operationId: row.operation_id,
          receipt: modpackReceiptSchema.parse(row.receipt),
          installedAt: row.installed_at,
        }
      : null;
  }
  async function lock(connection: Kysely<Database>, serverId: string) {
    await sql`select pg_advisory_xact_lock(hashtextextended(current_schema() || ${`:nickhosting:modpack:${serverId}`},0))`.execute(
      connection,
    );
  }
  async function snapshotValue(serverId: string): Promise<MinecraftModpacksSnapshot> {
    const [installed, row] = await Promise.all([
      receipt(serverId),
      db
        .selectFrom('minecraft_modpack_operations')
        .selectAll()
        .where('server_id', '=', serverId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .executeTakeFirst(),
    ]);
    const prepared = row?.prepared ? preparedModpackSchema.parse(row.prepared) : null;
    const plan = row?.plan ? modpackPlanSchema.parse(row.plan) : null;
    return {
      installed: installed
        ? {
            pack: installed.receipt.pack,
            target: installed.receipt.target,
            installedAt: installed.installedAt.toISOString(),
            operationId: installed.operationId,
          }
        : null,
      operation: row
        ? {
            id: row.id,
            canCancel:
              canAbandonPreparedRuntime(row) ||
              canCancelUnstartedRuntime(row) ||
              (row.runtime_preparation === null &&
                cancellable.includes(row.state as (typeof cancellable)[number])),
            ...(canAbandonPreparedRuntime(row)
              ? { cancellationEffect: 'runtime-retained' as const }
              : {}),
            selection: minecraftModpackPrepareSchema.parse(row.selection),
            state: row.state,
            phase: minecraftModpackPhaseSchema.parse(row.phase),
            progress: row.progress ? minecraftModpackProgressSchema.parse(row.progress) : null,
            pack: prepared?.pack ?? null,
            target: prepared?.target ?? null,
            runtimeSupported: Boolean(
              plan?.runtime &&
                !plan.blockers.some(
                  (item) => item.reason === 'runtime' || item.reason === 'loader-version',
                ),
            ),
            planDigest: row.plan_digest,
            changes: plan
              ? {
                  write: plan.write.length,
                  remove: plan.remove.length,
                  preserve: plan.preserve.length,
                  bytes: plan.write.reduce((sum, file) => sum + file.size, 0),
                }
              : null,
            deletePaths: plan?.remove ?? [],
            blockers: z.array(minecraftModpackBlockerSchema).parse(row.blockers),
            error: row.error,
            backupId: row.backup_id,
            restartRequired: row.restart_required,
            createdAt: row.created_at.toISOString(),
            updatedAt: row.updated_at.toISOString(),
          }
        : null,
    };
  }
  function wake() {
    hooks.wake?.();
  }
  async function cleanup(row: MinecraftModpackOperationRow) {
    if (!hooks.cleanup || !terminal.includes(row.state)) return;
    try {
      await hooks.cleanup(row);
      await db
        .updateTable('minecraft_modpack_operations')
        .set({ held_bytes: '0', staging_root: null })
        .where('id', '=', row.id)
        .where('state', 'in', ['applied', 'failed', 'cancelled', 'blocked'])
        .execute();
    } catch {
      // Private staging remains accounted until the host proves cleanup completed.
    }
  }
  async function finish(
    row: MinecraftModpackOperationRow,
    prepared: PreparedMinecraftModpack,
    plan: MinecraftModpackPlan,
    verified: MinecraftModpackFile[],
    token?: string,
    restartRequired = true,
  ) {
    const files = verifiedFiles(plan, verified);
    await db.transaction().execute(async (tx) => {
      await lock(tx, row.server_id);
      const current = await get(row.id, tx);
      const server = await tx
        .selectFrom('managed_servers')
        .select('owner_id')
        .where('id', '=', row.server_id)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!server || server.owner_id !== row.resource_owner_id)
        throw new DomainError('provenance_mismatch');
      if (
        token
          ? current.lease_token !== token || current.state !== 'applying'
          : current.state !== 'uncertain'
      )
        throw new DomainError('conflict');
      const existing = await receipt(row.server_id, tx);
      if ((existing?.operationId ?? null) !== plan.previousOperationId)
        throw new DomainError('conflict');
      const value = JSON.stringify({
        pack: prepared.pack,
        target: prepared.target,
        files: [...plan.retained, ...files],
      } satisfies MinecraftModpackReceipt);
      await tx
        .insertInto('minecraft_modpack_receipts')
        .values({ server_id: row.server_id, operation_id: row.id, receipt: value })
        .onConflict((conflict) =>
          conflict
            .column('server_id')
            .doUpdateSet({ operation_id: row.id, receipt: value, installed_at: new Date() }),
        )
        .execute();
      await tx
        .updateTable('minecraft_modpack_operations')
        .set({
          state: 'applied',
          restart_required: restartRequired,
          phase: 'complete',
          error: null,
          lease_token: null,
          lease_until: null,
          updated_at: new Date(),
        })
        .where('id', '=', row.id)
        .execute();
    });
  }

  return {
    async snapshot(context: AuthContext, serverId: string) {
      await authorized(context, serverId);
      return snapshotValue(serverId);
    },
    async prepare(context: AuthContext, serverId: string, input: unknown) {
      const selection = parse(minecraftModpackPrepareSchema, input);
      await db.transaction().execute(async (tx) => {
        if (selection.install) await lockResources(tx);
        await lock(tx, serverId);
        const { current, server } = await authorized(context, serverId, true, tx);
        if (selection.worldPolicy === 'reset')
          await authorizeServer(tx, current, serverId, 'game.minecraft.worlds.delete');
        if (selection.install?.backupBefore)
          await authorizeServer(tx, current, serverId, 'backups.create');
        if (selection.install && server.active_operation_id)
          throw new DomainError('operation_busy');
        const prior = await tx
          .selectFrom('minecraft_modpack_operations')
          .selectAll()
          .where('server_id', '=', serverId)
          .where('actor_user_id', '=', current.actorUserId)
          .where('idempotency_key', '=', selection.idempotencyKey)
          .executeTakeFirst();
        if (prior) {
          if (
            modpackDigest(minecraftModpackPrepareSchema.parse(prior.selection)) !==
            modpackDigest(selection)
          )
            throw new DomainError('conflict');
          return;
        }
        if (selection.install && server.active_operation_id)
          throw new DomainError('operation_busy');
        if (
          await tx
            .selectFrom('minecraft_modpack_operations')
            .select('id')
            .where('server_id', '=', serverId)
            .where('state', 'in', active)
            .executeTakeFirst()
        )
          throw new DomainError('operation_busy');
        await tx
          .insertInto('minecraft_modpack_operations')
          .values({
            id: randomUUID(),
            server_id: serverId,
            actor_user_id: current.actorUserId,
            actor_session_id: current[authSessionId] as string,
            subject_user_id: current.subjectUserId,
            support_session_id: current.support?.id ?? null,
            resource_owner_id: server.owner_id,
            physical_host_id: null,
            held_bytes: '0',
            staging_root: null,
            idempotency_key: selection.idempotencyKey,
            selection: JSON.stringify(selection),
            state: 'queued',
            phase: 'queued',
            progress: 'null',
            prepared: 'null',
            plan: 'null',
            plan_digest: null,
            blockers: '[]',
            apply_request: 'null',
            apply_actor_user_id: null,
            apply_actor_session_id: null,
            apply_subject_user_id: null,
            apply_support_session_id: null,
            apply_idempotency_key: null,
            journal: '[]',
            backup_id: null,
            restart_required: false,
            error: null,
            lease_token: null,
            lease_until: null,
          })
          .execute();
        await recordAudit(tx, current, 'minecraft.modpacks.preparation-requested', {
          serverId,
          provider: selection.provider,
          projectId: selection.projectId,
          versionId: selection.versionId,
          mode: selection.mode,
          ...(selection.install
            ? { install: true, backupBefore: selection.install.backupBefore }
            : {}),
        });
        await notifyJobOutbox(tx);
      });
      wake();
      return snapshotValue(serverId);
    },
    async cancel(context: AuthContext, serverId: string, operationId: string) {
      parse(z.uuid(), operationId);
      await db.transaction().execute(async (tx) => {
        await lock(tx, serverId);
        const { current } = await authorized(context, serverId, true, tx);
        const row = await get(operationId, tx);
        if (row.server_id !== serverId) throw new DomainError('not_found');
        if (row.state === 'cancelled') return;
        const abandon = canAbandonPreparedRuntime(row) || canCancelUnstartedRuntime(row);
        if (
          !abandon &&
          (row.runtime_preparation !== null ||
            !cancellable.includes(row.state as (typeof cancellable)[number]))
        )
          throw new DomainError('operation_busy');
        const cancelled = await tx
          .updateTable('minecraft_modpack_operations')
          .set({ state: 'cancelled', updated_at: new Date() })
          .where('id', '=', operationId)
          .where((eb) =>
            abandon
              ? eb.and([
                  eb('state', '=', 'uncertain'),
                  eb('lease_token', 'is', null),
                  sql<boolean>`(publication is null or publication = 'null'::jsonb)`,
                ])
              : eb.and([
                  eb('runtime_preparation', 'is', null),
                  eb('state', 'in', [...cancellable]),
                ]),
          )
          .returning('id')
          .executeTakeFirst();
        if (!cancelled) throw new DomainError('operation_busy');
        await recordAudit(tx, current, 'minecraft.modpacks.cancelled', { serverId, operationId });
      });
      // A preparing worker owns its stage until it observes cancellation and stops writing.
      const cancelled = await get(operationId);
      if (cancelled.runtime_preparation !== null && cancelled.lease_token === null)
        await cleanup(cancelled);
      wake();
      return snapshotValue(serverId);
    },
    async apply(context: AuthContext, serverId: string, input: unknown) {
      const request = parse(minecraftModpackApplySchema, input);
      await db.transaction().execute(async (tx) => {
        // Generic enqueue checks the publication fence under this same lock.
        // Serialize both admissions before either creates its durable owner.
        await lockResources(tx);
        await lock(tx, serverId);
        const { current, server } = await authorized(context, serverId, true, tx);
        if (request.backupBefore) await authorizeServer(tx, current, serverId, 'backups.create');
        const row = await get(request.operationId, tx);
        if (row.server_id !== serverId) throw new DomainError('not_found');
        if (minecraftModpackPrepareSchema.parse(row.selection).worldPolicy === 'reset')
          await authorizeServer(tx, current, serverId, 'game.minecraft.worlds.delete');
        if (row.apply_idempotency_key) {
          if (
            row.apply_actor_user_id !== current.actorUserId ||
            modpackDigest(row.apply_request) !== modpackDigest(request)
          )
            throw new DomainError('conflict');
          return;
        }
        if (server.active_operation_id) throw new DomainError('operation_busy');
        if (row.state !== 'ready' || row.plan_digest !== request.planDigest)
          throw new DomainError('conflict');
        const plan = modpackPlanSchema.parse(row.plan);
        if (plan.blockers.length || !plan.runtime) throw new DomainError('integration_unavailable');
        if (
          modpackDigest([...new Set(request.expectedDeletePaths)].sort()) !==
          modpackDigest([...plan.remove].sort())
        )
          throw new DomainError('conflict');
        await tx
          .updateTable('minecraft_modpack_operations')
          .set({
            state: 'apply_queued',
            apply_request: JSON.stringify(request),
            apply_actor_user_id: current.actorUserId,
            apply_actor_session_id: current[authSessionId] as string,
            apply_subject_user_id: current.subjectUserId,
            apply_support_session_id: current.support?.id ?? null,
            apply_idempotency_key: request.idempotencyKey,
            updated_at: new Date(),
          })
          .where('id', '=', row.id)
          .execute();
        await recordAudit(tx, current, 'minecraft.modpacks.apply-requested', {
          serverId,
          operationId: row.id,
        });
        await notifyJobOutbox(tx);
      });
      wake();
      return snapshotValue(serverId);
    },
    /** Worker wake/listener and fallback sweeper both use this durable bounded queue. */
    async pending(limit = 20) {
      const rows = await db
        .selectFrom('minecraft_modpack_operations')
        .select('id')
        .where((eb) =>
          eb.or([
            eb('state', 'in', ['queued', 'apply_queued']),
            eb.and([
              eb('state', 'in', ['preparing', 'applying']),
              eb('lease_until', '<', new Date()),
            ]),
            eb.and([
              eb('state', 'in', ['applied', 'failed', 'blocked', 'cancelled']),
              eb('held_bytes', '>', '0'),
              eb.or([eb('lease_until', 'is', null), eb('lease_until', '<', new Date())]),
            ]),
          ]),
        )
        .orderBy(
          sql<number>`case when state in ('queued','preparing','apply_queued','applying') then 0 else 1 end`,
        )
        .orderBy('updated_at')
        .limit(Math.min(Math.max(limit, 1), 100))
        .execute();
      return rows.map((row) => row.id);
    },
    async process(operationId: string): Promise<'continue' | undefined> {
      // A dedicated local lock prevents an expired lease from racing a still-running
      // downloader or private staging cleanup. No game lock is held during preparation.
      return db.connection().execute(async (workerConnection) => {
        const workerLock = await sql<{
          acquired: boolean;
        }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${`:nickhosting:modpack-worker:${operationId}`},0)) as acquired`.execute(
          workerConnection,
        );
        if (!workerLock.rows[0]?.acquired) return;
        try {
          const token = randomUUID();
          const claimed = await db.transaction().execute(async (tx) => {
            const row = await tx
              .selectFrom('minecraft_modpack_operations')
              .selectAll()
              .where('id', '=', operationId)
              .forUpdate()
              .executeTakeFirst();
            if (!row || (row.lease_until && row.lease_until > new Date())) return null;
            if (terminal.includes(row.state)) return row;
            if (
              row.state === 'applying' ||
              (row.state === 'preparing' && row.runtime_preparation !== null)
            ) {
              await tx
                .updateTable('minecraft_modpack_operations')
                .set({
                  state: 'uncertain',
                  error: 'operation_uncertain',
                  lease_token: null,
                  lease_until: null,
                  updated_at: new Date(),
                })
                .where('id', '=', row.id)
                .execute();
              return null;
            }
            if (!['queued', 'preparing', 'apply_queued'].includes(row.state)) return null;
            const state = row.state === 'apply_queued' ? 'applying' : 'preparing';
            await tx
              .updateTable('minecraft_modpack_operations')
              .set({
                state,
                lease_token: token,
                lease_until: new Date(Date.now() + leaseMs),
                updated_at: new Date(),
              })
              .where('id', '=', row.id)
              .execute();
            return { ...row, state, lease_token: token } as MinecraftModpackOperationRow;
          });
          if (!claimed) return;
          if (terminal.includes(claimed.state)) {
            await cleanup(claimed);
            await db
              .updateTable('minecraft_modpack_operations')
              .set({ lease_token: null, lease_until: null })
              .where('id', '=', operationId)
              .execute();
            return;
          }
          const timing = createOperationTiming(options.logger?.isEnabled('debug') ?? false);
          const queueAgeMs = Date.now() - claimed.updated_at.getTime();
          let continueQueuedApply = false;
          const controller = new AbortController();
          let heartbeatBusy = false;
          const heartbeat = setInterval(() => {
            if (heartbeatBusy) return;
            heartbeatBusy = true;
            void db
              .updateTable('minecraft_modpack_operations')
              .set({ lease_until: new Date(Date.now() + leaseMs) })
              .where('id', '=', operationId)
              .where('lease_token', '=', token)
              .where('state', 'in', ['preparing', 'applying'])
              .returning('id')
              .executeTakeFirst()
              .then(
                (row) => {
                  if (!row) controller.abort();
                },
                () => controller.abort(),
              )
              .finally(() => {
                heartbeatBusy = false;
              });
          }, 10_000);
          heartbeat.unref();
          const check = async () => {
            controller.signal.throwIfAborted();
            const row = await get(operationId);
            if (
              row.lease_token !== token ||
              !['preparing', 'applying'].includes(row.state) ||
              !row.lease_until ||
              row.lease_until <= new Date()
            )
              throw new DomainError('conflict');
            await timing.measure('authorize', () => hooks.authorize(row, row.state === 'applying'));
            return row;
          };
          const update = async (
            values: Partial<Updateable<Database['minecraft_modpack_operations']>>,
          ) => {
            const row = await db
              .updateTable('minecraft_modpack_operations')
              .set(values)
              .where('id', '=', operationId)
              .where('lease_token', '=', token)
              .where('state', 'in', ['preparing', 'applying'])
              .returning('id')
              .executeTakeFirst();
            if (!row) throw new DomainError('conflict');
          };
          let execution = claimed;
          let earlyScope: MinecraftModpackApplyScope | undefined;
          let preparedObservation: MinecraftModpackObservation | undefined;
          let earlyRuntime: Promise<void> | undefined;
          let earlyRuntimeReady = false;
          let earlyLifecyclePhase: MinecraftModpackPhase = 'runtime';
          let earlyLock: Promise<void> | undefined;
          let releaseEarlyLock: (() => void) | undefined;
          const earlyReleased = new Promise<void>((resolve) => {
            releaseEarlyLock = resolve;
          });
          const awaitRuntime = async () => {
            if (!earlyRuntime) return;
            if (!earlyRuntimeReady)
              await update({
                phase: earlyLifecyclePhase,
                progress: 'null',
                updated_at: new Date(),
              });
            await earlyRuntime;
          };
          async function effect<T>(
            phase: MinecraftModpackPhase,
            work: () => Promise<T>,
            alreadyDispatched = false,
          ) {
            if (earlyScope && !earlyRuntimeReady) earlyLifecyclePhase = phase;
            const current = await check();
            const journal = journalSchema.parse(current.journal);
            if (!alreadyDispatched)
              journal.push({ phase, state: 'dispatched', at: new Date().toISOString() });
            await update({ phase, journal: JSON.stringify(journal), updated_at: new Date() });
            const result = await work();
            await check();
            journal.push({ phase, state: 'confirmed', at: new Date().toISOString() });
            await update({ journal: JSON.stringify(journal), updated_at: new Date() });
            return result;
          }
          try {
            await check();
            if (claimed.state === 'preparing') {
              // A crashed preparation may have left a private stage. The operation
              // advisory lock proves its old writer has exited before reclamation.
              if (claimed.staging_root) {
                if (!hooks.cleanup) throw new DomainError('content_storage_unavailable');
                await hooks.cleanup(claimed);
                await update({ held_bytes: '0', staging_root: null });
              }
              const selection = minecraftModpackPrepareSchema.parse(claimed.selection);
              let progressAt = 0;
              let progressPhase: MinecraftModpackPhase | undefined;
              const prepared = preparedModpackSchema.parse(
                await hooks.prepare({
                  operation: await get(operationId),
                  attemptId: token,
                  selection,
                  signal: controller.signal,
                  beforeInventory: async () => {
                    // Pterodactyl rejects Client API file access while its installer is active.
                    // Download and local extraction still overlap the runtime branch.
                    await awaitRuntime();
                  },
                  ...(selection.install
                    ? {
                        runtimeReady: async (binding: MinecraftModpackRuntimeBinding) => {
                          if (earlyRuntime) throw new DomainError('conflict');
                          const current = await check();
                          const checkpoint =
                            current.runtime_preparation === null
                              ? null
                              : runtimePreparationSchema.parse(current.runtime_preparation);
                          if (
                            checkpoint &&
                            modpackDigest(checkpoint.binding) !== modpackDigest(binding)
                          )
                            throw new DomainError('provenance_mismatch');
                          const source =
                            checkpoint ??
                            (await db
                              .selectFrom('managed_servers as server')
                              .innerJoin(
                                'minecraft_server_profiles as profile',
                                'profile.server_id',
                                'server.id',
                              )
                              .select([
                                'server.mapping_id as sourceMappingId',
                                'profile.combination_id as sourceCombinationId',
                              ])
                              .where('server.id', '=', claimed.server_id)
                              .executeTakeFirstOrThrow());
                          const preparation = {
                            binding,
                            sourceMappingId: source.sourceMappingId,
                            sourceCombinationId: source.sourceCombinationId,
                          };
                          await update({
                            runtime_preparation: JSON.stringify({
                              ...preparation,
                              state: 'preparing',
                            }),
                          });
                          let ready!: () => void;
                          let failed!: (error: unknown) => void;
                          const available = new Promise<void>((resolve, reject) => {
                            ready = resolve;
                            failed = reject;
                          });
                          earlyLock = hooks.withServerLock(
                            await get(operationId),
                            async (scope) => {
                              earlyScope = scope;
                              earlyRuntime = (async () => {
                                const journal = journalSchema.parse(
                                  (await get(operationId)).journal,
                                );
                                const confirmed = (phase: MinecraftModpackPhase) =>
                                  journal.some(
                                    (entry) => entry.phase === phase && entry.state === 'confirmed',
                                  );
                                if (!confirmed('stopping'))
                                  await effect('stopping', () => scope.stop());
                                if (
                                  selection.install?.backupBefore &&
                                  confirmed('backup') &&
                                  !(await get(operationId)).backup_id
                                )
                                  throw new DomainError('operation_uncertain');
                                if (selection.install?.backupBefore && !confirmed('backup')) {
                                  const backupId = await effect('backup', () => scope.backup());
                                  if (!backupId) throw new DomainError('operation_uncertain');
                                  await update({ backup_id: backupId });
                                }
                                if (confirmed('runtime') && checkpoint) {
                                  if (!scope.assertPreparedRuntime)
                                    throw new DomainError('operation_uncertain');
                                  await scope.assertPreparedRuntime(binding, preparation);
                                }
                                if (!confirmed('runtime'))
                                  await effect(
                                    'runtime',
                                    () => scope.configureRuntime(binding),
                                    journal.some(
                                      (entry) =>
                                        entry.phase === 'runtime' && entry.state === 'dispatched',
                                    ),
                                  );
                                await update({
                                  runtime_preparation: JSON.stringify({
                                    ...preparation,
                                    state: 'ready',
                                  }),
                                });
                                earlyRuntimeReady = true;
                              })();
                              // Attach immediately: a failing runtime may finish before downloads do.
                              void earlyRuntime.catch(() => {
                                controller.abort();
                              });
                              ready();
                              await earlyReleased;
                              await earlyRuntime;
                            },
                          );
                          void earlyLock.catch(failed);
                          await available;
                        },
                      }
                    : {}),
                  async progress(phase, value) {
                    controller.signal.throwIfAborted();
                    const complete = value !== null && value.completedFiles === value.totalFiles;
                    if (phase === progressPhase && !complete && Date.now() - progressAt < 500)
                      return;
                    await check();
                    await update({
                      phase,
                      progress: JSON.stringify(
                        value ? minecraftModpackProgressSchema.parse(value) : null,
                      ),
                      updated_at: new Date(),
                    });
                    progressAt = Date.now();
                    progressPhase = phase;
                  },
                  async reservation(value) {
                    await check();
                    if (!Number.isSafeInteger(value.bytes) || value.bytes < 0 || !value.stagingRoot)
                      throw new DomainError('validation_failed');
                    await update({
                      physical_host_id: z.uuid().parse(value.physicalHostId),
                      held_bytes: String(value.bytes),
                      staging_root: value.stagingRoot,
                      updated_at: new Date(),
                    });
                  },
                }),
              );
              if (
                prepared.pack.project.provider !== selection.provider ||
                prepared.pack.project.id !== selection.projectId ||
                prepared.pack.version.id !== selection.versionId ||
                prepared.pack.version.projectId !== selection.projectId
              )
                throw new DomainError('provenance_mismatch');
              await check();
              await awaitRuntime();
              const previous = await receipt(claimed.server_id);
              const [observation, runtime] = await Promise.all([
                timing.measure('inventory', () =>
                  hooks.inspect(claimed.server_id, prepared, previous?.receipt ?? null),
                ),
                timing.measure('resolveRuntime', async () =>
                  earlyScope
                    ? Promise.resolve(
                        runtimePreparationSchema.parse((await get(operationId)).runtime_preparation)
                          .binding,
                      )
                    : hooks.resolveRuntime(claimed.server_id, prepared),
                ),
              ]);
              if (earlyScope) preparedObservation = observation;
              const runtimeCheckpoint = earlyScope
                ? runtimePreparationSchema.parse((await get(operationId)).runtime_preparation)
                : null;
              const plan = timing.measureSync('plan', () =>
                planMinecraftModpack({
                  selection,
                  prepared,
                  observation: runtimeCheckpoint
                    ? {
                        ...observation,
                        combinationId: runtimeCheckpoint.sourceCombinationId,
                        mappingId: runtimeCheckpoint.sourceMappingId,
                      }
                    : observation,
                  previous,
                  runtime,
                }),
              );
              await check();
              if (earlyScope && plan.blockers.length) {
                await awaitRuntime();
                await update({
                  prepared: JSON.stringify(prepared),
                  plan: JSON.stringify(plan),
                  plan_digest: modpackDigest({ prepared, plan }),
                });
                throw new MinecraftModpackBlockedError(plan.blockers);
              }
              const planDigest = modpackDigest({ prepared, plan });
              const install = selection.install && !plan.blockers.length && plan.runtime;
              const applyRequest = install
                ? minecraftModpackApplySchema.parse({
                    operationId,
                    planDigest,
                    confirm: true,
                    backupBefore: selection.install?.backupBefore ?? false,
                    expectedDeletePaths: plan.remove,
                    idempotencyKey: selection.idempotencyKey,
                  })
                : null;
              // Persist the exact resolved plan and the original Install intent together.
              // The apply worker reauthorizes this actor before any server effect.
              await update({
                state: plan.blockers.length
                  ? 'blocked'
                  : install
                    ? earlyScope
                      ? 'applying'
                      : 'apply_queued'
                    : 'ready',
                ...(applyRequest
                  ? {
                      apply_request: JSON.stringify(applyRequest),
                      apply_actor_user_id: claimed.actor_user_id,
                      apply_actor_session_id: claimed.actor_session_id,
                      apply_subject_user_id: claimed.subject_user_id,
                      apply_support_session_id: claimed.support_session_id,
                      apply_idempotency_key: selection.idempotencyKey,
                    }
                  : {}),
                phase: 'ready',
                prepared: JSON.stringify(prepared),
                plan: JSON.stringify(plan),
                plan_digest: planDigest,
                blockers: JSON.stringify(plan.blockers),
                error: null,
                ...(earlyScope ? {} : { lease_token: null, lease_until: null }),
                updated_at: new Date(),
              });
              if (earlyScope) execution = await get(operationId);
              if (applyRequest && !earlyScope) {
                await notifyJobOutbox(db);
                wake();
              }
            }
            if (execution.state === 'applying') {
              const claimed = execution;
              const prepared = preparedModpackSchema.parse(claimed.prepared);
              const plan = modpackPlanSchema.parse(claimed.plan);
              const request = minecraftModpackApplySchema.parse(claimed.apply_request);
              if (
                !plan.runtime ||
                plan.blockers.length ||
                claimed.plan_digest !== modpackDigest({ prepared, plan }) ||
                request.planDigest !== claimed.plan_digest
              )
                throw new DomainError('conflict');
              await update({ phase: 'checking', updated_at: new Date() });
              const apply = async (scope: MinecraftModpackApplyScope) => {
                await check();
                const previous = await receipt(claimed.server_id);
                if ((previous?.operationId ?? null) !== plan.previousOperationId)
                  throw new DomainError('conflict');
                const earlyPrepared = claimed.runtime_preparation !== null;
                const resuming = !earlyScope && journalSchema.parse(claimed.journal).length > 0;
                const resumingPublication = hasResumableModpackPublicationJournal(claimed);
                if (resuming) {
                  if (resumingPublication) {
                    if (!scope.assertPublicationResumable || !scope.resumePublication)
                      throw new DomainError('operation_uncertain');
                    await scope.assertPublicationResumable(prepared, plan);
                  } else {
                    if (
                      !hasResumableModpackRuntimeJournal(claimed) ||
                      !scope.assertRuntimeResumable
                    )
                      throw new DomainError('operation_uncertain');
                    await scope.assertRuntimeResumable(plan);
                  }
                }
                await awaitRuntime();
                if (!resumingPublication) await scope.preflightPublication(prepared, plan);
                if (earlyScope && scope.stagePublication)
                  await scope.stagePublication(prepared, plan);
                if (!earlyPrepared && !resuming) await effect('stopping', () => scope.stop());
                if (!earlyPrepared && !resuming && request.backupBefore) {
                  const backupId = await effect('backup', () => scope.backup());
                  if (!backupId) throw new DomainError('operation_uncertain');
                  await update({ backup_id: backupId });
                }
                // The uninterrupted Install scope already inventoried after runtime installation.
                // Recovered and review-first operations need a fresh observation.
                const observation =
                  preparedObservation ?? (await scope.inspect(prepared, previous?.receipt ?? null));
                assertMinecraftModpackPlanCurrent(
                  plan,
                  resuming || earlyPrepared
                    ? {
                        ...observation,
                        // The exact transition proof above authorizes only these registry
                        // coordinates to move. Every reviewed file/world guard stays intact.
                        combinationId: plan.sourceCombinationId,
                        mappingId: plan.sourceMappingId,
                      }
                    : observation,
                );
                if (
                  !earlyPrepared &&
                  !resumingPublication &&
                  plan.runtime &&
                  (plan.runtime.combinationId !== plan.sourceCombinationId ||
                    plan.runtime.mappingId !== plan.sourceMappingId)
                ) {
                  await effect(
                    'runtime',
                    () => scope.configureRuntime(plan.runtime as MinecraftModpackRuntimeBinding),
                    resuming,
                  );
                }
                await effect(
                  'publishing',
                  () =>
                    resumingPublication && scope.resumePublication
                      ? scope.resumePublication(prepared, plan)
                      : scope.publish(prepared, plan),
                  resumingPublication,
                );
                await update({ phase: 'verifying', updated_at: new Date() });
                await check();
                const files = await scope.verify(prepared, plan);
                if (!files) throw new DomainError('operation_uncertain');
                verifiedFiles(plan, files);
                await finish(claimed, prepared, plan, files, token, true);
              };
              if (earlyScope) await apply(earlyScope);
              else await hooks.withServerLock(claimed, apply);
              releaseEarlyLock?.();
              if (earlyLock) await earlyLock;
              // Normal start admission acquires the same server lock. Files are
              // already durable and verified before relinquishing publication.
              clearInterval(heartbeat);
              if (hooks.restoreRunningState) {
                const applied = await get(operationId);
                const journal = journalSchema.parse(applied.journal);
                try {
                  await hooks.authorize(applied, true);
                  journal.push({
                    phase: 'restoring',
                    state: 'dispatched',
                    at: new Date().toISOString(),
                  });
                  await db
                    .updateTable('minecraft_modpack_operations')
                    .set({
                      phase: 'restoring',
                      journal: JSON.stringify(journal),
                      updated_at: new Date(),
                    })
                    .where('id', '=', operationId)
                    .where('state', '=', 'applied')
                    .execute();
                  const restored = await hooks.restoreRunningState(applied);
                  journal.push({
                    phase: 'restoring',
                    state: 'confirmed',
                    at: new Date().toISOString(),
                  });
                  await db
                    .updateTable('minecraft_modpack_operations')
                    .set({
                      phase: 'complete',
                      restart_required: !restored,
                      journal: JSON.stringify(journal),
                      updated_at: new Date(),
                    })
                    .where('id', '=', operationId)
                    .where('state', '=', 'applied')
                    .execute();
                } catch (error) {
                  await db
                    .updateTable('minecraft_modpack_operations')
                    .set({
                      phase: 'complete',
                      restart_required: true,
                      error: errorCode(error),
                      updated_at: new Date(),
                    })
                    .where('id', '=', operationId)
                    .where('state', '=', 'applied')
                    .execute();
                }
              }
            }
          } catch (error) {
            releaseEarlyLock?.();
            if (earlyLock) await earlyLock.catch(() => {});
            const row = await get(operationId);
            if (row.lease_token === token && ['preparing', 'applying'].includes(row.state)) {
              const journal = journalSchema.parse(row.journal);
              const uncertain =
                (row.runtime_preparation !== null || row.state === 'applying') &&
                (row.runtime_preparation !== null ||
                  journal.some((entry) =>
                    ['runtime', 'publishing', 'restoring'].includes(entry.phase),
                  ) ||
                  journal.at(-1)?.state === 'dispatched');
              const blocked =
                row.state === 'preparing' && error instanceof MinecraftModpackBlockedError;
              await update({
                state: uncertain ? 'uncertain' : blocked ? 'blocked' : 'failed',
                error: uncertain ? 'operation_uncertain' : errorCode(error),
                ...(blocked ? { blockers: JSON.stringify(error.blockers) } : {}),
                lease_token: null,
                lease_until: null,
                updated_at: new Date(),
              });
            }
          } finally {
            releaseEarlyLock?.();
            if (earlyLock) await earlyLock.catch(() => {});
            clearInterval(heartbeat);
            const row = await get(operationId);
            continueQueuedApply = row.state === 'apply_queued';
            if (row.state === 'cancelled' && row.lease_token === token)
              await db
                .updateTable('minecraft_modpack_operations')
                .set({ lease_token: null, lease_until: null })
                .where('id', '=', operationId)
                .where('lease_token', '=', token)
                .execute();
            await timing.measure('cleanup', async () => cleanup(await get(operationId)));
            if (options.logger?.isEnabled('debug')) {
              try {
                options.logger.log('debug', 'servers.modpack_worker_timing', {
                  operationId,
                  serverId: claimed.server_id,
                  attemptId: token,
                  mode: claimed.state,
                  queueAgeMs,
                  ...timing.report(),
                });
              } catch {
                /* Diagnostics must not change the operation outcome. */
              }
            }
          }
          if (continueQueuedApply) return 'continue' as const;
        } finally {
          await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${`:nickhosting:modpack-worker:${operationId}`},0))`.execute(
            workerConnection,
          );
        }
      });
    },
    async recover(context: AuthContext, serverId: string, operationId: string) {
      parse(z.uuid(), operationId);
      const { current } = await authorized(context, serverId, true);
      return db.connection().execute(async (connection) => {
        const locked = await sql<{
          acquired: boolean;
        }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${`:nickhosting:modpack-worker:${operationId}`},0)) as acquired`.execute(
          connection,
        );
        if (!locked.rows[0]?.acquired) throw new DomainError('operation_busy');
        try {
          const row = await get(operationId);
          if (row.server_id !== serverId) throw new DomainError('not_found');
          if (minecraftModpackPrepareSchema.parse(row.selection).worldPolicy === 'reset')
            await authorizeServer(connection, current, serverId, 'game.minecraft.worlds.delete');
          if (row.state !== 'uncertain') throw new DomainError('conflict');
          if (row.runtime_preparation !== null && row.publication === null) {
            runtimePreparationSchema.parse(row.runtime_preparation);
            const entries = journalSchema.parse(row.journal);
            if (
              entries.some(
                (entry) =>
                  entry.state === 'dispatched' &&
                  entry.phase !== 'runtime' &&
                  !entries.some(
                    (other) => other.phase === entry.phase && other.state === 'confirmed',
                  ),
              )
            )
              throw new DomainError('operation_uncertain');
            // Resume the same pinned install intent; runtime dispatch markers remain intact.
            await db
              .updateTable('minecraft_modpack_operations')
              .set({
                state: 'queued',
                prepared: 'null',
                plan: 'null',
                plan_digest: null,
                apply_request: 'null',
                error: null,
                lease_token: null,
                lease_until: null,
                actor_user_id: current.actorUserId,
                actor_session_id: current[authSessionId] as string,
                subject_user_id: current.subjectUserId,
                support_session_id: current.support?.id ?? null,
                updated_at: new Date(),
              })
              .where('id', '=', row.id)
              .where('state', '=', 'uncertain')
              .execute();
            await notifyJobOutbox(db);
            wake();
            return snapshotValue(serverId);
          }
          const prepared = preparedModpackSchema.parse(row.prepared);
          const plan = modpackPlanSchema.parse(row.plan);
          if (row.plan_digest !== modpackDigest({ prepared, plan }))
            throw new DomainError('conflict');
          // Recovery observes existing effects under the current caller's authority.
          // Revoking the original actor must not prevent an Owner from reconciling.
          const recovered = await hooks.recover(row, prepared, plan, current);
          if (recovered.state === 'resume-runtime' || recovered.state === 'resume-publication') {
            const request = minecraftModpackApplySchema.parse(row.apply_request);
            if (request.operationId !== row.id || request.planDigest !== row.plan_digest)
              throw new DomainError('conflict');
            if (
              !plan.runtime ||
              plan.blockers.length ||
              !(recovered.state === 'resume-runtime'
                ? hasResumableModpackRuntimeJournal(row)
                : hasResumableModpackPublicationJournal(row))
            )
              throw new DomainError('operation_uncertain');
            await db.transaction().execute(async (tx) => {
              await lockResources(tx);
              await lock(tx, serverId);
              const { current: actor, server } = await authorized(context, serverId, true, tx);
              if (
                server.owner_id !== row.resource_owner_id ||
                (server.active_operation_id && server.active_operation_id !== row.id)
              )
                throw new DomainError('conflict');
              const queued = await tx
                .updateTable('minecraft_modpack_operations')
                .set({
                  state: 'apply_queued',
                  error: null,
                  apply_actor_user_id: actor.actorUserId,
                  apply_actor_session_id: actor[authSessionId] as string,
                  apply_subject_user_id: actor.subjectUserId,
                  apply_support_session_id: actor.support?.id ?? null,
                  lease_token: null,
                  lease_until: null,
                  updated_at: new Date(),
                })
                .where('id', '=', row.id)
                .where('state', '=', 'uncertain')
                .returning('id')
                .executeTakeFirst();
              if (!queued) throw new DomainError('conflict');
              await notifyJobOutbox(tx);
            });
            wake();
          } else if (recovered.state === 'applied')
            await finish(
              row,
              prepared,
              plan,
              recovered.files,
              undefined,
              recovered.restartRequired ?? true,
            );
          else if (recovered.state === 'unchanged')
            await db
              .updateTable('minecraft_modpack_operations')
              .set({ state: 'failed', error: 'operation_uncertain', updated_at: new Date() })
              .where('id', '=', row.id)
              .where('state', '=', 'uncertain')
              .execute();
          await cleanup(await get(operationId));
          await recordAudit(db, current, 'minecraft.modpacks.recovered', {
            serverId,
            operationId,
            state: recovered.state,
          });
          return snapshotValue(serverId);
        } finally {
          await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${`:nickhosting:modpack-worker:${operationId}`},0))`.execute(
            connection,
          );
        }
      });
    },
  };
}
