import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import type { FilemanEntry, FilemanJobServices, FilemanReadService } from '@nickhosting/game-sdk';
import { describe, expect, it, vi } from 'vitest';
import { minecraftModpackPrepareSchema } from '../../../games/minecraft/src/modpack-contracts.js';
import {
  type MinecraftModpackObservation,
  type PreparedMinecraftModpack,
  planMinecraftModpack,
} from './minecraft-modpacks-plan.js';
import {
  createModpackPublication,
  type ModpackPublicationJournal,
  modpackRemoteStage,
} from './modpack-publication.js';
import { createOperationTiming } from './operation-timing.js';

const oldTime = '2026-01-01T00:00:00Z';
const newTime = '2026-02-01T00:00:00Z';
const file = (path: string, hash = 'a') => ({ path, size: 50, sha256: hash.repeat(64) });
const dirname = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test fixture');
  return value;
}
function fixture(recovery = false) {
  const operationId = randomUUID();
  const target = {
    minecraftVersion: '1.21.1',
    loader: 'fabric' as const,
    loaderVersion: '0.16.10',
  };
  const binding = { combinationId: randomUUID(), mappingId: randomUUID(), target };
  const prepared: PreparedMinecraftModpack = {
    pack: {
      project: {
        id: 'pack',
        provider: 'modrinth',
        name: 'Pack',
        summary: '',
        websiteUrl: 'https://example.test/pack',
        authors: [],
      },
      version: {
        id: 'v2',
        projectId: 'pack',
        name: '2',
        version: '2',
        minecraftVersions: ['1.21.1'],
        loaders: ['fabric'],
        channel: 'release',
        available: true,
        source: 'modrinth-index',
      },
    },
    target,
    stagingKey: 'private/stage',
    files: [file('mods/new.jar')],
    blockers: [],
  };
  const tree = new Map<string, FilemanEntry>();
  const add = (
    path: string,
    kind: FilemanEntry['kind'] = 'file',
    time = oldTime,
    size = kind === 'file' ? 50 : 0,
  ) => {
    if (dirname(path) && !tree.has(dirname(path))) add(dirname(path), 'directory', time);
    tree.set(path, { name: basename(path), kind, size, modifiedAt: time });
  };
  add('mods', 'directory');
  add('mods/old.jar');
  add('config', 'directory');
  add('config/local.toml');
  add('world/level.dat');
  add('server.properties');
  const selection = minecraftModpackPrepareSchema.parse({
    provider: 'modrinth',
    projectId: 'pack',
    versionId: 'v2',
    mode: 'replace',
    idempotencyKey: 'key',
  });
  const plan = () => {
    const observation: MinecraftModpackObservation = {
      entries: [...tree].map(([path, { name: _name, ...entry }]) => ({ ...entry, path })),
      combinationId: binding.combinationId,
      mappingId: binding.mappingId,
      worldRoots: ['world'],
      protectedPaths: ['server.jar'],
      replacePaths: ['mods'],
    };
    return planMinecraftModpack({
      prepared,
      selection,
      observation,
      previous: null,
      runtime: binding,
    });
  };
  let journal: ModpackPublicationJournal | null = null;
  const saveJournal = vi.fn(async (value: ModpackPublicationJournal) => {
    journal = structuredClone(value);
  });
  const authorize = vi.fn(async () => {});
  const listCalls: string[][] = [];
  const readScope = vi.fn(
    () =>
      ({
        listMany: vi.fn(async (directories: readonly string[]) => {
          listCalls.push([...directories]);
          return directories.map((directory) => {
            if (directory && !tree.has(directory))
              return { directory, error: 'unavailable' as const };
            if (directory && tree.get(directory)?.kind !== 'directory')
              return { directory, error: 'forbidden' as const };
            return {
              directory,
              files: [...tree]
                .filter(([path]) => dirname(path) === directory)
                .map(([, entry]) => ({ ...entry })),
            };
          });
        }),
      }) as unknown as FilemanReadService,
  );
  const adapter = {
    createDirectory: vi.fn(async (_identifier: string, root: string, name: string) => {
      add([root, name].filter(Boolean).join('/'), 'directory', newTime);
    }),
    renameFiles: vi.fn(
      async (_identifier: string, _root: string, moves: { from: string; to: string }[]) => {
        expect(journal?.batches.at(-1)?.moves).toEqual(moves);
        for (const move of moves) {
          if (!tree.has(move.from) || (dirname(move.to) && !tree.has(dirname(move.to)))) continue;
          if (tree.has(move.to)) throw new DomainError('conflict');
          const entries = [...tree].filter(([path]) => under(path, move.from));
          for (const [path] of entries) tree.delete(path);
          for (const [path, entry] of entries) {
            const to = move.to + path.slice(move.from.length);
            tree.set(to, { ...entry, name: basename(to) });
          }
        }
      },
    ),
    deleteFiles: vi.fn(async (_identifier: string, _root: string, names: string[]) => {
      for (const path of tree.keys())
        if (names.some((name) => under(path, name))) tree.delete(path);
    }),
  };
  const archive = vi.fn(
    async (
      _prepared: PreparedMinecraftModpack,
      files: readonly ReturnType<typeof file>[],
      destinationRoot: string,
    ) => {
      const contents = files.map((entry) => ({
        ...entry,
        path: `${destinationRoot}/${entry.path}`,
      }));
      return {
        sourceSha256: 'f'.repeat(64),
        contentLength: 1000,
        files: contents,
        open: () => new ReadableStream<Uint8Array>(),
        completion: Promise.resolve({
          files: contents,
          bytes: contents.reduce((sum, entry) => sum + entry.size, 0),
        }),
      };
    },
  );
  const uploadArchive = vi.fn(
    async (input: Parameters<NonNullable<FilemanJobServices['uploadArchive']>>[0]) => {
      expect(journal?.state).toBe('staging');
      await input.beforeWrite?.();
      const completion = await input.completion;
      const manifest = {
        id: input.id,
        destinationRoot: input.destinationRoot,
        files: completion.files,
      };
      await input.beforePublish(manifest);
      for (const entry of completion.files) add(entry.path, 'file', newTime, entry.size);
      return {
        id: input.id,
        digest: 'b'.repeat(64),
        files: completion.files.length,
        bytes: completion.bytes,
        manifest,
      };
    },
  );
  const assertArchiveResumable = vi.fn(async () => {});
  const resumeArchive = vi.fn(
    async (input: Parameters<NonNullable<FilemanJobServices['resumeArchive']>>[0]) => {
      await input.beforeWrite?.();
      const manifest = { id: input.id, destinationRoot: input.destinationRoot, files: input.files };
      await input.beforePublish(manifest);
      for (const entry of input.files) add(entry.path, 'file', newTime, entry.size);
      return {
        id: input.id,
        digest: 'b'.repeat(64),
        files: input.files.length,
        bytes: input.files.reduce((sum, file) => sum + file.size, 0),
        manifest,
      };
    },
  );
  const options = {
    operationId,
    identifier: 'test',
    fileman: {
      readScope,
      uploadArchive,
      uploadStaged: vi.fn(),
      ...(recovery ? { assertArchiveResumable, resumeArchive } : {}),
    },
    adapter,
    authorize,
    archive,
    readJournal: async () => structuredClone(journal),
    saveJournal,
  };
  return {
    ...options,
    prepared,
    plan,
    tree,
    add,
    readScope,
    listCalls,
    uploadArchive,
    assertArchiveResumable,
    resumeArchive,
    helper: createModpackPublication(options),
    journal: () => journal,
    resetHelper: () => createModpackPublication(options),
  };
}

