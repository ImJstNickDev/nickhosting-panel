import { randomUUID } from 'node:crypto';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { type Database, recordAudit } from '@nickhosting/database';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import type { Kysely } from 'kysely';
import { type Environment, lockResources } from './admission.js';
import { currentInteractiveContext } from './interactive-context.js';
import { authorizeServer, enqueueLockedServerOperation } from './registry.js';
import {
  ensureSatisfactoryModState,
  inspectSatisfactoryModInventory,
} from './satisfactory-mod-manager.js';
import { assertNoPendingUpload } from './upload-admission.js';

async function access(db: Kysely<Database>, actor: AuthContext, serverId: string) {
  const server = await authorizeServer(db, actor, serverId, 'server:manage');
  for (const permission of [
    'console.power',
    'files.sftp',
    'files.read',
    'files.write',
    'files.delete',
  ])
    await authorizeServer(db, actor, serverId, permission);
  const mapping = await db
    .selectFrom('runtime_egg_mappings')
    .select('game_id')
    .where('id', '=', server.mapping_id)
    .executeTakeFirst();
  if (mapping?.game_id !== 'satisfactory') throw new DomainError('not_found');
  return server;
}

/** Coordinates NickPanel lifecycle/content writers. It does not revoke or claim
 * exclusive ownership of already-authenticated external SFTP transports. */
export async function beginSatisfactoryExternalEdit(
  db: Kysely<Database>,
  actor: AuthContext,
  serverId: string,
  input: { revision: number; idempotencyKey: string },
  env: Environment = {},
) {
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const current = await currentInteractiveContext(tx, actor, env);
    const server = await access(tx, current, serverId);
    await ensureSatisfactoryModState(tx, serverId);
    const state = await tx
      .selectFrom('satisfactory_mod_states')
      .selectAll()
      .where('server_id', '=', serverId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (state.external_mode)
      return { externalMode: true as const, jobId: server.active_operation_id };
    if (
      state.revision !== input.revision ||
      server.active_operation_id ||
      server.installation_state !== 'installed' ||
      !['offline', 'running'].includes(server.runtime_state)
    )
      throw new DomainError('conflict');
    await assertNoPendingUpload(tx, serverId);
    const reused = await tx
      .selectFrom('operation_jobs')
      .select('id')
      .where('actor_id', '=', current.actorUserId)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst();
    if (reused) throw new DomainError('conflict');
    // Even a cached offline observation needs the lifecycle's physical stop proof.
    const operation = await enqueueLockedServerOperation(
      tx,
      current,
      serverId,
      { action: 'stop', idempotencyKey: input.idempotencyKey },
      env,
    );
    const jobId = operation.jobId;
    const row = await tx
      .selectFrom('server_operations')
      .select('plan')
      .where('job_id', '=', jobId)
      .executeTakeFirstOrThrow();
    await tx
      .updateTable('server_operations')
      .set({ plan: JSON.stringify({ ...row.plan, satisfactoryExternalEdit: true }) })
      .where('job_id', '=', jobId)
      .execute();
    await tx
      .updateTable('satisfactory_mod_states')
      .set({
        external_mode: true,
        external_previous_intent: server.intent,
        inventory_fingerprint: null,
        revision: state.revision + 1,
        updated_at: new Date(),
      })
      .where('server_id', '=', serverId)
      .execute();
    await tx
      .updateTable('managed_servers')
      .set({ intent: 'maintenance', updated_at: new Date() })
      .where('id', '=', serverId)
      .execute();
    await tx
      .updateTable('gateway_server_states')
      .set({
        state: 'maintenance',
        generation: randomUUID(),
        readiness_observed_at: null,
        idle_since: null,
        updated_at: new Date(),
      })
      .where('server_id', '=', serverId)
      .execute();
    await recordAudit(tx, current, 'satisfactory.mods.external.begin', { serverId, jobId });
    return { externalMode: true as const, jobId };
  });
}

export async function finishSatisfactoryExternalEdit(
  db: Kysely<Database>,
  adapter: PterodactylAdapter,
  actor: AuthContext,
  serverId: string,
  input: { revision: number; inventoryFingerprint: string },
  env: Environment = {},
) {
  const authorize = async () => {
    const current = await currentInteractiveContext(db, actor, env);
    const server = await access(db, current, serverId);
    if (server.active_operation_id || server.runtime_state !== 'offline')
      throw new DomainError('conflict');
  };
  await authorize();
  const server = await access(db, actor, serverId);
  const inventory = await inspectSatisfactoryModInventory(db, adapter, server, authorize);
  if (inventory.fingerprint !== input.inventoryFingerprint) throw new DomainError('conflict');
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const current = await currentInteractiveContext(tx, actor, env);
    const fresh = await access(tx, current, serverId);
    const state = await tx
      .selectFrom('satisfactory_mod_states')
      .selectAll()
      .where('server_id', '=', serverId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (
      !state.external_mode ||
      state.revision !== input.revision ||
      fresh.active_operation_id ||
      fresh.runtime_state !== 'offline' ||
      state.inventory_fingerprint !== inventory.fingerprint
    )
      throw new DomainError('conflict');
    await assertNoPendingUpload(tx, serverId);
    if (
      await tx
        .selectFrom('resource_reservations')
        .select('server_id')
        .where('server_id', '=', serverId)
        .executeTakeFirst()
    )
      throw new DomainError('operation_uncertain');
    await tx
      .updateTable('satisfactory_mod_states')
      .set({
        external_mode: false,
        external_previous_intent: null,
        revision: state.revision + 1,
        updated_at: new Date(),
      })
      .where('server_id', '=', serverId)
      .execute();
    // Returning from an editor never grants fresh wake consent or starts a game.
    await tx
      .updateTable('managed_servers')
      .set({ intent: 'manually_stopped', updated_at: new Date() })
      .where('id', '=', serverId)
      .execute();
    await tx
      .updateTable('gateway_server_states')
      .set({
        state: 'manually_stopped',
        generation: randomUUID(),
        idle_since: null,
        updated_at: new Date(),
      })
      .where('server_id', '=', serverId)
      .execute();
    await recordAudit(tx, current, 'satisfactory.mods.external.finish', {
      serverId,
      fingerprint: inventory.fingerprint,
    });
    return { externalMode: false as const };
  });
}
