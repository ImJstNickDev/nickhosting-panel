import { createHash } from 'node:crypto';
import { hashArchiveFile, visitArchive } from '@nickhosting/content-providers';
import { DomainError, type SecretCodec } from '@nickhosting/core';
import { type Database, notifyGatewayChange } from '@nickhosting/database';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import { type Selectable, sql } from 'kysely';
import { z } from 'zod';
import {
  OpenworldTokenExpired,
  openworldDashboardToken,
  readOpenworldTelemetry,
} from '../../../games/openworld/src/dashboard-api.js';
import { dispatchOpenworldPlayerAction } from '../../../games/openworld/src/native-player-actions.js';
import type { Environment } from './admission.js';
import type { GameUpdateHooks, VersionUpdatePreparation } from './game-version-update.js';
import type { GameLifecycleContext } from './lifecycle.js';
import { downloadOpenworldRelease } from './openworld-catalog.js';
import { resolveOpenworldDashboardTarget } from './openworld-dashboard.js';
import {
  assertCurrentOpenworldScope,
  readOpenworldScope,
  sharedReads,
} from './openworld-telemetry.js';
import { openworldUpdatePlanSchema } from './openworld-update-plan.js';

type Progress = Selectable<Database['openworld_server_updates']>;
type Phase = Progress['phase'];
const beforeStop: Phase[] = ['preparing', 'waiting-empty', 'notice'];
const binaryProof = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.int().positive(),
});

export async function inspectOpenworldUpdate(bytes: Uint8Array) {
  let binary: z.infer<typeof binaryProof> | undefined;
  const required = new Set(['README.txt', 'THIRD-PARTY-NOTICES.txt']);
  let assets = false;
  // Match the distribution roots accepted by the installed egg. A malformed
  // release must be discovered while the previous server is still available.
  await visitArchive(
    bytes,
    async (file) => {
      if (file.path === 'openworld-server')
        binary = binaryProof.parse({ size: file.size, sha256: await hashArchiveFile(file) });
      else {
        if (file.path.startsWith('assets/')) assets = true;
        else if (!required.delete(file.path)) throw new DomainError('validation_failed');
        await hashArchiveFile(file); // validate the size and CRC of every distributed asset
      }
    },
    { maxEntries: 20000, maxArchiveBytes: 128 * 1024 ** 2, maxExpandedBytes: 1536 * 1024 ** 2 },
    async (path) => {
      if (!path.startsWith('assets/')) throw new DomainError('validation_failed');
    },
  );
  if (!binary || !assets || required.size) throw new DomainError('validation_failed');
  return binary;
}

function progressRow(c: GameLifecycleContext) {
  return c.db
    .selectFrom('openworld_server_updates')
    .selectAll()
    .where('server_id', '=', c.server.id)
    .where('job_id', '=', c.operation().job_id)
    .executeTakeFirstOrThrow();
}

async function moveOpenworldUpdate(
  c: GameLifecycleContext,
  from: readonly Phase[],
  phase: Phase,
  fields: { deadline?: Date | null; restart?: boolean } = {},
) {
  const row = await c.db.transaction().execute(async (tx) => {
    const moved = await tx
      .updateTable('openworld_server_updates')
      .set({ phase, updated_at: new Date(), ...fields })
      .where('job_id', '=', c.operation().job_id)
      .where('server_id', '=', c.server.id)
      .where('phase', 'in', from)
      .returningAll()
      .executeTakeFirst();
    if (moved && (phase === 'stopping' || phase === 'starting')) await notifyGatewayChange(tx);
    return moved;
  });
  return row ?? progressRow(c);
}

async function nativeConnection(c: GameLifecycleContext) {
  const { address: origin, password } = await resolveOpenworldDashboardTarget(
    c.db,
    c.adapter,
    c.server.id,
  );
  const signal = AbortSignal.timeout(4500);
  const token = await openworldDashboardToken(origin, password, signal);
  return { origin, token, signal, fetcher: fetch };
}

