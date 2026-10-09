import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type AuthContext,
  assertPermission,
  DomainError,
  type Permission,
} from '@nickhosting/core';
import { type Database, getSettings, recordAudit } from '@nickhosting/database';
import { evaluateGameAccess, gameManifestSchema } from '@nickhosting/game-sdk';
import {
  minecraftRuntimeMappingSchema,
  type ResolvedMinecraftRuntime,
  validateMinecraftRuntimeMapping,
} from '@nickhosting/minecraft';
import {
  type ProvisionPlan,
  type PterodactylAdapter,
  supportsStopConfirmation,
} from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import {
  checkStorage,
  type DB,
  type Environment,
  lockResources,
  reserveStartInTransaction,
} from './admission.js';

import {
  allocationAddressesOverlap,
  assertBackendPoolNamespace,
  canonicalAllocationAddress,
  poolAllowsLoopbackEgg,
  validatedBackendInventory,
} from './allocation-pool.js';
import { currentInteractiveContext } from './interactive-context.js';
import {
  type MinecraftPreparedContent,
  minecraftConfigurationSchema,
  minecraftStoredConfigurationSchema,
} from './minecraft-content-contracts.js';
import { requireMinecraftChoice } from './minecraft-registry.js';
import { bindMinecraftSource } from './minecraft-sources.js';
import { assertNoPendingUpload } from './upload-admission.js';

export const limitsSchema = z
  .object({
    memory: z.number().int().min(32).max(1048576),
    cpu: z.number().int().min(1).max(100000),
    disk: z.number().int().min(16).max(1073741824),
    swap: z.literal(0).default(0),
    io: z.number().int().min(10).max(1000).default(500),
  })
  .strict();
const keySchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const id = z.uuid();
const name = z.string().trim().min(1).max(100);
export const createServerSchema = z
  .object({
    idempotencyKey: keySchema,
    mappingId: id,
    name,
    projectId: id.optional(),
    limits: limitsSchema,
    autoStart: z.boolean().default(true),
    minecraft: z
      .object({ choiceId: z.uuid(), configuration: minecraftConfigurationSchema })
      .strict()
      .optional(),
  })
  .strict();
export const operationSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('minecraft-content'),
      idempotencyKey: keySchema,
      command: z.unknown(),
    })
    .strict(),
  z
    .object({ action: z.enum(['start', 'stop', 'restart', 'backup']), idempotencyKey: keySchema })
    .strict(),
  z
    .object({
      action: z.enum(['reinstall', 'wipe', 'delete']),
      idempotencyKey: keySchema,
      confirm: z.literal(true),
      backupBefore: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      action: z.literal('restore'),
      idempotencyKey: keySchema,
      confirm: z.literal(true),
      backupId: id,
      truncate: z.boolean().default(true),
    })
    .strict(),
  z
    .object({ action: z.literal('configure'), idempotencyKey: keySchema, limits: limitsSchema })
    .strict(),
]);
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const value = schema.safeParse(input);
  if (!value.success) throw new DomainError('validation_failed');
  return value.data;
}
export function ownerOnly(context: AuthContext) {
  assertPermission(context, 'platform:manage');
  if (context.sessionType !== 'regular') throw new DomainError('forbidden');
}

export async function authorizeServer(
  db: DB,
  context: AuthContext,
  serverId: string,
  permission: Permission = 'server:read',
) {
  parse(id, serverId);
  const row = await db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!row) throw new DomainError('not_found');
  const member = row.project_id
    ? await db
        .selectFrom('project_members')
        .select('role')
        .where('project_id', '=', row.project_id)
        .where('user_id', '=', context.subjectUserId)
        .executeTakeFirst()
    : undefined;
  assertPermission(context, permission, { ownerUserId: row.owner_id, memberRole: member?.role });
  return row;
}

export async function listServers(db: DB, context: AuthContext) {
  assertPermission(context, 'server:read', { ownerUserId: context.subjectUserId });
  let query = db.selectFrom('managed_servers').selectAll().where('deleted_at', 'is', null);
  if (context.role !== 'owner' || context.sessionType !== 'regular') {
    query = query.where((expression) =>
      expression.or([
        expression('owner_id', '=', context.subjectUserId),
        expression.exists(
          expression
            .selectFrom('project_members')
            .select('project_id')
            .whereRef('project_members.project_id', '=', 'managed_servers.project_id')
            .where('project_members.user_id', '=', context.subjectUserId),
        ),
      ]),
    );
  }
  return (await query.orderBy('created_at', 'desc').limit(1000).execute()).map(publicServer);
}
export function publicServer(row: Awaited<ReturnType<typeof authorizeServer>>) {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    projectId: row.project_id,
    mappingId: row.mapping_id,
    limits: row.limits,
    runtimeState: row.runtime_state,
    readiness: row.readiness,
    intent: row.intent,
    installationState: row.installation_state,
    activeOperationId: row.active_operation_id,
    lastObservedAt: row.last_observed_at,
    createdAt: row.created_at,
  };
}

