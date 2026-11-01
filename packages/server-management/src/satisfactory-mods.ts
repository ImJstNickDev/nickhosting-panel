import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { DomainError } from '@nickhosting/core';
import { getSettings } from '@nickhosting/database';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  prepareSatisfactoryMods,
  satisfactoryModLockSchema,
  satisfactoryModSelectionSchema,
  satisfactoryVersionPaths,
} from '../../../games/satisfactory/src/mods.js';
import { diffSatisfactoryMods } from '../../../games/satisfactory/src/mods-plan.js';
import { contentStorageRoot, reserveContentStaging } from './content-admission.js';
import type { GameLifecycleContext } from './lifecycle.js';
import {
  ensureSatisfactoryModState,
  inspectSatisfactoryModInventory,
} from './satisfactory-mod-manager.js';
import { assertServerStorageCapacity } from './storage-capacity.js';

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
  gameVersion: z.number().int().positive().optional(),
  requiredTargets: z.array(z.enum(['LinuxServer', 'Windows', 'WindowsServer'])).optional(),
  downloadCacheBytes: z.number().int().nonnegative().max(536870912).optional(),
});

export async function processSatisfactoryMods(
  context: GameLifecycleContext,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const command = z
    .object({
      kind: z.literal('mods'),
      selection: satisfactoryModSelectionSchema.default([]),
      mode: z.enum(['preview', 'apply', 'rollback']).optional(),
      revision: z.number().int().nonnegative().optional(),
      planId: z.uuid().optional(),
      profileId: z.uuid().optional(),
      vanilla: z.boolean().default(false),
    })
    .parse(context.operation().plan.satisfactoryContent);
  const identifier = context.server.pterodactyl_identifier;
  if (!identifier) throw new DomainError('integration_unavailable');
  await context.authorize();
  if (command.mode !== 'preview' || !context.previewSourceVerified) await context.assertStopped();
  const managerState = command.mode
    ? await ensureSatisfactoryModState(context.db, context.server.id)
    : null;
  const priorRecovery = z
    .object({ jobId: z.uuid(), supersededStageJobs: z.array(z.uuid()).max(128).default([]) })
    .safeParse(managerState?.recovery);
  if (managerState?.recovery && !priorRecovery.success)
    throw new DomainError('configuration_invalid');
  if (
    managerState &&
    (managerState.external_mode || managerState.revision !== command.revision) &&
    context.operation().plan.satisfactoryModsApplied !== true
  )
    throw new DomainError('conflict');
  const root = env.NH_SATISFACTORY_MOD_WORK_ROOT
    ? resolve(env.NH_SATISFACTORY_MOD_WORK_ROOT)
    : contentStorageRoot((await getSettings(context.db, env)).values.contentWorkRoot, env);
  const stage = join(root, 'content-staging', context.operation().job_id);
  const previewPhase = async (phase: 'preparing' | 'inventory') => {
    if (command.mode === 'preview')
      await context.update({
        plan: { ...context.operation().plan, satisfactoryPreviewPhase: phase },
      });
  };
  const releaseStage = async (jobId: string) => {
    z.uuid().parse(jobId);
    await rm(join(root, 'content-staging', jobId), { recursive: true, force: true });
    await context.db
      .updateTable('minecraft_staging_claims')
      .set({ state: 'released' })
      .where('job_id', '=', jobId)
      .execute();
  };
  const cleanup = async () => {
    await rm(stage, { recursive: true, force: true });
    await context.db
      .updateTable('minecraft_staging_claims')
      .set({ state: 'released' })
      .where('job_id', '=', context.operation().job_id)
      .execute();
  };
  const cleanupApplied = async (input: unknown) => {
    const value = z
      .object({
        release: z.array(z.uuid()),
        files: z.number().int().nonnegative(),
        retainedBytes: z.number().int().nonnegative(),
        removeCurrent: z.boolean(),
      })
      .parse(input);
    for (const jobId of value.release) await releaseStage(jobId);
    await context.db
      .updateTable('satisfactory_mod_states')
      .set({ recovery: sql`jsonb_set(recovery,'{supersededStageJobs}','[]'::jsonb)` })
      .where('server_id', '=', context.server.id)
      .where(sql<boolean>`recovery->>'jobId' = ${context.operation().job_id}`)
      .execute();
    if (value.removeCurrent) await cleanup();
    else {
      for (let index = 0; index < value.files; index++)
        await rm(join(stage, `${index}.bin`), { force: true });
      await context.db
        .updateTable('minecraft_staging_claims')
        .set({ reserved_bytes: String(value.retainedBytes + 65536) })
        .where('job_id', '=', context.operation().job_id)
        .execute();
    }
  };
  if (context.operation().plan.satisfactoryModsApplied === true) {
    if (!command.mode) await cleanup();
    else await cleanupApplied(context.operation().plan.satisfactoryModsCleanup);
    return true;
  }
  await mkdir(stage, { recursive: true, mode: 0o700 });
  let recoveryAppliedFiles: z.infer<typeof filesSchema> = [];
  let sourceStageJobId: string | null = null;
  if (command.mode) {
    const expired = await context.db
      .selectFrom('satisfactory_mod_plans')
      .select(['id', 'job_id'])
      .where('server_id', '=', context.server.id)
      .where('expires_at', '<', new Date())
      .limit(100)
      .execute();
    for (const plan of expired) {
      if (plan.id === command.planId || !plan.job_id) continue;
      const job = await context.db
        .selectFrom('operation_jobs')
        .select('state')
        .where('id', '=', plan.job_id)
        .executeTakeFirst();
      if (job && !['succeeded', 'failed'].includes(job.state)) continue;
      await releaseStage(plan.job_id);
      await context.db.deleteFrom('satisfactory_mod_plans').where('id', '=', plan.id).execute();
    }
    if (command.mode === 'preview') {
      // Incremental drafts must not accumulate a full stage for every checkbox.
      // Retain the three most recent completed previews for navigation/cache reuse.
      const superseded = await context.db
        .selectFrom('satisfactory_mod_plans as plan')
        .innerJoin('operation_jobs as job', 'job.id', 'plan.job_id')
        .select(['plan.id', 'plan.job_id'])
        .where('plan.server_id', '=', context.server.id)
        .where('plan.id', '!=', command.planId!)
        .where('plan.status', 'in', ['pending', 'ready', 'failed'])
        .where('job.state', 'in', ['succeeded', 'failed'])
        .orderBy('plan.created_at', 'desc')
        .offset(3)
        .execute();
      for (const plan of superseded) {
        if (!plan.job_id) continue;
        await releaseStage(plan.job_id);
        await context.db.deleteFrom('satisfactory_mod_plans').where('id', '=', plan.id).execute();
      }
    }
  }
  if (command.mode === 'apply' || command.mode === 'rollback') {
    const plan =
      command.mode === 'apply'
        ? await context.db
            .selectFrom('satisfactory_mod_plans')
            .selectAll()
            .where('id', '=', command.planId!)
            .where('server_id', '=', context.server.id)
            .executeTakeFirstOrThrow()
        : null;
    const recovery =
      command.mode === 'rollback'
        ? z
            .object({
              jobId: z.uuid(),
              selection: satisfactoryModSelectionSchema,
              files: filesSchema,
              lock: satisfactoryModLockSchema,
              vanilla: z.boolean(),
              profileId: z.uuid().nullable(),
              appliedFiles: filesSchema.optional(),
              gameVersion: z.number().int().positive().optional(),
            })
            .parse(managerState?.recovery)
        : null;
    if (
      plan &&
      (plan.status !== 'ready' ||
        plan.revision !== command.revision ||
        plan.expires_at.getTime() < Date.now() ||
        !plan.job_id)
    )
      throw new DomainError('conflict');
    const selected = plan
      ? satisfactoryModSelectionSchema.parse(plan.selection)
      : recovery!.selection;
    sourceStageJobId = plan?.job_id ?? recovery!.jobId;
    const source = join(root, 'content-staging', sourceStageJobId);
    command.selection = selected;
    command.vanilla = plan?.vanilla ?? recovery!.vanilla;
    command.profileId = plan?.profile_id ?? recovery?.profileId ?? undefined;
    recoveryAppliedFiles = recovery?.appliedFiles ?? [];
    const inventory = await inspectSatisfactoryModInventory(
      context.db,
      context.adapter,
      context.server,
      context.authorize,
    );
    try {
      await writeFile(join(stage, 'baseline.json'), JSON.stringify(inventory.files), {
        mode: 0o600,
        flag: 'wx',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (
      (plan && inventory.gameVersion !== plan.game_version) ||
      (recovery?.gameVersion && inventory.gameVersion !== recovery.gameVersion)
    )
      throw new DomainError('conflict');
    if (
      !context.operation().plan.satisfactoryModsApplying &&
      ((plan && inventory.fingerprint !== plan.inventory_fingerprint) ||
        (plan && inventory.diverged))
    )
      throw new DomainError('conflict');
    const { authorizeQueuedEffect } = await import('./runtime.js');
    const actor = await authorizeQueuedEffect(
      context.db,
      context.operation().job_id,
      context.server.id,
      env,
      context.adapter,
    );
    await reserveContentStaging(
      context.db,
      actor,
      context.operation().job_id,
      context.server.id,
      1610612736,
      env,
    );
    const sourceFiles = filesSchema.parse(plan?.files ?? recovery!.files);
    for (let i = 0; i < sourceFiles.length; i++)
      await copyFile(join(source, `${recovery ? 'old-' : ''}${i}.bin`), join(stage, `${i}.bin`));
    await writeFile(
      join(stage, 'receipt.json'),
      JSON.stringify({
        selection: selected,
        files: sourceFiles,
        lock: plan?.lock ?? recovery!.lock,
        gameVersion: plan?.game_version ?? recovery?.gameVersion,
      }),
      { mode: 0o600 },
    );
  }
  let receipt: z.infer<typeof receiptSchema>;
  let previewInventory: Awaited<ReturnType<typeof inspectSatisfactoryModInventory>> | undefined;
  try {
    receipt = receiptSchema.parse(JSON.parse(await readFile(join(stage, 'receipt.json'), 'utf8')));
    if (JSON.stringify(receipt.selection) !== JSON.stringify(command.selection))
      throw new DomainError('conflict');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Without a committed preparation receipt none of this job's payloads can
    // have been applied. Do not accumulate partial staging files across retries.
    await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { recursive: true, mode: 0o700 });
    let versionPath: (typeof satisfactoryVersionPaths)[number] | undefined;
    const entries = await context.adapter.listFiles(identifier, 'Engine/Binaries/Linux');
    for (const candidate of satisfactoryVersionPaths) {
      const entry = entries.find((item) => item.name === candidate.split('/').at(-1));
      if (entry?.is_file && !entry.is_symlink) {
        versionPath = candidate;
        break;
      }
    }
    if (!versionPath) throw new DomainError('configuration_invalid');
    const metadata = await Promise.allSettled([
      context.adapter.readFile(identifier, versionPath, 65536),
      context.adapter.readFile(identifier, 'FactoryServer.sh', 1048576),
    ]);
    if (metadata[0].status === 'rejected') throw metadata[0].reason;
    if (metadata[1].status === 'rejected') throw metadata[1].reason;
    const versionFile = Buffer.from(metadata[0].value);
    const launcherFile = Buffer.from(metadata[1].value);
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
    const profile = command.profileId
      ? await context.db
          .selectFrom('satisfactory_mod_profiles')
          .select('required_targets')
          .where('id', '=', command.profileId)
          .where('server_id', '=', context.server.id)
          .executeTakeFirstOrThrow()
      : null;
    await previewPhase('preparing');
    const cacheSources = await context.db
      .selectFrom('satisfactory_mod_plans as plan')
      .innerJoin('operation_jobs as job', 'job.id', 'plan.job_id')
      .select('plan.job_id')
      .where('plan.server_id', '=', context.server.id)
      .where('plan.status', '=', 'ready')
      .where('job.state', '=', 'succeeded')
      .where('plan.game_version', '=', Number(JSON.parse(versionFile.toString('utf8')).Changelist))
      .where('plan.expires_at', '>', new Date())
      .orderBy('plan.created_at', 'desc')
      .limit(2)
      .execute();
    const preparationStarted = performance.now();
    let nativeDurationMs = 0;
    let inventoryDurationMs = 0;
    const abort = new AbortController();
    const settle = <T>(work: Promise<T>): Promise<T> =>
      work.catch((error: unknown) => {
        if (!abort.signal.aborted) abort.abort(error);
        throw error;
      });
    const inventoryWork =
      command.mode === 'preview'
        ? settle(
            inspectSatisfactoryModInventory(
              context.db,
              context.adapter,
              context.server,
              context.authorize,
              { signal: abort.signal, reuseListings: true },
            ).finally(() => {
              inventoryDurationMs = Math.round(performance.now() - preparationStarted);
            }),
          )
        : Promise.resolve(undefined);
    const prepareWork = settle(
      (async () =>
        prepareSatisfactoryMods({
          sandboxExecutable: env.NH_CONTENT_SANDBOX_PATH,
          executable: env.NH_FICSIT_CLI_PATH ?? '/usr/local/bin/ficsit',
          executableSha256:
            env.NH_FICSIT_CLI_SHA256 ??
            (process.arch === 'arm64'
              ? 'a591eb87be517d9d03798184c210d7166141be19e37b9d4e5fe68c84f264c6bf'
              : '2af0f8815af93b097c7a97968569575b21cf451b7c345fbb62fae29096ee4a31'),
          stagingRoot: root,
          outputDirectory: stage,
          signal: abort.signal,
          downloadCache: {
            sourceDirectories: cacheSources.flatMap((source) =>
              source.job_id ? [join(root, 'content-staging', z.uuid().parse(source.job_id))] : [],
            ),
          },
          selection: command.selection,
          vanilla: command.vanilla,
          requiredTargets: profile
            ? z
                .array(z.enum(['LinuxServer', 'Windows', 'WindowsServer']))
                .parse(profile.required_targets)
            : ['LinuxServer'],
          // Resolve published metadata afresh: external lockfiles are never download authority.
          versionPath,
          versionFile,
          launcherFile,
        }))().finally(() => {
        nativeDurationMs = Math.round(performance.now() - preparationStarted);
      }),
    );
    // Both branches share this operation's connection lease. Cancellation must
    // settle every read and child process before the delivery releases its lock.
    const results = await Promise.allSettled([prepareWork, inventoryWork]);
    if (abort.signal.aborted) throw abort.signal.reason;
    const preparedResult = results[0];
    const inventoryResult = results[1];
    if (preparedResult.status !== 'fulfilled') throw preparedResult.reason;
    if (inventoryResult.status !== 'fulfilled') throw inventoryResult.reason;
    const prepared = preparedResult.value;
    previewInventory = inventoryResult.value;
    try {
      context.logger?.log('info', 'satisfactory.mods_preparation', {
        jobId: context.operation().job_id,
        durationMs: nativeDurationMs,
        nativeTimings: prepared.timings,
        inventoryDurationMs,
        overlappedDurationMs: Math.round(performance.now() - preparationStarted),
        cacheSources: cacheSources.length,
        files: prepared.files.length,
      });
    } catch {
      // Timing diagnostics never invalidate a successfully prepared payload.
    }
    receipt = {
      downloadCacheBytes: prepared.downloadCacheBytes,
      gameVersion: Number(JSON.parse(versionFile.toString('utf8')).Changelist),
      requiredTargets: profile
        ? z
            .array(z.enum(['LinuxServer', 'Windows', 'WindowsServer']))
            .parse(profile.required_targets)
        : ['LinuxServer'],
      selection: command.selection,
      lock: prepared.lock,
      files: prepared.files.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        size: file.size,
      })),
    };
    await writeFile(join(stage, 'receipt.tmp'), JSON.stringify(receipt), { mode: 0o600 });
    await rename(join(stage, 'receipt.tmp'), join(stage, 'receipt.json'));
  }
  if (command.mode === 'preview') {
    await previewPhase('inventory');
    const inventory =
      previewInventory ??
      (await inspectSatisfactoryModInventory(
        context.db,
        context.adapter,
        context.server,
        context.authorize,
        { reuseListings: true },
      ));
    if (inventory.diverged || inventory.gameVersion !== receipt.gameVersion)
      throw new DomainError('conflict');
    const changes = diffSatisfactoryMods({
      previousLock: satisfactoryModLockSchema.parse(managerState!.lock),
      nextLock: receipt.lock,
      previousSelection: satisfactoryModSelectionSchema.parse(managerState!.selection),
      selection: receipt.selection,
      vanilla: command.vanilla,
    });
    await context.update({
      plan: {
        ...context.operation().plan,
        satisfactoryModsRequiredTargets: receipt.requiredTargets ?? ['LinuxServer'],
      },
    });
    await context.db
      .updateTable('satisfactory_mod_plans')
      .set({
        status: 'ready',
        job_id: context.operation().job_id,
        lock: JSON.stringify(receipt.lock),
        files: JSON.stringify(receipt.files),
        changes: JSON.stringify(changes),
        inventory_fingerprint: inventory.fingerprint,
        game_version: inventory.gameVersion,
      })
      .where('id', '=', command.planId!)
      .where('server_id', '=', context.server.id)
      .where('revision', '=', command.revision!)
      .execute();
    await context.db
      .updateTable('minecraft_staging_claims')
      .set({
        reserved_bytes: String((await preparedStageBytes(stage)) + 65536),
      })
      .where('job_id', '=', context.operation().job_id)
      .execute();
    return true;
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
  for (const file of recoveryAppliedFiles) {
    const index = oldFiles.findIndex((old) => old.path === file.path);
    if (index < 0) oldFiles.push(file);
    else oldFiles[index] = file;
  }
  // Validate managed ownership before every write; external SFTP changes remain conflicts.
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
  // Snapshot every managed byte before the first mutation. Recovery survives partial applies.
  // Preflight all destinations before snapshot/mutation, including unmanaged collisions.
  if (command.mode && !context.operation().plan.satisfactoryModsApplying)
    for (const file of receipt.files) {
      const old = oldFiles.find((value) => value.path === file.path);
      const hash = await readHash(file.path, Math.max(file.size, old?.size ?? 0));
      if (hash !== null && hash !== file.sha256 && hash !== old?.sha256)
        throw new DomainError('conflict');
    }
  if (
    command.mode &&
    command.mode !== 'rollback' &&
    !context.operation().plan.satisfactoryModsApplying
  ) {
    for (const [index, file] of oldFiles.entries()) {
      if ((await readHash(file.path, file.size)) !== file.sha256) throw new DomainError('conflict');
      const response = await context.adapter.downloadFile(identifier, file.path, {
        maxBytes: Math.max(1, file.size),
        authorize: context.authorize,
      });
      const { pipeline } = await import('node:stream/promises');
      const { createWriteStream } = await import('node:fs');
      await pipeline(
        Readable.fromWeb(response.body as never),
        createWriteStream(join(stage, `old-${index}.bin`), { mode: 0o600 }),
      );
      const copied = createHash('sha256');
      let copiedBytes = 0;
      for await (const chunk of createReadStream(join(stage, `old-${index}.bin`))) {
        copiedBytes += chunk.length;
        copied.update(chunk);
      }
      if (copiedBytes !== file.size || copied.digest('hex') !== file.sha256)
        throw new DomainError('conflict');
    }
    await context.db
      .updateTable('satisfactory_mod_states')
      .set({
        recovery: JSON.stringify({
          jobId: context.operation().job_id,
          supersededStageJobs: priorRecovery.success
            ? [
                ...new Set(
                  [priorRecovery.data.jobId, ...priorRecovery.data.supersededStageJobs].filter(
                    (id) => id !== context.operation().job_id,
                  ),
                ),
              ]
            : [],
          selection: previous?.selection ?? [],
          files: oldFiles,
          lock: previous?.lock ?? { version: 1, mods: {} },
          vanilla: previous?.vanilla ?? false,
          profileId: previous?.active_profile_id ?? null,
          appliedFiles: receipt.files,
          gameVersion: receipt.gameVersion,
        }),
      })
      .where('server_id', '=', context.server.id)
      .execute();
    await context.update({ plan: { ...context.operation().plan, satisfactoryModsApplying: true } });
  }
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
    const staged = join(stage, `${index}.bin`);
    const metadata = await lstat(staged);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== file.size)
      throw new DomainError('operation_uncertain');
    const stagedHash = createHash('sha256');
    for await (const chunk of createReadStream(staged)) stagedHash.update(chunk);
    if (stagedHash.digest('hex') !== file.sha256) throw new DomainError('operation_uncertain');
    await context.effect(`satisfactory.mods.upload.${index}`, async () => {
      await context.authorize();
      await context.assertStopped();
      await context.adapter.uploadFile(identifier, file.path, {
        body: Readable.toWeb(createReadStream(staged, { highWaterMark: 65536 }), {
          strategy: { highWaterMark: 65536, size: (chunk: Buffer) => chunk.byteLength },
        }) as ReadableStream<Uint8Array>,
        contentLength: file.size,
        maxBytes: file.size,
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
  if (!command.mode)
    await context.db
      .insertInto('satisfactory_mod_states')
      .values({
        server_id: context.server.id,
        selection: JSON.stringify(receipt.selection),
        files: JSON.stringify(receipt.files),
        lock: JSON.stringify(receipt.lock),
        active_profile_id: null,
        external_previous_intent: null,
        inventory_fingerprint: null,
        recovery: null,
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
  const cleanupPlan = {
    release: [
      ...new Set(
        [
          sourceStageJobId,
          priorRecovery.success ? priorRecovery.data.jobId : null,
          ...(priorRecovery.success ? priorRecovery.data.supersededStageJobs : []),
        ].filter((id): id is string => !!id && id !== context.operation().job_id),
      ),
    ],
    files: receipt.files.length,
    retainedBytes: oldFiles.reduce((sum, file) => sum + file.size, 0),
    removeCurrent: command.mode === 'rollback',
  };
  const completedPlan = {
    ...context.operation().plan,
    satisfactoryModsApplied: true,
    ...(command.mode ? { satisfactoryModsCleanup: cleanupPlan } : {}),
  };
  if (command.mode) {
    const inventory = await inspectSatisfactoryModInventory(
      context.db,
      context.adapter,
      context.server,
      context.authorize,
    );
    const baseline = filesSchema.parse(
      JSON.parse(await readFile(join(stage, 'baseline.json'), 'utf8')),
    );
    const expected = new Map(baseline.map((file) => [file.path, file]));
    for (const file of oldFiles) expected.delete(file.path);
    for (const file of receipt.files) expected.set(file.path, file);
    if (
      inventory.files.length !== expected.size ||
      inventory.files.some((file) => {
        const item = expected.get(file.path);
        return !item || item.size !== file.size || item.sha256 !== file.sha256;
      })
    )
      throw new DomainError('conflict');
    await context.db.transaction().execute(async (tx) => {
      if (command.profileId) {
        const profile = await tx
          .selectFrom('satisfactory_mod_profiles')
          .select('id')
          .where('id', '=', command.profileId)
          .where('server_id', '=', context.server.id)
          .executeTakeFirst();
        if (!profile) command.profileId = undefined;
        else
          await tx
            .updateTable('satisfactory_mod_profiles')
            .set({
              selection: JSON.stringify(receipt.selection),
              vanilla: command.vanilla,
              updated_at: new Date(),
            })
            .where('id', '=', profile.id)
            .execute();
      }
      await tx
        .updateTable('satisfactory_mod_states')
        .set({
          selection: JSON.stringify(receipt.selection),
          files: JSON.stringify(receipt.files),
          lock: JSON.stringify(receipt.lock),
          updated_at: new Date(),
          revision: managerState!.revision + 1,
          vanilla: command.vanilla,
          active_profile_id: command.profileId ?? null,
          inventory_fingerprint: inventory.fingerprint,
          ...(command.mode === 'rollback' ? { recovery: null } : {}),
        })
        .where('server_id', '=', context.server.id)
        .execute();
      if (command.planId)
        await tx
          .updateTable('satisfactory_mod_plans')
          .set({ status: 'applied' })
          .where('id', '=', command.planId)
          .execute();
      await tx
        .updateTable('server_operations')
        .set({ plan: JSON.stringify(completedPlan) })
        .where('job_id', '=', context.operation().job_id)
        .execute();
    });
  }
  await context.update({ plan: completedPlan });
  if (command.mode) await cleanupApplied(cleanupPlan);
  else await cleanup();
  return true;
}

async function preparedStageBytes(directory: string): Promise<number> {
  let bytes = 0;
  let entries = 0;
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > 32) throw new DomainError('configuration_invalid');
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++entries > 40000 || entry.isSymbolicLink())
        throw new DomainError('configuration_invalid');
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (entry.isFile()) bytes += (await lstat(child)).size;
      else throw new DomainError('configuration_invalid');
      if (bytes > 1610612736) throw new DomainError('configuration_invalid');
    }
  };
  await walk(directory, 0);
  return bytes;
}