function createOccupancyReader() {
  const tokens = sharedReads<{ origin: string; token: string }>(256, Date.now, 60000);
  return async (c: GameLifecycleContext, fresh = false) => {
    try {
      const scope = await readOpenworldScope(c.db, c.server.id);
      if (scope.reason) return null;
      const load = async () => {
        const { origin, token } = await nativeConnection(c);
        if (scope.origin !== origin) throw new DomainError('provenance_mismatch');
        assertCurrentOpenworldScope(scope, await readOpenworldScope(c.db, c.server.id));
        return { origin, token };
      };
      const cached = fresh ? load() : tokens.get(scope.liveKey, 60000, load);
      const { origin, token } = await cached;
      try {
        const { players } = await readOpenworldTelemetry(
          origin,
          token,
          'status',
          AbortSignal.timeout(4500),
        );
        assertCurrentOpenworldScope(scope, await readOpenworldScope(c.db, c.server.id));
        if (
          players.connecting == null ||
          !Number.isSafeInteger(players.connecting) ||
          players.connecting < 0
        )
          return players.online > 0 ? players.online : null;
        return players.online + players.connecting;
      } catch (error) {
        if (error instanceof OpenworldTokenExpired) tokens.discard(scope.liveKey, cached);
        return null;
      }
    } catch {
      return null;
    }
  };
}

async function kickForOpenworldUpdate(c: GameLifecycleContext) {
  // The native kick endpoint accepts a reason. Use current connection IDs only
  // within this snapshot and give the entire courtesy a bounded time budget.
  const { target } = openworldUpdatePlanSchema.parse(c.operation().plan.openworldUpdate);
  const native = await nativeConnection(c);
  const { players } = await readOpenworldTelemetry(
    native.origin,
    native.token,
    'players',
    native.signal,
  );
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, players.length) }, async () => {
      while (!native.signal.aborted && index < players.length) {
        const player = players[index++];
        if (player)
          await dispatchOpenworldPlayerAction(native, player.id, {
            kind: 'kick',
            reason: `Server restarting to update to Openworld ${target.version}.`,
          }).catch(() => {});
      }
    }),
  );
}

async function broadcast(c: GameLifecycleContext, seconds: number, reminder: boolean) {
  const key = reminder ? 'openworldReminderAttempted' : 'openworldNoticeAttempted';
  if (c.operation().plan[key] === true) return;
  const { target } = openworldUpdatePlanSchema.parse(c.operation().plan.openworldUpdate);
  // Sending a message is at most once. A worker interruption cannot move the deadline.
  await c.update({ plan: { ...c.operation().plan, [key]: true } });
  await c.authorize();
  try {
    const when = seconds ? `in ${seconds} seconds` : 'now';
    await c.adapter.sendCommand(
      c.server.pterodactyl_identifier ?? '',
      `say Server restarting ${when} to update to Openworld ${target.version}.`,
    );
  } catch {
    await c.db
      .updateTable('openworld_server_updates')
      .set({ warning: reminder ? 'reminder_failed' : 'notice_failed', updated_at: new Date() })
      .where('job_id', '=', c.operation().job_id)
      .execute();
  }
}

function preparation(row: Progress): VersionUpdatePreparation {
  if (row.phase === 'cancelled') return { state: 'cancelled' };
  if (beforeStop.includes(row.phase))
    return { state: 'wait', ...(row.deadline ? { next: row.deadline } : {}) };
  return { state: 'stop' };
}

