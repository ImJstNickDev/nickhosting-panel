import { type AuthContext, DomainError } from '@nickhosting/core';
import { z } from 'zod';
import type { Environment } from './admission.js';
import type { GameLifecycleContext } from './lifecycle.js';
import type { MinecraftContentOptions } from './minecraft-content.js';
import { modpackRuntimeBindingSchema } from './minecraft-modpacks-plan.js';
import {
  type ConfigureModpackRuntimeOptions,
  configureModpackRuntime,
  prepareMinecraftVersionInstallation,
} from './modpack-runtime.js';

const versionPlan = z.strictObject({
  sourceCombinationId: z.uuid(),
  target: modpackRuntimeBindingSchema,
});
export async function runMinecraftVersionChange(
  context: GameLifecycleContext,
  stage: 'prepare' | 'apply',
  actor: AuthContext,
  options: {
    env: Environment;
    observedImageDigest: MinecraftContentOptions['observedImageDigest'];
    reserve?: () => Promise<void>;
  },
) {
  const { server, db } = context;
  const job = context.operation();
  const { sourceCombinationId, target } = versionPlan.parse(job.plan.minecraftVersion);
  const operation: ConfigureModpackRuntimeOptions = {
    db,
    adapter: context.adapter,
    timing: context.timing,
    serverId: server.id,
    operationId: job.job_id,
    journalSource: 'server-operation',
    reserve: options.reserve,
    context: actor,
    env: options.env,
    binding: target,
    contentOptions: options,
    authorize: context.authorize,
    assertStopped: context.assertStopped,
    readTransition: async () => context.operation().plan.minecraftVersionTransition,
    saveTransition: async (value) =>
      context.update({
        phase: `minecraft_version_${value.state}`,
        effect_state: ['installation-dispatched', 'startup-dispatched'].includes(value.state)
          ? 'uncertain'
          : 'confirmed',
        plan: { ...context.operation().plan, minecraftVersionTransition: value },
      }),
  };
  if (stage === 'prepare') {
    await prepareMinecraftVersionInstallation(operation, sourceCombinationId);
    if (job.action === 'wipe' && job.plan.wipeComplete !== true)
      await db
        .updateTable('minecraft_server_profiles')
        .set({ installed: false, updated_at: new Date() })
        .where('server_id', '=', server.id)
        .where('combination_id', '=', sourceCombinationId)
        .where('installed', '=', true)
        .execute();
    return;
  }
  await configureModpackRuntime(operation);
  await context.authorize();
  await context.assertStopped();
  const fresh = job.action === 'wipe';
  if (fresh) {
    const identifier = server.pterodactyl_identifier;
    if (!identifier || !job.plan.wipeComplete) throw new DomainError('provenance_mismatch');
    // Replaying this absolute bootstrap write is safe. Keep mode never opens a user file.
    const files = await context.adapter.listFiles(identifier);
    const eula = files.find((f) => f.name === 'eula.txt');
    if (eula && (!eula.is_file || eula.is_symlink)) throw new DomainError('conflict');
    if (
      !eula ||
      Buffer.from(await context.adapter.readFile(identifier, 'eula.txt')).toString('utf8') !==
        'eula=true\n'
    ) {
      await context.authorize();
      await context.assertStopped();
      await context.adapter.writeFile(identifier, 'eula.txt', 'eula=true\n');
    }
    if (
      Buffer.from(await context.adapter.readFile(identifier, 'eula.txt')).toString('utf8') !==
      'eula=true\n'
    )
      throw new DomainError('operation_uncertain');
  }
  await db.transaction().execute(async (tx) => {
    const row = await tx
      .selectFrom('minecraft_server_profiles')
      .select('configuration')
      .where('server_id', '=', server.id)
      .where('combination_id', '=', target.combinationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const { modpack: _previousPack, ...configuration } = z
      .record(z.string(), z.unknown())
      .parse(row.configuration);
    await tx
      .updateTable('minecraft_server_profiles')
      .set({
        configuration: JSON.stringify(
          fresh
            ? {
                eula: true,
                properties: {},
                operators: [],
                whitelist: [],
                playerIdentities: { operators: [], whitelist: [] },
              }
            : configuration,
        ),
        configuration_state: '{}',
        ...(fresh ? { content_state: '{}' } : {}),
        updated_at: new Date(),
      })
      .where('server_id', '=', server.id)
      .execute();
    await tx.deleteFrom('minecraft_modpack_receipts').where('server_id', '=', server.id).execute();
    if (fresh) {
      for (const table of [
        'minecraft_content_items',
        'minecraft_mod_drafts',
        'minecraft_plugin_drafts',
        'minecraft_mod_receipts',
        'minecraft_plugin_receipts',
        'minecraft_mod_restart',
        'minecraft_plugin_restart',
      ] as const)
        await tx.deleteFrom(table).where('server_id', '=', server.id).execute();
      for (const table of [
        'minecraft_mod_changes',
        'minecraft_plugin_changes',
        'minecraft_datapack_changes',
      ] as const)
        await tx
          .updateTable(table)
          .set({ state: 'cancelled', updated_at: new Date() })
          .where('server_id', '=', server.id)
          .where('state', '=', 'failed')
          .execute();
      await tx
        .updateTable('minecraft_datapack_applies')
        .set({
          reload: 'not_required',
          cleanup: '[]',
          cleanup_state: 'complete',
          updated_at: new Date(),
        })
        .where('server_id', '=', server.id)
        .where('state', 'in', ['published', 'reconciled'])
        .execute();
      await tx
        .updateTable('minecraft_modpack_operations')
        .set({ state: 'cancelled', updated_at: new Date() })
        .where('server_id', '=', server.id)
        .where((eb) =>
          eb.or([
            eb('state', '=', 'failed'),
            eb.and([
              eb('state', 'in', ['queued', 'preparing', 'ready', 'blocked']),
              eb('runtime_preparation', 'is', null),
            ]),
          ]),
        )
        .execute();
    }
  });
}