async function requestLock(tx: Transaction<Database>, context: AuthContext, key: string) {
  await sql`select pg_advisory_xact_lock(hashtextextended(current_schema() || ':request:' || ${context.actorUserId} || ':' || ${key},0))`.execute(
    tx,
  );
}
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
async function previousRequest(
  tx: Transaction<Database>,
  context: AuthContext,
  key: string,
  hash: string,
) {
  const old = await tx
    .selectFrom('operation_jobs')
    .selectAll()
    .where('actor_id', '=', context.actorUserId)
    .where('idempotency_key', '=', key)
    .executeTakeFirst();
  if (!old) return;
  if (old.command_hash !== hash || old.subject_id !== context.subjectUserId)
    throw new DomainError('conflict');
  const operation = await tx
    .selectFrom('server_operations')
    .selectAll()
    .where('job_id', '=', old.id)
    .executeTakeFirstOrThrow();
  return { serverId: operation.server_id, jobId: old.id };
}
async function insertOperation(
  tx: Transaction<Database>,
  context: AuthContext,
  server: { id: string; owner_id: string },
  jobId: string,
  key: string,
  hash: string,
  action: Database['server_operations']['action'],
  plan: Record<string, unknown>,
) {
  await tx
    .insertInto('operation_jobs')
    .values({
      id: jobId,
      actor_id: context.actorUserId,
      subject_id: context.subjectUserId,
      resource_owner_id: server.owner_id,
      support_session_id: context.support?.id ?? null,
      idempotency_key: key,
      command_hash: hash,
      command: JSON.stringify({
        type: 'server.operation',
        version: 1,
        payload: { serverId: server.id, operationId: jobId },
      }),
      policy_snapshot: JSON.stringify({
        role: context.role,
        sessionType: context.sessionType,
        ownerElevation: context.ownerElevation,
      }),
      max_attempts: 5,
      error_code: null,
      completed_at: null,
    })
    .execute();
  await tx
    .insertInto('server_operations')
    .values({
      job_id: jobId,
      server_id: server.id,
      action,
      plan: JSON.stringify(plan),
      effect_started_at: null,
      lease_until: null,
      lease_token: null,
    })
    .execute();
  await tx.insertInto('job_outbox').values({ job_id: jobId, last_dispatched_at: null }).execute();
  await tx
    .updateTable('managed_servers')
    .set({ active_operation_id: jobId, updated_at: new Date() })
    .where('id', '=', server.id)
    .execute();
  await tx
    .insertInto('server_events')
    .values({
      server_id: server.id,
      job_id: jobId,
      actor_id: context.actorUserId,
      subject_id: context.subjectUserId,
      support_session_id: context.support?.id ?? null,
      message_key: 'activity.server.queued',
      data: JSON.stringify({ action }),
    })
    .execute();
  await recordAudit(tx, context, 'server.operation.queued', { serverId: server.id, jobId, action });
  return { serverId: server.id, jobId };
}

