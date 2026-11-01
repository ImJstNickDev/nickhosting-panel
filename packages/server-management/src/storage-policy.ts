import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type AuthContext, assertConfigWritable, DomainError } from '@nickhosting/core';
import {
  assertStoragePolicyIdle,
  type Database,
  getSettings,
  recordAudit,
} from '@nickhosting/database';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { checkedObservation, type Environment, lockResources } from './admission.js';
import { verifyManagedIdentity } from './lifecycle.js';
import { ownerOnly, parse } from './registry.js';
import type { StoragePolicyTransition, StoragePolicyUser } from './storage-policy-contracts.js';

export type {
  StoragePolicyServer,
  StoragePolicyTransition,
  StoragePolicyUser,
} from './storage-policy-contracts.js';

type DB = Kysely<Database>;
const quota = z.number().int().min(1).max(1073741824);
const userQuota = z.number().int().min(0).max(1073741824);
const previewSchema = z
  .object({ policy: z.enum(['GLOBAL_POOL', 'PER_USER_BUDGET']), defaultUserStorageMiB: quota })
  .strict();
const applySchema = z
  .object({
    users: z.array(
      z
        .object({
          userId: z.string().min(1),
          quotaMiB: userQuota,
          servers: z.array(
            z
              .object({ serverId: z.uuid(), diskMiB: z.number().int().min(0).max(1073741824) })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
interface Plan {
  fingerprint: string;
  providerUrl: string | undefined;
  users: StoragePolicyUser[];
  attemptedDiskMiB?: Record<string, number>;
  backupBytes?: Record<string, number>;
  explicitBudgetUsers?: string[];
}
const errorCode = (error: unknown) =>
  error instanceof DomainError ? error.code : 'integration_unavailable';
const required = (user: StoragePolicyUser) =>
  user.servers.some((s) => s.proposedDiskMiB === null)
    ? null
    : user.servers.reduce((sum, s) => sum + (s.proposedDiskMiB ?? 0) * (1 + s.backupSlots), 0);
const quotaSource = (user: StoragePolicyUser, plan: Plan, defaultQuota: number) =>
  user.quotaMiB === 0 ||
  user.quotaMiB !== defaultQuota ||
  user.quotaSource === 'override' ||
  plan.explicitBudgetUsers?.includes(user.userId)
    ? 'override'
    : 'default';

/** Explicit Owner application is the only path that queues remote changes. Preview
 * is read-only towards providers; blocked plans remain fenced until reconciled. */
export function createStoragePolicyService(options: {
  db: DB;
  adapter: PterodactylAdapter;
  env?: Environment;
  reconcileSftp?: (connection: DB, serverId: string, diskMiB: number) => Promise<unknown>;
}) {
  const { db, adapter } = options;
  const env = options.env ?? {};
  async function owner(connection: DB, context: AuthContext) {
    ownerOnly(context);
    const user = await connection
      .selectFrom('user')
      .select(['role', 'emailVerified'])
      .where('id', '=', context.actorUserId)
      .executeTakeFirst();
    if (user?.role !== 'owner' || !user.emailVerified) throw new DomainError('forbidden');
  }
  async function inventory(connection: DB) {
    return connection
      .selectFrom('managed_servers as s')
      .innerJoin('runtime_egg_mappings as m', 'm.id', 's.mapping_id')
      .innerJoin('user as u', 'u.id', 's.owner_id')
      .selectAll('s')
      .select(['u.name as owner_name', 'm.feature_limits'])
      .where('s.deleted_at', 'is', null)
      .orderBy('s.id')
      .execute();
  }
  type Server = Awaited<ReturnType<typeof inventory>>[number];
  function fingerprint(rows: Server[]) {
    return createHash('sha256')
      .update(
        JSON.stringify(
          rows.map((s) => ({
            id: s.id,
            owner: s.owner_id,
            node: s.node_id,
            mapping: s.mapping_id,
            provider: s.pterodactyl_id,
            uuid: s.pterodactyl_uuid,
            identifier: s.pterodactyl_identifier,
            user: s.provider_user_id,
            external: s.external_id,
            backups: s.feature_limits,
            limits: { ...s.limits, disk: undefined },
          })),
        ),
      )
      .digest('hex');
  }
  async function read(connection: DB, id: string) {
    const row = await connection
      .selectFrom('storage_policy_transitions')
      .selectAll()
      .where('id', '=', parse(z.uuid(), id))
      .executeTakeFirst();
    if (!row) throw new DomainError('not_found');
    return { row, plan: row.plan as Plan };
  }
  function publicValue({ row, plan }: Awaited<ReturnType<typeof read>>): StoragePolicyTransition {
    return {
      id: row.id,
      status: row.status,
      policy: row.policy,
      previousPolicy: row.previous_policy,
      defaultUserStorageMiB: row.default_user_storage_mib,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      errorCode: row.error_code,
      users: plan.users.map((user) => ({
        ...user,
        quotaSource: quotaSource(user, plan, row.default_user_storage_mib),
      })),
    };
  }
  async function writable(
    connection: DB,
    policy: 'GLOBAL_POOL' | 'PER_USER_BUDGET',
    defaultUserStorageMiB: number,
  ) {
    const settings = await getSettings(connection, env);
    assertConfigWritable({ storagePolicy: policy, defaultUserStorageMiB }, settings);
    return settings;
  }
  async function idle(connection: DB, rows: Server[]) {
    if (
      rows.some(
        (s) =>
          s.active_operation_id ||
          s.installation_state !== 'installed' ||
          !s.pterodactyl_id ||
          !s.pterodactyl_identifier,
      )
    )
      throw new DomainError('conflict');
    if (
      await connection
        .selectFrom('upload_ingestion_claims')
        .select('id')
        .limit(1)
        .executeTakeFirst()
    )
      throw new DomainError('conflict');
    if (
      !options.reconcileSftp &&
      (await connection
        .selectFrom('external_sftp_credentials')
        .select('id')
        .where('state', '!=', 'revoked')
        .limit(1)
        .executeTakeFirst())
    )
      throw new DomainError('configuration_invalid');
  }
  async function checkPools(connection: DB, rows: Server[], plan: Plan) {
    const nodes = await connection
      .selectFrom('managed_nodes')
      .select(['id', 'physical_host_id'])
      .execute();
    const hosts = await connection.selectFrom('physical_hosts').select('id').execute();
    for (const stored of hosts) {
      const hostRows = rows.filter(
        (s) => nodes.find((n) => n.id === s.node_id)?.physical_host_id === stored.id,
      );
      if (!hostRows.length) continue;
      const { host, snapshot } = await checkedObservation(connection, stored.id, env);
      const proposed = plan.users
        .flatMap((u) => u.servers)
        .filter((s) => hostRows.some((r) => r.id === s.serverId));
      let total = 0;
      let additional = 0;
      for (const item of proposed) {
        const backupBytes = plan.backupBytes?.[item.serverId];
        if (item.usageBytes === null || backupBytes === undefined)
          throw new DomainError('resources_unavailable');
        const occupied = (item.usageBytes + backupBytes) / 1048576;
        const allowance =
          item.proposedDiskMiB === 0
            ? occupied
            : (item.proposedDiskMiB ?? 0) * (1 + item.backupSlots);
        total += Math.max(occupied, allowance);
        additional += Math.max(0, allowance - occupied);
      }
      if (
        total > Number(host.storage_pool_mib) ||
        additional > snapshot.availableDiskMiB - Number(host.disk_headroom_mib)
      )
        throw new DomainError('storage_exhausted');
    }
  }
  async function measure(connection: DB, server: Server) {
    if (!server.pterodactyl_id || !server.pterodactyl_identifier) throw new DomainError('conflict');
    const remote = await adapter.getApplicationServer(server.pterodactyl_id);
    await verifyManagedIdentity(connection, server, remote);
    if (!isDeepStrictEqual(remote.feature_limits, server.feature_limits))
      throw new DomainError('conflict');
    if (
      ['memory', 'cpu', 'swap', 'io'].some(
        (key) =>
          remote.limits[key as keyof typeof remote.limits] !==
          server.limits[key as keyof typeof server.limits],
      ) ||
      (remote.limits.threads ?? '') !== (server.limits.threads ?? '')
    )
      throw new DomainError('conflict');
    const started = Date.now();
    const [resources, backups] = await Promise.all([
      adapter.getResources(server.pterodactyl_identifier),
      adapter.listBackups(server.pterodactyl_identifier),
    ]);
    const bytes = resources.resources.disk_bytes;
    if (
      Date.now() - started > 30_000 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      backups.some((b) => !b.completed_at || !Number.isSafeInteger(b.bytes))
    )
      throw new DomainError('resources_unavailable');
    const backupBytes = backups.reduce((sum, b) => sum + b.bytes, 0);
    if (!Number.isSafeInteger(backupBytes) || backupBytes < 0)
      throw new DomainError('resources_unavailable');
    if (backupBytes > 0 && !server.feature_limits.backups)
      throw new DomainError('storage_exhausted');
    const usageMiB = bytes / 1048576;
    const minimum = Math.max(
      16,
      Math.ceil(usageMiB + Math.max(128, usageMiB * 0.1)),
      Math.ceil(backupBytes / 1048576 / Math.max(1, server.feature_limits.backups)),
    );
    return {
      remote,
      backupBytes,
      usageBytes: bytes,
      observedAt: new Date().toISOString(),
      minimumDiskMiB: minimum,
    };
  }
  async function save(
    connection: DB,
    id: string,
    plan: Plan,
    status: StoragePolicyTransition['status'],
    error: string | null = null,
  ) {
    await connection
      .updateTable('storage_policy_transitions')
      .set({ plan: JSON.stringify(plan), status, error_code: error, updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }
  async function get(context: AuthContext, id: string) {
    await owner(db, context);
    return publicValue(await read(db, id));
  }
  async function status(context: AuthContext) {
    await owner(db, context);
    const settings = await getSettings(db, env);
    const latest = await db
      .selectFrom('storage_policy_transitions')
      .select('id')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return {
      policy: settings.values.storagePolicy,
      defaultUserStorageMiB: settings.values.defaultUserStorageMiB,
      lockedKeys: settings.lockedKeys,
      transition: latest ? publicValue(await read(db, latest.id)) : null,
    };
  }
  async function preview(context: AuthContext, raw: unknown) {
    await owner(db, context);
    const input = parse(previewSchema, raw);
    const settings = await writable(db, input.policy, input.defaultUserStorageMiB);
    await assertStoragePolicyIdle(db);
    const rows = await inventory(db);
    const budgets = await db.selectFrom('storage_user_budgets').selectAll().execute();
    const legacyBudgets = await db.selectFrom('resource_user_limits').selectAll().execute();
    const users: StoragePolicyUser[] = [];
    const backupBytes: Record<string, number> = {};
    const explicitBudgetUsers: string[] = [];
    for (const server of rows) {
      let user = users.find((u) => u.userId === server.owner_id);
      if (!user) {
        const budget = budgets.find((b) => b.user_id === server.owner_id);
        const legacy = legacyBudgets.find(
          (b) => b.user_id === server.owner_id && (!b.expires_at || b.expires_at > new Date()),
        );
        const explicit = budget ? budget.storage_mib !== null : legacy !== undefined;
        if (explicit) explicitBudgetUsers.push(server.owner_id);
        user = {
          userId: server.owner_id,
          name: server.owner_name,
          quotaMiB: Number(
            budget
              ? (budget.storage_mib ?? input.defaultUserStorageMiB)
              : (legacy?.storage_mib ?? input.defaultUserStorageMiB),
          ),
          quotaSource: explicit ? 'override' : 'default',
          requiredMiB: 0,
          servers: [],
        };
        users.push(user);
      }
      const item: StoragePolicyUser['servers'][number] = {
        serverId: server.id,
        name: server.name,
        usageBytes: null,
        observedAt: null,
        currentDiskMiB: server.limits.disk,
        minimumDiskMiB: null,
        proposedDiskMiB: null,
        backupSlots: server.feature_limits.backups,
        status: 'pending',
        errorCode: null,
      };
      try {
        if (server.active_operation_id || server.installation_state !== 'installed')
          throw new DomainError('conflict');
        const measured = await measure(db, server);
        backupBytes[server.id] = measured.backupBytes;
        Object.assign(item, {
          usageBytes: measured.usageBytes,
          observedAt: measured.observedAt,
          minimumDiskMiB: measured.minimumDiskMiB,
          currentDiskMiB: measured.remote.limits.disk,
          proposedDiskMiB:
            input.policy === 'GLOBAL_POOL' || user.quotaMiB === 0
              ? 0
              : Math.max(measured.minimumDiskMiB, server.limits.disk),
        });
      } catch (error) {
        item.status = 'blocked';
        item.errorCode = errorCode(error);
      }
      user.servers.push(item);
      user.requiredMiB = required(user);
    }
    const id = randomUUID();
    const plan: Plan = {
      fingerprint: fingerprint(rows),
      providerUrl: settings.values.pterodactylBaseUrl,
      users,
      backupBytes,
      explicitBudgetUsers,
    };
    await db.transaction().execute(async (tx) => {
      await lockResources(tx);
      await owner(tx, context);
      await assertStoragePolicyIdle(tx);
      await writable(tx, input.policy, input.defaultUserStorageMiB);
      if (fingerprint(await inventory(tx)) !== plan.fingerprint) throw new DomainError('conflict');
      await tx
        .updateTable('storage_policy_transitions')
        .set({ status: 'superseded', updated_at: new Date() })
        .where('status', '=', 'draft')
        .execute();
      await tx
        .insertInto('storage_policy_transitions')
        .values({
          id,
          actor_user_id: context.actorUserId,
          status: 'draft',
          policy: input.policy,
          previous_policy: settings.values.storagePolicy,
          default_user_storage_mib: input.defaultUserStorageMiB,
          plan: JSON.stringify(plan),
          error_code: null,
        })
        .execute();
      await recordAudit(tx, context, 'storage.policy.previewed', {
        transitionId: id,
        policy: input.policy,
      });
    });
    return get(context, id);
  }
  async function apply(context: AuthContext, id: string, raw: unknown) {
    await owner(db, context);
    const input = parse(applySchema, raw);
    await db.transaction().execute(async (tx) => {
      await lockResources(tx);
      await owner(tx, context);
      const { row, plan } = await read(tx, id);
      if (row.status === 'completed') return;
      if (!['draft', 'blocked', 'applying'].includes(row.status)) throw new DomainError('conflict');
      await assertStoragePolicyIdle(tx, id);
      const settings = await writable(tx, row.policy, row.default_user_storage_mib);
      const rows = await inventory(tx);
      if (
        fingerprint(rows) !== plan.fingerprint ||
        settings.values.storagePolicy !== row.previous_policy ||
        settings.values.pterodactylBaseUrl !== plan.providerUrl
      )
        throw new DomainError('conflict');
      await idle(tx, rows);
      if (
        input.users.length !== plan.users.length ||
        new Set(input.users.map((u) => u.userId)).size !== input.users.length
      )
        throw new DomainError('validation_failed');
      for (const user of plan.users) {
        const edit = input.users.find((u) => u.userId === user.userId);
        if (
          !edit ||
          edit.servers.length !== user.servers.length ||
          new Set(edit.servers.map((s) => s.serverId)).size !== edit.servers.length
        )
          throw new DomainError('validation_failed');
        for (const item of user.servers) {
          const target = edit.servers.find((s) => s.serverId === item.serverId)?.diskMiB;
          if (
            item.minimumDiskMiB === null ||
            item.usageBytes === null ||
            target === undefined ||
            (row.policy === 'GLOBAL_POOL' || edit.quotaMiB === 0
              ? target !== 0
              : target < 16 || item.minimumDiskMiB === null || target < item.minimumDiskMiB)
          )
            throw new DomainError('validation_failed');
          if (
            row.status === 'applying' &&
            (target !== item.proposedDiskMiB || edit.quotaMiB !== user.quotaMiB)
          )
            throw new DomainError('conflict');
          if (item.proposedDiskMiB !== target || item.status !== 'applied') item.status = 'pending';
          item.proposedDiskMiB = target;
          item.errorCode = null;
        }
        user.quotaMiB = edit.quotaMiB;
        user.quotaSource = quotaSource(user, plan, row.default_user_storage_mib);
        user.requiredMiB = required(user);
        if (
          row.policy === 'PER_USER_BUDGET' &&
          user.quotaMiB !== 0 &&
          (user.requiredMiB === null || user.requiredMiB > user.quotaMiB)
        )
          throw new DomainError('storage_exhausted');
      }
      await checkPools(tx, rows, plan);
      if (row.status === 'applying') return;
      await tx
        .updateTable('storage_policy_transitions')
        .set({ actor_user_id: context.actorUserId })
        .where('id', '=', id)
        .execute();
      await save(tx, id, plan, 'applying');
      await recordAudit(tx, context, 'storage.policy.requested', {
        transitionId: id,
        policy: row.policy,
      });
    });
    return get(context, id);
  }
  async function retry(context: AuthContext, id: string) {
    const value = await get(context, id);
    if (value.status !== 'blocked' && value.status !== 'applying')
      throw new DomainError('conflict');
    return apply(context, id, {
      users: value.users.map((u) => ({
        userId: u.userId,
        quotaMiB: u.quotaMiB,
        servers: u.servers.map((s) => ({ serverId: s.serverId, diskMiB: s.proposedDiskMiB })),
      })),
    });
  }
  /** Refresh only observations on the existing blocked intent. Desired allocations,
   * accepted user quotas and the durable effect ledger survive cleanup/recovery. */
  async function refresh(context: AuthContext, id: string) {
    await owner(db, context);
    return db.connection().execute(async (connection) => {
      const workerKey = ':storage-policy-worker';
      const acquired = await sql<{
        locked: boolean;
      }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${workerKey},0)) as locked`.execute(
        connection,
      );
      if (!acquired.rows[0]?.locked) throw new DomainError('conflict');
      try {
        const { row, plan } = await read(connection, id);
        if (row.status !== 'blocked') throw new DomainError('conflict');
        const rows = await inventory(connection);
        const settings = await getSettings(connection, env);
        if (
          fingerprint(rows) !== plan.fingerprint ||
          settings.values.pterodactylBaseUrl !== plan.providerUrl ||
          settings.values.storagePolicy !== row.previous_policy
        )
          throw new DomainError('conflict');
        let failure: string | null = null;
        plan.backupBytes ??= {};
        for (const user of plan.users) {
          for (const item of user.servers) {
            const serverKey = `:nickhosting:server:${item.serverId}`;
            const lock = await sql<{
              locked: boolean;
            }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${serverKey},0)) as locked`.execute(
              connection,
            );
            try {
              if (!lock.rows[0]?.locked) throw new DomainError('conflict');
              await owner(connection, context);
              const currentRows = await inventory(connection);
              if (fingerprint(currentRows) !== plan.fingerprint) throw new DomainError('conflict');
              const server = currentRows.find((s) => s.id === item.serverId);
              if (
                !server ||
                server.active_operation_id ||
                server.installation_state !== 'installed'
              )
                throw new DomainError('conflict');
              const measured = await measure(connection, server);
              if (
                measured.remote.limits.disk !== server.limits.disk &&
                measured.remote.limits.disk !== item.proposedDiskMiB &&
                measured.remote.limits.disk !== plan.attemptedDiskMiB?.[item.serverId]
              )
                throw new DomainError('conflict');
              Object.assign(item, {
                usageBytes: measured.usageBytes,
                observedAt: measured.observedAt,
                minimumDiskMiB: measured.minimumDiskMiB,
                currentDiskMiB: measured.remote.limits.disk,
                errorCode: null,
              });
              if (item.status !== 'applied' || measured.remote.limits.disk !== item.proposedDiskMiB)
                item.status = 'pending';
              plan.backupBytes[item.serverId] = measured.backupBytes;
            } catch (error) {
              item.usageBytes = null;
              item.observedAt = null;
              item.minimumDiskMiB = null;
              item.status = 'blocked';
              item.errorCode = errorCode(error);
              delete plan.backupBytes[item.serverId];
              failure ??= item.errorCode;
            } finally {
              if (lock.rows[0]?.locked)
                await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${serverKey},0))`.execute(
                  connection,
                );
            }
          }
          user.requiredMiB = required(user);
        }
        await connection.transaction().execute(async (tx) => {
          await lockResources(tx);
          await owner(tx, context);
          const current = await read(tx, id);
          const currentSettings = await getSettings(tx, env);
          if (
            current.row.status !== 'blocked' ||
            current.row.updated_at.getTime() !== row.updated_at.getTime() ||
            fingerprint(await inventory(tx)) !== plan.fingerprint ||
            currentSettings.values.pterodactylBaseUrl !== plan.providerUrl ||
            currentSettings.values.storagePolicy !== row.previous_policy
          )
            throw new DomainError('conflict');
          await save(tx, id, plan, 'blocked', failure);
          await recordAudit(tx, context, 'storage.policy.refreshed', { transitionId: id });
        });
        return publicValue(await read(connection, id));
      } finally {
        await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${workerKey},0))`.execute(
          connection,
        );
      }
    });
  }
  async function processPending() {
    return db.connection().execute(async (connection) => {
      const key = ':storage-policy-worker';
      const acquired = await sql<{
        locked: boolean;
      }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${key},0)) as locked`.execute(
        connection,
      );
      if (!acquired.rows[0]?.locked) return;
      try {
        const pending = await connection
          .selectFrom('storage_policy_transitions')
          .select('id')
          .where('status', '=', 'applying')
          .limit(1)
          .executeTakeFirst();
        if (!pending) return;
        const { row, plan } = await read(connection, pending.id);
        const context: AuthContext = {
          actorUserId: row.actor_user_id,
          subjectUserId: row.actor_user_id,
          role: 'owner',
          sessionType: 'regular',
          ownerElevation: false,
        };
        try {
          for (const user of plan.users)
            for (const item of user.servers) {
              const serverKey = `:nickhosting:server:${item.serverId}`;
              const locked = await sql<{
                locked: boolean;
              }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${serverKey},0)) as locked`.execute(
                connection,
              );
              if (!locked.rows[0]?.locked) throw new DomainError('conflict');
              try {
                let server: Server | undefined;
                await connection.transaction().execute(async (tx) => {
                  await lockResources(tx);
                  await owner(tx, context);
                  await assertStoragePolicyIdle(tx, row.id);
                  const current = await read(tx, row.id);
                  if (current.row.status !== 'applying') throw new DomainError('conflict');
                  const settings = await writable(tx, row.policy, row.default_user_storage_mib);
                  const rows = await inventory(tx);
                  await idle(tx, rows);
                  if (
                    fingerprint(rows) !== plan.fingerprint ||
                    settings.values.pterodactylBaseUrl !== plan.providerUrl ||
                    settings.values.storagePolicy !== row.previous_policy
                  )
                    throw new DomainError('conflict');
                  server = rows.find((s) => s.id === item.serverId);
                });
                if (!server || item.proposedDiskMiB === null) throw new DomainError('conflict');
                const verifiedServer = server;
                const desiredDiskMiB = item.proposedDiskMiB;
                const measured = await measure(connection, server);
                plan.backupBytes ??= {};
                plan.backupBytes[item.serverId] = measured.backupBytes;
                Object.assign(item, {
                  usageBytes: measured.usageBytes,
                  observedAt: measured.observedAt,
                  minimumDiskMiB: measured.minimumDiskMiB,
                });
                if (item.proposedDiskMiB > 0 && item.proposedDiskMiB < measured.minimumDiskMiB)
                  throw new DomainError('storage_exhausted');
                await connection.transaction().execute(async (tx) => {
                  await lockResources(tx);
                  await checkPools(tx, await inventory(tx), plan);
                });
                const remote = measured.remote;
                if (
                  remote.limits.disk !== server.limits.disk &&
                  remote.limits.disk !== item.proposedDiskMiB &&
                  remote.limits.disk !== plan.attemptedDiskMiB?.[item.serverId]
                )
                  throw new DomainError('conflict');
                // No replay after an uncertain PATCH until provider readback proves
                // whether the exact absolute desired cap already took effect.
                if (remote.limits.disk !== item.proposedDiskMiB) {
                  await connection.transaction().execute(async (tx) => {
                    await lockResources(tx);
                    await owner(tx, context);
                    if (fingerprint(await inventory(tx)) !== plan.fingerprint)
                      throw new DomainError('conflict');
                    plan.attemptedDiskMiB ??= {};
                    plan.attemptedDiskMiB[item.serverId] = desiredDiskMiB;
                    await save(tx, row.id, plan, 'applying');
                  });
                  await adapter.updateBuild(remote.id, {
                    ...remote.limits,
                    disk: item.proposedDiskMiB,
                    allocation: remote.allocation,
                    feature_limits: remote.feature_limits,
                  });
                }
                const confirmed = await adapter.getApplicationServer(remote.id);
                await verifyManagedIdentity(connection, server, confirmed);
                if (confirmed.limits.disk !== item.proposedDiskMiB)
                  throw new DomainError('conflict');
                // The provider cap is already effective even if SFTP confirmation
                // fails next; expose that readback in the durable blocked plan.
                item.currentDiskMiB = confirmed.limits.disk;
                if (options.reconcileSftp)
                  await options.reconcileSftp(connection, item.serverId, item.proposedDiskMiB);
                await connection.transaction().execute(async (tx) => {
                  await lockResources(tx);
                  await owner(tx, context);
                  if (fingerprint(await inventory(tx)) !== plan.fingerprint)
                    throw new DomainError('conflict');
                  await tx
                    .updateTable('managed_servers')
                    .set({
                      limits: JSON.stringify({ ...verifiedServer.limits, disk: desiredDiskMiB }),
                      updated_at: new Date(),
                    })
                    .where('id', '=', item.serverId)
                    .execute();
                  item.currentDiskMiB = desiredDiskMiB;
                  item.status = 'applied';
                  item.errorCode = null;
                  await save(tx, row.id, plan, 'applying');
                  await recordAudit(tx, context, 'storage.policy.server_applied', {
                    transitionId: row.id,
                    serverId: item.serverId,
                    diskMiB: item.proposedDiskMiB,
                  });
                });
              } catch (error) {
                item.status = 'blocked';
                item.errorCode = errorCode(error);
                throw error;
              } finally {
                await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${serverKey},0))`.execute(
                  connection,
                );
              }
            }
          await connection.transaction().execute(async (tx) => {
            await lockResources(tx);
            await sql`select pg_advisory_xact_lock(hashtextextended(current_schema() || ':settings',0))`.execute(
              tx,
            );
            await owner(tx, context);
            const rows = await inventory(tx);
            await idle(tx, rows);
            if (fingerprint(rows) !== plan.fingerprint) throw new DomainError('conflict');
            const settings = await writable(tx, row.policy, row.default_user_storage_mib);
            await checkPools(tx, rows, plan);
            if (
              settings.values.storagePolicy !== row.previous_policy ||
              settings.values.pterodactylBaseUrl !== plan.providerUrl
            )
              throw new DomainError('conflict');
            if (row.policy === 'PER_USER_BUDGET')
              for (const user of plan.users) {
                const storageMiB =
                  quotaSource(user, plan, row.default_user_storage_mib) === 'default'
                    ? null
                    : String(user.quotaMiB);
                await tx
                  .insertInto('storage_user_budgets')
                  .values({ user_id: user.userId, storage_mib: storageMiB })
                  .onConflict((c) =>
                    c
                      .column('user_id')
                      .doUpdateSet({ storage_mib: storageMiB, updated_at: new Date() }),
                  )
                  .execute();
              }
            const previous = await tx
              .selectFrom('platform_settings')
              .select('value')
              .where('key', '=', 'platform')
              .executeTakeFirst();
            const value = {
              ...previous?.value,
              storagePolicy: row.policy,
              defaultUserStorageMiB: row.default_user_storage_mib,
            };
            await tx
              .insertInto('platform_settings')
              .values({ key: 'platform', value })
              .onConflict((c) => c.column('key').doUpdateSet({ value, updated_at: new Date() }))
              .execute();
            await save(tx, row.id, plan, 'completed');
            await recordAudit(tx, context, 'storage.policy.completed', {
              transitionId: row.id,
              policy: row.policy,
            });
          });
        } catch (error) {
          await save(connection, row.id, plan, 'blocked', errorCode(error));
        }
      } finally {
        await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${key},0))`.execute(
          connection,
        );
      }
    });
  }
  return { status, preview, get, apply, retry, refresh, processPending };
}
