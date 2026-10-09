import { createHash, randomUUID } from 'node:crypto';
import { safeContentPath } from '@nickhosting/content-providers';
import { DomainError } from '@nickhosting/core';
import { describe, expect, it, vi } from 'vitest';
import {
  planMinecraftPlayerList,
  verifyMinecraftPlayer,
} from '../../../games/minecraft/src/management.js';
import type { GameLifecycleContext } from './lifecycle.js';
import {
  applyMinecraftStoredPlayerChange,
  applyMinecraftTextChange,
  assertMinecraftContentTarget,
  assertMinecraftModpackTransition,
  assertMinecraftRuntimePathsPreserved,
  hashMinecraftRemoteFile,
  type MinecraftPreparedContent,
  minecraftConfigurationSchema,
  minecraftContentCommandSchema,
  minecraftContentWipePreview,
  resolveMinecraftStoredPlayers,
} from './minecraft-content.js';
import { minecraftStoredConfigurationSchema } from './minecraft-content-contracts.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const steps = new Set<string>();
  const symlinks = new Set<string>();
  let selected = '';
  const operation = { job_id: 'fixture', phase: 'planned', effect_state: 'none', plan: {} };
  const db = {
    selectFrom: () => {
      const query = {
        select: () => query,
        where: (column: string, _op: string, value: string) => {
          if (column === 'step') selected = value;
          return query;
        },
        executeTakeFirst: async () => (steps.has(selected) ? { step: selected } : undefined),
      };
      return query;
    },
    insertInto: () => {
      const query = {
        values: (value: { step: string }) => {
          selected = value.step;
          return query;
        },
        onConflict: () => query,
        execute: async () => {
          steps.add(selected);
        },
      };
      return query;
    },
  };
  const adapter = {
    listFiles: vi.fn(async (_identifier: string, root = '') => {
      const entries = new Map<
        string,
        { name: string; is_file: boolean; is_symlink: boolean; size: number }
      >();
      for (const [path, value] of files) {
        if (root && !path.startsWith(`${root}/`)) continue;
        const relative = root ? path.slice(root.length + 1) : path;
        const name = relative.split('/')[0] ?? '';
        entries.set(name, {
          name,
          is_file: !relative.includes('/'),
          is_symlink: symlinks.has([root, name].filter(Boolean).join('/')),
          size: Buffer.byteLength(value),
        });
      }
      return [...entries.values()];
    }),
    readFile: vi.fn(async (_id: string, path: string) => Buffer.from(files.get(path) ?? '')),
    downloadFile: vi.fn(
      async (
        _id: string,
        path: string,
        options: { authorize: () => Promise<void>; maxBytes: number },
      ) => {
        await options.authorize();
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from(files.get(path) ?? ''));
              controller.close();
            },
          }),
        };
      },
    ),
    writeFile: vi.fn(async (_id: string, path: string, value: string) => {
      files.set(path, value);
    }),
  };
  const authorize = vi.fn(async () => {});
  const assertStopped = vi.fn(async () => {});
  const context = {
    db,
    adapter,
    server: { id: 'fixture', pterodactyl_identifier: 'fixture' },
    operation: () => operation,
    authorize,
    assertStopped,
    effect: async (phase: string, action: () => Promise<void>) => {
      operation.phase = phase;
      operation.effect_state = 'prepared';
      await action();
      operation.effect_state = 'confirmed';
      return true;
    },
  } as unknown as GameLifecycleContext;
  return { context, files, steps, symlinks, operation, adapter, authorize, assertStopped };
}
const change = (before = 'motd=Old\n', after = 'motd=New\n') => ({
  path: 'server.properties' as const,
  content: after,
  beforeSha256: hash(before),
  afterSha256: hash(after),
});