export async function createManagedServer(
  db: Kysely<Database>,
  adapter: PterodactylAdapter,
  context: AuthContext,
  input: unknown,
  env: Environment = {},
  options: { minecraftInitialContent?: MinecraftPreparedContent } = {},
) {
  assertPermission(context, 'server:manage', { ownerUserId: context.subjectUserId });
  const value = parse(createServerSchema, input);
  const hash = digest({ kind: 'create', subject: context.subjectUserId, value });
  return db.transaction().execute(async (tx) => {
    await requestLock(tx, context, value.idempotencyKey);
    const previous = await previousRequest(tx, context, value.idempotencyKey, hash);
    if (previous) return previous;
    await lockResources(tx);
    const mapping = await tx
      .selectFrom('runtime_egg_mappings')
      .selectAll()
      .where('id', '=', value.mappingId)
      .executeTakeFirst();
    if (!mapping?.enabled) throw new DomainError('not_found');
    const minecraft =
      mapping.game_id === 'minecraft-java'
        ? await requireMinecraftChoice(
            tx,
            await currentInteractiveContext(tx, context, env),
            value.minecraft?.choiceId ?? '',
            env,
          )
        : undefined;
    if (
      (mapping.game_id === 'minecraft-java') !== (value.minecraft !== undefined) ||
      (minecraft && minecraft.row.mapping_id !== mapping.id)
    )
      throw new DomainError('validation_failed');
    if (value.minecraft?.configuration.modpack) {
      const initial = options.minecraftInitialContent;
      const selected = value.minecraft.configuration.modpack;
      const expected =
        'sourceId' in selected
          ? { kind: 'modpack-upload', archiveRef: selected.sourceId }
          : { kind: 'modpack', ...selected };
      if (
        !initial ||
        initial.combinationId !== value.minecraft.choiceId ||
        !isDeepStrictEqual(initial.command, expected) ||
        !initial.archiveRef
      )
        throw new DomainError('validation_failed');
    } else if (options.minecraftInitialContent) throw new DomainError('validation_failed');
    const node = await tx
      .selectFrom('managed_nodes')
      .selectAll()
      .where('id', '=', mapping.node_id)
      .executeTakeFirstOrThrow();
    if (!node.enabled) throw new DomainError('resources_unavailable');
    const rollout = await tx
      .selectFrom('game_rollouts')
      .selectAll()
      .where('integration_id', '=', mapping.game_id)
      .executeTakeFirstOrThrow();
    if (
      !evaluateGameAccess(
        { gameId: mapping.game_id, state: rollout.state, allowedUserIds: rollout.allowlist },
        { userId: context.subjectUserId, role: context.role },
      ).canCreate
    )
      throw new DomainError('forbidden');
    if (value.projectId) {
      const project = await tx
        .selectFrom('projects')
        .selectAll()
        .where('id', '=', value.projectId)
        .executeTakeFirst();
      if (!project || project.owner_id !== context.subjectUserId)
        throw new DomainError('forbidden');
    }
    const { values: config } = await getSettings(tx, env);
    const count = await tx
      .selectFrom('managed_servers')
      .select(tx.fn.countAll<string>().as('n'))
      .where('owner_id', '=', context.subjectUserId)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    if (config.maxServersPerUser !== null && Number(count.n) >= config.maxServersPerUser)
      throw new DomainError('resources_unavailable');
    const pending = await tx
      .selectFrom('managed_servers as server')
      .select(tx.fn.countAll<string>().as('n'))
      .where('server.owner_id', '=', context.subjectUserId)
      .where('server.deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb.exists(
            eb
              .selectFrom('server_operations as operation')
              .select('operation.job_id')
              .whereRef('operation.job_id', '=', 'server.active_operation_id')
              .where('operation.action', '=', 'provision'),
          ),
          eb.exists(
            eb
              .selectFrom('installation_reservations as installation')
              .innerJoin(
                'server_operations as operation',
                'operation.job_id',
                'installation.operation_id',
              )
              .select('installation.server_id')
              .whereRef('installation.server_id', '=', 'server.id')
              .where('operation.action', '=', 'provision'),
          ),
        ]),
      )
      .executeTakeFirstOrThrow();
    if (Number(pending.n) >= config.maxConcurrentProvisionsPerUser)
      throw new DomainError('resources_unavailable');
    await checkStorage(
      tx,
      context.subjectUserId,
      node.physical_host_id,
      value.limits.disk * (1 + mapping.feature_limits.backups),
      env,
    );
    const { pool, allocations: inventory } = await validatedBackendInventory(adapter, node, env);
    await assertBackendPoolNamespace(tx, node, pool, env);
    const owned = await tx
      .selectFrom('server_allocations as allocation')
      .innerJoin('managed_nodes as ownerNode', 'ownerNode.id', 'allocation.node_id')
      .select([
        'allocation.pterodactyl_allocation_id',
        'allocation.node_id',
        'allocation.backend_address',
        'allocation.port',
      ])
      .where('ownerNode.physical_host_id', '=', node.physical_host_id)
      .execute();
    const free: typeof inventory = [];
    for (const allocation of inventory) {
      if (
        allocation.assigned ||
        (canonicalAllocationAddress(allocation.ip) === '127.0.0.1' &&
          !poolAllowsLoopbackEgg(pool, mapping))
      )
        continue;
      if (
        owned.some(
          (existing) =>
            (existing.node_id === node.id &&
              existing.pterodactyl_allocation_id === allocation.id) ||
            (existing.port === allocation.port &&
              allocationAddressesOverlap(existing.backend_address, allocation.backendAddress)),
        )
      )
        continue;
      if (
        free.some(
          (existing) =>
            existing.id === allocation.id ||
            (existing.port === allocation.port &&
              allocationAddressesOverlap(existing.backendAddress, allocation.backendAddress)),
        )
      )
        continue;
      free.push(allocation);
    }
    const roles = mapping.port_roles;
    if (!roles.length || free.length < roles.length || roles.filter((r) => r.primary).length !== 1)
      throw new DomainError('allocation_unavailable');
    const serverId = randomUUID(),
      jobId = randomUUID(),
      externalId = `nh-${serverId}`;
    await tx
      .insertInto('managed_servers')
      .values({
        id: serverId,
        owner_id: context.subjectUserId,
        project_id: value.projectId ?? null,
        mapping_id: mapping.id,
        node_id: node.id,
        name: value.name,
        external_id: externalId,
        pterodactyl_id: null,
        pterodactyl_uuid: null,
        pterodactyl_identifier: null,
        limits: JSON.stringify(value.limits),
        active_operation_id: jobId,
        last_observed_at: null,
        deleted_at: null,
      })
      .execute();
    const allocationRows = roles.map((role, index) => {
      const allocation = free[index];
      if (!allocation) throw new DomainError('allocation_unavailable');
      return {
        id: randomUUID(),
        server_id: serverId,
        node_id: node.id,
        pterodactyl_allocation_id: allocation.id,
        address: canonicalAllocationAddress(allocation.ip),
        backend_address: allocation.backendAddress,
        port: allocation.port,
        role: role.role,
        protocols: role.protocols,
        is_primary: role.primary,
      };
    });
    await tx.insertInto('server_allocations').values(allocationRows).execute();
    const primary = allocationRows.find((r) => r.is_primary);
    if (!primary) throw new DomainError('configuration_invalid');
    const environment = { ...mapping.environment };
    if (minecraft)
      Object.assign(
        environment,
        validateMinecraftRuntimeMapping(
          minecraft.row.resolved_runtime as ResolvedMinecraftRuntime,
          parse(minecraftRuntimeMappingSchema, minecraft.row.binding),
        ),
      );
    for (const role of roles) {
      const variable = (role as typeof role & { environmentVariable?: string }).environmentVariable;
      if (variable)
        environment[variable] = String(
          allocationRows.find((allocation) => allocation.role === role.role)?.port,
        );
    }
    const provision: ProvisionPlan = {
      name: value.name,
      externalId,
      userId: node.provision_user_id,
      eggId: mapping.egg_id,
      dockerImage: mapping.docker_image,
      startup: mapping.startup,
      environment,
      limits: value.limits,
      featureLimits: mapping.feature_limits,
      allocation: {
        default: primary.pterodactyl_allocation_id,
        additional: allocationRows
          .filter((r) => !r.is_primary)
          .map((r) => r.pterodactyl_allocation_id),
      },
    };
    if (minecraft && value.minecraft) {
      await tx
        .insertInto('minecraft_server_profiles')
        .values({
          server_id: serverId,
          combination_id: minecraft.row.id,
          configuration: JSON.stringify(value.minecraft.configuration),
        })
        .execute();
    }
    if (options.minecraftInitialContent?.archiveRef)
      await bindMinecraftSource(
        tx,
        context,
        options.minecraftInitialContent.archiveRef,
        serverId,
        env,
      );
    return insertOperation(
      tx,
      context,
      { id: serverId, owner_id: context.subjectUserId },
      jobId,
      value.idempotencyKey,
      hash,
      'provision',
      {
        provision,
        autoStart: value.autoStart,
        ...(options.minecraftInitialContent
          ? { minecraftInitialContent: options.minecraftInitialContent }
          : {}),
      },
    );
  });
}

