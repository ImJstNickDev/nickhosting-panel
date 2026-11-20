import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { type Kysely, type Selectable, sql } from 'kysely';
import {
  satisfactoryModLockSchema,
  satisfactoryModSelectionSchema,
} from '../../../games/satisfactory/src/mods.js';
import {
  readSatisfactoryModInventory,
  type SatisfactoryInventory,
} from '../../../games/satisfactory/src/mods-inventory.js';
import type { SatisfactoryModLimits } from '../../../games/satisfactory/src/mods-limits.js';
import { directoryServerIdentity } from './directory-identity.js';
import { emptySatisfactoryLock } from './satisfactory-mod-manager.js';

type DB = Kysely<Database>;
type Server = Selectable<Database['managed_servers']>;
const table = 'satisfactory_mod_inventory_observations';
const revision = (id: string) =>
  sql<number>`coalesce((select revision from satisfactory_mod_states where server_id=${id}), 0)`;
export async function satisfactoryObservationScope(db: DB, server: Server) {
  const identity = await db
    .selectFrom('managed_nodes as node')
    .leftJoin('provider_accounts as owner', (join) =>
      join.on('owner.user_id', '=', server.owner_id),
    )
    .leftJoin('provider_server_projections as projection', (join) =>
      join.on('projection.server_id', '=', server.id),
    )
    .select([
      'node.pterodactyl_node_id',
      'owner.instance_id',
      'owner.provider_url',
      'owner.provider_uuid',
      'projection.identity_invalidated',
      revision(server.id).as('revision'),
    ])
    .where('node.id', '=', server.node_id)
    .executeTakeFirstOrThrow();
  if (identity.identity_invalidated) throw new DomainError('provenance_mismatch');
  return {
    revision: identity.revision,
    binding: createHash('sha256')
      .update(JSON.stringify([directoryServerIdentity(server), server.mapping_id, identity]))
      .digest('hex'),
  };
}

export async function savedSatisfactoryObservation(db: DB, id: string, binding: string) {
  const row = await db
    .selectFrom(table)
    .select([
      'observed_at',
      'inventory',
      sql<boolean>`observed_at < clock_timestamp() - interval '60 seconds'`.as('stale'),
    ])
    .where('server_id', '=', id)
    .where('binding', '=', binding)
    .executeTakeFirst();
  if (!row?.observed_at || !row.inventory) return null;
  const inventory = row.inventory as Pick<SatisfactoryInventory, 'items' | 'issues'> & {
    gameVersion: number | null;
    diverged: boolean;
  };
  return { ...inventory, observedAt: row.observed_at.toISOString(), stale: row.stale };
}

/** A display observation reads bounded descriptors and markers. Full byte verification is separate. */
export async function observeSatisfactoryMods(
  db: DB,
  server: Server,
  scope: Awaited<ReturnType<typeof satisfactoryObservationScope>>,
  adapter: PterodactylAdapter,
  authorize: () => Promise<void>,
  limits: SatisfactoryModLimits,
  signal: AbortSignal,
) {
  const id = server.id,
    identifier = server.pterodactyl_identifier;
  if (!identifier) throw new DomainError('conflict');
  const lease = randomUUID(),
    startedAt = (
      await db.selectNoFrom(sql<Date>`clock_timestamp()`.as('at')).executeTakeFirstOrThrow()
    ).at.getTime();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  const check = async () => {
    deadline.throwIfAborted();
    await authorize();
    deadline.throwIfAborted();
  };
  const until = sql<Date>`clock_timestamp() + interval '125 seconds'`;
  let waitMs = 100;
  for (;;) {
    await check();
    const claimed = await db
      .insertInto(table)
      .values({ server_id: id, lease_id: lease, lease_binding: scope.binding, lease_until: until })
      .onConflict((oc) =>
        oc
          .column('server_id')
          .doUpdateSet({ lease_id: lease, lease_binding: scope.binding, lease_until: until })
          .where((eb) =>
            eb.or([
              eb(`${table}.lease_id`, 'is', null),
              eb(`${table}.lease_binding`, '!=', scope.binding),
              eb(`${table}.lease_until`, '<=', sql<Date>`clock_timestamp()`),
            ]),
          )
          .where((eb) =>
            eb.or([
              eb(`${table}.binding`, 'is', null),
              eb(`${table}.binding`, '!=', scope.binding),
              eb(`${table}.observed_at`, '<', new Date(startedAt)),
            ]),
          ),
      )
      .returning('server_id')
      .executeTakeFirst();
    if (claimed) break;
    const saved = await savedSatisfactoryObservation(db, id, scope.binding);
    if (saved && Date.parse(saved.observedAt) >= startedAt) {
      await check();
      return saved;
    }
    await delay(waitMs, undefined, { signal: deadline });
    waitMs = Math.min(waitMs * 2, 1000);
  }
  let published = false;
  try {
    const state = await db
      .selectFrom('satisfactory_mod_states')
      // Migration 059 used an empty object as the default for an uninitialized lock.
      .select(['revision', 'selection', sql<unknown>`nullif(lock, '{}'::jsonb)`.as('lock')])
      .where('server_id', '=', id)
      .executeTakeFirst();
    if ((state?.revision ?? 0) !== scope.revision) throw new DomainError('conflict');
    const selection = satisfactoryModSelectionSchema.parse(state?.selection ?? []);
    const lock = satisfactoryModLockSchema.parse(state?.lock ?? emptySatisfactoryLock);
    let metadataBytes = 0;
    const reading = await readSatisfactoryModInventory({
      listFiles: async (path) => {
        await check();
        return adapter.listFiles(identifier, path);
      },
      readFile: async (path, max) => {
        await check();
        const bytes = Buffer.from(await adapter.readFile(identifier, path, max));
        metadataBytes += bytes.length;
        if (metadataBytes > limits.metadataBytes) throw new DomainError('conflict');
        return bytes;
      },
      selection,
      maxEntries: limits.maxFiles * 2,
    });
    await check();
    // A descriptor or marker can prove visible drift. Byte-only changes are
    // checked against the full fingerprint at preview, apply and external adoption.
    const expected = new Map(
      Object.entries(lock.mods).filter(([, mod]) => mod.targets.LinuxServer),
    );
    const managed = new Set(reading.items.filter((mod) => mod.managed).map((mod) => mod.reference));
    const inventory = {
      diverged:
        reading.items.some(
          (mod) =>
            mod.managed &&
            (!expected.has(mod.reference) || expected.get(mod.reference)?.version !== mod.version),
        ) || [...expected.keys()].some((ref) => !managed.has(ref)),
      items: reading.items,
      issues: reading.issues,
      gameVersion: reading.gameBuild,
    };
    if ((await satisfactoryObservationScope(db, server)).binding !== scope.binding)
      throw new DomainError('conflict');
    const result = await db
      .updateTable(table)
      .set({
        binding: scope.binding,
        inventory: JSON.stringify(inventory),
        observed_at: sql<Date>`clock_timestamp()`,
        lease_id: null,
        lease_binding: null,
        lease_until: null,
      })
      .where('server_id', '=', id)
      .where('lease_id', '=', lease)
      .where(revision(id), '=', scope.revision)
      .returning('observed_at')
      .executeTakeFirst();
    if (!result?.observed_at) throw new DomainError('conflict');
    published = true;
    return { ...inventory, observedAt: result.observed_at.toISOString(), stale: false };
  } finally {
    if (!published)
      await db
        .updateTable(table)
        .set({ lease_id: null, lease_binding: null, lease_until: null })
        .where('server_id', '=', id)
        .where('lease_id', '=', lease)
        .execute();
  }
}
