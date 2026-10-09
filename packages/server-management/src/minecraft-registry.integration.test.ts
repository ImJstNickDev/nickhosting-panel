import { randomUUID } from 'node:crypto';
import { authSessionId } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { minecraftDigest, minecraftVerificationChecks } from '@nickhosting/minecraft';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  importMinecraftEvidence,
  inspectMinecraftCombination,
  minecraftCatalog,
  minecraftMappingDigest,
  requireMinecraftChoice,
  setMinecraftAvailability,
  signMinecraftEvidence,
} from './minecraft-registry.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let choiceId: string;
const env = { NH_MINECRAFT_EVIDENCE_KEY: '1'.repeat(64) };
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
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  f = await managementFixture(database.db, { interactive: true });
  await f.db
    .insertInto('game_integrations')
    .values({ id: 'minecraft-java', version: '1.0.0', manifest: {} })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await f.db
    .insertInto('game_rollouts')
    .values({ integration_id: 'minecraft-java', state: 'public', allowlist: [] })
    .onConflict((c) => c.column('integration_id').doUpdateSet({ state: 'public', allowlist: [] }))
    .execute();
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({ game_id: 'minecraft-java', runtime_id: 'vanilla' })
    .where('id', '=', f.mappingId)
    .execute();
  const mapping = await f.db
    .selectFrom('runtime_egg_mappings')
    .selectAll()
    .where('id', '=', f.mappingId)
    .executeTakeFirstOrThrow();
  choiceId = randomUUID();
  await f.db
    .insertInto('minecraft_combinations')
    .values({
      id: choiceId,
      mapping_id: f.mappingId,
      combination: JSON.stringify(combination),
      resolved_runtime: '{}',
      binding: '{}',
      mapping_digest: minecraftMappingDigest(mapping),
      identity_digest: minecraftDigest({ combination, mappingId: f.mappingId }),
    })
    .execute();
});
async function report(kind: 'protocol-fixture' | 'real-server' = 'real-server') {
  const choice = await inspectMinecraftCombination(f.db, choiceId, env);
  return {
    runId: randomUUID(),
    kind,
    combinationDigest: minecraftDigest(combination),
    choiceDigest: choice.row.identity_digest,
    mappingDigest: choice.mappingDigest,
    recordedAt: new Date().toISOString(),
    checks: Object.fromEntries(minecraftVerificationChecks.map((name) => [name, true])),
    evidenceSha256: 'd'.repeat(64),
    server: {
      uuid: randomUUID(),
      externalId: 'nh-isolated-test',
      artifactSha256: 'e'.repeat(64),
      imageDigest: `sha256:${'f'.repeat(64)}`,
      javaMajor: 21,
    },
    client: { implementation: 'isolated-fixture-client', version: '1.0.0', protocolId: 767 },
  };
}
async function attest(kind: 'protocol-fixture' | 'real-server' = 'real-server') {
  const value = await report(kind);
  await importMinecraftEvidence(
    f.db,
    f.owner,
    choiceId,
    { report: value, signature: signMinecraftEvidence(value, env) },
    env,
  );
}
describe('Minecraft Owner evidence and user eligibility', () => {
  it('an Owner checkbox cannot manufacture compatibility', async () => {
    await setMinecraftAvailability(f.db, f.owner, choiceId, { enabled: true }, env);
    expect((await inspectMinecraftCombination(f.db, choiceId, env)).support).toBe('unverified');
    await expect(requireMinecraftChoice(f.db, f.context, choiceId, env)).rejects.toThrow(
      'integration_unavailable',
    );
    expect((await minecraftCatalog(f.db, f.context, env)).some((row) => row.id === choiceId)).toBe(
      false,
    );
    const value = await report();
    await expect(
      importMinecraftEvidence(
        f.db,
        f.owner,
        choiceId,
        { report: value, signature: '0'.repeat(64) },
        env,
      ),
    ).rejects.toThrow('forbidden');
  });
  it('signed real evidence and independent availability yield a simple public choice', async () => {
    await attest();
    await setMinecraftAvailability(f.db, f.owner, choiceId, { enabled: true }, env);
    const row = (await minecraftCatalog(f.db, f.context, env)).find(
      (entry) => entry.id === choiceId,
    );
    expect(row).toEqual({ id: choiceId, version: '1.21.1', runtime: 'vanilla' });
    expect((await inspectMinecraftCombination(f.db, choiceId, env)).support).toBe('verified');
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({ docker_image: 'changed/image:21' })
      .where('id', '=', f.mappingId)
      .execute();
    await expect(requireMinecraftChoice(f.db, f.context, choiceId, env)).rejects.toThrow(
      'integration_unavailable',
    );
  });
  it('rejects the first import of signed evidence against a different Minecraft binding', async () => {
    const value = await report();
    const original = await f.db
      .selectFrom('minecraft_combinations')
      .selectAll()
      .where('id', '=', choiceId)
      .executeTakeFirstOrThrow();
    const otherId = randomUUID();
    await f.db
      .insertInto('minecraft_combinations')
      .values({
        ...original,
        id: otherId,
        combination: JSON.stringify(original.combination),
        resolved_runtime: JSON.stringify(original.resolved_runtime),
        binding: JSON.stringify({ fixedVariables: { UNTETESTED: 'changed' } }),
        identity_digest: '7'.repeat(64),
      })
      .execute();
    await expect(
      importMinecraftEvidence(
        f.db,
        f.owner,
        otherId,
        { report: value, signature: signMinecraftEvidence(value, env) },
        env,
      ),
    ).rejects.toThrow('validation_failed');
    expect((await inspectMinecraftCombination(f.db, otherId, env)).support).toBe('unverified');
    await expect(
      importMinecraftEvidence(
        f.db,
        f.owner,
        choiceId,
        { report: value, signature: signMinecraftEvidence(value, env) },
        env,
      ),
    ).resolves.toBeUndefined();
  });
  it('fixtures stay hidden except explicit private-testing allowlists', async () => {
    await attest('protocol-fixture');
    await setMinecraftAvailability(f.db, f.owner, choiceId, { enabled: true }, env);
    await expect(requireMinecraftChoice(f.db, f.owner, choiceId, env)).rejects.toThrow();
    await f.db
      .updateTable('game_rollouts')
      .set({ state: 'private-testing', allowlist: [f.context.subjectUserId] })
      .where('integration_id', '=', 'minecraft-java')
      .execute();
    expect((await requireMinecraftChoice(f.db, f.context, choiceId, env)).support).toBe(
      'experimental',
    );
    await f.db
      .updateTable('game_rollouts')
      .set({ allowlist: [] })
      .where('integration_id', '=', 'minecraft-java')
      .execute();
    await expect(requireMinecraftChoice(f.db, f.context, choiceId, env)).rejects.toThrow(
      'forbidden',
    );
  });
  it('tampering, an absent key, role revocation and normal users cannot promote entries', async () => {
    await attest();
    expect((await inspectMinecraftCombination(f.db, choiceId)).support).toBe('unverified');
    await expect(
      setMinecraftAvailability(f.db, f.context, choiceId, { enabled: true }, env),
    ).rejects.toThrow('forbidden');
    const value = await report();
    const signature = signMinecraftEvidence(value, env);
    await expect(
      importMinecraftEvidence(
        f.db,
        f.owner,
        choiceId,
        { report: { ...value, kind: 'protocol-fixture' }, signature },
        env,
      ),
    ).rejects.toThrow('forbidden');
    const sessionId = f.owner[authSessionId];
    if (!sessionId) throw new Error('Expected authenticated fixture owner');
    await f.db.deleteFrom('session').where('id', '=', sessionId).execute();
    await expect(
      setMinecraftAvailability(f.db, f.owner, choiceId, { enabled: true }, env),
    ).rejects.toThrow();
  });
});
