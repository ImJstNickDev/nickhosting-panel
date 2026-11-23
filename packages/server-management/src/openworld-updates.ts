import { type AuthContext, DomainError, type SecretCodec } from '@nickhosting/core';
import { recordAudit } from '@nickhosting/database';
import { z } from 'zod';
import { openworldUpgradeChoices } from '../../../games/openworld/src/update-releases.js';
import { type DB, type Environment, lockResources } from './admission.js';
import { currentInteractiveContext } from './interactive-context.js';
import { listOpenworldReleases } from './openworld-catalog.js';
import { openworldUpdatePlanSchema, openworldUpdateSelection } from './openworld-update-plan.js';
import { getOpenworldUpdateNoticeSeconds } from './openworld-update-settings.js';
import { wakeInstallationOperationInTransaction } from './provider-installation-events.js';
import {
  authorizeServer,
  enqueueServerOperation,
  parse,
  replayManagedGameOperation,
} from './registry.js';

const request = z.strictObject({
  version: z.string(),
  expectedVersion: z.string(),
  mode: z.enum(['timed', 'when-empty', 'immediate']),
  noticeSeconds: z.number().optional(),
  backupBefore: z.boolean(),
  idempotencyKey: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
});
const cancellable = ['preparing', 'notice', 'waiting-empty'] as const;

async function installed(db: DB, who: AuthContext, id: string) {
  const server = await authorizeServer(db, who, id, 'server:manage');
  const release = await db
    .selectFrom('openworld_server_profiles as p')
    .innerJoin('runtime_egg_mappings as m', (join) => join.on('m.id', '=', server.mapping_id))
    .where('m.game_id', '=', 'openworld')
    .where('m.runtime_id', '=', 'dedicated')
    .where('p.server_id', '=', id)
    .select(['p.version', 'p.size', 'p.sha256'])
    .executeTakeFirst();
  if (!release) throw new DomainError('not_found');
  return release;
}

async function snapshot(db: DB, serverId: string, jobId?: string) {
  let query = db
    .selectFrom('openworld_server_updates as u')
    .innerJoin('server_operations as o', 'o.job_id', 'u.job_id')
    .innerJoin('operation_jobs as j', 'j.id', 'u.job_id')
    .where('u.server_id', '=', serverId)
    .selectAll('u')
    .select(['o.plan', 'j.error_code', 'j.state']);
  if (jobId) query = query.where('u.job_id', '=', jobId);
  const row = await query
    .orderBy('u.created_at', 'desc')
    .orderBy('u.job_id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  const plan = openworldUpdatePlanSchema.parse(row.plan.openworldUpdate);
  const phase = row.state === 'failed' && row.phase !== 'cancelled' ? 'failed' : row.phase;
  return {
    id: row.job_id,
    fromVersion: plan.source.version,
    toVersion: plan.target.version,
    phase,
    deadline: row.deadline?.toISOString() ?? null,
    startedAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    restart: row.restart,
    warning: row.warning,
    error: row.error_code,
    backupBefore: plan.backupBefore,
    cancellable: cancellable.some((p) => p === phase),
  };
}

export function createOpenworldUpdates(
  db: DB,
  codec: SecretCodec | undefined,
  env: Environment = {},
) {
  async function releases() {
    if (!codec) throw new DomainError('integration_unavailable');
    return listOpenworldReleases(db, codec, env);
  }
  async function byId(server: string, job: string) {
    const item = await snapshot(db, server, job);
    if (!item) throw new DomainError('not_found');
    return item;
  }
  return {
    async options(who: AuthContext, id: string) {
      const source = await installed(db, who, id);
      const [catalog, defaultNoticeSeconds, current] = await Promise.all([
        releases(),
        getOpenworldUpdateNoticeSeconds(db, env),
        snapshot(db, id),
      ]);
      const choices = openworldUpgradeChoices(source.version, catalog);
      const recommended =
        choices.find((choice) => !choice.version.startsWith('pre-')) ?? choices[0];
      return {
        installedVersion: source.version,
        latestVersion: recommended?.version ?? null,
        releases: choices.map(({ version, size }) => ({ version, size })),
        defaultNoticeSeconds,
        current,
      };
    },
    async current(who: AuthContext, id: string) {
      await installed(db, who, id);
      return { current: await snapshot(db, id) };
    },
    async submit(who: AuthContext, id: string, body: unknown) {
      const { backupBefore, idempotencyKey, ...choice } = parse(request, body);
      const selection = parse(openworldUpdateSelection, choice);
      const op = {
        action: 'reinstall',
        confirm: true,
        idempotencyKey,
        backupBefore,
        openworldVersion: selection,
      };
      const replay = await replayManagedGameOperation(db, who, id, op, env);
      if (replay) return byId(id, replay.jobId);
      const source = await installed(db, who, id);
      if (source.version !== selection.expectedVersion) throw new DomainError('conflict');
      const target = openworldUpgradeChoices(source.version, await releases()).find(
        (r) => r.version === selection.version,
      );
      if (!target) throw new DomainError('conflict');
      const delaySeconds =
        selection.mode === 'timed'
          ? (selection.noticeSeconds ?? (await getOpenworldUpdateNoticeSeconds(db, env)))
          : 0;
      const result = await enqueueServerOperation(db, who, id, op, env, {
        openworldUpdate: {
          source,
          target,
          delaySeconds,
          waitForEmpty: selection.mode === 'when-empty',
          backupBefore,
        },
      });
      return byId(id, result.jobId);
    },
    async cancel(who: AuthContext, id: string, job: string) {
      parse(z.uuid(), job);
      await installed(db, who, id);
      return db.transaction().execute(async (tx) => {
        // Match terminal lifecycle's resource lock and wait()'s job lock.
        // Cancellation and its outbox wake must commit together.
        await lockResources(tx);
        const actor = await currentInteractiveContext(tx, who, env);
        await installed(tx, actor, id);
        const pending = await tx
          .selectFrom('operation_jobs as j')
          .innerJoin('openworld_server_updates as u', 'u.job_id', 'j.id')
          .select('j.state')
          .where('u.server_id', '=', id)
          .where('j.id', '=', job)
          .forUpdate('j')
          .executeTakeFirst();
        if (!pending) throw new DomainError('not_found');
        if (!['queued', 'running'].includes(pending.state)) {
          const terminal = await snapshot(tx, id, job);
          if (terminal?.phase === 'cancelled') return terminal;
          throw new DomainError('conflict');
        }
        const cancelled = await tx
          .updateTable('openworld_server_updates')
          .set({ phase: 'cancelled', deadline: null, updated_at: new Date() })
          .where('server_id', '=', id)
          .where('job_id', '=', job)
          .where('phase', 'in', cancellable)
          .returning('job_id')
          .executeTakeFirst();
        const row = await snapshot(tx, id, job);
        if (!row) throw new DomainError('not_found');
        if (row.phase !== 'cancelled') throw new DomainError('conflict');
        if (cancelled) {
          await wakeInstallationOperationInTransaction(tx, job, new Date());
          await recordAudit(tx, actor, 'openworld.update.cancelled', { serverId: id, jobId: job });
        }
        return row;
      });
    },
  };
}
