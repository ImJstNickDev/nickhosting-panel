import { describe, expect, it } from 'vitest';
import {
  createMinecraftIdentityProvider,
  editMinecraftProperties,
  minecraftAvatarUrl,
  minecraftUuid,
  parseMinecraftProperties,
  planMinecraftPlayerList,
  planMinecraftWorldImport,
  planMinecraftWorldSelection,
  verifyMinecraftPlayer,
} from './management.js';
import { assertModpackRuntimeCompatible, minecraftWizard } from './wizard.js';

const uuid = '12345678-1234-4234-9234-123456789abc';
const player = {
  uuid,
  name: 'Example_1',
  source: 'mojang' as const,
  verifiedAt: '2026-10-10T00:00:00.000Z',
};
describe('Minecraft properties plans', () => {
  it('preserves unrelated values/comments and uses verified version-specific supported keys', () => {
    const input = '# custom\nmotd=Old\nserver-port=25565\nprivate-custom=value\n';
    const plan = editMinecraftProperties(
      input,
      { motd: 'A = friendly server', pvp: false },
      { release: '26.1', supportedKeys: ['motd', 'pvp'] },
    );
    expect(parseMinecraftProperties(plan.content)).toMatchObject({
      motd: 'A = friendly server',
      pvp: 'false',
      'server-port': '25565',
      'private-custom': 'value',
    });
    expect(plan.content).toContain('# custom');
    expect(plan.beforeSha256).not.toBe(plan.afterSha256);
    expect(plan.requiresStoppedServer).toBe(true);
    expect(() =>
      editMinecraftProperties(
        input,
        { 'simulation-distance': 8 },
        { release: '1.16.5', supportedKeys: ['motd'] },
      ),
    ).toThrow();
  });
  it('handles Java property escapes and continuation, rejects duplicate escaped keys', () => {
    expect(parseMinecraftProperties('motd=hello\\\n  world\nx\\:y : value\\=42\n')).toEqual({
      motd: 'helloworld',
      'x:y': 'value=42',
    });
    expect(() => parseMinecraftProperties('motd=one\nmot\\u0064=two')).toThrow();
    expect(() => parseMinecraftProperties('motd=bad\\u0xx0')).toThrow();
  });
  it('rejects exposure settings, invalid ranges and injected newlines even if declared supported', () => {
    for (const changes of [
      { 'server-ip': '0.0.0.0' },
      { 'online-mode': false },
      { 'rcon.password': 'bad' },
      { 'view-distance': 33 },
      { motd: 'hello\nserver-ip=0.0.0.0' },
    ] as Record<string, string | number | boolean>[])
      expect(() =>
        editMinecraftProperties('', changes, {
          release: '26.1',
          supportedKeys: Object.keys(changes),
        }),
      ).toThrow();
  });
});
describe('Minecraft identity and player mutation plans', () => {
  it('requires matching independent name and UUID responses', async () => {
    const verified = await verifyMinecraftPlayer(
      'example_1',
      {
        lookupName: async () => ({ id: uuid.replaceAll('-', ''), name: 'Example_1' }),
        lookupUuid: async () => ({ id: uuid, name: 'Example_1' }),
      },
      new Date(player.verifiedAt),
    );
    expect(verified).toEqual(player);
    await expect(
      verifyMinecraftPlayer('Example_1', {
        lookupName: async () => ({ id: uuid, name: 'Example_1' }),
        lookupUuid: async () => ({ id: uuid, name: 'SomeoneElse' }),
      }),
    ).rejects.toThrow();
    expect(minecraftAvatarUrl(verified, false)).toBeUndefined();
    expect(minecraftAvatarUrl(verified, true)).toContain(uuid);
    expect(() => minecraftUuid('00000000-0000-0000-0000-000000000000')).toThrow();
  });
  it('identity HTTP client pins origins, bounds bodies and rejects redirects', async () => {
    const calls: string[] = [];
    const provider = createMinecraftIdentityProvider({
      userAgent: 'NickHosting-Test',
      fetch: async (url, init) => {
        calls.push(String(url));
        expect(init?.redirect).toBe('error');
        return new Response(JSON.stringify({ id: uuid, name: 'Example_1' }));
      },
    });
    expect(await verifyMinecraftPlayer('Example_1', provider)).toMatchObject({
      uuid,
      source: 'mojang',
    });
    expect(calls).toEqual([
      'https://api.mojang.com/users/profiles/minecraft/Example_1',
      `https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replaceAll('-', '')}`,
    ]);
    const excessive = createMinecraftIdentityProvider({
      userAgent: 'NickHosting-Test',
      fetch: async () => new Response('x'.repeat(65_537)),
    });
    await expect(excessive.lookupName('Example_1')).rejects.toThrow();
    expect(() => provider.lookupName('bad/name')).toThrow();
  });
  it('plans idempotent whitelist and operator changes without shell/console interpolation', () => {
    const first = planMinecraftPlayerList('[]', 'whitelist', 'add', player);
    expect(planMinecraftPlayerList(first.content, 'whitelist', 'add', player).content).toBe(
      first.content,
    );
    expect(
      JSON.parse(planMinecraftPlayerList(first.content, 'whitelist', 'remove', player).content),
    ).toEqual([]);
    const op = planMinecraftPlayerList('[]', 'operators', 'add', player, { operatorLevel: 2 });
    expect(JSON.parse(op.content)[0]).toMatchObject({ uuid, level: 2, bypassesPlayerLimit: false });
    expect(() =>
      planMinecraftPlayerList(op.content, 'operators', 'add', player, { operatorLevel: 5 }),
    ).toThrow();
    expect(() =>
      planMinecraftPlayerList('[{"uuid":"bad","name":"Example_1"}]', 'whitelist', 'remove', player),
    ).toThrow();
  });
});
const world = [
  { path: 'source/level.dat', size: 100, compressedSize: 100, type: 'file' as const },
  { path: 'source/region/r.0.0.mca', size: 1000, compressedSize: 100, type: 'file' as const },
];
describe('Minecraft isolated world plans', () => {
  it('maps one world root without rewriting version-specific dimension layouts', () => {
    const plan = planMinecraftWorldImport(
      [
        ...world,
        {
          path: 'source/dimensions/minecraft/the_nether/region/r.0.0.mca',
          size: 100,
          compressedSize: 50,
          type: 'file',
        },
      ],
      { targetWorld: 'survival', maxBytes: 10_000 },
    );
    expect(plan.files[2]?.target).toBe('survival/dimensions/minecraft/the_nether/region/r.0.0.mca');
    expect(plan.requiresNbtValidation).toBe(true);
    expect(plan.totalBytes).toBe(1200);
  });
  it.each([
    '../other/level.dat',
    '/level.dat',
    'C:/level.dat',
    'source/../level.dat',
    'source\\level.dat',
    'source/mod.jar',
    'source/.hidden/file',
  ])('rejects unsafe world path %s', (path) => {
    expect(() =>
      planMinecraftWorldImport([...world, { path, size: 1, compressedSize: 1, type: 'file' }], {
        targetWorld: 'safe',
        maxBytes: 10000,
      }),
    ).toThrow();
  });
  it('rejects case collisions, multiple worlds, symlinks, bombs and storage exhaustion', () => {
    for (const addition of [
      { path: 'source/LEVEL.DAT', size: 1, compressedSize: 1, type: 'file' as const },
      { path: 'other/level.dat', size: 1, compressedSize: 1, type: 'file' as const },
      { path: 'source/link', size: 1, compressedSize: 1, type: 'symlink' as const },
      { path: 'source/bomb', size: 1000, compressedSize: 1, type: 'file' as const },
    ])
      expect(() =>
        planMinecraftWorldImport([...world, addition], { targetWorld: 'safe', maxBytes: 10000 }),
      ).toThrow();
    expect(() => planMinecraftWorldImport(world, { targetWorld: 'safe', maxBytes: 100 })).toThrow();
    expect(() =>
      planMinecraftWorldImport(world, { targetWorld: 'plugins', maxBytes: 10000 }),
    ).toThrow();
  });
  it('selects only verified compatible world DataVersion and preserves config', () => {
    const plan = planMinecraftWorldSelection(
      'motd=Hi\nlevel-name=old\n',
      { name: 'survival', verifiedDataVersion: 5000, sha256: 'a'.repeat(64) },
      { allowedDataVersions: [5000] },
    );
    expect(parseMinecraftProperties(plan.content)).toEqual({
      motd: 'Hi',
      'level-name': 'survival',
    });
    expect(() =>
      planMinecraftWorldSelection(
        '',
        { name: 'survival', verifiedDataVersion: 5001, sha256: 'a'.repeat(64) },
        { allowedDataVersions: [5000] },
      ),
    ).toThrow();
  });
});
describe('Minecraft four-step public wizard', () => {
  const choices = [
    {
      id: 'choice1',
      release: '26.1',
      runtime: 'fabric' as const,
      nameKey: 'games.minecraft-java.runtime.fabric',
      protocol: 9999,
      status: 'verified',
    },
  ];
  const pack = {
    provider: 'modrinth' as const,
    projectId: 'pack',
    versionId: 'version',
    release: '26.1',
    runtime: 'fabric' as const,
    loaderVersion: '0.19.5',
    choiceId: 'choice1',
  };
  it('uses four steps, derives pack runtime/version and retains player settings without technical badges', () => {
    const descriptor = minecraftWizard(choices, pack);
    expect(descriptor.steps.map((step) => step.id)).toEqual([
      'choose-game',
      'configure',
      'resources',
      'create',
    ]);
    const fields = descriptor.steps[1]?.fields.map((field) => field.id);
    expect(fields).toContain('operators');
    expect(fields).toContain('whitelist');
    expect(fields).not.toContain('runtimeVersion');
    expect(JSON.stringify(descriptor)).not.toContain('protocol');
    expect(JSON.stringify(descriptor)).not.toContain('verified');
    expect(minecraftWizard(choices).steps[1]?.fields.map((field) => field.id)).toContain(
      'runtimeVersion',
    );
  });
  it('cannot use an unavailable choice or silently retarget an existing immutable runtime', () => {
    expect(() => minecraftWizard([], pack)).toThrow();
    expect(() =>
      assertModpackRuntimeCompatible(
        { release: '26.1', runtime: 'fabric', loaderVersion: '0.19.5' },
        pack,
      ),
    ).not.toThrow();
    expect(() =>
      assertModpackRuntimeCompatible({ release: '26.1', runtime: 'paper' }, pack),
    ).toThrow();
    expect(() =>
      assertModpackRuntimeCompatible(
        { release: '26.1', runtime: 'fabric', loaderVersion: '0.19.4' },
        pack,
      ),
    ).toThrow();
  });
});
