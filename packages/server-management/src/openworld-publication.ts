import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import { type DashboardProxyProvider, dashboardHostname } from '@nickhosting/external-services';
import { type Kysely, sql } from 'kysely';

type DB = Kysely<Database>;

async function currentHostname(db: DB, serverId: string) {
  const row = await db
    .selectFrom('openworld_dashboard_dns')
    .select('hostname')
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  return row && dashboardHostname(row.hostname) ? row.hostname : null;
}

/** A DNS apply can temporarily enter pending/uncertain for the same name.
 * The ingress denies it immediately; keep its certificate until DNS settles. */
async function pendingHostname(db: DB, serverId: string, hostname: string) {
  return db
    .selectFrom('server_dns_preferences as p')
    .innerJoin('dns_assignments as d', (j) =>
      j.onRef('d.id', '=', 'p.assignment_id').onRef('d.server_id', '=', 'p.server_id'),
    )
    .innerJoin('managed_servers as s', 's.id', 'p.server_id')
    .select('d.id')
    .where('s.id', '=', serverId)
    .where('s.deleted_at', 'is', null)
    .where('p.enabled', '=', true)
    .where('d.hostname', '=', hostname)
    .where('d.state', 'in', ['pending', 'uncertain'])
    .where(sql<boolean>`d.plan->>'action' = 'apply' and not(d.plan ? 'sharedHostId')`)
    .executeTakeFirst();
}

export async function resolveOpenworldPublication(db: DB, hostname: string) {
  if (!dashboardHostname(hostname)) return;
  return db
    .selectFrom('openworld_dashboard_dns as d')
    .innerJoin('openworld_dashboard_publications as pub', 'pub.server_id', 'd.server_id')
    .select('d.server_id as serverId')
    .where('d.hostname', '=', hostname)
    .where('pub.enabled', '=', true)
    .where('pub.state', '=', 'active')
    .whereRef('pub.tracked_hostname', '=', 'd.hostname')
    .where('pub.proxy_host_id', 'is not', null)
    .executeTakeFirst();
}

export async function getOpenworldPublication(db: DB, serverId: string) {
  const [row, hostname] = await Promise.all([
    db
      .selectFrom('openworld_dashboard_publications')
      .select(['enabled', 'state', 'tracked_hostname'])
      .where('server_id', '=', serverId)
      .executeTakeFirst(),
    currentHostname(db, serverId),
  ]);
  const enabled = row?.enabled === true;
  const phase: 'disabled' | 'pending' | 'active' | 'error' = !enabled
    ? 'disabled'
    : row.state === 'error'
      ? 'error'
      : hostname && hostname === row.tracked_hostname && row.state === 'active'
        ? 'active'
        : 'pending';
  return { enabled, phase, hostname };
}

/** Caller authorizes the owner before changing intent. The worker alone owns the remote ledger. */
export async function setOpenworldPublication(db: DB, serverId: string, enabled: boolean) {
  if (enabled && !(await currentHostname(db, serverId)))
    throw new DomainError('configuration_invalid');
  await db
    .insertInto('openworld_dashboard_publications')
    .values({ server_id: serverId, enabled })
    .onConflict((oc) =>
      oc
        .column('server_id')
        .doUpdateSet({
          enabled,
          state: 'pending',
          revision: sql`openworld_dashboard_publications.revision + 1`,
          due_at: sql`now()`,
        })
        .where((eb) =>
          eb.or([
            eb('openworld_dashboard_publications.enabled', '!=', enabled),
            eb('openworld_dashboard_publications.state', '=', 'error'),
          ]),
        ),
    )
    .execute();
  return getOpenworldPublication(db, serverId);
}