export function createOpenworldUpdateHooks(
  codec: SecretCodec,
  env: Environment,
  services = {
    download: downloadOpenworldRelease,
    occupancy: createOccupancyReader(),
    kick: kickForOpenworldUpdate,
  },
) {
  const hooks: GameUpdateHooks = {
    async cancelled(c) {
      return (await progressRow(c)).phase === 'cancelled';
    },
    async stage(c, phase) {
      const from: Record<typeof phase, Phase[]> = {
        backup: ['stopping'],
        installing: ['stopping', 'backup'],
        verifying: ['installing'],
        starting: ['verifying'],
      };
      await moveOpenworldUpdate(c, from[phase], phase);
    },
    async finish(tx, jobId, success) {
      await tx
        .updateTable('openworld_server_updates')
        .set({ phase: success ? 'completed' : 'failed', updated_at: new Date() })
        .where('job_id', '=', jobId)
        .where('phase', '!=', 'cancelled')
        .execute();
      await tx.deleteFrom('openworld_update_artifacts').where('job_id', '=', jobId).execute();
    },
    async prepare(c: GameLifecycleContext, stopped: () => Promise<boolean>, now: () => Date) {
      const update = openworldUpdatePlanSchema.parse(c.operation().plan.openworldUpdate);
      let row = await progressRow(c);
      if (row.phase === 'cancelled' || !beforeStop.includes(row.phase)) return preparation(row);
      if (c.operation().plan.openworldBinary === undefined) {
        await c.authorize();
        // A worker can exit after publishing the verified archive but before recording
        // the binary proof. Resume locally even if the upstream has gone offline.
        const saved = await c.db
          .selectFrom('openworld_update_artifacts')
          .select('archive')
          .where('job_id', '=', c.operation().job_id)
          .where('sha256', '=', update.target.sha256)
          .executeTakeFirst();
        const bytes = saved?.archive ?? (await services.download(c.db, codec, env, update.target));
        const binary = await inspectOpenworldUpdate(bytes);
        if (!saved)
          await c.db
            .insertInto('openworld_update_artifacts')
            .values({
              job_id: c.operation().job_id,
              sha256: update.target.sha256,
              archive: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            })
            .onConflict((k) => k.column('job_id').doNothing())
            .execute();
        await c.update({ plan: { ...c.operation().plan, openworldBinary: binary } });
        row = await progressRow(c);
        if (row.phase === 'cancelled') return preparation(row);
      }
      const nextNotice = (deadline: Date) => {
        const reminder = deadline.getTime() - 30000;
        return {
          state: 'wait' as const,
          next:
            update.delaySeconds > 60 && now().getTime() < reminder ? new Date(reminder) : deadline,
        };
      };
      if (row.phase === 'notice' && row.deadline) {
        const seconds = Math.ceil((row.deadline.getTime() - now().getTime()) / 1000);
        if (seconds > 0) {
          if (c.operation().plan.openworldNoticeAttempted !== true)
            await broadcast(c, seconds, false);
          else if (update.delaySeconds > 60 && seconds <= 30) await broadcast(c, seconds, true);
          return nextNotice(row.deadline);
        }
        return preparation(
          await moveOpenworldUpdate(c, beforeStop, 'stopping', { restart: !(await stopped()) }),
        );
      }
      let offline = false;
      let count: number | null;
      if (row.phase === 'waiting-empty') {
        count = await services.occupancy(c);
        if (count !== null && count > 0) return { state: 'wait' };
        if (count === null) {
          // Unknown occupancy can mean a temporarily inaccessible dashboard.
          // Reconcile physical shutdown at most once per minute across retries.
          const nextProof = Number(c.operation().plan.gameUpdateNextStopProof ?? 0);
          if (nextProof > now().getTime()) return { state: 'wait' };
          offline = await stopped();
          if (!offline) {
            await c.update({
              plan: { ...c.operation().plan, gameUpdateNextStopProof: now().getTime() + 60000 },
            });
            return { state: 'wait' };
          }
        }
      } else {
        offline = await stopped();
        count = offline ? 0 : await services.occupancy(c);
      }
      if (!offline) {
        if (update.waitForEmpty && count !== 0)
          return preparation(await moveOpenworldUpdate(c, beforeStop, 'waiting-empty'));
        if (count !== 0 && update.delaySeconds > 0 && !update.waitForEmpty) {
          const deadline = new Date(now().getTime() + update.delaySeconds * 1000);
          row = await moveOpenworldUpdate(c, ['preparing'], 'notice', { deadline, restart: true });
          if (row.phase === 'notice') {
            await broadcast(c, update.delaySeconds, false);
            return nextNotice(deadline);
          }
          return preparation(row);
        }
        if (count !== 0 && !update.waitForEmpty) {
          row = await moveOpenworldUpdate(c, beforeStop, 'stopping', { restart: true });
          if (row.phase === 'stopping') await broadcast(c, 0, false);
          return preparation(row);
        }
      }
      // The API cancellation competes with this transition inside PostgreSQL.
      // Only the winner may dispatch the stop.
      return preparation(
        await moveOpenworldUpdate(c, beforeStop, 'stopping', { restart: !offline }),
      );
    },
    async verify(c: GameLifecycleContext) {
      const operation = c.operation();
      const { source, target } = openworldUpdatePlanSchema.parse(operation.plan.openworldUpdate);
      const expected = binaryProof.parse(operation.plan.openworldBinary);
      await c.authorize();
      let file: Awaited<ReturnType<typeof c.adapter.downloadFile>>;
      const identifier = c.server.pterodactyl_identifier ?? '';
      try {
        file = await c.adapter.downloadFile(identifier, 'openworld-server', {
          maxBytes: expected.size,
          refillGrant: false,
        });
      } catch (error) {
        // A bounded transfer rejects an oversized Content-Length before opening
        // the stream. Corroborate with a fresh directory read to distinguish a
        // wrong installation from a transient transport failure.
        if (
          error instanceof PterodactylError &&
          ['not_found', 'invalid_response'].includes(error.reason)
        ) {
          const entries = await c.adapter.listFiles(identifier, '');
          const entry = entries.find((item) => item.name === 'openworld-server');
          if (!entry?.is_file || entry.is_symlink || entry.size !== expected.size)
            throw new DomainError('configuration_invalid', 503, {
              reason: 'installation_outputs_missing',
            });
        }
        throw error;
      }
      const hash = createHash('sha256');
      let size = 0;
      const reader = file.body.getReader();
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > expected.size)
            throw new DomainError('configuration_invalid', 503, {
              reason: 'installation_outputs_missing',
            });
          hash.update(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (size !== expected.size || hash.digest('hex') !== expected.sha256)
        throw new DomainError('configuration_invalid', 503, {
          reason: 'installation_outputs_missing',
        });
      await c.db.transaction().execute(async (tx) => {
        const profile = await tx
          .selectFrom('openworld_server_profiles')
          .selectAll()
          .where('server_id', '=', c.server.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (profile.version !== target.version || profile.sha256 !== target.sha256) {
          if (profile.version !== source.version || profile.sha256 !== source.sha256)
            throw new DomainError('conflict');
          await tx
            .updateTable('openworld_server_profiles')
            .set({ ...target, history_sha256: sql<string>`coalesce(history_sha256, sha256)` })
            .where('server_id', '=', c.server.id)
            .execute();
        }
        await tx
          .updateTable('gateway_server_states')
          .set({ game_version: target.version, updated_at: new Date() })
          .where('server_id', '=', c.server.id)
          .where('protocol_id', '=', 'openworld')
          .execute();
        await tx
          .deleteFrom('installation_reservations')
          .where('server_id', '=', c.server.id)
          .where('operation_id', '=', operation.job_id)
          .execute();
        await notifyGatewayChange(tx);
      });
      await c.update({ plan: { ...c.operation().plan, openworldVersionVerified: true } });
    },
    async allowStop(c) {
      const plan = openworldUpdatePlanSchema.parse(c.operation().plan.openworldUpdate);
      return !plan.waitForEmpty || (await services.occupancy(c, true)) === 0;
    },
    async deferStop(tx, jobId) {
      await tx
        .updateTable('openworld_server_updates')
        .set({ phase: 'waiting-empty', deadline: null, updated_at: new Date() })
        .where('job_id', '=', jobId)
        .where('phase', '=', 'stopping')
        .execute();
      await notifyGatewayChange(tx);
    },
    async beforeStop(c) {
      if (!openworldUpdatePlanSchema.parse(c.operation().plan.openworldUpdate).waitForEmpty)
        await services.kick(c);
    },
  };
  return hooks;
}
