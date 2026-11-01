import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { type Kysely, type Selectable, sql } from 'kysely';
import { z } from 'zod';
import {
  type SatisfactoryModFile,
  satisfactoryModLockSchema,
  satisfactoryModSelectionSchema,
  satisfactoryVersionPaths,
  satisfiesSatisfactoryModVersion,
} from '../../../games/satisfactory/src/mods.js';
import { readSatisfactoryModInventory } from '../../../games/satisfactory/src/mods-inventory.js';
import { lockResources } from './admission.js';
import { assertNoPendingUpload } from './upload-admission.js';

export const satisfactoryManagedFileSchema = z.object({
  path: z
    .string()
    .regex(/^FactoryGame\/Mods\/[A-Za-z0-9_. /-]+$/)
    .refine((path) => !path.split('/').some((part) => part === '..' || part === '.')),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
});
export const satisfactoryManagedFilesSchema = z.array(satisfactoryManagedFileSchema).max(20000);
export function sameSatisfactorySelection(first: unknown, second: unknown) {
  const normalize = (input: unknown) =>
    satisfactoryModSelectionSchema
      .parse(input)
      .map((item) => ({
        reference: item.reference,
        version: item.version,
        enabled: item.enabled !== false,
      }))
      .sort((a, b) => a.reference.localeCompare(b.reference));
  return JSON.stringify(normalize(first)) === JSON.stringify(normalize(second));
}
export const emptySatisfactoryLock = { version: 1 as const, mods: {} };
export async function ensureSatisfactoryModState(db: Kysely<Database>, serverId: string) {
  await db
    .insertInto('satisfactory_mod_states')
    .values({
      server_id: serverId,
      selection: '[]',
      files: '[]',
      lock: JSON.stringify(emptySatisfactoryLock),
      active_profile_id: null,
      external_previous_intent: null,
      inventory_fingerprint: null,
      recovery: null,
    })
    .onConflict((oc) => oc.column('server_id').doNothing())
    .execute();
  return db
    .selectFrom('satisfactory_mod_states')
    .selectAll()
    .where('server_id', '=', serverId)
    .executeTakeFirstOrThrow();
}

