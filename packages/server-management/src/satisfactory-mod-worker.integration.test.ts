import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createTestDatabase } from '@nickhosting/database/testing';
import { type PterodactylAdapter, PterodactylError } from '@nickhosting/pterodactyl-adapter';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { satisfactoryManifest } from '../../../games/satisfactory/src/manifest.js';
import { prepareSatisfactoryMods } from '../../../games/satisfactory/src/mods.js';
import type { GameLifecycleContext } from './lifecycle.js';
import { enqueueServerOperation } from './registry.js';
import { authorizeQueuedEffect } from './runtime.js';
import {
  cleanupSatisfactoryModPlans,
  ensureSatisfactoryModState,
  inspectSatisfactoryModInventory,
} from './satisfactory-mod-manager.js';
import { processSatisfactoryMods } from './satisfactory-mods.js';
import { managementFixture } from './test-fixtures.js';

vi.mock('./runtime.js', async (original) => ({
  ...(await original<object>()),
  authorizeQueuedEffect: vi.fn(),
}));
vi.mock('../../../games/satisfactory/src/mods.js', async (original) => ({
  ...(await original<object>()),
  prepareSatisfactoryMods: vi.fn(),
}));
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>,
  id: string,
  root: string,
  env: Record<string, string>,
  files: Map<string, Buffer>,
  adapter: PterodactylAdapter;
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const lock = (version: string) => ({
  version: 1,
  mods: {
    Example: {
      version,
      dependencies: {},
      targets: { LinuxServer: { hash: 'a'.repeat(64), link: 'https://api.ficsit.app/test.zip' } },
    },
  },
});
function modFiles(version: string) {
  return new Map(
    Object.entries({
      'FactoryGame/Mods/Example/.smm': '',
      'FactoryGame/Mods/Example/Example.uplugin': JSON.stringify({
        FriendlyName: 'Example',
        VersionName: version,
      }),
      'FactoryGame/Mods/Example/binary.so': `binary-${version}`,
      'FactoryGame/Mods/nick_hosting-lock.json': JSON.stringify(lock(version)),
    }).map(([p, v]) => [p, Buffer.from(v)]),
  );
}
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
afterEach(async () => {
  if (id && database)
    await database.db
      .updateTable('minecraft_staging_claims')
      .set({ state: 'released' })
      .where('server_id', '=', id)
      .execute();
  if (root) await rm(root, { force: true, recursive: true });
  vi.clearAllMocks();
});
beforeEach(async () => {
  f = await managementFixture(database.db, { interactive: true });
  id = await f.server();
  root = `./mountdata/test-assets/mod-manager-${randomUUID()}`;
  env = {
    NH_CONTENT_WORK_ROOT: root,
    NH_CONTENT_SOURCE_FREE_BYTES: '0',
    NH_CONTENT_SOURCE_FREE_PERCENT: '0',
  };
  await mkdir(root, { recursive: true });
  await f.db
    .insertInto('game_integrations')
    .values({
      id: 'satisfactory',
      version: satisfactoryManifest.version,
      manifest: satisfactoryManifest,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({ game_id: 'satisfactory', runtime_id: 'dedicated' })
    .where('id', '=', f.mappingId)
    .execute();
  files = new Map([
    ['FactoryServer.sh', Buffer.from('launcher')],
    [
      'Engine/Binaries/Linux/UnrealServer-Linux-Shipping.version',
      Buffer.from(JSON.stringify({ Changelist: 123456 })),
    ],
    ...modFiles('1.0.0'),
  ]);
  const directories = new Set([
    '',
    'FactoryGame',
    'FactoryGame/Mods',
    'FactoryGame/Mods/Example',
    'Engine',
    'Engine/Binaries',
    'Engine/Binaries/Linux',
  ]);
  adapter = {
    ...f.adapter,
    listFiles: vi.fn(async (_id: string, path: string) => {
      const prefix = path ? `${path}/` : '';
      const result = new Map<
        string,
        { name: string; is_file: boolean; is_symlink: boolean; size: number }
      >();
      for (const directory of directories) {
        if (directory === path || !directory.startsWith(prefix)) continue;
        const relative = directory.slice(prefix.length);
        if (!relative.includes('/'))
          result.set(relative, { name: relative, is_file: false, is_symlink: false, size: 0 });
      }
      for (const [file, data] of files) {
        if (!file.startsWith(prefix)) continue;
        const relative = file.slice(prefix.length),
          name = relative.split('/')[0]!;
        if (!relative.includes('/'))
          result.set(name, { name, is_file: true, is_symlink: false, size: data.length });
      }
      return [...result.values()];
    }),
    readFile: vi.fn(async (_id: string, path: string) => files.get(path)!),
    downloadFile: vi.fn(async (_id: string, path: string) => ({
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(files.get(path));
          controller.close();
        },
      }),
    })),
    uploadFile: vi.fn(
      async (_id: string, path: string, input: { body: ReadableStream<Uint8Array> }) => {
        files.set(path, Buffer.from(await new Response(input.body).arrayBuffer()));
      },
    ),
    prepareUploadBatch: vi.fn(async () => null),
    prepareUpload: vi.fn(
      async (identifier: string, path: string) =>
        (input: Parameters<PterodactylAdapter['uploadFile']>[2]) =>
          adapter.uploadFile(identifier, path, input),
    ),
    createDirectory: vi.fn(async (_id: string, parent: string, name: string) => {
      directories.add(parent ? `${parent}/${name}` : name);
    }),
    deleteFiles: vi.fn(async (_id: string, _root: string, paths: string[]) => {
      for (const path of paths) files.delete(path);
    }),
  } as unknown as PterodactylAdapter;
  await ensureSatisfactoryModState(f.db, id);
  const seed = [...modFiles('1.0.0')].map(([path, data]) => ({
    path,
    size: data.length,
    sha256: hash(data),
  }));
  await f.db
    .updateTable('satisfactory_mod_states')
    .set({
      selection: JSON.stringify([{ reference: 'Example', version: '1.0.0' }]),
      files: JSON.stringify(seed),
      lock: JSON.stringify(lock('1.0.0')),
    })
    .where('server_id', '=', id)
    .execute();
  vi.mocked(authorizeQueuedEffect).mockResolvedValue(f.context);
  vi.mocked(prepareSatisfactoryMods).mockImplementation(async (options) => {
    const selection = options.selection.find((item) => item.enabled !== false);
    const selected = selection ? modFiles(selection.version) : new Map<string, Buffer>();
    const output = [];
    for (const [path, data] of selected) {
      await writeFile(join(options.outputDirectory!, `${output.length}.bin`), data);
      output.push({ path, size: data.length, sha256: hash(data) });
    }
    return {
      files: output,
      lock: selection ? (lock(selection.version) as never) : { version: 1, mods: {} },
    };
  });
});
async function context(command: Record<string, unknown>) {
  const result = await enqueueServerOperation(
    f.db,
    f.context,
    id,
    {
      action: 'satisfactory-content',
      idempotencyKey: randomUUID(),
      command: { kind: 'mods', ...command },
    },
    env,
    { satisfactoryContent: true },
  );
  await f.db
    .updateTable('operation_jobs')
    .set({ state: 'running' })
    .where('id', '=', result.jobId)
    .execute();
  let operation = await f.db
    .selectFrom('server_operations')
    .selectAll()
    .where('job_id', '=', result.jobId)
    .executeTakeFirstOrThrow();
  const server = await f.db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return {
    db: f.db,
    server,
    adapter,
    operation: () => operation,
    authorize: async () => {},
    assertStopped: async () => {},
    effect: async (_phase: string, perform: () => Promise<unknown>) => {
      await perform();
      return true;
    },
    update: async (patch: { plan?: Record<string, unknown> }) => {
      if (patch.plan) {
        operation = { ...operation, plan: patch.plan };
        await f.db
          .updateTable('server_operations')
          .set({ plan: JSON.stringify(patch.plan) })
          .where('job_id', '=', operation.job_id)
          .execute();
      }
    },
  } as GameLifecycleContext;
}
async function complete(ctx: GameLifecycleContext) {
  await f.db
    .updateTable('managed_servers')
    .set({ active_operation_id: null })
    .where('id', '=', id)
    .execute();
  await f.db
    .updateTable('operation_jobs')
    .set({ state: 'succeeded', completed_at: new Date() })
    .where('id', '=', ctx.operation().job_id)
    .execute();
}
async function previewContext(version = '2.0.0', profileId?: string) {
  const planId = randomUUID();
  const revision = (
    await f.db
      .selectFrom('satisfactory_mod_states')
      .select('revision')
      .where('server_id', '=', id)
      .executeTakeFirstOrThrow()
  ).revision;
  await f.db
    .insertInto('satisfactory_mod_plans')
    .values({
      id: planId,
      server_id: id,
      job_id: null,
      revision,
      selection: JSON.stringify([{ reference: 'Example', version }]),
      vanilla: false,
      profile_id: profileId ?? null,
      lock: null,
      files: null,
      changes: null,
      inventory_fingerprint: null,
      game_version: null,
    })
    .execute();
  const ctx = await context({
    mode: 'preview',
    profileId,
    selection: [{ reference: 'Example', version }],
    revision,
    planId,
  });
  return { ctx, planId };
}
async function preview(version = '2.0.0', profileId?: string) {
  const { ctx, planId } = await previewContext(version, profileId);
  await processSatisfactoryMods(ctx, env);
  await complete(ctx);
  return planId;
}
it.each([false, true])(
  'uses an existing stopped proof only for preview (verified=%s)',
  async (verified) => {
    const { ctx } = await previewContext();
    ctx.previewSourceVerified = verified ? true : undefined;
    ctx.assertStopped = vi.fn(async () => {});
    await processSatisfactoryMods(ctx, env);
    expect(ctx.assertStopped).toHaveBeenCalledTimes(verified ? 0 : 1);
  },
);
it.each(['apply', 'rollback'])('still requires a current stopped proof for %s', async (mode) => {
  const planId = await preview();
  const ctx = await context({ mode, revision: 0, planId });
  ctx.previewSourceVerified = true;
  ctx.assertStopped = vi.fn(async () => {
    throw new Error('current stopped proof required');
  });
  await expect(processSatisfactoryMods(ctx, env)).rejects.toThrow('current stopped proof required');
  expect(ctx.assertStopped).toHaveBeenCalledTimes(1);
  expect(adapter.uploadFile).not.toHaveBeenCalled();
});
it('overlaps native preparation and the live byte inventory', async () => {
  const { ctx } = await previewContext();
  const release = Promise.withResolvers<void>();
  const prepare = vi.mocked(prepareSatisfactoryMods).getMockImplementation()!;
  const download = vi.mocked(adapter.downloadFile).getMockImplementation()!;
  vi.mocked(prepareSatisfactoryMods).mockImplementation(async (options) => {
    await release.promise;
    return prepare(options);
  });
  vi.mocked(adapter.downloadFile).mockImplementation(async (...args) => {
    await release.promise;
    return download(...args);
  });
  const pending = processSatisfactoryMods(ctx, env);
  try {
    await vi.waitFor(() => {
      expect(prepareSatisfactoryMods).toHaveBeenCalledTimes(1);
      expect(adapter.downloadFile).toHaveBeenCalled();
    });
  } finally {
    release.resolve();
  }
  await expect(pending).resolves.toBe(true);
});
it.each(['native', 'inventory'])('aborts and drains the sibling when %s fails', async (failure) => {
  const { ctx } = await previewContext();
  const release = Promise.withResolvers<void>();
  const inventoryEntered = Promise.withResolvers<void>();
  const nativeEntered = Promise.withResolvers<void>();
  const list = vi.mocked(adapter.listFiles).getMockImplementation()!;
  let signal: AbortSignal | undefined;
  vi.mocked(adapter.listFiles).mockImplementation(async (...args) => {
    if (args[1] === '') {
      inventoryEntered.resolve();
      if (failure === 'inventory') {
        await nativeEntered.promise;
        throw new Error('inventory failure');
      }
      await release.promise;
    }
    return list(...args);
  });
  vi.mocked(prepareSatisfactoryMods).mockImplementation(async (options) => {
    signal = options.signal;
    nativeEntered.resolve();
    if (failure === 'native') {
      await inventoryEntered.promise;
      throw new Error('native failure');
    }
    await release.promise;
    options.signal?.throwIfAborted();
    throw new Error('expected cancellation');
  });
  let settled = false;
  const pending = processSatisfactoryMods(ctx, env).then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(settled).toBe(false);
  } finally {
    release.resolve();
  }
  expect(await pending).toMatchObject({ message: `${failure} failure` });
  expect(adapter.uploadFile).not.toHaveBeenCalled();
});
it('drains inventory when native preparation throws synchronously', async () => {
  vi.mocked(prepareSatisfactoryMods).mockImplementation(() => {
    throw new Error('invalid native options');
  });
  const { ctx } = await previewContext('3.0.0');
  const release = Promise.withResolvers<void>();
  let calls = 0,
    entered = false,
    settled = false;
  ctx.authorize = async () => {
    if (++calls === 2) {
      entered = true;
      await release.promise;
    }
  };
  const pending = processSatisfactoryMods(ctx, env).then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(prepareSatisfactoryMods).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
  }
  expect(await pending).toMatchObject({ message: 'invalid native options' });
});
it('passes the previous successful same-server/build plan as an archive cache source', async () => {
  const priorId = await preview();
  const prior = await f.db
    .selectFrom('satisfactory_mod_plans')
    .selectAll()
    .where('id', '=', priorId)
    .executeTakeFirstOrThrow();
  await preview('3.0.0');
  expect(
    vi.mocked(prepareSatisfactoryMods).mock.calls.at(-1)?.[0].downloadCache?.sourceDirectories,
  ).toEqual([join(resolve(root), 'content-staging', prior.job_id!)]);
});
it.each(['server', 'build', 'plan', 'job'])(
  'excludes a prior cache with a different or unsuccessful %s',
  async (kind) => {
    const priorId = await preview();
    const prior = await f.db
      .selectFrom('satisfactory_mod_plans')
      .selectAll()
      .where('id', '=', priorId)
      .executeTakeFirstOrThrow();
    if (kind === 'job') {
      await f.db
        .updateTable('operation_jobs')
        .set({ state: 'failed' })
        .where('id', '=', prior.job_id!)
        .execute();
    } else {
      await f.db
        .updateTable('satisfactory_mod_plans')
        .set(
          kind === 'server'
            ? {
                server_id: await (
                  await managementFixture(database.db, { interactive: true })
                ).server(),
              }
            : kind === 'build'
              ? { game_version: 654321 }
              : { status: 'failed' },
        )
        .where('id', '=', priorId)
        .execute();
    }
    await preview('3.0.0');
    expect(
      vi.mocked(prepareSatisfactoryMods).mock.calls.at(-1)?.[0].downloadCache?.sourceDirectories,
    ).toEqual([]);
  },
);
it('defers throttled grants without uploads then resumes the same prepared apply', async () => {
  const planId = await preview();
  const apply = await context({ mode: 'apply', revision: 0, planId });
  vi.mocked(adapter.prepareUploadBatch).mockRejectedValueOnce(
    new PterodactylError('rate_limited', 'client', 'rejected', 429, 60_000),
  );
  expect(await processSatisfactoryMods(apply, env)).toBe(false);
  expect(adapter.uploadFile).not.toHaveBeenCalled();
  expect(apply.operation().plan.providerPreflightRetryAt).toEqual(expect.any(String));
  expect(apply.operation().plan.satisfactoryModsApplying).toBe(true);
  expect(
    await f.db
      .selectFrom('satisfactory_mod_states')
      .select(['revision', 'recovery'])
      .where('server_id', '=', id)
      .executeTakeFirstOrThrow(),
  ).toMatchObject({
    revision: 0,
    recovery: expect.objectContaining({ jobId: apply.operation().job_id }),
  });
  expect(await processSatisfactoryMods(apply, env)).toBe(true);
  expect(files.get('FactoryGame/Mods/Example/binary.so')?.toString()).toBe('binary-2.0.0');
  expect(prepareSatisfactoryMods).toHaveBeenCalledOnce();
  await complete(apply);
});

