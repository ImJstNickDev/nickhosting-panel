import { type AuthContext, DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { FilemanReadService } from '@nickhosting/game-sdk';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql } from 'kysely';
import {
  listSavedPlayerFiles,
  type OpenworldSavedPlayersPage,
  readSavedPlayerDocuments,
  savedAccountId,
} from '../../../games/openworld/src/offline-players.js';
import { readOpenworldScope } from './openworld-telemetry.js';

const maxBatch = 32;
const pageSize = 40;
const directory = 'openworld_player_directories';
const players = 'openworld_saved_players';
type DB = Kysely<Database>;
type WithFiles = <T>(
  who: AuthContext,
  id: string,
  work: (files: FilemanReadService) => Promise<T>,
) => Promise<T>;
const authorized = (db: DB, who: AuthContext, id: string) =>
  readOpenworldScope(db, id, { who, resource: 'player' });

async function checkBinding(db: DB, who: AuthContext, id: string, binding: string) {
  if ((await authorized(db, who, id)).binding !== binding)
    throw new DomainError('provenance_mismatch');
}
const lastScan = (db: DB, id: string, binding: string) =>
  db
    .selectFrom(directory)
    .selectAll()
    .where('server_id', '=', id)
    .where('binding', '=', binding)
    .executeTakeFirst();