/** Full, bounded, no-follow inventory. Fingerprints cover file bytes, not mutable timestamps. */
export async function inspectSatisfactoryModInventory(
  db: Kysely<Database>,
  adapter: PterodactylAdapter,
  server: Pick<Selectable<Database['managed_servers']>, 'id' | 'pterodactyl_identifier'>,
  authorize: () => Promise<void> = async () => {},
) {
  const identifier = server.pterodactyl_identifier;
  if (!identifier) throw new DomainError('integration_unavailable');
  await authorize();
  const state = await db
    .selectFrom('satisfactory_mod_states')
    .selectAll()
    .where('server_id', '=', server.id)
    .executeTakeFirst();
  const selection = satisfactoryModSelectionSchema.parse(state?.selection ?? []);
  const lock = satisfactoryModLockSchema.parse(state?.lock ?? emptySatisfactoryLock);
  let metadataBytes = 0;
  const listFiles = async (path: string) => {
    await authorize();
    return adapter.listFiles(identifier, path);
  };
  const readFile = async (path: string, maxBytes: number) => {
    await authorize();
    const bytes = Buffer.from(await adapter.readFile(identifier, path, maxBytes));
    metadataBytes += bytes.length;
    if (metadataBytes > 67108864) throw new DomainError('conflict');
    return bytes;
  };
  const inventory = await readSatisfactoryModInventory({ listFiles, readFile, selection, lock });
  const files: SatisfactoryModFile[] = [];
  let total = 0,
    entriesSeen = 0;
  const deadline = AbortSignal.timeout(120000);
  const walk = async (path: string, depth = 0): Promise<void> => {
    if (depth > 32) throw new DomainError('conflict');
    await authorize();
    for (const entry of await listFiles(path)) {
      deadline.throwIfAborted();
      if (++entriesSeen > 40000) throw new DomainError('conflict');
      if (
        !/^[A-Za-z0-9_. -]+$/.test(entry.name) ||
        entry.name === '.' ||
        entry.name === '..' ||
        entry.is_symlink
      )
        throw new DomainError('conflict');
      const name = `${path}/${entry.name}`;
      if (name.length > 1024) throw new DomainError('conflict');
      if (!entry.is_file) {
        await walk(name, depth + 1);
        continue;
      }
      total += entry.size;
      if (total > 536870912 || files.length >= 20000) throw new DomainError('conflict');
      const response = await adapter.downloadFile(identifier, name, {
        maxBytes: Math.max(1, entry.size),
        signal: deadline,
        authorize,
      });
      const digest = createHash('sha256');
      let size = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > entry.size) throw new DomainError('conflict');
          digest.update(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (size !== entry.size) throw new DomainError('conflict');
      files.push({ path: name, size, sha256: digest.digest('hex') });
    }
  };
  const factory = (await listFiles('')).find((entry) => entry.name === 'FactoryGame');
  if (factory?.is_symlink || factory?.is_file) throw new DomainError('conflict');
  const mods = factory
    ? (await listFiles('FactoryGame')).find((entry) => entry.name === 'Mods')
    : undefined;
  if (mods?.is_symlink || mods?.is_file) throw new DomainError('conflict');
  if (mods) await walk('FactoryGame/Mods');
  files.sort((a, b) => a.path.localeCompare(b.path));
  const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const previous = satisfactoryManagedFilesSchema.parse(state?.files ?? []);
  const diverged = state?.inventory_fingerprint
    ? state.inventory_fingerprint !== fingerprint
    : previous.some(
        (file) =>
          !files.some((current) => current.path === file.path && current.sha256 === file.sha256),
      ) ||
      inventory.items.some(
        (item) => item.managed && !previous.some((file) => file.path.startsWith(`${item.path}/`)),
      );
  const gameVersion = inventory.gameBuild;
  return {
    ...inventory,
    items: inventory.items,
    files,
    fingerprint,
    diverged,
    gameVersion,
  };
}

export async function readSatisfactoryGameBuild(adapter: PterodactylAdapter, identifier: string) {
  const listFiles = (path: string) => adapter.listFiles(identifier, path);
  const readFile = async (path: string, max: number) =>
    Buffer.from(await adapter.readFile(identifier, path, max));
  let gameVersion: number | null = null;
  for (const path of satisfactoryVersionPaths) {
    const entries = await listFiles('Engine/Binaries/Linux');
    const entry = entries.find((item) => item.name === path.split('/').at(-1));
    if (!entry) continue;
    if (entry.is_symlink || !entry.is_file) throw new DomainError('conflict');
    const value = JSON.parse((await readFile(path, 65536)).toString('utf8')) as {
      Changelist?: unknown;
    };
    if (Number.isSafeInteger(value.Changelist) && Number(value.Changelist) > 0)
      gameVersion = Number(value.Changelist);
    break;
  }
  return gameVersion;
}

