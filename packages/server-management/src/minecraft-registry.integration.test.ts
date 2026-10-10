import { createHash, randomUUID } from 'node:crypto';
import { authSessionId } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { minecraftDigest, minecraftVerificationChecks } from '@nickhosting/minecraft';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  importMinecraftEvidence,
  inspectMinecraftCombination,
  minecraftCatalog,
  minecraftMappingDigest,
  registerMinecraftCombination,
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
  it('loads more than 1000 declared choices in three queries and orders all families by local dates', async () => {
    const source = await f.db
      .selectFrom('minecraft_combinations')
      .selectAll()
      .where('id', '=', choiceId)
      .executeTakeFirstOrThrow();
    const entries = Array.from({ length: 1001 }, (_, index) => ({
      id: randomUUID(),
      mapping_id: source.mapping_id,
      combination: JSON.stringify({
        ...combination,
        release: `bulk-${index}`,
        releaseType: index % 2 ? 'snapshot' : 'release',
      }),
      resolved_runtime: '{}',
      binding: '{}',
      mapping_digest: source.mapping_digest,
      identity_digest: minecraftDigest({ bulk: index, choiceId }),
      enabled: true,
    }));
    await f.db.insertInto('minecraft_combinations').values(entries).execute();
    await f.db
      .insertInto('minecraft_release_metadata')
      .values([
        {
          id: 'bulk-0',
          release_type: 'release',
          release_time: new Date('2025-01-01'),
          metadata_url: 'https://example.test/0',
          sha1: 'a'.repeat(40),
        },
        {
          id: 'bulk-1',
          release_type: 'snapshot',
          release_time: new Date('2026-01-01'),
          metadata_url: 'https://example.test/1',
          sha1: 'b'.repeat(40),
        },
      ])
      .onConflict((c) => c.column('id').doNothing())
      .execute();
    let count = 0;
    const measured = f.db.withPlugin({
      transformQuery(args) {
        count++;
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const choices = await minecraftCatalog(measured, f.context, env);
    expect(count).toBe(3);
    expect(choices.filter((choice) => entries.some((row) => row.id === choice.id))).toHaveLength(
      1001,
    );
    expect(choices.slice(0, 2).map((choice) => choice.version)).toEqual(['bulk-1', 'bulk-0']);
    expect(choices.find((choice) => choice.version === 'bulk-2')?.releaseTime).toBeNull();
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({ docker_image: 'changed/image:21' })
      .where('id', '=', f.mappingId)
      .execute();
    expect(
      (await minecraftCatalog(measured, f.context, env)).some((choice) =>
        entries.some((row) => row.id === choice.id),
      ),
    ).toBe(false);
  });
  it('bulk choices retain undeclared runtime signatures, private testing and availability gates', async () => {
    const paper = { ...combination, profile: 'paper' };
    await f.db
      .updateTable('minecraft_combinations')
      .set({ combination: JSON.stringify(paper), enabled: true })
      .where('id', '=', choiceId)
      .execute();
    const present = async () =>
      (await minecraftCatalog(f.db, f.context, env)).some((row) => row.id === choiceId);
    expect(await present()).toBe(false);
    const value = {
      ...(await report('protocol-fixture')),
      combinationDigest: minecraftDigest(paper),
    };
    await importMinecraftEvidence(
      f.db,
      f.owner,
      choiceId,
      { report: value, signature: signMinecraftEvidence(value, env) },
      env,
    );
    expect(await present()).toBe(false);
    await f.db
      .updateTable('game_rollouts')
      .set({ state: 'private-testing', allowlist: [f.context.subjectUserId] })
      .where('integration_id', '=', 'minecraft-java')
      .execute();
    expect(await present()).toBe(true);
    expect((await minecraftCatalog(f.db, f.context, {})).some((row) => row.id === choiceId)).toBe(
      false,
    );
    await f.db
      .updateTable('game_rollouts')
      .set({ allowlist: [] })
      .where('integration_id', '=', 'minecraft-java')
      .execute();
    expect(await present()).toBe(false);
  });
  it('registers only a complete explicitly frozen actual egg environment', async () => {
    const versionUrl = 'https://piston-meta.mojang.com/v1/packages/fixture/1.21.1.json';
    const version = Buffer.from(
      JSON.stringify({
        id: '1.21.1',
        javaVersion: { majorVersion: 21 },
        downloads: {
          server: {
            url: 'https://piston-data.mojang.com/v1/objects/fixture/server.jar',
            sha1: 'a'.repeat(40),
            size: 1,
          },
        },
      }),
    );
    const manifest = Buffer.from(
      JSON.stringify({
        versions: [
          {
            id: '1.21.1',
            type: 'release',
            url: versionUrl,
            sha1: createHash('sha1').update(version).digest('hex'),
          },
        ],
      }),
    );
    const metadata = {
      read: async (url: string) => ({
        bytes: url === versionUrl ? version : manifest,
        evidence: { url, sha256: 'b'.repeat(64), retrievedAt: new Date().toISOString() },
      }),
    };
    const protocols = async () => ({
      source: { url: 'https://example.test/protocols', sha256: 'c'.repeat(64) },
      releases: new Map([
        [
          '1.21.1',
          {
            release: '1.21.1',
            protocolId: 767,
            family: 'netty' as const,
            transfer: false,
            releaseType: 'release' as const,
          },
        ],
      ]),
    });
    const adapter = {
      ...f.adapter,
      getEgg: async () => ({
        id: 1,
        nest: 1,
        relationships: {
          variables: {
            object: 'list',
            data: [
              { attributes: { env_variable: 'VERSION', default_value: 'latest' } },
              { attributes: { env_variable: 'FLAGS', default_value: 'untrusted-default' } },
            ],
          },
        },
      }),
    } as unknown as PterodactylAdapter;
    const input = {
      mappingId: f.mappingId,
      runtime: { release: '1.21.1', profile: 'vanilla' },
      binding: {
        profile: 'vanilla',
        release: '1.21.1',
        image: 'fixture/image:1',
        imageJavaMajor: 21,
        declaredEggVariables: ['VERSION'],
        bindings: { release: 'VERSION' },
        fixedVariables: {},
        installationKind: 'server-jar',
        artifactPaths: { server: 'server.jar' },
        supportedProperties: [],
      },
    };
    await expect(
      registerMinecraftCombination(f.db, adapter, f.owner, input, env, { metadata, protocols }),
    ).rejects.toThrow('configuration_invalid');
    input.binding.declaredEggVariables.push('FLAGS');
    await expect(
      registerMinecraftCombination(f.db, adapter, f.owner, input, env, { metadata, protocols }),
    ).rejects.toThrow('configuration_invalid');
    input.binding.fixedVariables = { FLAGS: '' };
    await expect(
      registerMinecraftCombination(f.db, adapter, f.owner, input, env, { metadata, protocols }),
    ).resolves.toEqual({ id: expect.any(String) });
  });
  it('compiled Vanilla installation works without local evidence while diagnostics remain truthful', async () => {
    await setMinecraftAvailability(f.db, f.owner, choiceId, { enabled: true }, env);
    expect((await inspectMinecraftCombination(f.db, choiceId, env)).support).toBe('unverified');
    await expect(requireMinecraftChoice(f.db, f.context, choiceId)).resolves.toMatchObject({
      supportAuthority: 'integration',
      capabilities: { installation: true, gateway: false, sleepWake: false },
    });
    expect((await minecraftCatalog(f.db, f.context)).some((row) => row.id === choiceId)).toBe(true);
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
    expect(row).toMatchObject({
      id: choiceId,
      version: '1.21.1',
      releaseType: 'release',
      runtime: 'vanilla',
    });
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
  it('diagnostic fixture evidence does not gate Vanilla but rollout and allowlists remain authoritative', async () => {
    await attest('protocol-fixture');
    await setMinecraftAvailability(f.db, f.owner, choiceId, { enabled: true }, env);
    await expect(requireMinecraftChoice(f.db, f.owner, choiceId, env)).resolves.toMatchObject({
      supportAuthority: 'integration',
    });
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