export interface GatewayAutomationOperation {
  generation: string;
  kind: 'wake' | 'sleep';
  quiescenceUntil?: string;
}

/** Sleep permission is a short-lived Gateway ingress fence. A persisted handoff
 * only exempts ongoing confirmation, never a new external power effect. */
export function assertGatewaySleepFence(
  plan: Record<string, unknown>,
  now: Date,
  allowExistingHandoff = false,
): void {
  const marker = plan.gatewayAutomation;
  if (
    typeof marker !== 'object' ||
    marker === null ||
    !('kind' in marker) ||
    marker.kind !== 'sleep'
  )
    return;
  const deadline =
    'quiescenceUntil' in marker &&
    typeof marker.quiescenceUntil === 'string' &&
    z.iso.datetime().safeParse(marker.quiescenceUntil).success
      ? Date.parse(marker.quiescenceUntil)
      : NaN;
  const handoff =
    typeof plan.gatewaySleepHandoffAt === 'string' &&
    z.iso.datetime().safeParse(plan.gatewaySleepHandoffAt).success
      ? Date.parse(plan.gatewaySleepHandoffAt)
      : NaN;
  if (!Number.isFinite(deadline)) throw new DomainError('forbidden');
  if (allowExistingHandoff && Number.isFinite(handoff) && handoff > 0 && handoff < deadline) return;
  if (deadline <= now.getTime()) throw new DomainError('forbidden');
}