export async function reconcileOpenworldPublications(
  db: DB,
  provider: () => DashboardProxyProvider | Promise<DashboardProxyProvider>,
  unavailable: (id: string) => void,
) {
  const rows = await db
    .selectFrom('openworld_dashboard_publications')
    .select('id')
    .where('due_at', '<=', sql<Date>`now()`)
    .orderBy('due_at')
    .orderBy('id')
    .limit(8)
    .execute();
  let processed = 0;
  for (const { id } of rows) {
    await db.connection().execute(async (con) => {
      const key = sql`hashtextextended(current_schema() || ':dashboard:' || ${id}::text, 0)`;
      const lock = await sql<{
        locked: boolean;
      }>`select pg_try_advisory_lock(${key}) as locked`.execute(con);
      if (!lock.rows[0]?.locked) return;
      try {
        const row = await con
          .selectFrom('openworld_dashboard_publications')
          .selectAll()
          .where('id', '=', id)
          .where('due_at', '<=', sql<Date>`now()`)
          .executeTakeFirst();
        if (!row) return;
        processed++;
        const change = () =>
          con.updateTable('openworld_dashboard_publications').where('id', '=', id);
        const finish = () => change().where('revision', '=', row.revision);
        try {
          const wanted = row.server_id ? await currentHostname(con, row.server_id) : null;
          if (
            !wanted &&
            row.server_id &&
            row.tracked_hostname &&
            (await pendingHostname(con, row.server_id, row.tracked_hostname))
          ) {
            if (!row.enabled) {
              const npm = await provider();
              if (row.provider_origin !== npm.origin) throw new DomainError('provenance_mismatch');
              await npm.remove(
                { ownership: id, hostname: row.tracked_hostname, remoteId: row.proxy_host_id },
                true,
              );
              await change().set({ proxy_host_id: null, state: 'pending' }).execute();
            }
            await finish()
              .set({ state: 'pending', due_at: sql`now()+interval '15 minutes'` })
              .execute();
            return;
          }
          if (row.tracked_hostname && row.tracked_hostname !== wanted) {
            const npm = await provider();
            if (row.provider_origin !== npm.origin) throw new DomainError('provenance_mismatch');
            await npm.remove(
              { ownership: id, hostname: row.tracked_hostname, remoteId: row.proxy_host_id },
              false,
            );
            await change()
              .set({
                tracked_hostname: null,
                provider_origin: null,
                proxy_host_id: null,
                state: 'pending',
              })
              .execute();
          }
          if (!wanted) {
            await finish()
              .set({ state: row.enabled ? 'error' : 'pending', due_at: null })
              .execute();
            if (!row.server_id)
              await con
                .deleteFrom('openworld_dashboard_publications')
                .where('id', '=', id)
                .where('server_id', 'is', null)
                .where('tracked_hostname', 'is', null)
                .execute();
            return;
          }
          const npm = await provider();
          const same = row.tracked_hostname === wanted;
          if (same && row.provider_origin !== npm.origin)
            throw new DomainError('provenance_mismatch');
          if (!same) {
            // Commit intent before a remote write so retry/disable can recover a lost response.
            await change()
              .set({
                tracked_hostname: wanted,
                provider_origin: npm.origin,
                proxy_host_id: null,
                state: 'pending',
              })
              .execute();
          }
          const route = {
            ownership: id,
            hostname: wanted,
            remoteId: same ? row.proxy_host_id : null,
          };
          if (row.enabled) {
            const remoteId = await npm.ensure(route);
            await change().set({ proxy_host_id: remoteId }).execute();
            await finish()
              .set({
                state: 'active',
                due_at: sql`now()+interval '15 minutes'+random()*interval '2 minutes'`,
              })
              .execute();
          } else {
            await npm.prepare(route);
            await change().set({ proxy_host_id: null, state: 'pending' }).execute();
            await finish()
              .set({ due_at: sql`now()+interval '1 day'+random()*interval '1 hour'` })
              .execute();
          }
        } catch (error) {
          // A management API outage does not invalidate a previously confirmed route.
          // Local revocation/rename independently fence ingress in its current DNS join.
          const confirmedLost =
            error instanceof DomainError &&
            (error.code === 'provenance_mismatch' || error.code === 'conflict');
          await finish()
            .set({
              state: sql`CASE WHEN state='active' AND NOT ${confirmedLost} THEN 'active' ELSE 'error' END`,
              due_at: sql`now()+interval '10 minutes'+random()*interval '1 minute'`,
            })
            .execute();
          unavailable(id);
        }
      } finally {
        await sql`select pg_advisory_unlock(${key})`.execute(con);
      }
    });
  }
  return processed;
}
