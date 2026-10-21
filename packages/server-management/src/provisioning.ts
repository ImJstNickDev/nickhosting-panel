import { type AuthContext, DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { PrivateTransferCache } from '@nickhosting/pterodactyl-adapter';
import type { Kysely } from 'kysely';
import {
  loadModpackProvisioning,
  type ModpackProvisioning,
  modpackProvisioningPresentation,
} from './modpack-provisioning.js';
import { authorizeServer } from './registry.js';

export const provisioningStages = [
  'preparing',
  'installing',
  'configuring',
  'starting',
  'ready',
] as const;
export type ProvisioningStage = (typeof provisioningStages)[number];
export interface InstallationLog {
  id: string;
  at: string;
  text: string;
}
export interface InstallationTranscript {
  logs: InstallationLog[];
  available: boolean;
}
export const installationLogKey = (jobId: string) => `installation-transcript:v1:${jobId}`;

/** A later confirmed start resolves a first-start denial for the live server,
 * while its original operation and Activity history remain immutable. */
export async function successfulStartAfter(db: Kysely<Database>, serverId: string, since: Date) {
  return Boolean(
    await db
      .selectFrom('server_operations as operation')
      .innerJoin('operation_jobs as job', 'job.id', 'operation.job_id')
      .select('job.id')
      .where('operation.server_id', '=', serverId)
      .where('operation.action', 'in', ['start', 'restart'])
      .where('job.state', '=', 'succeeded')
      .where('job.completed_at', '>', since)
      .limit(1)
      .executeTakeFirst(),
  );
}

/** Public progress comes from the durable journal, never the queue delivery state. */
export function provisioningPresentation(
  row: {
    job_id: string;
    action: string;
    phase: string;
    plan: Record<string, unknown>;
    effect_state: string;
    state: string;
    error_code: string | null;
    created_at: Date;
    updated_at: Date;
    completed_at: Date | null;
  },
  transcript: InstallationTranscript = { logs: [], available: false },
  modpack?: ModpackProvisioning,
) {
  if (row.plan.modpackOperationId === row.job_id) {
    const source = modpack?.id === row.job_id ? modpack : undefined;
    const presentation = modpackProvisioningPresentation(source);
    const updatedAt = source?.updated_at ?? row.updated_at;
    return {
      ...presentation,
      jobId: row.job_id,
      action: 'reinstall' as const,
      startedAt: row.created_at.toISOString(),
      updatedAt: updatedAt.toISOString(),
      completedAt: ['completed', 'failed'].includes(presentation.state)
        ? updatedAt.toISOString()
        : null,
      // Modpack phases are not the ordinary installer's prepare/install/configure sequence.
      stages: [],
      logs: transcript.logs,
      logsAvailable: transcript.available,
    };
  }
  const saved = row.plan.provisioning as
    | { stage?: ProvisioningStage; timestamps?: Partial<Record<ProvisioningStage, string>> }
    | undefined;
  const denied = row.state === 'succeeded' && row.plan.initialStartDenied === true;
  const stage: ProvisioningStage = denied
    ? 'starting'
    : row.state === 'succeeded'
      ? 'ready'
      : (saved?.stage ??
        (row.phase === 'initial_start'
          ? 'starting'
          : row.plan.installConfirmed === true
            ? 'configuring'
            : ['installation', 'reinstall'].includes(row.phase)
              ? 'installing'
              : 'preparing'));
  const ordinaryWait = [
    'installation',
    'installation_terminal_unproven',
    'game_configuration',
    'power_confirmation',
    'resource_cache_expiry',
    'start_terminal_unproven',
  ].includes(String(row.plan.waitReason));
  const state = denied
    ? 'start-denied'
    : row.state === 'succeeded'
      ? 'completed'
      : row.state === 'failed'
        ? 'failed'
        : row.effect_state === 'uncertain' && !ordinaryWait
          ? 'uncertain'
          : 'active';
  const timestamps = saved?.timestamps ?? {};
  const current = provisioningStages.indexOf(stage);
  return {
    jobId: row.job_id,
    action: row.action as 'provision' | 'reinstall',
    stage,
    state,
    startedAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    errorCode: denied ? 'resources_unavailable' : state === 'active' ? null : row.error_code,
    stages: provisioningStages
      .filter((id) => id !== 'starting' || row.plan.autoStart === true || stage === 'starting')
      .map((id) => {
        const index = provisioningStages.indexOf(id);
        return {
          id,
          state:
            index < current || state === 'completed'
              ? 'completed'
              : index > current
                ? 'pending'
                : state === 'failed'
                  ? 'failed'
                  : state === 'start-denied'
                    ? 'pending'
                    : 'active',
          ...(timestamps[id]
            ? { startedAt: timestamps[id] }
            : id === 'preparing'
              ? { startedAt: row.created_at.toISOString() }
              : {}),
          ...(index < current && timestamps[provisioningStages[index + 1] ?? 'ready']
            ? { completedAt: timestamps[provisioningStages[index + 1] ?? 'ready'] }
            : {}),
        };
      }),
    logs: transcript.logs,
    logsAvailable: transcript.available,
    workflow: undefined,
  };
}

export async function getServerProvisioning(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  cache?: PrivateTransferCache,
) {
  const server = await authorizeServer(db, context, serverId);
  const row = await db
    .selectFrom('server_operations as operation')
    .innerJoin('operation_jobs as job', 'job.id', 'operation.job_id')
    .select([
      'operation.job_id',
      'operation.action',
      'operation.phase',
      'operation.plan',
      'operation.effect_state',
      'job.state',
      'job.error_code',
      'job.created_at',
      'job.updated_at',
      'job.completed_at',
    ])
    .where('operation.server_id', '=', serverId)
    .where('operation.action', 'in', ['provision', 'reinstall'])
    .orderBy('job.created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  if (
    row.state === 'succeeded' &&
    row.plan.initialStartDenied === true &&
    (await successfulStartAfter(db, serverId, row.completed_at ?? row.created_at))
  )
    return null;
  let transcript: InstallationTranscript = { logs: [], available: false };
  if (cache) {
    try {
      const value = await cache.get(installationLogKey(row.job_id));
      if (value) transcript = JSON.parse(value) as InstallationTranscript;
    } catch {
      /* A bounded log cache outage must not hide durable operation progress. */
    }
  }
  let canReinstall = false;
  if (
    row.state === 'failed' &&
    server.pterodactyl_id &&
    !server.active_operation_id &&
    ['offline', 'unknown'].includes(server.runtime_state)
  ) {
    try {
      await authorizeServer(db, context, serverId, 'server:manage');
      const compute = await db
        .selectFrom('resource_reservations')
        .select('server_id')
        .where('server_id', '=', serverId)
        .executeTakeFirst();
      const reserved = await db
        .selectFrom('installation_reservations')
        .select('server_id')
        .where('server_id', '=', serverId)
        .executeTakeFirst();
      canReinstall = !reserved && !compute;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
    }
  }
  const modpacks = await loadModpackProvisioning(db, [
    { jobId: row.job_id, serverId, plan: row.plan },
  ]);
  return {
    ...provisioningPresentation(row, transcript, modpacks.get(row.job_id)),
    canReinstall: row.plan.modpackOperationId ? false : canReinstall,
  };
}