/** Caller holds the global resource lock shared with snapshot issuance. Disabled
 * routes retain their last issued lease until it expires; never shorten it. */
export async function revokeGatewayRoutesForDeletion(
  tx: Transaction<Database>,
  serverId: string,
  now: Date,
): Promise<boolean> {
  await tx
    .updateTable('gateway_routes')
    .set({
      enabled: false,
      revision: sql<string>`revision + 1`,
      payload_hash: null,
      updated_at: now,
    })
    .where('server_id', '=', serverId)
    .where('enabled', '=', true)
    .execute();
  const last = await tx
    .selectFrom('gateway_routes')
    .select('lease_expires_at')
    .where('server_id', '=', serverId)
    .where('lease_expires_at', 'is not', null)
    .orderBy('lease_expires_at', 'desc')
    .executeTakeFirst();
  return !last?.lease_expires_at || last.lease_expires_at.getTime() < now.getTime();
}

/** Internal composition boundary. Caller holds the global resource transaction lock;
 * ordinary requests additionally serialize their request key before taking it. */
export async function enqueueLockedServerOperation(
  tx: Transaction<Database>,
  context: AuthContext,
  serverId: string,
  input: unknown,
  env: Environment = {},
  automation?: GatewayAutomationOperation,
  options: {
    minecraftPlan?: MinecraftPreparedContent;
    minecraftInitialContent?: MinecraftPreparedContent;
  } = {},
) {
  const value = parse(operationSchema, input);
  const hash = digest({ kind: 'operation', subject: context.subjectUserId, serverId, value });
  const server = await authorizeServer(
    tx,
    context,
    serverId,
    ['start', 'stop', 'restart', 'backup'].includes(value.action)
      ? 'server:operate'
      : 'server:manage',
  );
  if (server.active_operation_id) throw new DomainError('conflict');
  if (value.action === 'start' || value.action === 'restart') {
    const mapping = await tx
      .selectFrom('runtime_egg_mappings')
      .select('game_id')
      .where('id', '=', server.mapping_id)
      .executeTakeFirstOrThrow();
    if (mapping.game_id === 'minecraft-java') {
      const profile = await tx
        .selectFrom('minecraft_server_profiles')
        .select('installed')
        .where('server_id', '=', serverId)
        .executeTakeFirst();
      if (!profile?.installed) throw new DomainError('conflict');
    }
  }
  await assertNoPendingUpload(tx, serverId);
  if (
    (!server.pterodactyl_id && value.action !== 'delete') ||
    (server.installation_state !== 'installed' &&
      !['delete', 'reinstall', 'wipe'].includes(value.action))
  )
    throw new DomainError('conflict');
  if (
    await tx
      .selectFrom('installation_reservations')
      .select('server_id')
      .where('server_id', '=', serverId)
      .executeTakeFirst()
  )
    throw new DomainError('operation_uncertain');
  const jobId = randomUUID();
  const plan: Record<string, unknown> = automation ? { gatewayAutomation: automation } : {};
  if (value.action === 'minecraft-content') {
    if (
      !options.minecraftPlan ||
      automation ||
      !isDeepStrictEqual(options.minecraftPlan.command, value.command)
    )
      throw new DomainError('forbidden');
    const profile = await tx
      .selectFrom('minecraft_server_profiles')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (
      !profile ||
      (!profile.installed &&
        options.minecraftPlan.command.kind !== 'verify' &&
        (!Array.isArray(profile.installed_manifest) || profile.installed_manifest.length === 0)) ||
      profile.combination_id !== options.minecraftPlan.combinationId
    )
      throw new DomainError('conflict');
    plan.minecraftContent = options.minecraftPlan;
    plan.backupBefore = options.minecraftPlan.backupBefore;
  }
  if (value.action === 'reinstall' || value.action === 'wipe') {
    const profile = await tx
      .selectFrom('minecraft_server_profiles')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (profile) {
      const configuration = parse(minecraftStoredConfigurationSchema, profile.configuration);
      if (configuration.modpack) {
        const selected = configuration.modpack;
        const expected =
          'sourceId' in selected
            ? { kind: 'modpack-upload', archiveRef: selected.sourceId }
            : { kind: 'modpack', ...selected };
        const initial = options.minecraftInitialContent;
        if (
          !initial ||
          initial.combinationId !== profile.combination_id ||
          !initial.archiveRef ||
          !isDeepStrictEqual(initial.command, expected)
        )
          throw new DomainError('conflict');
        await bindMinecraftSource(tx, context, initial.archiveRef, serverId, env);
        plan.minecraftInitialContent = initial;
      }
    }
  }
  const reservation = await tx
    .selectFrom('resource_reservations')
    .selectAll()
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  if (
    ['configure', 'reinstall', 'wipe', 'restore', 'delete', 'minecraft-content'].includes(
      value.action,
    ) &&
    reservation
  )
    throw new DomainError('operation_uncertain');
  if (value.action === 'start' || value.action === 'restart')
    plan.reservationCreated = !reservation;
  if (value.action === 'start' || value.action === 'restart')
    await reserveStartInTransaction(tx, serverId, jobId, value.action, env);
  if (value.action === 'stop') {
    await tx
      .updateTable('resource_reservations')
      .set({ state: 'stopping', operation_id: jobId, updated_at: new Date() })
      .where('server_id', '=', serverId)
      .execute();
    await tx
      .updateTable('managed_servers')
      .set({ intent: automation?.kind === 'sleep' ? 'sleeping' : 'manually_stopped' })
      .where('id', '=', serverId)
      .execute();
  }
  if (
    ['wipe', 'reinstall', 'restore', 'configure', 'delete', 'minecraft-content'].includes(
      value.action,
    ) &&
    !['offline', 'unknown'].includes(server.runtime_state)
  )
    throw new DomainError('conflict');
  if ('backupBefore' in value) plan.backupBefore = value.backupBefore;
  if (value.action === 'restore') {
    plan.backupId = value.backupId;
    plan.truncate = value.truncate;
  }
  if (value.action === 'configure') {
    const node = await tx
      .selectFrom('managed_nodes')
      .selectAll()
      .where('id', '=', server.node_id)
      .executeTakeFirstOrThrow();
    const mapping = await tx
      .selectFrom('runtime_egg_mappings')
      .selectAll()
      .where('id', '=', server.mapping_id)
      .executeTakeFirstOrThrow();
    await checkStorage(
      tx,
      server.owner_id,
      node.physical_host_id,
      value.limits.disk * (1 + mapping.feature_limits.backups),
      env,
      serverId,
    );
    if (value.limits.disk < server.limits.disk) throw new DomainError('conflict');
    const primary = await tx
      .selectFrom('server_allocations')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('is_primary', '=', true)
      .executeTakeFirstOrThrow();
    plan.build = {
      ...value.limits,
      allocation: primary.pterodactyl_allocation_id,
      feature_limits: mapping.feature_limits,
    };
    // Reserve expanded persistent allowance before the remote effect.
    plan.previousLimits = server.limits;
    await tx
      .updateTable('managed_servers')
      .set({
        limits: JSON.stringify({
          ...server.limits,
          memory: Math.max(server.limits.memory, value.limits.memory),
          cpu: Math.max(server.limits.cpu, value.limits.cpu),
          disk: Math.max(server.limits.disk, value.limits.disk),
        }),
      })
      .where('id', '=', serverId)
      .execute();
  }
  if (value.action === 'delete') await revokeGatewayRoutesForDeletion(tx, serverId, new Date());
  return insertOperation(
    tx,
    context,
    server,
    jobId,
    value.idempotencyKey,
    hash,
    value.action,
    plan,
  );
}

