import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { requeueOpenworldPublications } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { DashboardProxyProvider, NpmRoute } from '@nickhosting/external-services';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { openworldManifest } from '../../../games/openworld/src/manifest.js';
import {
  getOpenworldPublication,
  reconcileOpenworldPublications,
  resolveOpenworldPublication,
  setOpenworldPublication,
} from './openworld-publication.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});

it('fences requests immediately on rename, disable and delete; recovers after an ambiguous create', async () => {
  const db = database.db,
    f = await managementFixture(db),
    id = await f.server(),
    dnsId = randomUUID();
  const a = 'aurora.servers.example',
    b = 'brina.servers.example';
  await db
    .insertInto('game_integrations')
    .values({ id: 'openworld', version: openworldManifest.version, manifest: openworldManifest })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await db
    .updateTable('runtime_egg_mappings')
    .set({ game_id: 'openworld', runtime_id: 'dedicated' })
    .where('id', '=', f.mappingId)
    .execute();
  const plan = (hostname: string, shared = false) =>
    JSON.stringify({
      action: 'apply',
      connection: { hostname },
      ...(shared ? { sharedHostId: randomUUID() } : {}),
    });
  await db
    .insertInto('dns_assignments')
    .values({
      id: dnsId,
      server_id: id,
      hostname: a,
      ownership_token: randomUUID(),
      plan: plan(a, true),
      ledger: '[]',
      state: 'active',
    })
    .execute();
  await db
    .insertInto('server_dns_preferences')
    .values({
      server_id: id,
      assignment_id: dnsId,
      enabled: true,
      domain_id: 'example',
      subdomain: 'aurora',
    })
    .onConflict((c) => c.column('server_id').doUpdateSet({ assignment_id: dnsId, enabled: true }))
    .execute();
  await db
    .insertInto('dns_hostname_reservations')
    .values({ hostname: a, owner_id: dnsId, release_after: null })
    .execute();
  await expect(setOpenworldPublication(db, id, true)).rejects.toMatchObject({
    code: 'configuration_invalid',
  });
  await db
    .updateTable('dns_assignments')
    .set({ plan: plan(a) })
    .where('id', '=', dnsId)
    .execute();
  // A first-party primary DNS confirmation queues TLS even without an explicit toggle.
  await db
    .updateTable('dns_assignments')
    .set({ state: 'pending' })
    .where('id', '=', dnsId)
    .execute();
  await db
    .updateTable('dns_assignments')
    .set({ state: 'active' })
    .where('id', '=', dnsId)
    .execute();
  expect(
    await db
      .selectFrom('openworld_dashboard_publications')
      .select('enabled')
      .where('server_id', '=', id)
      .executeTakeFirst(),
  ).toEqual({ enabled: false });
  expect(await getOpenworldPublication(db, id)).toEqual({
    enabled: false,
    phase: 'disabled',
    hostname: a,
  });
  expect((await setOpenworldPublication(db, id, true)).phase).toBe('pending');
  expect(await resolveOpenworldPublication(db, a)).toBeUndefined();
  const removals: NpmRoute[] = [];
  const prepare = vi.fn<DashboardProxyProvider['prepare']>().mockResolvedValue(undefined);
  const ensure = vi
    .fn<DashboardProxyProvider['ensure']>()
    .mockRejectedValueOnce(Error('lost response'))
    .mockResolvedValue(17);
  const provider: DashboardProxyProvider = {
    origin: 'https://isolated.test',
    ensure,
    prepare,
    async remove(route) {
      removals.push(route);
    },
  };
  const error = vi.fn();
  const run = () => reconcileOpenworldPublications(db, () => provider, error);
  // Simulate an existing exact DNS assignment, then save the key with the
  // untouched default (off). Its certificate is prepared without granting ingress.
  await db.deleteFrom('openworld_dashboard_publications').where('server_id', '=', id).execute();
  await requeueOpenworldPublications(db);
  await run();
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(await resolveOpenworldPublication(db, a)).toBeUndefined();
  expect((await getOpenworldPublication(db, id)).enabled).toBe(false);
  await setOpenworldPublication(db, id, true);
  await run();
  expect(error).toHaveBeenCalledTimes(1);
  expect((await getOpenworldPublication(db, id)).phase).toBe('error');
  // Saving the NPM key requeues the durable backlog in the same DB transaction.
  await requeueOpenworldPublications(db);
  await run();
  expect(ensure.mock.calls[0]?.[0]).toEqual(ensure.mock.calls[1]?.[0]);
  expect(await resolveOpenworldPublication(db, a)).toEqual({ serverId: id });
  // A retry of the same DNS intent must not revoke a real TLS certificate.
  await db
    .updateTable('dns_assignments')
    .set({ state: 'pending' })
    .where('id', '=', dnsId)
    .execute();
  expect(await resolveOpenworldPublication(db, a)).toBeUndefined();
  await run();
  expect(removals).toHaveLength(0);
  await db
    .updateTable('dns_assignments')
    .set({ state: 'active' })
    .where('id', '=', dnsId)
    .execute();
  await run();
  expect(await resolveOpenworldPublication(db, a)).toEqual({ serverId: id });
  // Management credentials can expire while the confirmed public route works.
  await requeueOpenworldPublications(db);
  ensure.mockRejectedValueOnce(new DomainError('forbidden'));
  await run();
  expect(await resolveOpenworldPublication(db, a)).toEqual({ serverId: id });
  // Positively observed remote drift must fence the very same registration.
  await requeueOpenworldPublications(db);
  ensure.mockRejectedValueOnce(new DomainError('provenance_mismatch'));
  await run();
  expect(await resolveOpenworldPublication(db, a)).toBeUndefined();
  await requeueOpenworldPublications(db);
  await run();
  expect(await resolveOpenworldPublication(db, a)).toEqual({ serverId: id });
  await db
    .updateTable('dns_assignments')
    .set({ hostname: b, plan: plan(b) })
    .where('id', '=', dnsId)
    .execute();
  await db
    .updateTable('dns_hostname_reservations')
    .set({ hostname: b })
    .where('owner_id', '=', dnsId)
    .execute();
  expect(await resolveOpenworldPublication(db, a)).toBeUndefined();
  expect(await resolveOpenworldPublication(db, b)).toBeUndefined();
  await run();
  expect(removals[0]).toMatchObject({ hostname: a, remoteId: 17 });
  expect(await resolveOpenworldPublication(db, b)).toEqual({ serverId: id });
  await setOpenworldPublication(db, id, false);
  expect(await resolveOpenworldPublication(db, b)).toBeUndefined();
  await run();
  expect(prepare).toHaveBeenLastCalledWith(expect.objectContaining({ hostname: b, remoteId: 17 }));
  await setOpenworldPublication(db, id, true);
  ensure.mockImplementationOnce(async () => {
    // A user can revoke while NPM is still completing its remote write.
    await setOpenworldPublication(db, id, false);
    return 17;
  });
  await run();
  expect(await resolveOpenworldPublication(db, b)).toBeUndefined();
  await run();
  expect(prepare).toHaveBeenCalledTimes(3);
  await setOpenworldPublication(db, id, true);
  await run();
  await db
    .updateTable('managed_servers')
    .set({ deleted_at: new Date() })
    .where('id', '=', id)
    .execute();
  expect(await resolveOpenworldPublication(db, b)).toBeUndefined();
  await run();
  expect(removals).toHaveLength(2);
  expect(error).toHaveBeenCalledTimes(3);
});