export function createOpenworldPlayerDirectory(db: DB, withFiles: WithFiles, now = Date.now) {
  const active = new Map<string, Promise<void>>();
  const failures = new Map<string, { until: number; error: unknown; canUseIndex: boolean }>();

  async function refresh(
    who: AuthContext,
    id: string,
    binding: string,
    baseline: number | undefined,
  ) {
    const started = new Date(now());
    const previous = await db
      .selectFrom(players)
      .innerJoin(directory, `${directory}.server_id`, `${players}.server_id`)
      .select(['file_stem', 'revision'])
      .where(`${directory}.server_id`, '=', id)
      .where('binding', '=', binding)
      .execute();
    const known = new Map(previous.map((p) => [p.file_stem, p.revision]));
    const scan = await withFiles(who, id, async (files) => {
      const candidates = await listSavedPlayerFiles(files);
      // Some provider versions omit mtime. Re-read those candidates periodically even
      // when a save is replaced with a different document of the same length.
      for (const ref of candidates.values()) {
        if (ref.save?.time === null || ref.stats?.time === null)
          ref.revision += `:${Math.floor(started.getTime() / 300000)}`;
      }
      const changed = Array.from(candidates.values()).filter(
        (r) => known.get(r.stem) !== r.revision,
      );
      // A file whose contents change frequently must not starve newly discovered players.
      changed.sort(
        (a, b) =>
          Number(known.has(a.stem)) - Number(known.has(b.stem)) || a.stem.localeCompare(b.stem),
      );
      const batch = changed.slice(0, maxBatch);
      const details = await readSavedPlayerDocuments(files, batch);
      const pending = new Set(changed.slice(maxBatch).map((r) => r.stem));
      return {
        rows: batch.map((r, i) => ({
          server_id: id,
          file_stem: r.stem,
          revision: r.revision,
          account_id: details[i]?.uuid ?? null,
          display_name: details[i]?.name ?? null,
          saved_at: details[i]?.savedAt ? new Date(details[i].savedAt) : null,
        })),
        // Drop rows for removed files and outdated entries not verified in this batch.
        remove: previous
          .filter((p) => !candidates.has(p.file_stem) || pending.has(p.file_stem))
          .map((p) => p.file_stem),
        indexing: changed.length > batch.length,
      };
    });
    await db.transaction().execute(async (tx) => {
      const server = await tx
        .selectFrom('managed_servers')
        .select('id')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!server) throw new DomainError('not_found');
      await checkBinding(tx, who, id, binding);
      const state = await tx
        .selectFrom(directory)
        .selectAll()
        .where('server_id', '=', id)
        .executeTakeFirst();
      // Another API process published a different scan since our directory diff began.
      if (state?.binding === binding && state.indexed_at.getTime() !== baseline) return;
      if (state?.binding !== binding)
        await tx.deleteFrom(directory).where('server_id', '=', id).execute();
      await tx
        .insertInto(directory)
        .values({ server_id: id, binding, indexed_at: started, indexing: scan.indexing })
        .onConflict((c) =>
          c
            .column('server_id')
            .doUpdateSet({ binding, indexed_at: started, indexing: scan.indexing }),
        )
        .execute();
      if (scan.remove.length)
        await tx
          .deleteFrom(players)
          .where('server_id', '=', id)
          .where(sql<boolean>`file_stem = any(${sql.val(scan.remove)}::text[])`)
          .execute();
      if (scan.rows.length)
        await tx
          .insertInto(players)
          .values(scan.rows)
          .onConflict((c) =>
            c.columns(['server_id', 'file_stem']).doUpdateSet((eb) => ({
              revision: eb.ref('excluded.revision'),
              account_id: eb.ref('excluded.account_id'),
              display_name: eb.ref('excluded.display_name'),
              saved_at: eb.ref('excluded.saved_at'),
            })),
          )
          .execute();
    });
  }
  return {
    async list(
      who: AuthContext,
      id: string,
      search: string,
      page: number,
    ): Promise<OpenworldSavedPlayersPage> {
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000 || search.length > 150)
        throw new DomainError('validation_failed');
      const { binding } = await authorized(db, who, id);
      const last = await lastScan(db, id, binding);
      const due = !last || now() - last.indexed_at.getTime() >= (last.indexing ? 1000 : 60000);
      let refreshing = false;
      if (due) {
        const failed = failures.get(binding);
        if (failed && failed.until > now()) {
          if (!last || !failed.canUseIndex) throw failed.error;
        } else {
          let task = active.get(binding);
          if (!task && active.size < 64) {
            task = refresh(who, id, binding, last?.indexed_at.getTime())
              .catch((error: unknown) => {
                const canUseIndex =
                  error instanceof PterodactylError
                    ? ['unavailable', 'timeout', 'rate_limited'].includes(error.reason)
                    : error instanceof DomainError &&
                      ['integration_unavailable', 'game_not_ready'].includes(error.code);
                // A caller's revoked grant must not poison another viewer's cache.
                if (
                  canUseIndex ||
                  (error instanceof DomainError && error.code === 'provenance_mismatch')
                ) {
                  if (failures.size >= 256) failures.delete(failures.keys().next().value as string);
                  const backoff =
                    error instanceof PterodactylError ? (error.retryAfterMs ?? 5000) : 5000;
                  failures.set(binding, {
                    until: now() + Math.max(1000, backoff),
                    error,
                    canUseIndex,
                  });
                }
                throw error;
              })
              .finally(() => active.delete(binding));
            failures.delete(binding);
            active.set(binding, task);
          }
          if (!last) {
            if (!task) throw new DomainError('rate_limited');
            await task;
          } else if (task) {
            refreshing = true;
            void task.catch(() => {});
          }
        }
      }
      return db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (tx) => {
          await checkBinding(tx, who, id, binding);
          const state = await lastScan(tx, id, binding);
          if (!state) throw new DomainError('integration_unavailable');
          let query = tx
            .selectFrom(players)
            .where('server_id', '=', id)
            .where('account_id', 'is not', null);
          if (search)
            query = query.where(
              sql<boolean>`(strpos(lower(account_id),lower(${search})) > 0 OR strpos(lower(coalesce(display_name,'')),lower(${search})) > 0)`,
            );
          const count = await query
            .select((eb) => eb.fn.count<string>('account_id').distinct().as('n'))
            .executeTakeFirstOrThrow();
          const summaries = query
            .select(['account_id', 'display_name', 'saved_at'])
            .$narrowType<{ account_id: string }>()
            .distinctOn('account_id')
            .orderBy('account_id')
            .orderBy(sql`saved_at desc nulls last`)
            .orderBy('file_stem');
          const found = await tx
            .selectFrom(summaries.as('matched'))
            .selectAll()
            .orderBy(sql`saved_at desc nulls last`)
            .orderBy('account_id')
            .limit(pageSize)
            .offset((page - 1) * pageSize)
            .execute();
          return {
            players: found.map((p) => ({
              uuid: p.account_id,
              name: p.display_name,
              savedAt: p.saved_at?.toISOString() ?? null,
            })),
            page,
            total: Number(count.n),
            indexedAt: state.indexed_at.toISOString(),
            indexing: state.indexing || refreshing,
            stale: now() - state.indexed_at.getTime() >= 60000,
          };
        });
    },
    async detail(who: AuthContext, id: string, uuid: string) {
      if (!savedAccountId.test(uuid)) throw new DomainError('validation_failed');
      const { binding } = await authorized(db, who, id);
      const detail = await withFiles(who, id, async (files) => {
        const refs = await listSavedPlayerFiles(files);
        const candidates = [
          refs.get(uuid),
          ...(uuid.startsWith('guest:') ? [refs.get(uuid.slice(6))] : []),
        ].filter((r) => r !== undefined);
        const records = (await readSavedPlayerDocuments(files, candidates)).filter(
          (p) => p?.uuid === uuid,
        );
        const player = records.find((p) => p?.savedAt) ?? records[0];
        if (!player) throw new DomainError('not_found');
        const stats = records.find((p) => p?.stats);
        return { ...player, stats: stats?.stats ?? null, statsAt: stats?.statsAt ?? null };
      });
      await checkBinding(db, who, id, binding);
      return detail;
    },
  };
}
