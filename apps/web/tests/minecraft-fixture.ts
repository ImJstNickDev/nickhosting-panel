import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { createTestDatabase } from '@nickhosting/database/testing';
import {
  minecraftDigest,
  minecraftManifest,
  minecraftVerificationChecks,
} from '@nickhosting/minecraft';
import { minecraftMappingDigest, signMinecraftEvidence } from '@nickhosting/server-management';

/** Synthetic provider bytes and signed evidence are confined to the disposable
 * browser-test schema. They prove application integration, never Minecraft or
 * egg compatibility. M4's real-server report remains the compatibility evidence. */
export const browserMinecraft = {
  release: '26.1',
  protocolId: 775,
  javaMajor: 25,
  worldDataVersion: 5000,
  image: 'isolated-browser/java:25',
  imageDigest: `sha256:${'f'.repeat(64)}`,
  serverJar: Buffer.from('NickHosting isolated browser provider server artifact; not executable'),
  properties:
    'motd=Browser survival\nmax-players=20\npvp=true\nwhite-list=false\nlevel-name=world\nview-distance=10\nsimulation-distance=10\ndifficulty=normal\ngamemode=survival\n',
};

export function browserLevelDat() {
  const name = (value: string) => {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const int = Buffer.alloc(4);
  int.writeInt32BE(browserMinecraft.worldDataVersion);
  return gzipSync(
    Buffer.concat([
      Buffer.from([10, 0, 0, 10]),
      name('Data'),
      Buffer.from([3]),
      name('DataVersion'),
      int,
      Buffer.from([10]),
      name('Version'),
      Buffer.from([3]),
      name('Id'),
      int,
      Buffer.from([8]),
      name('Name'),
      name(browserMinecraft.release),
      Buffer.from([0, 0, 0]),
    ]),
  );
}

export async function installMinecraftBrowserChoice(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  mappingId: string,
  env: Record<string, string | undefined>,
) {
  const { db } = database;
  env.NH_MINECRAFT_EVIDENCE_KEY = randomBytes(32).toString('hex');
  env.NH_MINECRAFT_METADATA_USER_AGENT = 'NickHosting isolated browser fixture';
  await db
    .insertInto('game_integrations')
    .values({
      id: 'minecraft-java',
      version: minecraftManifest.version,
      manifest: minecraftManifest,
    })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await db
    .insertInto('game_rollouts')
    .values({ integration_id: 'minecraft-java', state: 'public', allowlist: [] })
    .execute();
  await db
    .updateTable('runtime_egg_mappings')
    .set({
      game_id: 'minecraft-java',
      runtime_id: 'vanilla',
      docker_image: browserMinecraft.image,
      startup: 'java -jar server.jar',
    })
    .where('id', '=', mappingId)
    .execute();
  const mapping = await db
    .selectFrom('runtime_egg_mappings')
    .selectAll()
    .where('id', '=', mappingId)
    .executeTakeFirstOrThrow();
  const sha256 = createHash('sha256').update(browserMinecraft.serverJar).digest('hex');
  const combination = {
    release: browserMinecraft.release,
    releaseType: 'release',
    protocolId: browserMinecraft.protocolId,
    family: 'netty',
    transfer: true,
    profile: 'vanilla',
    javaMajor: browserMinecraft.javaMajor,
    runtimeDigest: 'a'.repeat(64),
    protocolSource: {
      url: 'https://provider.example.test/browser-fixture/protocol',
      sha256: 'b'.repeat(64),
    },
  };
  const properties = Object.keys(
    Object.fromEntries(
      browserMinecraft.properties
        .trim()
        .split('\n')
        .map((line) => line.split('=')),
    ),
  );
  const binding = {
    profile: 'vanilla',
    release: browserMinecraft.release,
    image: browserMinecraft.image,
    imageJavaMajor: browserMinecraft.javaMajor,
    declaredEggVariables: ['VERSION'],
    bindings: { release: 'VERSION' },
    fixedVariables: {},
    installationKind: 'server-jar',
    artifactPaths: { server: 'server.jar' },
    supportedProperties: properties,
  };
  const runtime = {
    release: browserMinecraft.release,
    releaseType: 'release',
    profile: 'vanilla',
    javaMajor: browserMinecraft.javaMajor,
    artifacts: [
      { role: 'server', url: 'https://provider.example.test/browser-fixture/server.jar', sha256 },
    ],
    installation: { kind: 'server-jar' },
    evidence: [],
  };
  const choiceId = randomUUID();
  const mappingDigest = minecraftMappingDigest(mapping);
  const identityDigest = minecraftDigest({ combination, binding });
  await db
    .insertInto('minecraft_combinations')
    .values({
      id: choiceId,
      mapping_id: mappingId,
      combination: JSON.stringify(combination),
      resolved_runtime: JSON.stringify(runtime),
      binding: JSON.stringify(binding),
      mapping_digest: mappingDigest,
      identity_digest: identityDigest,
      enabled: true,
    })
    .execute();
  const report = {
    runId: randomUUID(),
    kind: 'real-server',
    combinationDigest: minecraftDigest(combination),
    mappingDigest,
    choiceDigest: identityDigest,
    recordedAt: new Date(Date.now() - 1000).toISOString(),
    checks: Object.fromEntries(minecraftVerificationChecks.map((key) => [key, true])),
    evidenceSha256: createHash('sha256')
      .update('SYNTHETIC BROWSER FIXTURE ONLY; no real-server verification')
      .digest('hex'),
    server: {
      uuid: randomUUID(),
      externalId: 'isolated-browser-provider-fixture',
      artifactSha256: sha256,
      imageDigest: browserMinecraft.imageDigest,
      javaMajor: browserMinecraft.javaMajor,
      worldDataVersion: browserMinecraft.worldDataVersion,
      supportedProperties: properties,
    },
    client: {
      implementation: 'synthetic-browser-fixture-not-real-client',
      version: 'fixture-1',
      protocolId: browserMinecraft.protocolId,
    },
  };
  await db
    .insertInto('minecraft_verification_evidence')
    .values({
      id: report.runId,
      combination_id: choiceId,
      report: JSON.stringify(report),
      signature: signMinecraftEvidence(report, env),
    })
    .execute();
  return choiceId;
}
