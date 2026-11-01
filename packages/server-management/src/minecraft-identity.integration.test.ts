import { randomUUID } from 'node:crypto';
import { migrate } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import {
  minecraftDigest,
  minecraftManifest,
  minecraftVerificationChecks,
} from '@nickhosting/minecraft';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  inspectMinecraftCombination,
  minecraftMappingDigest,
  signMinecraftEvidence,
} from './minecraft-registry.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let serverId: string;
const env = { NH_MINECRAFT_EVIDENCE_KEY: '1'.repeat(64) };

beforeEach(async () => {
  database = await createTestDatabase();
  f = await managementFixture(database.db);
  serverId = await f.server();
  // Replay the new migration against a real pre-rename schema state, without
  // modifying immutable historical migration files or any shared database data.
  await database.pool.query(
    "DELETE FROM schema_migrations WHERE name = '031_minecraft_identity.sql'",
  );
  await f.db
    .insertInto('game_integrations')
    .values({
      id: 'minecraft-java',
      version: '1.0.0',
      manifest: JSON.stringify(minecraftManifest)
        .replaceAll('games.minecraft', 'games.minecraft-java')
        .replace('"id":"minecraft"', '"id":"minecraft-java"'),
    })
    .execute();
  await f.db
    .insertInto('game_rollouts')
    .values({
      integration_id: 'minecraft-java',
      state: 'private-testing',
      allowlist: [f.context.subjectUserId],
    })
    .execute();
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({ game_id: 'minecraft-java', runtime_id: 'vanilla' })
    .where('id', '=', f.mappingId)
    .execute();
});
afterEach(async () => {
  await database?.destroy();
});

it('rekeys integration references and preferences while preserving signed evidence and operation history', async () => {
  const mapping = await f.db
    .selectFrom('runtime_egg_mappings')
    .selectAll()
    .where('id', '=', f.mappingId)
    .executeTakeFirstOrThrow();
  const { enabled: _enabled, image_mode: _imageMode, ...oldIdentity } = mapping;
  const mappingDigest = minecraftDigest(oldIdentity);
  expect(minecraftMappingDigest(mapping)).toBe(mappingDigest);
  const combination = {
    release: '1.21.1',
    releaseType: 'release',
    protocolId: 767,
    family: 'netty',
    profile: 'vanilla',
    javaMajor: 21,
    runtimeDigest: 'a'.repeat(64),
    protocolSource: { url: 'https://example.test/protocols', sha256: 'b'.repeat(64) },
  };
  const choiceId = randomUUID();
  const identityDigest = minecraftDigest({ combination, binding: {} });
  await f.db
    .insertInto('minecraft_combinations')
    .values({
      id: choiceId,
      mapping_id: f.mappingId,
      combination: JSON.stringify(combination),
      resolved_runtime: '{}',
      binding: '{}',
      mapping_digest: mappingDigest,
      identity_digest: identityDigest,
    })
    .execute();
  const report = {
    runId: randomUUID(),
    kind: 'protocol-fixture',
    combinationDigest: minecraftDigest(combination),
    choiceDigest: identityDigest,
    mappingDigest,
    recordedAt: new Date().toISOString(),
    checks: Object.fromEntries(minecraftVerificationChecks.map((name) => [name, true])),
    evidenceSha256: 'd'.repeat(64),
    client: { implementation: 'isolated-fixture-client', version: '1.0.0', protocolId: 767 },
  };
  await f.db
    .insertInto('minecraft_verification_evidence')
    .values({
      id: report.runId,
      combination_id: choiceId,
      report: JSON.stringify(report),
      signature: signMinecraftEvidence(report, env),
    })
    .execute();
  await f.db
    .insertInto('minecraft_server_profiles')
    .values({ server_id: serverId, combination_id: choiceId, configuration: '{}' })
    .execute();
  await database.pool.query(
    `UPDATE platform_settings SET value = value || '{"gameIdleTimeouts":{"minecraft-java":{"gameTimeoutSeconds":1200,"runtimeTimeouts":{"vanilla":600}},"another":{"gameTimeoutSeconds":300,"runtimeTimeouts":{}}}}'::jsonb`,
  );
  await f.db
    .insertInto('file_viewer_preferences')
    .values({
      user_id: f.context.subjectUserId,
      scope: 'game',
      scope_id: 'minecraft-java',
      extension: 'properties',
      viewer_id: 'text',
    })
    .execute();
  await database.pool.query(
    `INSERT INTO gateway_server_states(server_id,generation,enabled,protocol_id,game_version,state,readiness_timeout_seconds,readiness_max_age_seconds,estimate_max_age_seconds,wake_retry_seconds) VALUES ($1,$2,true,'minecraft-java','1.21.1','sleeping',50,10,3600,30)`,
    [serverId, randomUUID()],
  );
  const preservedTables = [
    'minecraft_combinations',
    'minecraft_verification_evidence',
    'minecraft_server_profiles',
    'operation_jobs',
    'server_operations',
    'activity_events',
    'audit_events',
    'gateway_server_states',
  ] as const;
  // Pending commands retain their immutable idempotency hash and payload; the
  // worker resolves their stable server/mapping UUIDs after migration.
  await database.pool.query(
    `UPDATE operation_jobs SET state='queued', completed_at=NULL
    WHERE id IN (SELECT job_id FROM server_operations WHERE server_id=$1)`,
    [serverId],
  );
  const before = await Promise.all(
    preservedTables.map(
      async (table) =>
        (await database.pool.query(`SELECT row_to_json(t) AS value FROM ${table} t`)).rows,
    ),
  );
  expect(await migrate(database.pool)).toEqual(['031_minecraft_identity.sql']);
  expect(await migrate(database.pool)).toEqual([]);
  const after = await Promise.all(
    preservedTables.map(
      async (table) =>
        (await database.pool.query(`SELECT row_to_json(t) AS value FROM ${table} t`)).rows,
    ),
  );
  expect(after).toEqual(before);
  expect(
    await f.db
      .selectFrom('game_integrations')
      .selectAll()
      .where('id', '=', 'minecraft-java')
      .executeTakeFirst(),
  ).toBeUndefined();
  const integration = await f.db
    .selectFrom('game_integrations')
    .selectAll()
    .where('id', '=', 'minecraft')
    .executeTakeFirstOrThrow();
  expect(integration.manifest).toEqual(minecraftManifest);
  expect(
    await f.db
      .selectFrom('game_rollouts')
      .selectAll()
      .where('integration_id', '=', 'minecraft')
      .executeTakeFirstOrThrow(),
  ).toMatchObject({ state: 'private-testing', allowlist: [f.context.subjectUserId] });
  const choice = await inspectMinecraftCombination(f.db, choiceId, env);
  expect(choice.mapping.game_id).toBe('minecraft');
  expect(choice.mappingDigest).toBe(mappingDigest);
  expect(choice.row.identity_digest).toBe(identityDigest);
  expect(choice.evidence).toHaveLength(1);
  expect(signMinecraftEvidence(choice.evidence[0], env)).toBe(signMinecraftEvidence(report, env));
  expect(minecraftMappingDigest({ ...choice.mapping, startup: 'changed' })).not.toBe(mappingDigest);
  const dynamic = { ...mapping, image_mode: 'integration' as const, docker_image: '' };
  expect(minecraftMappingDigest({ ...dynamic, game_id: 'minecraft' })).toBe(
    minecraftMappingDigest(dynamic),
  );
  expect(
    (await f.db.selectFrom('file_viewer_preferences').selectAll().executeTakeFirstOrThrow())
      .scope_id,
  ).toBe('minecraft');
  const settings = await f.db.selectFrom('platform_settings').selectAll().executeTakeFirstOrThrow();
  expect(settings.value.gameIdleTimeouts).toEqual({
    minecraft: { gameTimeoutSeconds: 1200, runtimeTimeouts: { vanilla: 600 } },
    another: { gameTimeoutSeconds: 300, runtimeTimeouts: {} },
  });
});

