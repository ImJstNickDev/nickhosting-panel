import type { Database } from '@nickhosting/database';
import type { Kysely, Selectable } from 'kysely';
import type { MinecraftModpackPhase } from '../../../games/minecraft/src/modpack-contracts.js';
import type { ProvisioningStage } from './provisioning.js';

export type ModpackProvisioning = Pick<
  Selectable<Database['minecraft_modpack_operations']>,
  'id' | 'server_id' | 'state' | 'phase' | 'error' | 'updated_at'
>;

/** Read only the authoritative workflow fields for already-authorized operation rows. */
export async function loadModpackProvisioning(
  db: Kysely<Database>,
  operations: {
    jobId: string | null;
    serverId: string | null;
    plan: Record<string, unknown> | null;
  }[],
) {
  const expected = new Map(
    operations.flatMap((row) =>
      row.jobId && row.serverId && row.plan?.modpackOperationId === row.jobId
        ? [[row.jobId, row.serverId] as const]
        : [],
    ),
  );
  if (!expected.size) return new Map<string, ModpackProvisioning>();
  const rows = await db
    .selectFrom('minecraft_modpack_operations')
    .select(['id', 'server_id', 'state', 'phase', 'error', 'updated_at'])
    .where('id', 'in', [...expected.keys()])
    .execute();
  return new Map(
    rows.filter((row) => expected.get(row.id) === row.server_id).map((row) => [row.id, row]),
  );
}

const phases: Record<MinecraftModpackPhase, [ProvisioningStage, string]> = {
  queued: ['preparing', 'queued'],
  resolving: ['preparing', 'resolving'],
  downloading: ['preparing', 'preparing'],
  inspecting: ['preparing', 'inspecting'],
  ready: ['preparing', 'ready'],
  checking: ['preparing', 'checking'],
  stopping: ['preparing', 'stopping'],
  backup: ['preparing', 'backingUp'],
  runtime: ['installing', 'changingRuntime'],
  publishing: ['configuring', 'publishing'],
  verifying: ['configuring', 'verifying'],
  restoring: ['starting', 'restoring'],
  complete: ['ready', 'completed'],
};

export function modpackProvisioningPresentation(source?: ModpackProvisioning) {
  const state: 'uncertain' | 'failed' | 'completed' | 'active' =
    !source || source.state === 'uncertain'
      ? 'uncertain'
      : ['failed', 'blocked', 'cancelled'].includes(source.state)
        ? 'failed'
        : source.state === 'applied' && source.phase !== 'restoring'
          ? 'completed'
          : 'active';
  const [stage, phase] = phases[source?.phase as MinecraftModpackPhase] ?? [
    'preparing',
    'checking',
  ];
  const status =
    state === 'uncertain'
      ? 'uncertain'
      : state === 'failed'
        ? source?.state === 'blocked'
          ? 'needsAttention'
          : (source?.state ?? 'failed')
        : state === 'completed'
          ? 'completed'
          : source?.state === 'apply_queued'
            ? 'queued'
            : phase;
  return {
    stage,
    state,
    errorCode: state === 'active' ? null : (source?.error ?? null),
    workflow: {
      titleKey: 'games.minecraft.sections.modpacks',
      statusKey: `games.minecraft.modpacks.${status}`,
      phaseKey: `games.minecraft.modpacks.${phase}`,
      review: { sectionId: 'modpacks', labelKey: 'games.minecraft.modpacks.review' },
    },
  };
}

export function modpackJobState(
  source?: ModpackProvisioning,
): 'succeeded' | 'queued' | 'running' | 'uncertain' | 'failed' {
  const { state } = modpackProvisioningPresentation(source);
  return state === 'completed'
    ? 'succeeded'
    : state === 'active'
      ? source?.state === 'apply_queued'
        ? 'queued'
        : 'running'
      : state;
}