export async function reconcileSatisfactoryMods(
  db: Kysely<Database>,
  adapter: PterodactylAdapter,
  server: Pick<
    Selectable<Database['managed_servers']>,
    'id' | 'pterodactyl_identifier' | 'runtime_state'
  >,
  input: { fingerprint: string; revision: number; selection: unknown; profileId?: string },
  authorize: () => Promise<void>,
) {
  if (server.runtime_state !== 'offline') throw new DomainError('conflict');
  const inventory = await inspectSatisfactoryModInventory(db, adapter, server, authorize);
  if (inventory.fingerprint !== input.fingerprint) throw new DomainError('conflict');
  const selection = satisfactoryModSelectionSchema.parse(input.selection);
  if (
    inventory.items.some((item) => item.managed && item.issues.length) ||
    new Set(inventory.items.map((item) => item.reference)).size !== inventory.items.length
  )
    throw new DomainError('conflict');
  const mods: Record<string, z.infer<typeof satisfactoryModLockSchema>['mods'][string]> = {};
  for (const item of inventory.items) {
    if (!item.managed) continue;
    const candidates = inventory.lockfiles
      .map((value) => value.lock.mods[item.reference])
      .filter((value) => value && value.version === item.version);
    if (!candidates.length) throw new DomainError('conflict');
    mods[item.reference] = candidates[0]!;
  }
  for (const item of selection) {
    if (item.enabled === false || mods[item.reference]) continue;
    const clientOnly = inventory.lockfiles
      .map((value) => value.lock.mods[item.reference])
      .filter(
        (value) =>
          value &&
          !value.targets.LinuxServer &&
          satisfiesSatisfactoryModVersion(value.version, item.version),
      );
    if (clientOnly.length && new Set(clientOnly.map((value) => value!.version)).size === 1)
      mods[item.reference] = clientOnly[0]!;
  }
  for (const item of selection)
    if (
      item.enabled !== false &&
      (!mods[item.reference] ||
        !satisfiesSatisfactoryModVersion(mods[item.reference]!.version, item.version))
    )
      throw new DomainError('conflict');
  const files = inventory.files.filter(
    (file) =>
      inventory.items.some((item) => item.managed && file.path.startsWith(`${item.path}/`)) ||
      inventory.lockfiles.some((item) => item.path === file.path),
  );
  await authorize();
  await db.transaction().execute(async (tx) => {
    await lockResources(tx);
    await authorize();
    await assertNoPendingUpload(tx, server.id);
    const state = await tx
      .selectFrom('satisfactory_mod_states')
      .selectAll()
      .where('server_id', '=', server.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const current = await tx
      .selectFrom('managed_servers')
      .select(['runtime_state', 'active_operation_id'])
      .where('id', '=', server.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (
      state.revision !== input.revision ||
      !state.external_mode ||
      current.runtime_state !== 'offline' ||
      current.active_operation_id
    )
      throw new DomainError('conflict');
    const profile = input.profileId
      ? await tx
          .selectFrom('satisfactory_mod_profiles')
          .selectAll()
          .where('id', '=', input.profileId)
          .where('server_id', '=', server.id)
          .executeTakeFirst()
      : null;
    if (input.profileId && (!profile || !sameSatisfactorySelection(profile.selection, selection)))
      throw new DomainError('conflict');
    if (profile?.vanilla && inventory.items.some((item) => item.managed))
      throw new DomainError('conflict');
    await tx
      .updateTable('satisfactory_mod_states')
      .set({
        selection: JSON.stringify(selection),
        active_profile_id: profile?.id ?? null,
        vanilla: profile?.vanilla ?? false,
        files: JSON.stringify(files),
        lock: JSON.stringify({ version: 1, mods }),
        inventory_fingerprint: inventory.fingerprint,
        revision: state.revision + 1,
        updated_at: new Date(),
        recovery: state.recovery
          ? JSON.stringify({ ...(state.recovery as Record<string, unknown>), obsolete: true })
          : null,
      })
      .where('server_id', '=', server.id)
      .execute();
  });
  return { revision: input.revision + 1, fingerprint: inventory.fingerprint };
}

/** Reclaim expired previews and invalidated recovery snapshots through the shared
 * staging ledger. Current operations and referenced rollback bytes are retained. */
export async function cleanupSatisfactoryModPlans(
  db: Kysely<Database>,
  env: Readonly<Record<string, string | undefined>> = {},
) {
  const { rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { getSettings, assertStoragePolicyIdle } = await import('@nickhosting/database');
  const { contentStorageRoot } = await import('./content-admission.js');
  const candidates = await db
    .selectFrom('satisfactory_mod_plans as plan')
    .innerJoin('managed_servers as server', 'server.id', 'plan.server_id')
    .leftJoin('operation_jobs as job', 'job.id', 'plan.job_id')
    .select(['plan.id', 'plan.server_id'])
    .where('plan.expires_at', '<', new Date())
    .where('server.active_operation_id', 'is', null)
    .where((eb) =>
      eb.or([eb('job.id', 'is', null), eb('job.state', 'in', ['succeeded', 'failed'])]),
    )
    .orderBy('plan.expires_at', 'asc')
    .limit(50)
    .execute();
  let plans = 0,
    recoveries = 0;
  for (const candidate of candidates) {
    await db.transaction().execute(async (tx) => {
      await lockResources(tx);
      await assertStoragePolicyIdle(tx);
      const server = await tx
        .selectFrom('managed_servers')
        .select('active_operation_id')
        .where('id', '=', candidate.server_id)
        .forUpdate()
        .executeTakeFirst();
      if (!server || server.active_operation_id) return;
      const plan = await tx
        .selectFrom('satisfactory_mod_plans')
        .selectAll()
        .where('id', '=', candidate.id)
        .forUpdate()
        .executeTakeFirst();
      if (!plan || plan.expires_at.getTime() >= Date.now()) return;
      if (plan.job_id) {
        const job = await tx
          .selectFrom('operation_jobs')
          .select('state')
          .where('id', '=', plan.job_id)
          .executeTakeFirst();
        if (job && !['succeeded', 'failed'].includes(job.state)) return;
        const state = await tx
          .selectFrom('satisfactory_mod_states')
          .select('recovery')
          .where('server_id', '=', candidate.server_id)
          .executeTakeFirst();
        const recovery = z.object({ jobId: z.uuid() }).safeParse(state?.recovery);
        if (recovery.success && recovery.data.jobId === plan.job_id) return;
        const root = contentStorageRoot((await getSettings(tx, env)).values.contentWorkRoot, env);
        await rm(join(root, 'content-staging', z.uuid().parse(plan.job_id)), {
          force: true,
          recursive: true,
        });
        await tx
          .updateTable('minecraft_staging_claims')
          .set({ state: 'released' })
          .where('job_id', '=', plan.job_id)
          .execute();
      }
      await tx.deleteFrom('satisfactory_mod_plans').where('id', '=', plan.id).execute();
      plans++;
    });
  }
  const obsolete = await db
    .selectFrom('satisfactory_mod_states as state')
    .innerJoin('managed_servers as server', 'server.id', 'state.server_id')
    .select(['state.server_id', 'state.recovery'])
    .where('state.recovery', 'is not', null)
    .where('server.active_operation_id', 'is', null)
    .where((eb) =>
      eb.or([
        sql<boolean>`state.recovery->>'obsolete' = 'true'`,
        eb('server.deleted_at', 'is not', null),
      ]),
    )
    .limit(100)
    .execute();
  for (const candidate of obsolete) {
    await db.transaction().execute(async (tx) => {
      await lockResources(tx);
      await assertStoragePolicyIdle(tx);
      const server = await tx
        .selectFrom('managed_servers')
        .select(['active_operation_id', 'deleted_at'])
        .where('id', '=', candidate.server_id)
        .forUpdate()
        .executeTakeFirst();
      if (!server || server.active_operation_id) return;
      const state = await tx
        .selectFrom('satisfactory_mod_states')
        .select('recovery')
        .where('server_id', '=', candidate.server_id)
        .forUpdate()
        .executeTakeFirst();
      const recovery = z
        .object({
          obsolete: z.boolean().optional(),
          jobId: z.uuid(),
          supersededStageJobs: z.array(z.uuid()).max(128).default([]),
        })
        .safeParse(state?.recovery);
      if (!recovery.success || (!recovery.data.obsolete && !server.deleted_at)) return;
      const root = contentStorageRoot((await getSettings(tx, env)).values.contentWorkRoot, env);
      for (const jobId of new Set([recovery.data.jobId, ...recovery.data.supersededStageJobs])) {
        await rm(join(root, 'content-staging', jobId), { force: true, recursive: true });
        await tx
          .updateTable('minecraft_staging_claims')
          .set({ state: 'released' })
          .where('job_id', '=', jobId)
          .execute();
      }
      await tx
        .updateTable('satisfactory_mod_states')
        .set({ recovery: null })
        .where('server_id', '=', candidate.server_id)
        .execute();
      recoveries++;
    });
  }
  return { plans, recoveries };
}
