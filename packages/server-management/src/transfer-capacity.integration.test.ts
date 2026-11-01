import { randomUUID } from 'node:crypto';
import { resolveConfig } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertContentAdmission } from './content-admission.js';
import { managementFixture } from './test-fixtures.js';
import { unresolvedTransferBytes } from './transfer-capacity.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});

describe('shared modpack transfer reservations', () => {
  it('charges pending bytes to the physical disk and retains them until explicit release', async () => {
    const fixture = await managementFixture(database.db, { interactive: true });
    const serverId = await fixture.server();
    const id = randomUUID();
    await database.db
      .insertInto('minecraft_modpack_operations')
      .values({
        id,
        server_id: serverId,
        actor_user_id: fixture.context.actorUserId,
        actor_session_id: 'fixture-session',
        subject_user_id: fixture.context.subjectUserId,
        support_session_id: null,
        resource_owner_id: fixture.context.subjectUserId,
        physical_host_id: fixture.hostId,
        staging_root: null,
        idempotency_key: randomUUID(),
        selection: '{}',
        state: 'ready',
        held_bytes: '100',
        phase: 'ready',
        progress: 'null',
        prepared: 'null',
        plan: 'null',
        plan_digest: null,
        blockers: '[]',
        apply_request: 'null',
        apply_actor_user_id: null,
        apply_actor_session_id: null,
        apply_subject_user_id: null,
        apply_support_session_id: null,
        apply_idempotency_key: null,
        journal: '[]',
        backup_id: null,
        restart_required: false,
        error: null,
        lease_token: null,
        lease_until: null,
      })
      .execute();
    expect(await unresolvedTransferBytes(database.db)).toBe(100n);
    const config = resolveConfig({ contentSourceFreeBytes: 0, contentSourceFreePercent: 0 }).values;
    await expect(
      assertContentAdmission(
        database.db,
        config,
        {
          gameId: 'minecraft',
          ownerId: fixture.context.subjectUserId,
          root: '/not-read',
          bytes: 51n,
          active: 0,
        },
        { observeDisk: async () => ({ total: 1000n, available: 150n }) },
      ),
    ).rejects.toThrow('content_storage_unavailable');
    for (const state of ['uncertain', 'applied', 'cancelled'] as const) {
      await database.db
        .updateTable('minecraft_modpack_operations')
        .set({ state })
        .where('id', '=', id)
        .execute();
      expect(await unresolvedTransferBytes(database.db)).toBe(100n);
    }
    await database.db
      .updateTable('minecraft_modpack_operations')
      .set({ held_bytes: '0' })
      .where('id', '=', id)
      .execute();
    expect(await unresolvedTransferBytes(database.db)).toBe(0n);
    await expect(
      assertContentAdmission(
        database.db,
        config,
        {
          gameId: 'minecraft',
          ownerId: fixture.context.subjectUserId,
          root: '/not-read',
          bytes: 51n,
          active: 0,
        },
        { observeDisk: async () => ({ total: 1000n, available: 150n }) },
      ),
    ).resolves.toBeUndefined();
  });
});