it('previews without remote writes then applies frozen artifacts and restores original bytes on rollback', async () => {
  const planId = await preview();
  expect(adapter.uploadFile).not.toHaveBeenCalled();
  expect(files.get('FactoryGame/Mods/Example/binary.so')?.toString()).toBe('binary-1.0.0');
  const apply = await context({ mode: 'apply', revision: 0, planId });
  await processSatisfactoryMods(apply, env);
  await complete(apply);
  expect(files.get('FactoryGame/Mods/Example/binary.so')?.toString()).toBe('binary-2.0.0');
  expect(prepareSatisfactoryMods).toHaveBeenCalledTimes(1);
  const rollback = await context({ mode: 'rollback', revision: 1 });
  await processSatisfactoryMods(rollback, env);
  await complete(rollback);
  expect(files.get('FactoryGame/Mods/Example/binary.so')?.toString()).toBe('binary-1.0.0');
  expect(
    (
      await f.db
        .selectFrom('satisfactory_mod_states')
        .selectAll()
        .where('server_id', '=', id)
        .executeTakeFirstOrThrow()
    ).recovery,
  ).toBeNull();
});
it.each(['game-build', 'mod-bytes'])(
  'rejects changed %s after preview before writes',
  async (change) => {
    const planId = await preview();
    if (change === 'game-build')
      files.set(
        'Engine/Binaries/Linux/UnrealServer-Linux-Shipping.version',
        Buffer.from(JSON.stringify({ Changelist: 654321 })),
      );
    else files.set('FactoryGame/Mods/Example/binary.so', Buffer.from('changed-external'));
    const apply = await context({ mode: 'apply', revision: 0, planId });
    await expect(processSatisfactoryMods(apply, env)).rejects.toThrow('conflict');
    expect(adapter.uploadFile).not.toHaveBeenCalled();
  },
);
it('retains original recovery bytes after a partial upload failure and restores them', async () => {
  const planId = await preview();
  const upload = vi.mocked(adapter.uploadFile).getMockImplementation()!;
  let calls = 0;
  vi.mocked(adapter.uploadFile).mockImplementation(async (...args) => {
    if (++calls === 2) throw new Error('transport');
    return upload(...args);
  });
  const apply = await context({ mode: 'apply', revision: 0, planId });
  await expect(processSatisfactoryMods(apply, env)).rejects.toThrow('transport');
  await complete(apply);
  vi.mocked(adapter.uploadFile).mockImplementation(upload);
  const rollback = await context({ mode: 'rollback', revision: 0 });
  await processSatisfactoryMods(rollback, env);
  expect(files.get('FactoryGame/Mods/Example/Example.uplugin')?.toString()).toContain('1.0.0');
  expect(files.get('FactoryGame/Mods/Example/binary.so')?.toString()).toBe('binary-1.0.0');
});
it('detects a concurrent modification to an earlier uploaded file before committing state', async () => {
  const planId = await preview();
  const upload = vi.mocked(adapter.uploadFile).getMockImplementation()!;
  vi.mocked(adapter.uploadFile).mockImplementation(async (...args) => {
    await upload(...args);
    if (args[1].endsWith('-lock.json'))
      files.set('FactoryGame/Mods/Example/binary.so', Buffer.from('external-modification'));
  });
  const apply = await context({ mode: 'apply', revision: 0, planId });
  await expect(processSatisfactoryMods(apply, env)).rejects.toThrow('conflict');
  expect(
    (
      await f.db
        .selectFrom('satisfactory_mod_states')
        .select('revision')
        .where('server_id', '=', id)
        .executeTakeFirstOrThrow()
    ).revision,
  ).toBe(0);
});
it('retries a partial apply without replacing the original recovery snapshot', async () => {
  const planId = await preview();
  const upload = vi.mocked(adapter.uploadFile).getMockImplementation()!;
  let calls = 0;
  vi.mocked(adapter.uploadFile).mockImplementation(async (...args) => {
    if (++calls === 2) throw new Error('transport');
    return upload(...args);
  });
  const apply = await context({ mode: 'apply', revision: 0, planId });
  await expect(processSatisfactoryMods(apply, env)).rejects.toThrow('transport');
  const snapshot = await readFile(
    join(resolve(root), 'content-staging', apply.operation().job_id, 'old-1.bin'),
  );
  vi.mocked(adapter.uploadFile).mockImplementation(upload);
  await processSatisfactoryMods(apply, env);
  await complete(apply);
  expect(
    await readFile(join(resolve(root), 'content-staging', apply.operation().job_id, 'old-1.bin')),
  ).toEqual(snapshot);
  const rollback = await context({ mode: 'rollback', revision: 1 });
  await processSatisfactoryMods(rollback, env);
  expect(files.get('FactoryGame/Mods/Example/binary.so')?.toString()).toBe('binary-1.0.0');
});
it('replays artifact cleanup after a crash following the atomic applied marker', async () => {
  const planId = await preview();
  const plan = await f.db
    .selectFrom('satisfactory_mod_plans')
    .selectAll()
    .where('id', '=', planId)
    .executeTakeFirstOrThrow();
  const apply = await context({ mode: 'apply', revision: 0, planId });
  const update = apply.update;
  apply.update = async (patch) => {
    if (patch.plan?.satisfactoryModsApplied) throw new Error('crash');
    await update(patch);
  };
  await expect(processSatisfactoryMods(apply, env)).rejects.toThrow('crash');
  const persisted = await f.db
    .selectFrom('server_operations')
    .selectAll()
    .where('job_id', '=', apply.operation().job_id)
    .executeTakeFirstOrThrow();
  expect(persisted.plan.satisfactoryModsApplied).toBe(true);
  apply.operation = () => persisted;
  apply.update = update;
  await processSatisfactoryMods(apply, env);
  await expect(
    readFile(join(resolve(root), 'content-staging', plan.job_id!, '0.bin')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(
    (
      await f.db
        .selectFrom('minecraft_staging_claims')
        .select('state')
        .where('job_id', '=', plan.job_id!)
        .executeTakeFirstOrThrow()
    ).state,
  ).toBe('released');
});
it('reclaims expired preview stages only after the server has no active operation', async () => {
  const planId = await preview();
  const plan = await f.db
    .selectFrom('satisfactory_mod_plans')
    .selectAll()
    .where('id', '=', planId)
    .executeTakeFirstOrThrow();
  await f.db
    .updateTable('satisfactory_mod_plans')
    .set({ expires_at: new Date(Date.now() - 1000) })
    .where('id', '=', planId)
    .execute();
  await f.db
    .updateTable('managed_servers')
    .set({ active_operation_id: plan.job_id })
    .where('id', '=', id)
    .execute();
  expect(await cleanupSatisfactoryModPlans(f.db, env)).toMatchObject({ plans: 0 });
  expect(
    await readFile(join(resolve(root), 'content-staging', plan.job_id!, '0.bin')),
  ).toBeDefined();
  await f.db
    .updateTable('managed_servers')
    .set({ active_operation_id: null })
    .where('id', '=', id)
    .execute();
  expect(await cleanupSatisfactoryModPlans(f.db, env)).toMatchObject({ plans: 1 });
  await expect(
    readFile(join(resolve(root), 'content-staging', plan.job_id!, '0.bin')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
it('reads unchanged managed payloads only for capture and final verification', async () => {
  const planId = await preview('1.0.0');
  vi.mocked(adapter.downloadFile).mockClear();
  const apply = await context({ mode: 'apply', revision: 0, planId });
  await processSatisfactoryMods(apply, env);
  const reads = vi
    .mocked(adapter.downloadFile)
    .mock.calls.filter((call) => call[1].endsWith('/binary.so'));
  expect(reads).toHaveLength(2);
  expect(adapter.uploadFile).not.toHaveBeenCalled();
  const directory = join(root, 'content-staging', apply.operation().job_id);
  const actualBytes = (
    await Promise.all(
      (await readdir(directory)).map(async (name) => (await lstat(join(directory, name))).size),
    )
  ).reduce((a, b) => a + b, 0);
  const claim = await f.db
    .selectFrom('minecraft_staging_claims')
    .select('reserved_bytes')
    .where('job_id', '=', apply.operation().job_id)
    .executeTakeFirstOrThrow();
  expect(Number(claim.reserved_bytes)).toBe(actualBytes + 65536);
  const oldFiles = [...modFiles('1.0.0')];
  const index = oldFiles.findIndex(([path]) => path.endsWith('/binary.so'));
  expect(
    await readFile(
      join(root, 'content-staging', apply.operation().job_id, `old-${index}.bin`),
      'utf8',
    ),
  ).toBe('binary-1.0.0');
});
it('verifies the bytes actually persisted in the recovery snapshot before mutating the server', async () => {
  const planId = await preview();
  const download = vi.mocked(adapter.downloadFile).getMockImplementation()!;
  let reads = 0;
  vi.mocked(adapter.downloadFile).mockImplementation(async (...args) => {
    if (args[1].endsWith('/binary.so') && ++reads === 1)
      return {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from('raced-snapshot'));
            controller.close();
          },
        }),
      } as never;
    return download(...args);
  });
  const apply = await context({ mode: 'apply', revision: 0, planId });
  await expect(processSatisfactoryMods(apply, env)).rejects.toThrow('conflict');
  expect(adapter.uploadFile).not.toHaveBeenCalled();
  expect(
    (
      await f.db
        .selectFrom('satisfactory_mod_states')
        .select('recovery')
        .where('server_id', '=', id)
        .executeTakeFirstOrThrow()
    ).recovery,
  ).toBeNull();
});
it('updates the selected profile atomically and clears a removed profile binding on rollback', async () => {
  const profileId = randomUUID();
  await f.db
    .insertInto('satisfactory_mod_profiles')
    .values({
      id: profileId,
      server_id: id,
      name: 'Shared',
      selection: JSON.stringify([{ reference: 'Example', version: '1.0.0' }]),
      vanilla: false,
      required_targets: JSON.stringify(['LinuxServer', 'Windows']),
    })
    .execute();
  await f.db
    .updateTable('satisfactory_mod_states')
    .set({ active_profile_id: profileId })
    .where('server_id', '=', id)
    .execute();
  const planId = await preview('2.0.0', profileId);
  const apply = await context({ mode: 'apply', revision: 0, planId });
  await processSatisfactoryMods(apply, env);
  await complete(apply);
  expect(
    (
      await f.db
        .selectFrom('satisfactory_mod_profiles')
        .select('selection')
        .where('id', '=', profileId)
        .executeTakeFirstOrThrow()
    ).selection,
  ).toEqual([{ reference: 'Example', version: '2.0.0' }]);
  const plan = await f.db
    .selectFrom('satisfactory_mod_plans')
    .select('job_id')
    .where('id', '=', planId)
    .executeTakeFirstOrThrow();
  expect(
    (
      await f.db
        .selectFrom('server_operations')
        .select('plan')
        .where('job_id', '=', plan.job_id!)
        .executeTakeFirstOrThrow()
    ).plan.satisfactoryModsRequiredTargets,
  ).toEqual(['LinuxServer', 'Windows']);
  await f.db.deleteFrom('satisfactory_mod_profiles').where('id', '=', profileId).execute();
  await f.db
    .updateTable('satisfactory_mod_states')
    .set({ active_profile_id: null, revision: 2 })
    .where('server_id', '=', id)
    .execute();
  const rollback = await context({ mode: 'rollback', revision: 2 });
  await processSatisfactoryMods(rollback, env);
  expect(
    (
      await f.db
        .selectFrom('satisfactory_mod_states')
        .select('active_profile_id')
        .where('server_id', '=', id)
        .executeTakeFirstOrThrow()
    ).active_profile_id,
  ).toBeNull();
  expect(files.get('FactoryGame/Mods/Example/binary.so')?.toString()).toBe('binary-1.0.0');
});
it('retains superseded recovery references across a crash before the applying marker', async () => {
  const firstPlan = await preview();
  const first = await context({ mode: 'apply', revision: 0, planId: firstPlan });
  await processSatisfactoryMods(first, env);
  await complete(first);
  const planId = await preview('3.0.0');
  const apply = await context({ mode: 'apply', revision: 1, planId });
  const update = apply.update;
  let crash = true;
  apply.update = async (patch) => {
    if (crash && patch.plan?.satisfactoryModsApplying) {
      crash = false;
      throw new Error('before-marker');
    }
    await update(patch);
  };
  await expect(processSatisfactoryMods(apply, env)).rejects.toThrow('before-marker');
  const recovery = (
    await f.db
      .selectFrom('satisfactory_mod_states')
      .select('recovery')
      .where('server_id', '=', id)
      .executeTakeFirstOrThrow()
  ).recovery as { supersededStageJobs: string[] };
  expect(recovery.supersededStageJobs).toContain(first.operation().job_id);
  await processSatisfactoryMods(apply, env);
  expect(
    (
      await f.db
        .selectFrom('minecraft_staging_claims')
        .select('state')
        .where('job_id', '=', first.operation().job_id)
        .executeTakeFirstOrThrow()
    ).state,
  ).toBe('released');
  await expect(
    readFile(join(resolve(root), 'content-staging', first.operation().job_id, 'old-0.bin')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
it('releases deleted-server recovery bytes only after the deletion operation is no longer active', async () => {
  const planId = await preview();
  const apply = await context({ mode: 'apply', revision: 0, planId });
  await processSatisfactoryMods(apply, env);
  await f.db
    .updateTable('managed_servers')
    .set({ deleted_at: new Date() })
    .where('id', '=', id)
    .execute();
  expect(await cleanupSatisfactoryModPlans(f.db, env)).toMatchObject({ recoveries: 0 });
  expect(
    await readFile(join(resolve(root), 'content-staging', apply.operation().job_id, 'old-0.bin')),
  ).toBeDefined();
  await complete(apply);
  expect(await cleanupSatisfactoryModPlans(f.db, env)).toMatchObject({ recoveries: 1 });
  await expect(
    readFile(join(resolve(root), 'content-staging', apply.operation().job_id, 'old-0.bin')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(
    (
      await f.db
        .selectFrom('satisfactory_mod_states')
        .select('recovery')
        .where('server_id', '=', id)
        .executeTakeFirstOrThrow()
    ).recovery,
  ).toBeNull();
  expect(
    (
      await f.db
        .selectFrom('minecraft_staging_claims')
        .select('state')
        .where('job_id', '=', apply.operation().job_id)
        .executeTakeFirstOrThrow()
    ).state,
  ).toBe('released');
});

it.each([false, true])(
  'bounds incremental stages including failed previews: %s',
  async (failed) => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const planId = await preview(`${i + 2}.0.0`);
      ids.push(planId);
      if (failed && i < 2) {
        const plan = await f.db
          .selectFrom('satisfactory_mod_plans')
          .select('job_id')
          .where('id', '=', planId)
          .executeTakeFirstOrThrow();
        await f.db
          .updateTable('satisfactory_mod_plans')
          .set({ status: 'pending' })
          .where('id', '=', planId)
          .execute();
        await f.db
          .updateTable('operation_jobs')
          .set({ state: 'failed' })
          .where('id', '=', plan.job_id!)
          .execute();
      }
    }
    const calls = vi.mocked(prepareSatisfactoryMods).mock.calls;
    expect(calls[0]?.[0].downloadCache?.sourceDirectories).toEqual([]);
    expect(calls.at(-1)?.[0].downloadCache?.sourceDirectories).toHaveLength(2);
    const retained = await f.db
      .selectFrom('satisfactory_mod_plans')
      .selectAll()
      .where('server_id', '=', id)
      .execute();
    expect(retained).toHaveLength(4);
    expect(retained.some((plan) => plan.id === ids[0])).toBe(false);
    const claims = await f.db
      .selectFrom('minecraft_staging_claims')
      .selectAll()
      .where('server_id', '=', id)
      .execute();
    expect(claims.filter((claim) => claim.state === 'released')).toHaveLength(2);
    for (const plan of retained) {
      const claim = claims.find((value) => value.job_id === plan.job_id);
      const preparedFiles = plan.files as { size: number }[];
      const payloadBytes = preparedFiles.reduce((sum, file) => sum + file.size, 0);
      expect(Number(claim?.reserved_bytes)).toBeGreaterThan(payloadBytes + 65536);
      expect(Number(claim?.reserved_bytes)).toBeLessThan(payloadBytes + 1048576);
    }
    expect(adapter.uploadFile).not.toHaveBeenCalled();
  },
);

it('evicts optional completed preview caches before rejecting staging capacity', async () => {
  const first = await preview();
  const plan = await f.db
    .selectFrom('satisfactory_mod_plans')
    .select('job_id')
    .where('id', '=', first)
    .executeTakeFirstOrThrow();
  await f.db
    .updateTable('minecraft_staging_claims')
    .set({ reserved_bytes: String(4 * 1024 ** 3) })
    .where('job_id', '=', plan.job_id!)
    .execute();
  const next = await preview('3.0.0');
  expect(
    await f.db
      .selectFrom('satisfactory_mod_plans')
      .select('id')
      .where('id', '=', first)
      .executeTakeFirst(),
  ).toBeUndefined();
  expect(
    (
      await f.db
        .selectFrom('satisfactory_mod_plans')
        .select('status')
        .where('id', '=', next)
        .executeTakeFirstOrThrow()
    ).status,
  ).toBe('ready');
});

it('rejects enlarged managed files before creating their recovery copy', async () => {
  const planId = await preview();
  files.set('FactoryGame/Mods/Example/binary.so', Buffer.alloc(1024));
  const apply = await context({ mode: 'apply', revision: 0, planId });
  await expect(processSatisfactoryMods(apply, env)).rejects.toThrow('conflict');
  const index = [...modFiles('1.0.0').keys()].indexOf('FactoryGame/Mods/Example/binary.so');
  await expect(
    readFile(join(root, 'content-staging', apply.operation().job_id, `old-${index}.bin`)),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(adapter.uploadFile).not.toHaveBeenCalled();
});

it('rechecks the current output budget before applying a frozen plan', async () => {
  const planId = await preview();
  const apply = await context({ mode: 'apply', revision: 0, planId });
  await expect(
    processSatisfactoryMods(apply, { ...env, NH_SATISFACTORY_MOD_MAX_BYTES: '1' }),
  ).rejects.toThrow('resources_unavailable');
  expect(adapter.uploadFile).not.toHaveBeenCalled();
});
