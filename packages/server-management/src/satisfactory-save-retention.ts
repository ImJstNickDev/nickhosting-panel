import { createHash } from 'node:crypto';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { type Database, recordAudit } from '@nickhosting/database';
import { type Kysely, sql } from 'kysely';
import {
  safetySaveRotationCandidates,
  satisfactorySafetySaveName,
  satisfactorySafetySaveRetentionSchema,
} from '../../../games/satisfactory/src/save-retention.js';
import { satisfactorySaveDirectory } from '../../../games/satisfactory/src/world-paths.js';
import type { GameLifecycleContext } from './lifecycle.js';
import { authorizeServer } from './registry.js';

type Environment = Readonly<Record<string, string | undefined>>;
const root = `${satisfactorySaveDirectory}/server`;
function environmentKeep(env: Environment): number | undefined {
  const value = env.SATISFACTORY_SAFETY_SAVE_RETENTION;
  if (value === undefined || value === '') return undefined;
  const keep = Number(value);
  if (!Number.isInteger(keep) || keep < 1 || keep > 100)
    throw new DomainError('configuration_invalid');
  return keep;
}
export async function readSatisfactorySaveRetention(
  db: Kysely<Database>,
  serverId: string,
  env: Environment = {},
) {
  const keep = environmentKeep(env);
  const policies = await db
    .selectFrom('satisfactory_save_retention')
    .select(['session_name', 'keep_count'])
    .where('server_id', '=', serverId)
    .orderBy('session_name')
    .execute();
  return {
    defaultKeep: keep ?? 5,
    minimumKeep: 1,
    maximumKeep: 100,
    environmentLocked: keep !== undefined,
    policies: policies.map((policy) => ({
      sessionName: policy.session_name,
      keep: keep ?? policy.keep_count,
    })),
  };
}
export async function updateSatisfactorySaveRetention(
  db: Kysely<Database>,
  context: AuthContext,
  id: string,
  input: unknown,
  env: Environment = {},
) {
  const parsed = satisfactorySafetySaveRetentionSchema.safeParse(input);
  if (!parsed.success) throw new DomainError('validation_failed');
  if (environmentKeep(env) !== undefined) throw new DomainError('conflict');
  return db.transaction().execute(async (tx) => {
    // Share the exact lifecycle lock; policy cannot change during file rotation.
    const result = await sql<{
      acquired: boolean;
    }>`select pg_try_advisory_xact_lock(hashtextextended(current_schema() || ${`:nickhosting:server:${id}`},0)) as acquired`.execute(
      tx,
    );
    if (!result.rows[0]?.acquired) throw new DomainError('conflict');
    const server = await authorizeServer(tx, context, id, 'server:manage');
    const mapping = await tx
      .selectFrom('runtime_egg_mappings')
      .select('game_id')
      .where('id', '=', server.mapping_id)
      .executeTakeFirst();
    if (mapping?.game_id !== 'satisfactory') throw new DomainError('not_found');
    const updated = await tx
      .insertInto('satisfactory_save_retention')
      .values({
        server_id: id,
        session_name: parsed.data.sessionName,
        session_key: createHash('sha256').update(parsed.data.sessionName, 'utf8').digest('hex'),
        keep_count: parsed.data.keep,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['server_id', 'session_key'])
          .doUpdateSet({
            keep_count: parsed.data.keep,
            updated_at: new Date(),
          })
          .where('satisfactory_save_retention.session_name', '=', parsed.data.sessionName),
      )
      .returning('server_id')
      .executeTakeFirst();
    if (!updated) throw new DomainError('conflict');
    await recordAudit(tx, context, 'satisfactory.worlds.retention.updated', {
      serverId: id,
      sessionName: parsed.data.sessionName,
      keep: parsed.data.keep,
    });
    return readSatisfactorySaveRetention(tx, id, env);
  });
}