export async function enqueueServerOperation(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  input: unknown,
  env: Environment = {},
  options: {
    minecraftPlan?: MinecraftPreparedContent;
    minecraftInitialContent?: MinecraftPreparedContent;
  } = {},
) {
  const value = parse(operationSchema, input);
  const hash = digest({ kind: 'operation', subject: context.subjectUserId, serverId, value });
  if (value.action === 'stop') {
    // A manual stop immediately revokes wake consent, even if a previously queued
    // lifecycle operation prevents enqueueing the stop itself. Never roll consent
    // back with that conflict, and never silently enqueue a waiting stop.
    const replay = await db.transaction().execute(async (tx) => {
      await requestLock(tx, context, value.idempotencyKey);
      const previous = await previousRequest(tx, context, value.idempotencyKey, hash);
      if (previous) return previous;
      await lockResources(tx);
      const policy = await tx
        .selectFrom('gateway_server_states')
        .select('generation')
        .where('server_id', '=', serverId)
        .executeTakeFirst();
      // M3 consent changes are interactive effects. Do not carry authority
      // across either lock wait. Legacy internal M2 calls without a Gateway
      // policy retain their existing context contract.
      const actor = policy ? await currentInteractiveContext(tx, context, env) : context;
      await authorizeServer(tx, actor, serverId, 'server:operate');
      await tx
        .updateTable('managed_servers')
        .set({ intent: 'manually_stopped' })
        .where('id', '=', serverId)
        .execute();
      if (policy) {
        const generation = randomUUID();
        await tx
          .updateTable('gateway_server_states')
          .set({
            generation,
            state: 'manually_stopped',
            readiness_observed_at: null,
            idle_since: null,
            updated_at: new Date(),
          })
          .where('server_id', '=', serverId)
          .execute();
        await recordAudit(tx, actor, 'gateway.consent.revoked', {
          serverId,
          generation,
          previousGeneration: policy.generation,
          reason: 'manual_stop',
        });
      }
    });
    if (replay) return replay;
  }
  return db.transaction().execute(async (tx) => {
    await requestLock(tx, context, value.idempotencyKey);
    const previous = await previousRequest(tx, context, value.idempotencyKey, hash);
    if (previous) return previous;
    await lockResources(tx);
    const policy = await tx
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    const actor =
      policy || value.action === 'minecraft-content'
        ? await currentInteractiveContext(tx, context, env)
        : context;
    const result = await enqueueLockedServerOperation(
      tx,
      actor,
      serverId,
      value,
      env,
      undefined,
      options,
    );
    if (value.action === 'start' || value.action === 'restart') {
      if (policy) {
        const current = await tx
          .selectFrom('managed_servers')
          .select('intent')
          .where('id', '=', serverId)
          .executeTakeFirstOrThrow();
        const maintenance = current.intent === 'maintenance';
        await tx
          .updateTable('gateway_server_states')
          .set({
            generation: randomUUID(),
            state: maintenance ? 'maintenance' : 'waking',
            wake_job_id: result.jobId,
            sleep_job_id: null,
            process_started_at: null,
            readiness_observed_at: null,
            idle_since: null,
            error_code: null,
            startup_deadline_at: new Date(Date.now() + policy.readiness_timeout_seconds * 1000),
            updated_at: new Date(),
          })
          .where('server_id', '=', serverId)
          .execute();
        await tx
          .updateTable('managed_servers')
          .set({ intent: maintenance ? 'maintenance' : 'auto_wake_enabled', readiness: 'loading' })
          .where('id', '=', serverId)
          .execute();
      }
    }
    return result;
  });
}

