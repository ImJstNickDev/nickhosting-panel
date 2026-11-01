import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DomainError } from '@nickhosting/core';
import { getSettings } from '@nickhosting/database';
import { z } from 'zod';
import {
  prepareSatisfactoryMods,
  satisfactoryModLockSchema,
  satisfactoryModSelectionSchema,
  satisfactoryVersionPaths,
} from '../../../games/satisfactory/src/mods.js';
import { contentStorageRoot, reserveContentStaging } from './content-admission.js';
import type { GameLifecycleContext } from './lifecycle.js';
import { assertServerStorageCapacity } from './storage-capacity.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fileSchema = z.object({
  path: z
    .string()
    .regex(/^FactoryGame\/Mods\/[A-Za-z0-9_. /-]+$/)
    .refine((path) => !path.split('/').some((part) => part === '..' || part === '.')),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
});
const filesSchema = z.array(fileSchema).max(20000);
const receiptSchema = z.object({
  selection: satisfactoryModSelectionSchema,
  files: filesSchema,
  lock: satisfactoryModLockSchema,
});

export async function processSatisfactoryMods(
  context: GameLifecycleContext,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const command = z
    .object({ kind: z.literal('mods'), selection: satisfactoryModSelectionSchema })
    .parse(context.operation().plan.satisfactoryContent);
  const identifier = context.server.pterodactyl_identifier;
  if (!identifier) throw new DomainError('integration_unavailable');
  await context.authorize();
  await context.assertStopped();
  const root = env.NH_SATISFACTORY_MOD_WORK_ROOT
    ? resolve(env.NH_SATISFACTORY_MOD_WORK_ROOT)
    : contentStorageRoot((await getSettings(context.db, env)).values.contentWorkRoot, env);
  const stage = join(root, 'content-staging', context.operation().job_id);
  const cleanup = async () => {
    await rm(stage, { recursive: true, force: true });
    await context.db
      .updateTable('minecraft_staging_claims')
      .set({ state: 'released' })
      .where('job_id', '=', context.operation().job_id)
      .execute();
  };
  if (context.operation().plan.satisfactoryModsApplied === true) {
    await cleanup();
    return true;
  }
  await mkdir(stage, { recursive: true, mode: 0o700 });
  let receipt: z.infer<typeof receiptSchema>;
  try {
    receipt = receiptSchema.parse(JSON.parse(await readFile(join(stage, 'receipt.json'), 'utf8')));
    if (JSON.stringify(receipt.selection) !== JSON.stringify(command.selection))
      throw new DomainError('conflict');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    let versionPath: (typeof satisfactoryVersionPaths)[number] | undefined;
    let versionFile: Buffer | undefined;
    const entries = await context.adapter.listFiles(identifier, 'Engine/Binaries/Linux');
    for (const candidate of satisfactoryVersionPaths) {
      const entry = entries.find((item) => item.name === candidate.split('/').at(-1));
      if (entry?.is_file && !entry.is_symlink) {
        versionPath = candidate;
        versionFile = Buffer.from(await context.adapter.readFile(identifier, candidate, 65536));
        break;
      }
    }
    if (!versionPath || !versionFile) throw new DomainError('configuration_invalid');
    const { authorizeQueuedEffect } = await import('./runtime.js');
    const actor = await authorizeQueuedEffect(
      context.db,
      context.operation().job_id,
      context.server.id,
      env,
      context.adapter,
    );
    const configuredRoot = contentStorageRoot(
      (await getSettings(context.db, env)).values.contentWorkRoot,
      env,
    );
    if (root !== configuredRoot) throw new DomainError('configuration_invalid');
    await reserveContentStaging(
      context.db,
      actor,
      context.operation().job_id,
      context.server.id,
      1_610_612_736,
      env,
    );
    const prepared = await prepareSatisfactoryMods({
      sandboxExecutable: env.NH_CONTENT_SANDBOX_PATH,
      executable: env.NH_FICSIT_CLI_PATH ?? '/usr/local/bin/ficsit',
      executableSha256:
        env.NH_FICSIT_CLI_SHA256 ??
        (process.arch === 'arm64'
          ? 'a591eb87be517d9d03798184c210d7166141be19e37b9d4e5fe68c84f264c6bf'
          : '2af0f8815af93b097c7a97968569575b21cf451b7c345fbb62fae29096ee4a31'),
      stagingRoot: root,
      selection: command.selection,
      versionPath,
      versionFile,
      launcherFile: Buffer.from(
        await context.adapter.readFile(identifier, 'FactoryServer.sh', 1048576),
      ),
    });
    for (let index = 0; index < prepared.files.length; index++)
      await writeFile(join(stage, `${index}.bin`), prepared.files[index]!.bytes, { mode: 0o600 });
    receipt = {
      selection: command.selection,
      lock: prepared.lock,
      files: prepared.files.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        size: file.bytes.length,
      })),
    };
    await writeFile(join(stage, 'receipt.tmp'), JSON.stringify(receipt), { mode: 0o600 });
    await rename(join(stage, 'receipt.tmp'), join(stage, 'receipt.json'));
  }
  assertServerStorageCapacity(
    context.server.limits.disk,
    receipt.files.reduce((sum, file) => sum + file.size, 0),
  );
  const previous = await context.db
    .selectFrom('satisfactory_mod_states')
    .selectAll()
    .where('server_id', '=', context.server.id)
    .executeTakeFirst();
  const oldFiles = filesSchema.parse(previous?.files ?? []);
  // The stopped job is the sole writer. Validate existing managed files before replacing them.
  const readHash = async (path: string, maximum: number) => {
    const ancestors = path.split('/');
    for (let index = 0; index < ancestors.length - 1; index++) {
      const parent = ancestors.slice(0, index).join('/');
      const entry = (await context.adapter.listFiles(identifier, parent)).find(
        (item) => item.name === ancestors[index],
      );
      if (!entry) return null;
      if (entry.is_file || entry.is_symlink) throw new DomainError('conflict');
    }
    const directory = path.slice(0, path.lastIndexOf('/')),
      name = path.split('/').at(-1);
    const entries = await context.adapter.listFiles(identifier, directory);
    const found = entries.find((entry) => entry.name === name);
    if (!found) return null;
    if (!found.is_file || found.is_symlink) throw new DomainError('conflict');
    const response = await context.adapter.downloadFile(identifier, path, {
      maxBytes: Math.max(1, maximum),
      authorize: context.authorize,
    });
    const digest = createHash('sha256');
    const reader = response.body.getReader();
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maximum) throw new DomainError('conflict');
        digest.update(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return digest.digest('hex');
  };
  for (let index = 0; index < receipt.files.length; index++) {
    const file = receipt.files[index]!;
    const parts = file.path.split('/');
    for (let depth = 0; depth < parts.length - 1; depth++) {
      const parent = parts.slice(0, depth).join('/'),
        name = parts[depth]!;
      const entry = (await context.adapter.listFiles(identifier, parent)).find(
        (item) => item.name.toLowerCase() === name.toLowerCase(),
      );
      if (entry && (entry.is_symlink || entry.is_file || entry.name !== name))
        throw new DomainError('conflict');
      if (!entry)
        await context.effect(`satisfactory.mods.mkdir.${index}.${depth}`, async () => {
          await context.authorize();
          await context.assertStopped();
          await context.adapter.createDirectory(identifier, parent, name);
        });
    }
    const old = oldFiles.find((item) => item.path === file.path);
    const actual = await readHash(file.path, Math.max(file.size, old?.size ?? 0));
    if (actual === file.sha256) continue;
    if (actual !== null && actual !== old?.sha256) throw new DomainError('conflict');
    const bytes = await readFile(join(stage, `${index}.bin`));
    if (bytes.length !== file.size || hash(bytes) !== file.sha256)
      throw new DomainError('operation_uncertain');
    await context.effect(`satisfactory.mods.upload.${index}`, async () => {
      await context.authorize();
      await context.assertStopped();
      await context.adapter.uploadFile(identifier, file.path, {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        contentLength: bytes.length,
        maxBytes: bytes.length,
        authorize: async () => {
          await context.authorize();
          await context.assertStopped();
        },
      });
    });
    if ((await readHash(file.path, file.size)) !== file.sha256)
      throw new DomainError('operation_uncertain');
  }
  for (const [index, old] of oldFiles.entries()) {
    if (receipt.files.some((file) => file.path === old.path)) continue;
    const actual = await readHash(old.path, old.size);
    if (actual === null) continue;
    if (actual !== old.sha256) throw new DomainError('conflict');
    await context.effect(`satisfactory.mods.remove.${index}`, async () => {
      await context.authorize();
      await context.assertStopped();
      await context.adapter.deleteFiles(identifier, '', [old.path]);
    });
    if ((await readHash(old.path, old.size)) !== null) throw new DomainError('operation_uncertain');
  }
  await context.db
    .insertInto('satisfactory_mod_states')
    .values({
      server_id: context.server.id,
      selection: JSON.stringify(receipt.selection),
      files: JSON.stringify(receipt.files),
      lock: JSON.stringify(receipt.lock),
    })
    .onConflict((oc) =>
      oc.column('server_id').doUpdateSet({
        selection: JSON.stringify(receipt.selection),
        files: JSON.stringify(receipt.files),
        lock: JSON.stringify(receipt.lock),
        updated_at: new Date(),
      }),
    )
    .execute();
  await context.update({ plan: { ...context.operation().plan, satisfactoryModsApplied: true } });
  await cleanup();
  return true;
}