/** Journal evidence labels historical safety saves, but never grants deletion rights. */
export async function classifySatisfactorySafetySaves(
  db: Kysely<Database>,
  serverId: string,
  saveNames: string[],
): Promise<Set<string>> {
  const ids = [
    ...new Set(
      saveNames.flatMap((name) => {
        const match = satisfactorySafetySaveName.exec(name);
        return match?.[1] ? [match[1]] : [];
      }),
    ),
  ];
  if (!ids.length) return new Set();
  const jobs = await db
    .selectFrom('server_operations')
    .select('job_id')
    .where('server_id', '=', serverId)
    .where('job_id', 'in', ids)
    .where('action', 'in', ['stop', 'restart', 'backup'])
    .execute();
  return new Set(jobs.map((job) => `nh-stop-${job.job_id}`));
}

async function inspectRoot(context: GameLifecycleContext, signal: AbortSignal) {
  const identifier = context.server.pterodactyl_identifier;
  if (!identifier) throw new DomainError('conflict');
  let directory = '';
  for (const name of root.split('/')) {
    signal.throwIfAborted();
    const found = (await context.adapter.listFiles(identifier, directory)).find(
      (item) => item.name === name,
    );
    if (!found || found.is_file || found.is_symlink) throw new DomainError('conflict');
    directory = [directory, name].filter(Boolean).join('/');
  }
}
async function entry(context: GameLifecycleContext, saveName: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const identifier = context.server.pterodactyl_identifier;
  if (!identifier || !satisfactorySafetySaveName.test(saveName)) throw new DomainError('conflict');
  const found = (await context.adapter.listFiles(identifier, root)).find(
    (item) => item.name === `${saveName}.sav`,
  );
  if (!found?.is_file || found.is_symlink || found.size <= 0) throw new DomainError('conflict');
  return found;
}
async function fingerprint(context: GameLifecycleContext, saveName: string, signal: AbortSignal) {
  await context.authorize();
  const before = await entry(context, saveName, signal);
  const response = await context.adapter.downloadFile(
    context.server.pterodactyl_identifier ?? '',
    `${root}/${saveName}.sav`,
    {
      signal,
      idleTimeoutMs: 5000,
      maxBytes: before.size,
      authorize: context.authorize,
    },
  );
  const reader = response.body.getReader(),
    hash = createHash('sha256');
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > before.size) throw new DomainError('conflict');
      hash.update(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const after = await entry(context, saveName, signal);
  if (size !== before.size || after.size !== size || after.modified_at !== before.modified_at)
    throw new DomainError('conflict');
  return { sha256: hash.digest('hex'), size, modified_at: after.modified_at };
}

/** Called immediately after our successful SaveGame, within the lifecycle lock.
 * Losing a receipt must never stop the normal power handoff; without one, the
 * save remains permanently outside automatic retention. */
export async function captureSatisfactorySafetySave(
  context: GameLifecycleContext,
  sessionName: string,
  saveName: string,
): Promise<void> {
  if (!sessionName || sessionName.length > 4096) return;
  try {
    if (saveName !== `nh-stop-${context.operation().job_id}`) throw new DomainError('conflict');
    const signal = AbortSignal.timeout(8000);
    await inspectRoot(context, signal);
    const proof = await fingerprint(context, saveName, signal);
    await context.db
      .insertInto('satisfactory_safety_saves')
      .values({
        server_id: context.server.id,
        save_name: saveName,
        session_name: sessionName,
        job_id: context.operation().job_id,
        path: `${root}/${saveName}.sav`,
        ...proof,
        deleted_at: null,
      })
      .onConflict((conflict) => conflict.columns(['server_id', 'save_name']).doNothing())
      .execute();
  } catch {
    await context.event('satisfactory.worlds.retention.capture_skipped');
  }
}

/** Only invoked after the provider confirms this stop, still under the lifecycle
 * lock. No manual save, autosave, or legacy name-only match is ever deleted. */