export async function createProject(db: Kysely<Database>, context: AuthContext, input: unknown) {
  assertPermission(context, 'server:manage', { ownerUserId: context.subjectUserId });
  const value = parse(z.object({ name }).strict(), input);
  return db.transaction().execute(async (tx) => {
    const row = await tx
      .insertInto('projects')
      .values({ id: randomUUID(), owner_id: context.subjectUserId, name: value.name })
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(tx, context, 'project.created', { projectId: row.id });
    return row;
  });
}
export async function setProjectMember(
  db: Kysely<Database>,
  context: AuthContext,
  projectId: string,
  input: unknown,
) {
  const value = parse(
    z
      .object({
        userId: z.string().min(1),
        role: z.enum(['manager', 'operator', 'viewer']).nullable(),
      })
      .strict(),
    input,
  );
  return db.transaction().execute(async (tx) => {
    const project = await tx
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', parse(id, projectId))
      .executeTakeFirst();
    if (!project) throw new DomainError('not_found');
    assertPermission(context, 'server:manage', { ownerUserId: project.owner_id });
    if (value.userId === project.owner_id) throw new DomainError('conflict');
    if (
      !(await tx.selectFrom('user').select('id').where('id', '=', value.userId).executeTakeFirst())
    )
      throw new DomainError('not_found');
    if (value.role)
      await tx
        .insertInto('project_members')
        .values({ project_id: projectId, user_id: value.userId, role: value.role })
        .onConflict((c) =>
          c.columns(['project_id', 'user_id']).doUpdateSet({ role: value.role ?? 'viewer' }),
        )
        .execute();
    else
      await tx
        .deleteFrom('project_members')
        .where('project_id', '=', projectId)
        .where('user_id', '=', value.userId)
        .execute();
    await recordAudit(tx, context, 'project.member.updated', { projectId, ...value });
  });
}

