import type { Database } from '@nickhosting/database';
import { provisionPlanSchema } from '@nickhosting/pterodactyl-adapter';
import type { Kysely, Selectable } from 'kysely';

/** Durable local proof only. The worker still corroborates provider absence and
 * reauthorizes the frozen plan immediately before any creation effect. */
export async function retryableProvision(
  db: Kysely<Database>,
  server: Selectable<Database['managed_servers']>,
) {
  if (
    server.deleted_at ||
    server.pterodactyl_id !== null ||
    server.pterodactyl_uuid !== null ||
    server.pterodactyl_identifier !== null ||
    server.active_operation_id ||
    server.installation_state !== 'failed' ||
    !['offline', 'unknown'].includes(server.runtime_state)
  )
    return null;
  const row = await db
    .selectFrom('server_operations as operation')
    .innerJoin('operation_jobs as job', 'job.id', 'operation.job_id')
    .select([
      'operation.job_id',
      'operation.action',
      'operation.phase',
      'operation.plan',
      'operation.effect_state',
      'operation.effect_started_at',
      'operation.lease_token',
      'operation.lease_until',
      'job.state',
    ])
    .where('operation.server_id', '=', server.id)
    .orderBy('job.created_at', 'desc')
    .orderBy('operation.job_id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (
    row?.action !== 'provision' ||
    row.state !== 'failed' ||
    row.phase !== 'failed' ||
    row.effect_state !== 'none' ||
    row.effect_started_at !== null ||
    row.lease_token !== null ||
    row.lease_until !== null ||
    row.plan.noExternalEffect !== true ||
    row.plan.modpackOperationId !== undefined
  )
    return null;
  const provision = provisionPlanSchema.safeParse(row.plan.provision);
  if (
    !provision.success ||
    provision.data.externalId !== server.external_id ||
    typeof row.plan.autoStart !== 'boolean'
  )
    return null;
  const [compute, installation] = await Promise.all([
    db
      .selectFrom('resource_reservations')
      .select('server_id')
      .where('server_id', '=', server.id)
      .executeTakeFirst(),
    db
      .selectFrom('installation_reservations')
      .select('server_id')
      .where('server_id', '=', server.id)
      .executeTakeFirst(),
  ]);
  if (compute || installation) return null;
  return {
    jobId: row.job_id,
    plan: {
      provision: provision.data,
      autoStart: row.plan.autoStart,
      ...(row.plan.gatewayProvision !== undefined
        ? { gatewayProvision: row.plan.gatewayProvision }
        : {}),
      ...(row.plan.minecraftInitialContent !== undefined
        ? { minecraftInitialContent: row.plan.minecraftInitialContent }
        : {}),
      retriedProvisionJobId: row.job_id,
    },
  };
}