describe('Modpack publication', () => {
  it('stages in the hidden operation directory without changing the installed pack, then publishes once', async () => {
    const f = fixture();
    const plan = f.plan();
    await f.helper.stage(f.prepared, plan);
    expect(f.journal()?.state).toBe('staged');
    expect(f.tree.has('mods/old.jar')).toBe(true);
    expect(f.tree.has('mods/new.jar')).toBe(false);
    expect(f.adapter.renameFiles).not.toHaveBeenCalled();
    expect(f.adapter.createDirectory).not.toHaveBeenCalled();
    await f.helper.publish(f.prepared, plan);
    expect(f.uploadArchive).toHaveBeenCalledTimes(1);
    expect(f.archive).toHaveBeenCalledTimes(1);
    expect(f.tree.has('mods/new.jar')).toBe(true);
    expect(await f.helper.verify(f.prepared, plan)).not.toBeNull();
  });

  it('does not trust an in-memory staging receipt after reconstruction or overwrite changed destinations', async () => {
    const f = fixture();
    const plan = f.plan();
    await f.helper.stage(f.prepared, plan);
    await expect(f.resetHelper().publish(f.prepared, plan)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    f.add('mods/old.jar', 'file', newTime);
    await expect(f.helper.publish(f.prepared, plan)).rejects.toMatchObject({ code: 'conflict' });
    expect(f.adapter.renameFiles).not.toHaveBeenCalled();
  });

  it('reports publication phases with fixed labels and no paths', async () => {
    const f = fixture();
    let tick = 0;
    const timing = createOperationTiming(true, () => ++tick);
    const helper = createModpackPublication({ ...f, timing, readJournal: async () => f.journal() });
    const plan = f.plan();
    await helper.publish(f.prepared, plan);
    expect(await helper.verify(f.prepared, plan)).not.toBeNull();
    await helper.cleanup(f.prepared, plan, { applied: true });
    const report = timing.report();
    expect(Object.keys(report.stages)).toEqual(
      expect.arrayContaining([
        'archive',
        'uploadExtract',
        'directoryBatch',
        'retireRename',
        'publishRename',
        'cleanupDelete',
      ]),
    );
    expect(JSON.stringify(report)).not.toContain('mods/');
    expect(f.uploadArchive).toHaveBeenCalledTimes(1);
    expect(report.droppedSpans).toBe(0);
  });
  it('resumes only the exact retained transfer and publishes without rebuilding or uploading', async () => {
    const f = fixture(true);
    const plan = f.plan();
    f.uploadArchive.mockRejectedValueOnce(new DomainError('operation_uncertain'));
    await expect(f.helper.publish(f.prepared, plan)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    expect(f.journal()).toMatchObject({
      state: 'staging',
      stageFiles: [],
      batches: [],
      rollbackCreated: false,
    });
    expect(await f.resetHelper().recover(f.prepared, plan)).toEqual({
      state: 'resume-publication',
    });
    expect(f.resumeArchive).not.toHaveBeenCalled();
    expect(f.adapter.renameFiles).not.toHaveBeenCalled();
    await f.resetHelper().resume(f.prepared, plan);
    expect(await f.helper.verify(f.prepared, plan)).toEqual([
      { ...file('mods/new.jar'), modifiedAt: newTime },
    ]);
    expect(f.archive).toHaveBeenCalledTimes(1);
    expect(f.uploadArchive).toHaveBeenCalledTimes(1);
    expect(f.resumeArchive).toHaveBeenCalledTimes(1);
    expect(f.tree.has('world/level.dat')).toBe(true);
  });

  it.each([
    'claim',
    'original',
    'rename',
    'rollback',
    'binding',
    'provider',
    'extra-stage',
  ] as const)('refuses unsafe publication continuation for %s', async (reason) => {
    const f = fixture(true);
    const plan = f.plan();
    f.uploadArchive.mockRejectedValueOnce(new DomainError('operation_uncertain'));
    await expect(f.helper.publish(f.prepared, plan)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    const journal = f.journal();
    if (!journal) throw new Error('Missing journal');
    if (reason === 'claim')
      f.assertArchiveResumable.mockRejectedValue(new DomainError('operation_uncertain'));
    if (reason === 'original') required(f.tree.get('mods/old.jar')).modifiedAt = newTime;
    if (reason === 'rename')
      await f.saveJournal({ ...journal, batches: [{ phase: 'publish', moves: journal.publish }] });
    if (reason === 'rollback') await f.saveJournal({ ...journal, rollbackCreated: true });
    if (reason === 'binding') await f.saveJournal({ ...journal, binding: 'e'.repeat(64) });
    if (reason === 'provider')
      f.resumeArchive.mockRejectedValue(new DomainError('operation_uncertain'));
    if (reason === 'extra-stage') f.add(`${f.helper.getRemoteStage(plan).stagingRoot}/extra.txt`);
    await expect(f.resetHelper().resume(f.prepared, plan)).rejects.toBeInstanceOf(DomainError);
    expect(f.adapter.renameFiles).not.toHaveBeenCalled();
    expect(f.archive).toHaveBeenCalledTimes(1);
    expect(f.uploadArchive).toHaveBeenCalledTimes(1);
  });

  it('stages once, retires replaced data, publishes a whole subtree, retains worlds and configs', async () => {
    const f = fixture();
    const plan = f.plan();
    const roots = f.helper.getRemoteStage(plan);
    await f.helper.publish(f.prepared, plan);
    expect(await f.helper.verify(f.prepared, plan)).toEqual([
      { ...file('mods/new.jar'), modifiedAt: newTime },
    ]);
    expect(f.tree.has(`${roots.rollbackRoot}/0/old.jar`)).toBe(true);
    expect(f.tree.has('mods/old.jar')).toBe(false);
    expect(f.tree.has('world/level.dat')).toBe(true);
    expect(f.tree.has('config/local.toml')).toBe(true);
    expect(f.tree.has('server.properties')).toBe(true);
    expect(f.uploadArchive).toHaveBeenCalledTimes(1);
    expect(f.adapter.renameFiles).toHaveBeenNthCalledWith(2, 'test', '', [
      { from: `${roots.stagingRoot}/mods`, to: 'mods' },
    ]);
    expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
    expect(f.journal()?.state).toBe('verified');
  });

  it('trusts confirmed extraction, checks original targets, and records real mtimes only at final readback', async () => {
    const f = fixture();
    f.prepared.files = [file('mods/deep/a.jar'), file('mods/deep/b.jar')];
    const plan = f.plan();
    const root = f.helper.getRemoteStage(plan).stagingRoot;
    await f.helper.publish(f.prepared, plan);
    expect(f.journal()?.stageFiles.every((file) => file.modifiedAt === undefined)).toBe(true);
    expect(f.listCalls.flat().some((directory) => directory.startsWith(`${root}/`))).toBe(false);
    expect(f.listCalls.flat()).toContain('mods');
    const result = await f.helper.verify(f.prepared, plan);
    expect(result).toEqual(f.prepared.files.map((file) => ({ ...file, modifiedAt: newTime })));
    expect(f.journal()?.stageFiles).toEqual(result);
    expect(f.listCalls.flat().some((directory) => directory.startsWith(`${root}/`))).toBe(false);
    required(f.tree.get('mods/deep/a.jar')).modifiedAt = oldTime;
    expect(await f.helper.verify(f.prepared, plan)).toBeNull();
  });

  it('checks retired roots before publication and walks their descendants only in the final receipt', async () => {
    const f = fixture();
    f.add('mods/old/deep/keep.jar');
    const plan = f.plan();
    const { rollbackRoot } = f.helper.getRemoteStage(plan);
    await f.helper.publish(f.prepared, plan);
    expect(f.listCalls.flat()).toContain(rollbackRoot);
    expect(f.listCalls.flat().some((path) => path.startsWith(`${rollbackRoot}/`))).toBe(false);
    const retired = required(f.tree.get(`${rollbackRoot}/0/old/deep/keep.jar`));
    retired.size++;
    // Delaying this scan must never turn a corrupted rollback tree into a
    // successful receipt or allow its cleanup.
    expect(await f.helper.verify(f.prepared, plan)).toBeNull();
    expect(f.listCalls.flat()).toContain(`${rollbackRoot}/0/old/deep`);
    await expect(f.helper.cleanup(f.prepared, plan, { applied: true })).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
  });

  it('retains detailed stage inspection when recovering before the first rename', async () => {
    const f = fixture(true);
    const plan = f.plan();
    const root = f.helper.getRemoteStage(plan).stagingRoot;
    const save = required(f.saveJournal.getMockImplementation());
    f.saveJournal.mockImplementation(async (journal) => {
      await save(journal);
      if (journal.state === 'staged') throw new Error('Worker interrupted before retirement');
    });
    await expect(f.helper.publish(f.prepared, plan)).rejects.toThrow('Worker interrupted');
    expect(f.journal()?.stageFiles.every((file) => file.modifiedAt === undefined)).toBe(true);
    f.saveJournal.mockImplementation(save);
    expect(await f.helper.recover(f.prepared, plan)).toEqual({ state: 'resume-publication' });
    expect(f.listCalls.flat()).toContain(`${root}/mods`);
    await f.helper.resume(f.prepared, plan);
    expect(await f.helper.verify(f.prepared, plan)).toEqual([
      { ...file('mods/new.jar'), modifiedAt: newTime },
    ]);
    expect(f.uploadArchive).toHaveBeenCalledTimes(1);
    expect(f.archive).toHaveBeenCalledTimes(1);
  });

  it('retains rollback originals when a successful extraction receipt omitted a selected file', async () => {
    const f = fixture();
    const plan = f.plan();
    const roots = f.helper.getRemoteStage(plan);
    const upload = required(f.uploadArchive.getMockImplementation());
    f.uploadArchive.mockImplementation(async (input) => {
      const receipt = await upload(input);
      f.tree.delete(`${roots.stagingRoot}/mods/new.jar`);
      return receipt;
    });
    await f.helper.publish(f.prepared, plan);
    expect(await f.helper.verify(f.prepared, plan)).toBeNull();
    expect(await f.helper.recover(f.prepared, plan)).toEqual({ state: 'partial' });
    expect(f.tree.has(`${roots.rollbackRoot}/0/old.jar`)).toBe(true);
    expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
  });

  it.each(['missing', 'size', 'kind'] as const)(
    'keeps incomplete final publication uncertain for %s',
    async (change) => {
      const f = fixture();
      const plan = f.plan();
      await f.helper.publish(f.prepared, plan);
      if (change === 'missing') f.tree.delete('mods/new.jar');
      if (change === 'size') required(f.tree.get('mods/new.jar')).size += 1;
      if (change === 'kind') required(f.tree.get('mods/new.jar')).kind = 'symlink';
      expect(await f.helper.verify(f.prepared, plan)).toBeNull();
      expect(await f.helper.recover(f.prepared, plan)).toEqual({ state: 'partial' });
    },
  );

  it('uses one directory move for a new deep tree, no directory creation loops', async () => {
    const f = fixture();
    f.prepared.files = Array.from({ length: 250 }, (_, index) => file(`kubejs/a/b/${index}.js`));
    const plan = f.plan();
    await f.helper.publish(f.prepared, plan);
    expect(await f.helper.verify(f.prepared, plan)).toHaveLength(250);
    expect(f.adapter.createDirectory).toHaveBeenCalledTimes(1); // rollback only
    expect(f.journal()?.publish).toEqual([
      { from: `${modpackRemoteStage(f.operationId).stagingRoot}/kubejs`, to: 'kubejs' },
    ]);
  });

  it('recovers and publishes new trees without listing missing directories', async () => {
    const f = fixture(true);
    f.prepared.files = [
      file('kubejs/a/b/startup.js'),
      ...Array.from({ length: 105 }, (_, index) => file(`config/new-${index}/deep/settings.toml`)),
    ];
    const plan = f.plan();
    f.uploadArchive.mockRejectedValueOnce(new DomainError('operation_uncertain'));
    await expect(f.helper.publish(f.prepared, plan)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    await f.helper.assertResumable(f.prepared, plan);
    expect(f.listCalls.flat()).toContain('config');
    expect(f.listCalls.flat()).not.toContain('kubejs');
    expect(f.listCalls.flat().some((directory) => directory.startsWith('config/new-'))).toBe(false);
    await f.helper.resume(f.prepared, plan);
    expect(await f.helper.verify(f.prepared, plan)).toHaveLength(106);
    expect(f.listCalls.some((batch) => batch.length === 100)).toBe(true);
    for (const result of f.readScope.mock.results) {
      const calls = vi.mocked(result.value.listMany).mock.calls as [readonly string[]][];
      const listed = calls.flatMap(([directories]) => [...directories]);
      expect(listed[0]).toBe('');
      expect(new Set(listed).size).toBe(listed.length);
      for (const [index, directory] of listed.entries()) {
        if (directory) expect(listed.indexOf(dirname(directory))).toBeLessThan(index);
      }
    }
    expect(f.archive).toHaveBeenCalledTimes(1);
    expect(f.uploadArchive).toHaveBeenCalledTimes(1);
    expect(f.resumeArchive).toHaveBeenCalledTimes(1);
  });

  it.each(['not_found', 'unavailable'] as const)(
    'rejects %s from a directory already confirmed by its parent',
    async (error) => {
      const f = fixture();
      const plan = f.plan();
      const read = required(f.readScope.getMockImplementation());
      f.readScope.mockImplementation(() => {
        const scope = read();
        const list = scope.listMany.bind(scope);
        scope.listMany = async (directories) =>
          (await list(directories)).map((result) =>
            result.directory === 'mods' ? { directory: result.directory, error } : result,
          );
        return scope;
      });
      await expect(f.helper.publish(f.prepared, plan)).rejects.toMatchObject({
        code: 'operation_uncertain',
      });
      expect(f.adapter.renameFiles).not.toHaveBeenCalled();
      expect(f.tree.has('mods/old.jar')).toBe(true);
    },
  );

  it.each(['file', 'symlink'] as const)(
    'rejects a required directory changed to a %s without listing it',
    async (kind) => {
      const f = fixture();
      const plan = f.plan();
      f.add('mods', kind);
      await expect(f.helper.publish(f.prepared, plan)).rejects.toMatchObject({
        code: 'operation_uncertain',
      });
      expect(f.listCalls.flat()).not.toContain('mods');
      expect(f.adapter.renameFiles).not.toHaveBeenCalled();
    },
  );

  it('batches a thousand independent destinations without per-file HTTP', async () => {
    const f = fixture();
    f.prepared.files = Array.from({ length: 1001 }, (_, index) => file(`config/${index}.toml`));
    const plan = f.plan();
    await f.helper.publish(f.prepared, plan);
    expect(await f.helper.verify(f.prepared, plan)).toHaveLength(1001);
    expect(f.adapter.renameFiles.mock.calls.map((call) => call[2].length)).toEqual([1, 1000, 1]);
    expect(f.listCalls.every((call) => call.length <= 100)).toBe(true);
    expect(f.listCalls.flat().filter((path) => path === 'config')).toHaveLength(2); // prepublication + receipt
  });

  it('does not treat a successful empty rename response as publication proof', async () => {
    const f = fixture();
    const original = f.adapter.renameFiles.getMockImplementation();
    f.adapter.renameFiles
      .mockImplementationOnce(required(original))
      .mockImplementationOnce(async () => {});
    const plan = f.plan();
    await f.helper.publish(f.prepared, plan);
    expect(await f.helper.verify(f.prepared, plan)).toBeNull();
    const before = f.adapter.renameFiles.mock.calls.length;
    expect(await f.resetHelper().recover(f.prepared, plan)).toEqual({ state: 'partial' });
    expect(f.adapter.renameFiles).toHaveBeenCalledTimes(before);
    expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
  });

  it('stops before publication if retiring one source silently did not happen', async () => {
    const f = fixture();
    f.adapter.renameFiles.mockImplementation(async () => {});
    const plan = f.plan();
    await expect(f.helper.publish(f.prepared, plan)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    expect(f.adapter.renameFiles).toHaveBeenCalledTimes(1);
    expect(f.tree.has('mods/old.jar')).toBe(true);
    expect(f.journal()?.state).toBe('retiring');
  });

  it('reconciles a lost final response without replaying any effect', async () => {
    const f = fixture();
    const rename = required(f.adapter.renameFiles.getMockImplementation());
    f.adapter.renameFiles.mockImplementationOnce(rename).mockImplementationOnce(async (...args) => {
      await rename(...args);
      throw new Error('response lost');
    });
    const plan = f.plan();
    await expect(f.helper.publish(f.prepared, plan)).rejects.toThrow('response lost');
    expect(await f.resetHelper().recover(f.prepared, plan)).toEqual({
      state: 'applied',
      files: [{ ...file('mods/new.jar'), modifiedAt: newTime }],
    });
    expect(f.adapter.renameFiles).toHaveBeenCalledTimes(2);
    expect(f.uploadArchive).toHaveBeenCalledTimes(1);
  });

  it('keeps original files unchanged on an upload failure and never blindly retries', async () => {
    const f = fixture();
    f.uploadArchive.mockRejectedValue(new Error('transfer failed'));
    const plan = f.plan();
    await expect(f.helper.publish(f.prepared, plan)).rejects.toThrow('transfer failed');
    expect(await f.resetHelper().recover(f.prepared, plan)).toEqual({ state: 'unchanged' });
    await expect(f.resetHelper().publish(f.prepared, plan)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    expect(f.uploadArchive).toHaveBeenCalledTimes(1);
    expect(f.adapter.renameFiles).not.toHaveBeenCalled();
  });

  it('refuses missing final file metadata and inaccessible recovery observations', async () => {
    const f = fixture();
    const upload = required(f.uploadArchive.getMockImplementation());
    f.uploadArchive.mockImplementation(async (input) => {
      const result = await upload(input);
      const entry = required(f.tree.get(required(result.manifest.files[0]).path));
      delete entry.modifiedAt;
      return result;
    });
    const plan = f.plan();
    await f.helper.publish(f.prepared, plan);
    expect(await f.helper.verify(f.prepared, plan)).toBeNull();
    f.readScope.mockImplementation(
      () =>
        ({
          listMany: async (directories: readonly string[]) =>
            directories.map((directory) => ({ directory, error: 'forbidden' })),
        }) as unknown as FilemanReadService,
    );
    expect(await f.resetHelper().recover(f.prepared, plan)).toEqual({ state: 'unknown' });
  });

  it('rejects unowned roots and unsafe/mismatched/oversized plans before effects', async () => {
    const f = fixture();
    const plan = f.plan();
    const root = f.helper.getRemoteStage(plan).stagingRoot;
    f.add(root, 'directory');
    await expect(f.helper.publish(f.prepared, plan)).rejects.toMatchObject({ code: 'conflict' });
    f.tree.delete(root);
    await expect(
      f.helper.publish(f.prepared, { ...plan, write: [file('server.properties')] }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    f.prepared.files = Array.from({ length: 10001 }, (_, index) => file(`config/${index}.txt`));
    await expect(f.helper.publish(f.prepared, f.plan())).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(f.uploadArchive).not.toHaveBeenCalled();
    expect(f.adapter.renameFiles).not.toHaveBeenCalled();
  });

  it('does not retire originals changed during the background transfer', async () => {
    const f = fixture();
    const upload = required(f.uploadArchive.getMockImplementation());
    f.uploadArchive.mockImplementation(async (input) => {
      const result = await upload(input);
      required(f.tree.get('mods/old.jar')).modifiedAt = newTime;
      return result;
    });
    const plan = f.plan();
    await expect(f.helper.publish(f.prepared, plan)).rejects.toMatchObject({ code: 'conflict' });
    expect(f.adapter.renameFiles).not.toHaveBeenCalled();
    expect(await f.helper.recover(f.prepared, plan)).toEqual({ state: 'unknown' });
  });

  it('rejects metadata-compatible leftovers in a supposedly replaced subtree', async () => {
    const f = fixture();
    const plan = f.plan();
    await f.helper.publish(f.prepared, plan);
    f.add('mods/leftover.jar');
    expect(await f.helper.verify(f.prepared, plan)).toBeNull();
    expect(await f.helper.recover(f.prepared, plan)).toEqual({ state: 'partial' });
  });

  it('cleans only the operation-owned trees after durable applied confirmation', async () => {
    const f = fixture();
    const plan = f.plan();
    await f.helper.publish(f.prepared, plan);
    await expect(f.helper.cleanup(f.prepared, plan, { applied: true })).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    await f.helper.verify(f.prepared, plan);
    await f.helper.cleanup(f.prepared, plan, { applied: true });
    expect(f.adapter.deleteFiles).toHaveBeenCalledWith(
      'test',
      '',
      Object.values(f.helper.getRemoteStage(plan)),
    );
    expect(f.tree.has('mods/new.jar')).toBe(true);
    expect(f.tree.has('world/level.dat')).toBe(true);
    expect(f.journal()?.state).toBe('cleaned');
    await f.helper.cleanup(f.prepared, plan, { applied: true });
    expect(f.adapter.deleteFiles).toHaveBeenCalledTimes(1);
  });
});