export async function setRuntimeMapping(
  db: Kysely<Database>,
  adapter: PterodactylAdapter,
  context: AuthContext,
  input: unknown,
) {
  ownerOnly(context);
  const value = parse(
    z
      .object({
        id: id.optional(),
        gameId: z.string(),
        runtimeId: z.string(),
        nodeId: id,
        nestId: z.number().int().positive(),
        eggId: z.number().int().positive(),
        dockerImage: z.string().min(1),
        startup: z.string().min(1),
        environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
        portRoles: z
          .array(
            z
              .object({
                role: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
                environmentVariable: z
                  .string()
                  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
                  .optional(),
                protocols: z
                  .array(z.enum(['tcp', 'udp']))
                  .min(1)
                  .max(2)
                  .refine((protocols) => new Set(protocols).size === protocols.length),
                primary: z.boolean(),
              })
              .strict(),
          )
          .min(1)
          .max(32),
        featureLimits: z
          .object({
            databases: z.literal(0),
            allocations: z.number().int().min(1).max(32),
            backups: z.number().int().min(0).max(10),
          })
          .strict(),
        enabled: z.boolean().default(true),
      })
      .strict(),
    input,
  );
  const game = await db
    .selectFrom('game_integrations')
    .select('manifest')
    .where('id', '=', value.gameId)
    .executeTakeFirst();
  const manifest = parse(gameManifestSchema, game?.manifest);
  if (
    !manifest.runtimes.some((r) => r.id === value.runtimeId) ||
    value.portRoles.filter((r) => r.primary).length !== 1 ||
    new Set(value.portRoles.map((r) => r.role)).size !== value.portRoles.length ||
    value.featureLimits.allocations < value.portRoles.length ||
    new Set(
      value.portRoles.flatMap((role) =>
        role.environmentVariable ? [role.environmentVariable] : [],
      ),
    ).size !== value.portRoles.filter((role) => role.environmentVariable).length
  )
    throw new DomainError('validation_failed');
  for (const port of manifest.ports) {
    const mapped = value.portRoles.find((p) => p.role === port.role);
    const protocols = port.transport === 'both' ? ['tcp', 'udp'] : [port.transport];
    if (
      port.required &&
      (!mapped || protocols.some((p) => !mapped.protocols.includes(p as 'tcp' | 'udp')))
    )
      throw new DomainError('validation_failed');
  }
  const node = await db
    .selectFrom('managed_nodes')
    .selectAll()
    .where('id', '=', value.nodeId)
    .executeTakeFirstOrThrow();
  await adapter.getNode(node.pterodactyl_node_id);
  const egg = await adapter.getEgg(value.nestId, value.eggId);
  if (
    !supportsStopConfirmation(egg) ||
    egg.nest !== value.nestId ||
    ![egg.docker_image, ...Object.values(egg.docker_images ?? {})].includes(value.dockerImage)
  )
    throw new DomainError('validation_failed');
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const mappingId = value.id ?? randomUUID();
    const row = {
      id: mappingId,
      game_id: value.gameId,
      runtime_id: value.runtimeId,
      node_id: node.id,
      nest_id: egg.nest,
      egg_id: egg.id,
      docker_image: value.dockerImage,
      startup: value.startup,
      environment: JSON.stringify(value.environment),
      port_roles: JSON.stringify(value.portRoles),
      feature_limits: JSON.stringify(value.featureLimits),
      enabled: value.enabled,
    };
    const previous = value.id
      ? await tx
          .selectFrom('runtime_egg_mappings')
          .selectAll()
          .where('id', '=', value.id)
          .executeTakeFirst()
      : undefined;
    if (
      previous &&
      (await tx
        .selectFrom('managed_servers')
        .select('id')
        .where('mapping_id', '=', mappingId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst())
    ) {
      for (const key of [
        'game_id',
        'runtime_id',
        'node_id',
        'nest_id',
        'egg_id',
        'docker_image',
        'startup',
      ] as const)
        if (previous[key] !== row[key]) throw new DomainError('conflict');
      for (const key of ['environment', 'port_roles', 'feature_limits'] as const)
        if (!isDeepStrictEqual(previous[key], JSON.parse(row[key])))
          throw new DomainError('conflict');
    }
    await tx
      .insertInto('runtime_egg_mappings')
      .values(row)
      .onConflict((c) => c.column('id').doUpdateSet(row))
      .execute();
    await recordAudit(tx, context, 'runtime.mapping.updated', { mappingId });
    return { id: mappingId };
  });
}