describe('Minecraft durable content safety', () => {
  it('keeps every permitted pack path inside the previewed content roots', () => {
    for (const path of [
      'kubejs/example.cfg',
      'scripts/example.cfg',
      'resourcepacks/pack.zip',
      'root.cfg',
    ])
      expect(() => safeContentPath(path)).toThrow('validation_failed');
    for (const path of [
      'mods/example.jar',
      'plugins/example.jar',
      'config/example.cfg',
      'defaultconfigs/example.cfg',
    ])
      expect(() => safeContentPath(path)).not.toThrow();
  });
  it('allows explicitly consented empty pack previews while keeping world replacement scoped', () => {
    const replace = { wipeConsent: true as const, expectedDeletePaths: [], backupBefore: false };
    expect(
      minecraftContentCommandSchema.safeParse({
        kind: 'modpack-upload',
        archiveRef: randomUUID(),
        replace,
      }).success,
    ).toBe(true);
    expect(
      minecraftContentCommandSchema.safeParse({
        kind: 'world-import',
        archiveRef: randomUUID(),
        targetWorld: 'world',
        replace,
      }).success,
    ).toBe(false);
  });
  it('requires replacement consent for changed pack project, version or uploaded identity', () => {
    const current = { provider: 'modrinth' as const, projectId: 'packA', versionId: 'versionA' };
    const changed = [
      { kind: 'modpack' as const, ...current, projectId: 'packB' },
      { kind: 'modpack' as const, ...current, versionId: 'versionB' },
      { kind: 'modpack-upload' as const, archiveRef: randomUUID() },
    ];
    for (const command of changed) {
      const prepared = {
        combinationId: randomUUID(),
        command,
        previousModpack: current,
        backupBefore: false,
      };
      expect(() => assertMinecraftModpackTransition(current, prepared)).toThrow(
        'validation_failed',
      );
    }
    const uploaded = { sourceId: randomUUID() };
    expect(() =>
      assertMinecraftModpackTransition(uploaded, {
        combinationId: randomUUID(),
        command: { kind: 'modpack-upload', archiveRef: randomUUID() },
        previousModpack: uploaded,
        backupBefore: false,
      }),
    ).toThrow('validation_failed');
  });
  it('pins queued replacement consent to its prior selection, paths and backup decision', () => {
    const current = { sourceId: randomUUID() };
    const target = randomUUID();
    const prepared: MinecraftPreparedContent = {
      combinationId: randomUUID(),
      command: {
        kind: 'modpack-upload',
        archiveRef: target,
        replace: { wipeConsent: true, expectedDeletePaths: ['mods'], backupBefore: true },
      },
      previousModpack: current,
      backupBefore: true,
      deletePaths: ['mods'],
    };
    expect(() => assertMinecraftModpackTransition(current, prepared)).not.toThrow();
    expect(() => assertMinecraftModpackTransition({ sourceId: randomUUID() }, prepared)).toThrow(
      'conflict',
    );
    // Another job may already have selected this target; equality is not a receipt.
    expect(() => assertMinecraftModpackTransition({ sourceId: target }, prepared)).toThrow(
      'conflict',
    );
    expect(() =>
      assertMinecraftModpackTransition({ sourceId: target }, prepared, true),
    ).not.toThrow();
    expect(() =>
      assertMinecraftModpackTransition(current, { ...prepared, deletePaths: ['config'] }),
    ).toThrow('conflict');
    expect(() =>
      assertMinecraftModpackTransition(current, { ...prepared, backupBefore: false }),
    ).toThrow('conflict');
  });
  it('permits initial installation and exact same-pack retries without inventing wipe consent', () => {
    const current = { provider: 'modrinth' as const, projectId: 'pack', versionId: 'version' };
    const prepared = {
      combinationId: randomUUID(),
      command: { kind: 'modpack' as const, ...current },
      previousModpack: null,
      backupBefore: false,
    };
    expect(() => assertMinecraftModpackTransition(undefined, prepared)).not.toThrow();
    expect(() =>
      assertMinecraftModpackTransition(current, { ...prepared, previousModpack: current }),
    ).not.toThrow();
    const { previousModpack: _baseline, ...legacy } = prepared;
    expect(() => assertMinecraftModpackTransition(current, legacy)).not.toThrow();
    expect(() => assertMinecraftModpackTransition(undefined, legacy)).toThrow('conflict');
    expect(() =>
      assertMinecraftModpackTransition({ ...current, versionId: 'different' }, legacy),
    ).toThrow('conflict');
  });
  it('persists independently verified UUIDs before replay and never grants a reclaimed username', async () => {
    const first = '11111111111111111111111111111111';
    const reclaimed = '22222222222222222222222222222222';
    const provider = {
      lookupName: vi.fn(async () => ({ id: first, name: 'Original' })),
      lookupUuid: vi.fn(async () => ({ id: first, name: 'Original' })),
    };
    const prepared = await resolveMinecraftStoredPlayers(
      { eula: true, operators: ['Original'] },
      provider,
    );
    expect(provider.lookupName).toHaveBeenCalledOnce();
    const initial = prepared.playerIdentities?.operators[0];
    expect(initial?.uuid).toBe('11111111-1111-1111-1111-111111111111');
    provider.lookupName.mockImplementation(async () => ({ id: reclaimed, name: 'Original' }));
    provider.lookupUuid.mockImplementation(async () => ({ id: reclaimed, name: 'Original' }));
    const replay = await resolveMinecraftStoredPlayers(
      JSON.parse(JSON.stringify(prepared)),
      provider,
    );
    expect(provider.lookupName).toHaveBeenCalledOnce();
    expect(replay.playerIdentities?.operators[0]?.uuid).toBe(initial?.uuid);
    expect(minecraftConfigurationSchema.safeParse(replay).success).toBe(false);
  });
  it('retains explicit level-one operator permissions on reinstall and removes renamed players by UUID', async () => {
    const player = {
      uuid: '11111111-1111-1111-1111-111111111111',
      name: 'OldName',
      source: 'mojang' as const,
      verifiedAt: new Date().toISOString(),
      level: 1,
      bypassesPlayerLimit: false,
    };
    const configuration = applyMinecraftStoredPlayerChange(
      { eula: true },
      { list: 'operators', action: 'add' },
      player,
    );
    const provider = {
      lookupName: vi.fn(async () => ({ id: player.uuid, name: 'NewName' })),
      lookupUuid: vi.fn(async () => ({ id: player.uuid, name: 'NewName' })),
    };
    const replay = await resolveMinecraftStoredPlayers(configuration, provider);
    const stored = replay.playerIdentities?.operators[0];
    if (!stored) throw new Error('missing stored operator');
    const text = planMinecraftPlayerList('[]', 'operators', 'add', stored, {
      operatorLevel: stored.level,
      bypassesPlayerLimit: stored.bypassesPlayerLimit,
    });
    expect(JSON.parse(text.content)).toEqual([
      { uuid: player.uuid, name: 'OldName', level: 1, bypassesPlayerLimit: false },
    ]);
    expect(provider.lookupName).not.toHaveBeenCalled();
    const renamed = await verifyMinecraftPlayer('NewName', provider);
    const removed = applyMinecraftStoredPlayerChange(
      replay,
      { list: 'operators', action: 'remove' },
      renamed,
    );
    expect(removed.operators).toEqual([]);
    expect(removed.playerIdentities?.operators).toEqual([]);
    expect(
      minecraftStoredConfigurationSchema.safeParse({
        ...configuration,
        playerIdentities: { operators: [{ ...player, level: undefined }], whitelist: [] },
      }).success,
    ).toBe(false);
  });
  it('does not remove the original UUID when its former name has been reclaimed', () => {
    const original = {
      uuid: '11111111-1111-1111-1111-111111111111',
      name: 'Original',
      source: 'mojang' as const,
      verifiedAt: new Date().toISOString(),
      level: 1,
      bypassesPlayerLimit: false,
    };
    const config = applyMinecraftStoredPlayerChange(
      { eula: true },
      { list: 'operators', action: 'add' },
      original,
    );
    const result = applyMinecraftStoredPlayerChange(
      config,
      { list: 'operators', action: 'remove' },
      { ...original, uuid: '22222222-2222-2222-2222-222222222222' },
    );
    expect(result.playerIdentities?.operators).toEqual([original]);
  });
  it('requires explicit EULA consent and accepts independently verified player names only as inputs', () => {
    expect(minecraftConfigurationSchema.safeParse({ eula: false }).success).toBe(false);
    expect(
      minecraftConfigurationSchema.safeParse({ eula: true, operators: ['../bad'] }).success,
    ).toBe(false);
    expect(minecraftConfigurationSchema.parse({ eula: true })).toEqual({
      eula: true,
      properties: {},
      operators: [],
      whitelist: [],
    });
  });
  it('does not accept arbitrary plans, download URLs, paths or forged player UUIDs from clients', () => {
    for (const input of [
      { kind: 'modpack-upload', archiveRef: '/etc/passwd' },
      {
        kind: 'install',
        provider: 'modrinth',
        projectId: 'example',
        versionId: '1',
        url: 'https://evil.test',
      },
      { kind: 'player', list: 'operators', action: 'add', name: 'Player', uuid: 'forged' },
      {
        kind: 'modpack',
        provider: 'modrinth',
        projectId: 'p',
        versionId: 'v',
        replace: { wipeConsent: false, expectedDeletePaths: ['world'], backupBefore: true },
      },
    ])
      expect(minecraftContentCommandSchema.safeParse(input).success).toBe(false);
  });
  it('rejects loader, release and exact loader-version mismatch before any destructive work', () => {
    const target = {
      minecraftVersion: '1.21.11',
      loader: 'fabric' as const,
      loaderVersion: '0.18.4',
    };
    expect(() => assertMinecraftContentTarget(target, target)).not.toThrow();
    for (const next of [
      { ...target, minecraftVersion: '26.1' },
      { ...target, loader: 'forge' as const },
      { ...target, loaderVersion: '0.18.3' },
      { ...target, loaderVersion: undefined },
    ])
      expect(() => assertMinecraftContentTarget(next, target)).toThrow(DomainError);
  });
  it('writes only after a fresh hash precondition, authorization and physical stopped proof', async () => {
    const f = fixture({ 'server.properties': 'motd=Old\n' });
    await applyMinecraftTextChange(f.context, change());
    expect(f.files.get('server.properties')).toBe('motd=New\n');
    expect(f.assertStopped).toHaveBeenCalledOnce();
    expect(f.authorize).toHaveBeenCalled();
    expect(f.adapter.writeFile).toHaveBeenCalledOnce();
  });
  it('rejects edits to unrelated externally changed data without overwriting it', async () => {
    const f = fixture({ 'server.properties': 'motd=Owner changed this\n' });
    await expect(applyMinecraftTextChange(f.context, change())).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(f.adapter.writeFile).not.toHaveBeenCalled();
  });
  it('reconciles a lost success response using the recorded desired hash without repeating the write', async () => {
    const f = fixture({ 'server.properties': 'motd=Old\n' });
    f.adapter.writeFile.mockImplementationOnce(async (_id, path, value) => {
      f.files.set(path, value);
      throw new Error('lost acknowledgement');
    });
    await expect(applyMinecraftTextChange(f.context, change())).rejects.toThrow(
      'lost acknowledgement',
    );
    await applyMinecraftTextChange(f.context, change());
    expect(f.adapter.writeFile).toHaveBeenCalledOnce();
  });
  it('does not blindly replay an uncertain write whose desired value is absent', async () => {
    const f = fixture({ 'server.properties': 'motd=Old\n' });
    f.adapter.writeFile.mockRejectedValueOnce(new Error('unknown outcome'));
    await expect(applyMinecraftTextChange(f.context, change())).rejects.toThrow();
    await expect(applyMinecraftTextChange(f.context, change())).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    expect(f.adapter.writeFile).toHaveBeenCalledOnce();
  });
  it('fails closed on changed data after a completed step and on stopped-proof loss', async () => {
    const f = fixture({ 'server.properties': 'motd=Old\n' });
    await applyMinecraftTextChange(f.context, change());
    f.files.set('server.properties', 'motd=Changed later\n');
    await expect(applyMinecraftTextChange(f.context, change())).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    const other = fixture({ 'server.properties': 'motd=Old\n' });
    other.assertStopped.mockRejectedValueOnce(new DomainError('operation_uncertain'));
    await expect(applyMinecraftTextChange(other.context, change())).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    expect(other.adapter.writeFile).not.toHaveBeenCalled();
  });
  it('rejects symlinks and case aliases in every remote ancestor', async () => {
    const f = fixture({ 'mods/example.jar': 'bytes' });
    f.symlinks.add('mods');
    await expect(hashMinecraftRemoteFile(f.context, 'mods/example.jar')).rejects.toMatchObject({
      code: 'conflict',
    });
    f.symlinks.clear();
    f.files.set('Mods/other.jar', 'other');
    await expect(hashMinecraftRemoteFile(f.context, 'mods/example.jar')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(f.adapter.downloadFile).not.toHaveBeenCalled();
  });
  it('detects a remote stream changing size during verification', async () => {
    const f = fixture({ 'server.jar': 'abcd' });
    f.adapter.downloadFile.mockImplementationOnce(async () => ({
      body: new ReadableStream({
        start(c) {
          c.enqueue(Buffer.from('abcde'));
          c.close();
        },
      }),
    }));
    await expect(hashMinecraftRemoteFile(f.context, 'server.jar')).rejects.toMatchObject({
      code: 'conflict',
    });
  });
  it('protects attested runtime files even when an Owner maps them below a content/world directory', () => {
    const manifest = [{ path: 'mods/runtime/server.jar' }];
    for (const path of ['mods', 'mods/runtime', 'mods/runtime/server.jar'])
      expect(() => assertMinecraftRuntimePathsPreserved([path], manifest)).toThrow();
    expect(() =>
      assertMinecraftRuntimePathsPreserved(['world', 'mods/another.jar'], manifest),
    ).not.toThrow();
  });
  it('wipe preview includes only content and the selected world family, preserving runtime files', async () => {
    const f = fixture({
      'server.properties': 'level-name=Realm\n',
      'server.jar': 'runtime',
      'libraries/runtime.jar': 'runtime',
      'mods/mod.jar': 'mod',
      'Realm/level.dat': 'world',
      'Realm_nether/level.dat': 'nether',
      'unrelated/secret.txt': 'preserve',
    });
    expect(await minecraftContentWipePreview(f.context.adapter, 'fixture')).toEqual([
      'Realm',
      'Realm_nether',
      'mods',
    ]);
    expect(f.adapter.writeFile).not.toHaveBeenCalled();
  });
});
