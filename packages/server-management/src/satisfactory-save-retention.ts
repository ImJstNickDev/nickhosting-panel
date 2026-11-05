import { createHash } from 'node:crypto';
import { type AuthContext, DomainError, type SecretCodec } from '@nickhosting/core';
import { type Database, recordAudit } from '@nickhosting/database';
import { type Kysely, sql } from 'kysely';
import { satisfactorySessionsSchema } from '../../../games/satisfactory/src/api-schemas.js';
import { readOfflineSnapshots } from '../../../games/satisfactory/src/offline-snapshots.js';
import {
  safetySaveRotationCandidates,
  satisfactorySafetySaveName,
  satisfactorySafetySaveRetentionSchema,
} from '../../../games/satisfactory/src/save-retention.js';
import { satisfactorySaveTime } from '../../../games/satisfactory/src/save-time.js';
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

/** Journal evidence labels historical safety saves; adoption separately verifies
 * the native session, historical timestamp and stopped file bytes. */
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
 * save can only enter retention later through verified legacy adoption. */
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

/** Owner-authorized adoption of historical platform saves. The native observation
 * supplies session/time provenance and the successful operation supplies ownership.
 * A new immutable receipt captures today's bytes; names alone never enroll files. */
async function adoptLegacySafetySaves(
  context: GameLifecycleContext,
  codec: SecretCodec,
  currentSession: string,
  signal: AbortSignal,
): Promise<void> {
  const name = `gateway.satisfactory.observations.${context.server.id}`;
  const stored = await context.db
    .selectFrom('encrypted_secrets')
    .select('envelope')
    .where('name', '=', name)
    .executeTakeFirst();
  if (!stored) return;
  signal.throwIfAborted();
  const observation = readOfflineSnapshots(
    JSON.parse(codec.decrypt(stored.envelope, name)),
  ).EnumerateSessions;
  if (!observation || observation.observedAt > Date.now() + 5000 || observation.observedAt < 0)
    return;
  const parsed = satisfactorySessionsSchema.safeParse(observation.body.data);
  if (!parsed.success) return;
  const headers = parsed.data.sessions.flatMap((session) =>
    session.saveHeaders.map((save) => ({ session, save })),
  );
  const occurrences = new Map<string, number>();
  for (const { save } of headers)
    occurrences.set(save.saveName, (occurrences.get(save.saveName) ?? 0) + 1);
  const candidates = headers.flatMap(({ session, save }) => {
    const match = satisfactorySafetySaveName.exec(save.saveName);
    const at = satisfactorySaveTime(save.saveDateTime);
    return match?.[1] &&
      occurrences.get(save.saveName) === 1 &&
      session.sessionName === currentSession &&
      save.sessionName === currentSession &&
      (!save.saveLocationInfo || save.saveLocationInfo === 'SLI_Server') &&
      Number.isFinite(at) &&
      at >= 0 &&
      at <= observation.observedAt + 5000
      ? [{ saveName: save.saveName, jobId: match[1], at }]
      : [];
  });
  if (!candidates.length) return;
  // Include tombstones: a replaced or previously deleted file cannot acquire a
  // fresh receipt by reusing the same platform name.
  const existing = new Set(
    (
      await context.db
        .selectFrom('satisfactory_safety_saves')
        .select('save_name')
        .where('server_id', '=', context.server.id)
        .execute()
    ).map((row) => row.save_name),
  );
  const remaining = candidates.filter((entry) => !existing.has(entry.saveName));
  if (!remaining.length) return;
  const jobs = await context.db
    .selectFrom('server_operations as operation')
    .innerJoin('operation_jobs as job', 'job.id', 'operation.job_id')
    .select(['job.id', 'job.created_at', 'job.completed_at'])
    .where('operation.server_id', '=', context.server.id)
    .where('operation.action', 'in', ['stop', 'restart', 'backup'])
    .where('operation.phase', '=', 'complete')
    .where('job.state', '=', 'succeeded')
    .where(
      'job.id',
      'in',
      remaining.map((entry) => entry.jobId),
    )
    .execute();
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const eligible = remaining
    .flatMap((entry) => {
      const job = jobsById.get(entry.jobId);
      return job?.completed_at &&
        entry.at >= job.created_at.getTime() - 1000 &&
        entry.at <= job.completed_at.getTime()
        ? [
            {
              ...entry,
              createdAt: job.created_at.getTime(),
              completedAt: job.completed_at.getTime(),
            },
          ]
        : [];
    })
    .sort((a, b) => b.at - a.at || b.saveName.localeCompare(a.saveName));
  let adopted = 0;
  for (const candidate of eligible) {
    if (signal.aborted || adopted >= 8) break;
    try {
      await context.authorize();
      await context.assertStopped();
      const proof = await fingerprint(context, candidate.saveName, signal);
      const modifiedAt = Date.parse(proof.modified_at);
      // Changed/copied files with a different native save time remain unowned.
      if (
        Math.abs(modifiedAt - candidate.at) > 5000 ||
        !Number.isFinite(modifiedAt) ||
        modifiedAt < candidate.createdAt - 1000 ||
        modifiedAt > candidate.completedAt + 1000
      )
        continue;
      await context.assertStopped();
      signal.throwIfAborted();
      await context.db
        .insertInto('satisfactory_safety_saves')
        .values({
          server_id: context.server.id,
          save_name: candidate.saveName,
          session_name: currentSession,
          job_id: candidate.jobId,
          path: `${root}/${candidate.saveName}.sav`,
          ...proof,
          created_at: new Date(candidate.at),
          deleted_at: null,
        })
        .onConflict((conflict) => conflict.columns(['server_id', 'save_name']).doNothing())
        .execute();
      adopted++;
      await context.event('satisfactory.worlds.retention.adopted', {
        saveName: candidate.saveName,
        sessionName: currentSession,
      });
    } catch {
      await context.event('satisfactory.worlds.retention.adoption_skipped', {
        saveName: candidate.saveName,
      });
    }
  }
}

/** Only invoked after the provider confirms this stop, still under the lifecycle
 * lock. No manual save, autosave, or legacy name-only match is ever deleted. */
export async function rotateSatisfactorySafetySaves(
  context: GameLifecycleContext,
  env: Environment = {},
  codec?: SecretCodec,
): Promise<void> {
  await context.authorize();
  await context.assertStopped();
  const policy = await readSatisfactorySaveRetention(context.db, context.server.id, env);
  const policies = new Map(policy.policies.map((item) => [item.sessionName, item.keep]));
  let receipts = await context.db
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
  const signal = AbortSignal.timeout(10000);
  await inspectRoot(context, signal);
  if (codec) {
    try {
      await adoptLegacySafetySaves(context, codec, current.session_name, signal);
      receipts = await context.db
        .selectFrom('satisfactory_safety_saves')
        .selectAll()
        .where('server_id', '=', context.server.id)
        .where('deleted_at', 'is', null)
        .orderBy('created_at', 'desc')
        .orderBy('save_name', 'desc')
        .execute();
    } catch {
      await context.event('satisfactory.worlds.retention.adoption_skipped');
    }
  }
  const candidates = safetySaveRotationCandidates(
    receipts.filter((receipt) => receipt.session_name === current.session_name),
    (session) => policies.get(session) ?? policy.defaultKeep,
  );
  if (!candidates.length) return;
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