export async function rotateSatisfactorySafetySaves(
  context: GameLifecycleContext,
  env: Environment = {},
): Promise<void> {
  await context.authorize();
  await context.assertStopped();
  const policy = await readSatisfactorySaveRetention(context.db, context.server.id, env);
  const policies = new Map(policy.policies.map((item) => [item.sessionName, item.keep]));
  const receipts = await context.db
    .selectFrom('satisfactory_safety_saves')
    .selectAll()
    .where('server_id', '=', context.server.id)
    .where('deleted_at', 'is', null)
    .orderBy('created_at', 'desc')
    .orderBy('save_name', 'desc')
    .execute();
  // Only prune a world after this very stop captured a fresh recovery point.
  // Failed capture leaves every previous save untouched, even with a lower policy.
  const current = receipts.find((receipt) => receipt.job_id === context.operation().job_id);
  if (!current) return;
  const candidates = safetySaveRotationCandidates(
    receipts.filter((receipt) => receipt.session_name === current.session_name),
    (session) => policies.get(session) ?? policy.defaultKeep,
  );
  if (!candidates.length) return;
  const signal = AbortSignal.timeout(10000);
  await inspectRoot(context, signal);
  const anchors = new Map<string, (typeof receipts)[number]>();
  for (const receipt of receipts) {
    if (!anchors.has(receipt.session_name)) anchors.set(receipt.session_name, receipt);
  }
  const verifiedAnchors = new Map<string, Awaited<ReturnType<typeof fingerprint>>>();
  for (const session of new Set(candidates.map((receipt) => receipt.session_name))) {
    const anchor = anchors.get(session);
    if (!anchor) continue;
    try {
      const proof = await fingerprint(context, anchor.save_name, signal);
      if (
        proof.sha256 === anchor.sha256 &&
        proof.size === Number(anchor.size) &&
        proof.modified_at === anchor.modified_at
      )
        verifiedAnchors.set(session, proof);
    } catch {
      // Never delete older recovery points when the newest cannot be proven.
    }
  }
  let deleted = 0;
  for (const receipt of candidates) {
    if (signal.aborted || deleted >= 2) break;
    try {
      const anchor = anchors.get(receipt.session_name);
      const anchorProof = verifiedAnchors.get(receipt.session_name);
      if (
        !anchor ||
        !anchorProof ||
        anchor.save_name === receipt.save_name ||
        receipt.save_name === current.save_name
      )
        continue;
      if (receipt.path !== `${root}/${receipt.save_name}.sav`) throw new DomainError('conflict');
      const actual = await fingerprint(context, receipt.save_name, signal);
      if (
        actual.sha256 !== receipt.sha256 ||
        actual.size !== Number(receipt.size) ||
        actual.modified_at !== receipt.modified_at
      )
        throw new DomainError('conflict');
      await context.authorize();
      await context.assertStopped();
      const final = await entry(context, receipt.save_name, signal);
      if (final.size !== actual.size || final.modified_at !== actual.modified_at)
        throw new DomainError('conflict');
      const recovery = await entry(context, anchor.save_name, signal);
      if (recovery.size !== anchorProof.size || recovery.modified_at !== anchorProof.modified_at)
        throw new DomainError('conflict');
      signal.throwIfAborted();
      await context.adapter.deleteFiles(context.server.pterodactyl_identifier ?? '', root, [
        `${receipt.save_name}.sav`,
      ]);
      deleted++;
      await context.db
        .updateTable('satisfactory_safety_saves')
        .set({ deleted_at: new Date() })
        .where('server_id', '=', context.server.id)
        .where('save_name', '=', receipt.save_name)
        .execute();
      await context.event('satisfactory.worlds.retention.deleted', {
        saveName: receipt.save_name,
        sessionName: receipt.session_name,
      });
    } catch {
      // Missing, changed or unverifiable files are retained. The next stop may
      // retry a transient transport failure using the same immutable receipt.
      await context.event('satisfactory.worlds.retention.skipped', { saveName: receipt.save_name });
    }
  }
}
