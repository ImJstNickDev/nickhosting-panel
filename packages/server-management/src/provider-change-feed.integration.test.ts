import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ProviderChange } from '@nickhosting/pterodactyl-adapter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyProviderChange,
  cachedProviderStartLimits,
  invalidateProviderFeedHealth,
  linkProviderFeedServer,
  markProviderFeedHealth,
  registerProviderFeed,
} from './provider-change-feed.js';
import { managementFixture } from './test-fixtures.js';

describe('authenticated provider change projection', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let fixture: Awaited<ReturnType<typeof managementFixture>>;
  let serverId: string;
  let event: ProviderChange;
  const providerUrl = 'https://panel.example.test';
  let now: Date;
  beforeEach(async () => {
    database = await createTestDatabase();
    fixture = await managementFixture(database.db);
    serverId = await fixture.server();
    const server = await database.db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    if (
      server.pterodactyl_id === null ||
      !server.pterodactyl_uuid ||
      !server.pterodactyl_identifier
    )
      throw new Error('Fixture lacks provider identity');
    now = new Date();
    event = {
      schemaVersion: 1,
      eventId: randomUUID(),
      instanceId: randomUUID(),
      server: {
        providerId: server.pterodactyl_id,
        providerUuid: server.pterodactyl_uuid,
        identifier: server.pterodactyl_identifier,
        externalId: server.external_id,
        nodeId: fixture.providerNodeId,
      },
      revision: 1,
      type: 'snapshot',
      limits: { ...fixture.limits, threads: null },
      occurredAt: now.toISOString(),
    };
    await registerProviderFeed(database.db, {
      instanceId: event.instanceId,
      providerUrl,
      callbackUrl: 'https://app.example.test/internal/pterodactyl/events',
    });
    await linkProviderFeedServer(database.db, event.instanceId, serverId, event, now);
    await health();
  });
  afterEach(async () => {
    await database?.destroy();
  });
  async function generation() {
    return (
      await database.db
        .selectFrom('provider_change_feeds')
        .select('generation')
        .where('instance_id', '=', event.instanceId)
        .executeTakeFirstOrThrow()
    ).generation;
  }
  async function health(pendingEvents = 0) {
    await markProviderFeedHealth(
      database.db,
      {
        instanceId: event.instanceId,
        pendingEvents,
        checkedAt: now.toISOString(),
        expectedGeneration: await generation(),
      },
      now,
    );
  }
  const updated = (patch: Partial<ProviderChange> = {}): ProviderChange => ({
    ...event,
    eventId: randomUUID(),
    revision: 2,
    type: 'limits.updated',
    ...patch,
  });
  async function cached(at = now, url = providerUrl) {
    return cachedProviderStartLimits(database.db, serverId, url, at);
  }
  it('uses exact managed identity only after snapshot and healthy delivery', async () => {
    expect(await cached()).toEqual(event.limits);
    expect(await cached(now, 'https://another.example.test')).toBeNull();
    await invalidateProviderFeedHealth(database.db, event.instanceId);
    expect(await cached()).toBeNull();
  });
  it('invalidates health after applying an ordered event until outbox is drained', async () => {
    const change = updated({ limits: { ...event.limits, memory: 256 } });
    expect(await applyProviderChange(database.db, change, now)).toBe('applied');
    expect(await cached()).toBeNull();
    await health();
    expect(await cached()).toEqual(change.limits);
  });
  it('deduplicates concurrent deliveries and does not roll back on old revisions', async () => {
    const change = updated();
    expect(
      (
        await Promise.all([
          applyProviderChange(database.db, change, now),
          applyProviderChange(database.db, change, now),
        ])
      ).sort(),
    ).toEqual(['applied', 'duplicate']);
    expect(await applyProviderChange(database.db, updated({ revision: 1 }), now)).toBe('duplicate');
  });
  it('fails closed on gaps until an authoritative snapshot', async () => {
    expect(await applyProviderChange(database.db, updated({ revision: 4 }), now)).toBe(
      'invalidated',
    );
    await health();
    expect(await cached()).toBeNull();
    await linkProviderFeedServer(
      database.db,
      event.instanceId,
      serverId,
      { ...event, revision: 4 },
      now,
    );
    expect(await cached()).toEqual(event.limits);
  });
  it('rejects foreign instance, unknown identity and mismatched snapshot', async () => {
    await expect(
      applyProviderChange(database.db, updated({ instanceId: randomUUID() }), now),
    ).rejects.toThrow();
    await expect(
      applyProviderChange(
        database.db,
        updated({ server: { ...event.server, providerUuid: randomUUID() } }),
        now,
      ),
    ).rejects.toThrow();
    await expect(
      linkProviderFeedServer(
        database.db,
        event.instanceId,
        serverId,
        { ...event, server: { ...event.server, providerId: 99999 } },
        now,
      ),
    ).rejects.toThrow();
  });
  it('detects local provider identity drift before returning cached limits', async () => {
    await database.db
      .updateTable('managed_servers')
      .set({ pterodactyl_identifier: 'foreign' })
      .where('id', '=', serverId)
      .execute();
    expect(await cached()).toBeNull();
  });
  it('never resurrects an invalidated identity from same or newer revision snapshots', async () => {
    await applyProviderChange(database.db, updated({ type: 'identity.invalidated' }), now);
    await health();
    expect(await cached()).toBeNull();
    await applyProviderChange(database.db, updated({ revision: 3 }), now);
    for (const revision of [2, 3, 4])
      await expect(
        linkProviderFeedServer(
          database.db,
          event.instanceId,
          serverId,
          { ...event, revision },
          now,
        ),
      ).rejects.toThrow();
    expect(await cached()).toBeNull();
  });
  it('rejects delayed events as fresh evidence', async () => {
    await applyProviderChange(
      database.db,
      updated({ occurredAt: new Date(now.getTime() - 121000).toISOString() }),
      now,
    );
    await health();
    expect(await cached()).toBeNull();
  });
  it('does not let an in-flight older health response undo event invalidation', async () => {
    const expectedGeneration = await generation();
    await applyProviderChange(database.db, updated(), now);
    await markProviderFeedHealth(
      database.db,
      {
        instanceId: event.instanceId,
        pendingEvents: 0,
        checkedAt: now.toISOString(),
        expectedGeneration,
      },
      now,
    );
    expect(await cached()).toBeNull();
    await health();
    expect(await cached()).toEqual(event.limits);
  });
  it('never silently retargets a link even when local identity has changed too', async () => {
    const identity = { ...event.server, identifier: 'replacement' };
    await database.db
      .updateTable('managed_servers')
      .set({ pterodactyl_identifier: identity.identifier })
      .where('id', '=', serverId)
      .execute();
    await expect(
      linkProviderFeedServer(
        database.db,
        event.instanceId,
        serverId,
        { ...event, server: identity },
        now,
      ),
    ).rejects.toThrow();
    expect(await applyProviderChange(database.db, updated({ server: identity }), now)).toBe(
      'invalidated',
    );
    await health();
    expect(await cached()).toBeNull();
  });
  it('does not refresh stale snapshots through health alone or accept future health', async () => {
    expect(await cached(new Date(now.getTime() + 31000))).toBeNull();
    const later = new Date(now.getTime() + 121000);
    await markProviderFeedHealth(
      database.db,
      {
        instanceId: event.instanceId,
        pendingEvents: 0,
        checkedAt: later.toISOString(),
        expectedGeneration: await generation(),
      },
      later,
    );
    expect(await cached(later)).toBeNull();
    expect(await cached(now)).toBeNull();
    await health(1);
    expect(await cached()).toBeNull();
  });
  it('refuses registration changes that could retarget existing projections', async () => {
    await expect(
      registerProviderFeed(database.db, {
        instanceId: event.instanceId,
        providerUrl: 'https://foreign.example.test',
        callbackUrl: 'https://app.example.test/internal/pterodactyl/events',
      }),
    ).rejects.toThrow();
  });
  it('does not allow an old snapshot to overwrite a delivered newer revision', async () => {
    const change = updated({ limits: { ...event.limits, cpu: 25 } });
    await applyProviderChange(database.db, change, now);
    await linkProviderFeedServer(database.db, event.instanceId, serverId, event, now);
    await health();
    expect(await cached()).toEqual(change.limits);
  });
});