it('rolls back all rekeying when a user has conflicting canonical viewer preferences', async () => {
  for (const scopeId of ['minecraft-java', 'minecraft']) {
    await f.db
      .insertInto('file_viewer_preferences')
      .values({
        user_id: f.context.subjectUserId,
        scope: 'game',
        scope_id: scopeId,
        extension: 'properties',
        viewer_id: 'text',
      })
      .execute();
  }
  await expect(migrate(database.pool)).rejects.toMatchObject({ code: '23505' });
  expect(
    await f.db
      .selectFrom('game_integrations')
      .selectAll()
      .where('id', '=', 'minecraft')
      .executeTakeFirst(),
  ).toBeUndefined();
  expect(
    (
      await f.db
        .selectFrom('runtime_egg_mappings')
        .selectAll()
        .where('id', '=', f.mappingId)
        .executeTakeFirstOrThrow()
    ).game_id,
  ).toBe('minecraft-java');
  expect(
    (
      await database.pool.query(
        "SELECT * FROM schema_migrations WHERE name = '031_minecraft_identity.sql'",
      )
    ).rows,
  ).toHaveLength(0);
});

it('rejects ambiguous duplicate integration identities without merging Owner policy', async () => {
  await f.db
    .insertInto('game_integrations')
    .values({ id: 'minecraft', version: '1.0.0', manifest: '{}' })
    .execute();
  await expect(migrate(database.pool)).rejects.toThrow(
    'Both Minecraft integration identities exist',
  );
  expect(
    (
      await f.db
        .selectFrom('game_rollouts')
        .selectAll()
        .where('integration_id', '=', 'minecraft-java')
        .executeTakeFirstOrThrow()
    ).state,
  ).toBe('private-testing');
});

it('rejects ambiguous persisted sleep policy keys before changing any references', async () => {
  await database.pool.query(`UPDATE platform_settings SET value = value ||
    '{"gameIdleTimeouts":{"minecraft-java":{"gameTimeoutSeconds":1200,"runtimeTimeouts":{}},"minecraft":{"gameTimeoutSeconds":600,"runtimeTimeouts":{}}}}'::jsonb`);
  await expect(migrate(database.pool)).rejects.toThrow(
    'Both Minecraft sleep policy identities exist',
  );
  expect(
    (
      await f.db
        .selectFrom('runtime_egg_mappings')
        .selectAll()
        .where('id', '=', f.mappingId)
        .executeTakeFirstOrThrow()
    ).game_id,
  ).toBe('minecraft-java');
});
