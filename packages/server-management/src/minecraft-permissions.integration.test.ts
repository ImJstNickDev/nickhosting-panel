import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MinecraftPreparedContent } from './minecraft-content-contracts.js';
import { createProject, enqueueServerOperation, setProjectMember } from './registry.js';
import { setServerSubuser } from './subusers.js';
import { managementFixture, minecraftManagementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});

describe('legacy Minecraft replacement queue authorization', () => {
  it.each(['modpack', 'modpack-upload'] as const)(
    'denies direct domain grants for %s broad wipes while preserving inherited managers',
    async (kind) => {
      const f = await minecraftManagementFixture(database.db, { interactive: true });
      const peer = await managementFixture(database.db, { interactive: true });
      const serverId = await f.server();
      const combinationId = randomUUID();
      await f.db
        .insertInto('minecraft_combinations')
        .values({
          id: combinationId,
          mapping_id: f.mappingId,
          identity_digest: '1'.repeat(64),
          mapping_digest: '2'.repeat(64),
          combination: JSON.stringify({ edition: 'java', profile: 'fabric', release: '1.21.1' }),
          resolved_runtime: JSON.stringify({}),
          binding: JSON.stringify({}),
        })
        .execute();
      await f.db
        .insertInto('minecraft_server_profiles')
        .values({
          server_id: serverId,
          combination_id: combinationId,
          configuration: JSON.stringify({ eula: true }),
          installed: true,
        })
        .execute();
      await setServerSubuser(f.db, f.context, serverId, peer.context.subjectUserId, {
        permissionKeys: [
          'game.minecraft.modpacks.read',
          'game.minecraft.modpacks.write',
          'game.minecraft.worlds.read',
          'game.minecraft.worlds.delete',
        ],
      });
      const replace = {
        wipeConsent: true as const,
        expectedDeletePaths: ['config', 'plugins', 'world'],
        backupBefore: false,
      };
      const command: MinecraftPreparedContent['command'] =
        kind === 'modpack'
          ? { kind, provider: 'modrinth', projectId: 'fixture', versionId: 'v1', replace }
          : { kind, archiveRef: randomUUID(), replace };
      const input = { action: 'minecraft-content', command, idempotencyKey: randomUUID() };
      const options = {
        minecraftPlan: {
          combinationId,
          command,
          backupBefore: false,
          deletePaths: replace.expectedDeletePaths,
          previousModpack: null,
        },
      };
      await expect(
        enqueueServerOperation(f.db, peer.context, serverId, input, {}, options),
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect(
        await f.db
          .selectFrom('server_operations')
          .select('job_id')
          .where('server_id', '=', serverId)
          .where('action', '=', 'minecraft-content')
          .execute(),
      ).toEqual([]);

      const project = await createProject(f.db, f.context, { name: 'Legacy manager' });
      await f.db
        .updateTable('managed_servers')
        .set({ project_id: project.id })
        .where('id', '=', serverId)
        .execute();
      await setProjectMember(f.db, f.context, project.id, {
        userId: peer.context.subjectUserId,
        role: 'manager',
      });
      const queued = await enqueueServerOperation(f.db, peer.context, serverId, input, {}, options);
      expect(queued.jobId).toBeTruthy();
      expect(
        await f.db
          .selectFrom('server_operations')
          .select(['action', 'plan'])
          .where('job_id', '=', queued.jobId)
          .executeTakeFirst(),
      ).toMatchObject({
        action: 'minecraft-content',
        plan: { minecraftContent: { command, deletePaths: replace.expectedDeletePaths } },
      });
    },
  );
});
