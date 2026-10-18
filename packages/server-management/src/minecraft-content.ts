import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { Readable } from 'node:stream';
import {
  type ContentFileVerification,
  type ContentHttp,
  type ContentTarget,
  type CurseForgeProvider,
  contentPlanDigest,
  type InstalledContentFile,
  incompatibleContentSchema,
  inspectModpack,
  installedContentChange,
  ModrinthProvider,
  prepareArchiveTransfer,
  recoverContentStageLock,
  safeArchivePath,
  safeContentPath,
  stageContent,
  validateContentPlan,
} from '@nickhosting/content-providers';
import { type AuthContext, DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import {
  minecraftCombinationSchema,
  minecraftDigest,
  minecraftManifest,
  minecraftWorldDataVersion,
} from '@nickhosting/minecraft';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  canonicalMinecraftJarSha256,
  minecraftGeneratedLauncherMaxBytes,
} from '../../../games/minecraft/src/generated-launcher.js';
import {
  createMinecraftIdentityProvider,
  editMinecraftProperties,
  minecraftWorldName,
  parseMinecraftProperties,
  planMinecraftPlayerList,
  planMinecraftWorldSelection,
  verifyMinecraftPlayer,
} from '../../../games/minecraft/src/management.js';
import {
  minecraftRuntimeMappingSchema,
  type ResolvedMinecraftRuntime,
} from '../../../games/minecraft/src/runtime.js';
import {
  discoverMinecraftWorlds,
  inspectMinecraftWorldTransfer,
  planMinecraftWorldReplacement,
  recoverMinecraftWorldStageLock,
  stageMinecraftWorld,
  validateMinecraftLevelDat,
} from '../../../games/minecraft/src/world.js';
import { assessMinecraftWorldCompatibility } from '../../../games/minecraft/src/world-version.js';
import type {
  FilemanDirectoryResult,
  FilemanEntry,
  FilemanReadService,
} from '../../game-sdk/src/fileman-read.js';
import type { Environment } from './admission.js';
import { createFilemanReadService } from './fileman-read.js';
import { filemanTransferDigest, filemanTransferReceiptStep } from './fileman-transfers.js';
import type { GameLifecycleContext } from './lifecycle.js';
import { inspectMinecraftCombination } from './minecraft-registry.js';
import {
  assertMinecraftRemoteLaunch,
  requireMinecraftRuntimeImageEvidence,
} from './minecraft-runtime-evidence.js';
import { createMinecraftSourceStore, reserveMinecraftStaging } from './minecraft-sources.js';
import { supportsProviderFileOperations } from './provider-file-operations.js';
import { assertServerStorageCapacity } from './storage-capacity.js';
import { reserveUploadIngestion } from './upload-admission.js';

export type {
  MinecraftContentCommand,
  MinecraftPreparedContent,
} from './minecraft-content-contracts.js';
export {
  minecraftConfigurationSchema,
  minecraftContentCommandSchema,
} from './minecraft-content-contracts.js';

import {
  type MinecraftContentCommand,
  type MinecraftPreparedContent,
  minecraftConfigurationSchema,
  minecraftContentAllowsOnline,
  minecraftContentCommandSchema,
  minecraftContentSelectsWorld,
  minecraftStoredConfigurationSchema,
  minecraftStoredPlayerSchema,
} from './minecraft-content-contracts.js';
import type { createMinecraftWorldPreparation } from './minecraft-world-preparation.js';
export interface MinecraftContentOptions {
  worldPreparation?: ReturnType<typeof createMinecraftWorldPreparation>;
  http: ContentHttp;
  mountdataRoot: string;
  sourceRoot?: string;
  userAgent: string;
  curseforge?: CurseForgeProvider;
  env?: Environment;
  /** Trusted authenticated upload store only; never accepts a filesystem path from a browser. */
  archiveResolver?: (reference: string, serverId: string) => Promise<string>;
  worldArchiveResolver?: (
    reference: string,
    serverId: string,
  ) => Promise<{ path: string; sha256: string }>;
  acquireModpack?: (
    projectId: string,
    versionId: string,
    scope: string,
  ) => Promise<{ path: string; sourceId: string; sha256: string }>;
  creationArchiveResolver?: (sourceId: string) => Promise<{ path: string; sha256: string }>;
  identityProvider?: ReturnType<typeof createMinecraftIdentityProvider>;
  /** Fresh Docker container image identity from the explicitly bound physical-host observer. */
  observedImageDigest?: (db: Kysely<Database>, serverId: string) => Promise<string | null>;
  authorizeJob: (db: Kysely<Database>, jobId: string, serverId: string) => Promise<AuthContext>;
}
function fail(reason: string): never {
  throw new DomainError('validation_failed', 400, { reason });
}
function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function contentTarget(combination: unknown): ContentTarget {
  const value = minecraftCombinationSchema.parse(combination);
  return {
    minecraftVersion: value.release,
    loader: value.profile,
    ...(value.loaderVersion ? { loaderVersion: value.loaderVersion } : {}),
  };
}
function modpackSelection(command: MinecraftContentCommand) {
  if (command.kind === 'modpack')
    return {
      provider: command.provider,
      projectId: command.projectId,
      versionId: command.versionId,
    };
  if (command.kind === 'modpack-upload') return { sourceId: command.archiveRef };
  return undefined;
}
function assertModpackConsent(
  previous: MinecraftPreparedContent['previousModpack'],
  command: MinecraftContentCommand,
) {
  const target = modpackSelection(command);
  if (
    target &&
    previous &&
    minecraftDigest(previous) !== minecraftDigest(target) &&
    !('replace' in command && command.replace?.wipeConsent)
  )
    fail('minecraft_modpack_replacement_required');
}
/** Exact pack identity includes provider project/version or the immutable uploaded source. */
export function assertMinecraftModpackTransition(
  current: unknown,
  prepared: MinecraftPreparedContent,
  selectionCommitted = false,
): void {
  const command = minecraftContentCommandSchema.parse(prepared.command);
  if (command.kind !== 'modpack' && command.kind !== 'modpack-upload') return;
  const target = modpackSelection(command);
  if (!target) throw new DomainError('configuration_invalid');
  const selected = minecraftConfigurationSchema.shape.modpack.nullable().parse(current ?? null);
  const hasBaseline = Object.hasOwn(prepared, 'previousModpack');
  // Old jobs cannot acquire consent from a later selection. The narrow legacy
  // same-pack case still executes all installation/configuration verification.
  if (!hasBaseline) {
    if (minecraftDigest(selected) !== minecraftDigest(target) || command.replace)
      throw new DomainError('conflict');
    return;
  }
  const previous = minecraftConfigurationSchema.shape.modpack
    .unwrap()
    .nullable()
    .parse(prepared.previousModpack);
  if (
    minecraftDigest(selected) !== minecraftDigest(previous) &&
    !(selectionCommitted && minecraftDigest(selected) === minecraftDigest(target))
  )
    throw new DomainError('conflict');
  assertModpackConsent(previous, command);
  if (command.replace) {
    if (
      !prepared.deletePaths ||
      minecraftDigest([...prepared.deletePaths].sort()) !==
        minecraftDigest([...command.replace.expectedDeletePaths].sort()) ||
      prepared.backupBefore !== command.replace.backupBefore
    )
      throw new DomainError('conflict');
  } else if (prepared.deletePaths?.length || prepared.backupBefore) {
    throw new DomainError('conflict');
  }
}
export function assertMinecraftContentTarget(target: ContentTarget, expected: ContentTarget): void {
  if (
    target.minecraftVersion !== expected.minecraftVersion ||
    target.loader !== expected.loader ||
    target.loaderVersion !== expected.loaderVersion
  )
    fail('minecraft_content_runtime_mismatch');
}
export function assertMinecraftRuntimePathsPreserved(
  paths: readonly string[],
  installedManifest: unknown,
): void {
  const manifest = z.array(z.object({ path: z.string() }).passthrough()).parse(installedManifest);
  for (const path of paths) {
    safeArchivePath(path);
    if (
      manifest.some(
        (file) =>
          file.path === path ||
          file.path.startsWith(`${path}/`) ||
          path.startsWith(`${file.path}/`),
      )
    )
      fail('minecraft_runtime_file_protected');
  }
}
/** Preview is bound to the exact current world selection; runtime binaries are never wiped. */
export async function minecraftContentWipePreview(
  adapter: PterodactylAdapter,
  identifier: string,
): Promise<string[]> {
  const entries = await adapter.listFiles(identifier);
  const propertiesEntry = entries.find((entry) => entry.name === 'server.properties');
  let world = 'world';
  if (propertiesEntry)
    world = minecraftWorldName(
      parseMinecraftProperties(
        Buffer.from(await adapter.readFile(identifier, 'server.properties')).toString('utf8'),
      )['level-name'] ?? 'world',
    );
  const candidates = new Set([
    'mods',
    'plugins',
    'config',
    'defaultconfigs',
    world,
    `${world}_nether`,
    `${world}_the_end`,
  ]);
  return entries
    .filter((entry) => candidates.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}
export async function prepareMinecraftContentPlan(
  db: Kysely<Database>,
  serverId: string,
  input: unknown,
  options: MinecraftContentOptions & { adapter: PterodactylAdapter },
): Promise<MinecraftPreparedContent> {
  const command = minecraftContentCommandSchema.parse(input);
  const profile = await db
    .selectFrom('minecraft_server_profiles')
    .selectAll()
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  const server = await db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (
    !profile ||
    (!profile.installed &&
      command.kind !== 'verify' &&
      !z.array(z.unknown()).safeParse(profile.installed_manifest).data?.length) ||
    !server?.pterodactyl_identifier
  )
    throw new DomainError('conflict');
  const choice = await inspectMinecraftCombination(db, profile.combination_id, options.env);
  const result: MinecraftPreparedContent = {
    combinationId: profile.combination_id,
    command,
    backupBefore: false,
  };
  if (
    command.kind === 'world-import' ||
    command.kind === 'world-select' ||
    command.kind === 'world-remove'
  ) {
    const name = minecraftWorldName(
      command.kind === 'world-import' ? command.targetWorld : command.world,
    );
    // Reuse Worlds' trusted observation when available. A cold API caller retains
    // the regular dispatch inspection; no browser-provided verification is accepted.
    const actual =
      command.kind !== 'world-import'
        ? undefined
        : (await options.adapter.listFiles(server.pterodactyl_identifier)).filter(
            (entry) => entry.name.toLowerCase() === name.toLowerCase(),
          );
    if (
      actual &&
      (actual.length > 1 ||
        actual.some((entry) => entry.name !== name || entry.is_file || entry.is_symlink))
    )
      throw new DomainError('conflict');
    assertMinecraftRuntimePathsPreserved([name], profile.installed_manifest);
    result.world = {
      dataVersion:
        command.kind === 'world-select'
          ? worldDataVersion(choice)
          : minecraftWorldDataVersion(choice.combination.release),
      existing: command.kind !== 'world-import' || actual?.length === 1,
    };
    if (command.kind === 'world-select') {
      const inspected = await options.worldPreparation?.read(server, profile.combination_id);
      if (inspected) {
        const observation = inspected.worlds.find((world) => world.name === name);
        if (!observation) throw new DomainError('conflict');
        result.world.observation = observation;
      }
    }
    if (command.kind === 'world-import') {
      if (server.runtime_state === 'running') {
        const properties = parseMinecraftProperties(
          Buffer.from(
            await options.adapter.readFile(server.pterodactyl_identifier, 'server.properties'),
          ).toString('utf8'),
        );
        if (
          result.world.existing ||
          targetsConfiguredMinecraftWorld(properties['level-name'] ?? 'world', name)
        )
          throw new DomainError('conflict');
      }
      const source = await options.worldArchiveResolver?.(command.archiveRef, serverId);
      if (!source) throw new DomainError('integration_unavailable');
      const replacement = planMinecraftWorldReplacement(
        name,
        result.world.existing,
        command.replace,
      );
      result.archivePath = source.path;
      result.archiveRef = command.archiveRef;
      result.archiveSha256 = source.sha256;
      result.world.archiveSha256 = source.sha256;
      result.deletePaths = [...replacement.deletePaths];
      result.backupBefore = replacement.backupBefore;
    } else {
      if (!result.world.existing) throw new DomainError('not_found');
      result.backupBefore = command.kind === 'world-remove' && command.backupBefore;
    }
    return result;
  }
  if (command.kind === 'install') {
    const target = contentTarget(choice.combination);
    result.contentPlan =
      command.provider === 'modrinth'
        ? await new ModrinthProvider(options.http).resolve(
            command.projectId,
            command.versionId,
            target,
          )
        : await requiredCurseForge(options).resolve(
            Number(command.projectId),
            Number(command.versionId),
            target,
          );
  } else if (command.kind === 'modpack' || command.kind === 'modpack-upload') {
    result.previousModpack =
      minecraftStoredConfigurationSchema.parse(profile.configuration).modpack ?? null;
    assertModpackConsent(result.previousModpack, command);
    const scope = minecraftDigest({ serverId, command });
    if (command.kind === 'modpack') {
      const source = await options.acquireModpack?.(command.projectId, command.versionId, scope);
      if (!source) throw new DomainError('integration_unavailable');
      result.archivePath = source.path;
      result.archiveRef = source.sourceId;
      result.archiveSha256 = source.sha256;
    } else {
      result.archivePath = await options.archiveResolver?.(command.archiveRef, serverId);
      result.archiveRef = command.archiveRef;
    }
    if (!result.archivePath) throw new DomainError('integration_unavailable');
    result.contentPlan = await inspectModpack(result.archivePath, {
      curseforge: options.curseforge,
    });
    assertMinecraftContentTarget(result.contentPlan.target, contentTarget(choice.combination));
    if (command.replace) {
      const preview = await minecraftContentWipePreview(
        options.adapter,
        server.pterodactyl_identifier,
      );
      if (
        minecraftDigest(preview) !==
        minecraftDigest([...command.replace.expectedDeletePaths].sort())
      )
        throw new DomainError('conflict');
      result.deletePaths = preview;
      assertMinecraftRuntimePathsPreserved(preview, profile.installed_manifest);
      result.backupBefore = command.replace.backupBefore;
    }
  }
  if (result.contentPlan) result.planDigest = contentPlanDigest(result.contentPlan);
  if (result.contentPlan)
    assertMinecraftRuntimePathsPreserved(
      [...result.contentPlan.artifacts, ...result.contentPlan.overrides].map((file) => file.path),
      profile.installed_manifest,
    );
  return result;
}
export function assertMinecraftPlayerConfiguration(
  choice: Awaited<ReturnType<typeof inspectMinecraftCombination>>,
  configuration: z.infer<typeof minecraftConfigurationSchema>,
): void {
  if (
    choice.supportAuthority === 'integration' &&
    !choice.capabilities.playerManagement &&
    (configuration.operators.length > 0 ||
      configuration.whitelist.length > 0 ||
      configuration.properties['white-list'] === true ||
      configuration.properties['white-list'] === 'true')
  )
    throw new DomainError('integration_unavailable');
}
export async function prepareMinecraftCreationConfig(
  db: Kysely<Database>,
  choiceId: string,
  input: unknown,
  options: MinecraftContentOptions,
) {
  const configuration = minecraftConfigurationSchema.parse(input);
  const choice = await inspectMinecraftCombination(db, choiceId, options.env);
  assertMinecraftPlayerConfiguration(choice, configuration);
  if (!configuration.modpack) return { configuration };
  const selected = configuration.modpack;
  const source =
    'sourceId' in selected
      ? await options
          .creationArchiveResolver?.(selected.sourceId)
          .then((source) => ({ ...source, sourceId: selected.sourceId }))
      : await options.acquireModpack?.(
          selected.projectId,
          selected.versionId,
          minecraftDigest({ choiceId, selected }),
        );
  if (!source) throw new DomainError('integration_unavailable');
  const contentPlan = await inspectModpack(source.path, { curseforge: options.curseforge });
  assertMinecraftContentTarget(contentPlan.target, contentTarget(choice.combination));
  const initialContent: MinecraftPreparedContent = {
    combinationId: choiceId,
    command:
      'sourceId' in selected
        ? { kind: 'modpack-upload', archiveRef: selected.sourceId }
        : { kind: 'modpack', ...selected },
    backupBefore: false,
    previousModpack: selected,
    archivePath: source.path,
    archiveRef: source.sourceId,
    archiveSha256: source.sha256,
    contentPlan,
    planDigest: contentPlanDigest(contentPlan),
  };
  return { configuration, initialContent };
}
function requiredCurseForge(options: MinecraftContentOptions): CurseForgeProvider {
  if (!options.curseforge) throw new DomainError('integration_unavailable');
  return options.curseforge;
}
function worldDataVersion(choice: Awaited<ReturnType<typeof inspectMinecraftCombination>>): number {
  const version = minecraftWorldDataVersion(choice.combination.release);
  if (version === undefined) throw new DomainError('integration_unavailable');
  return version;
}

/** Every ancestor is checked; Wings accepts paths but does not make symlink ownership ours. */
type MinecraftReadContext = Pick<GameLifecycleContext, 'db' | 'server' | 'adapter' | 'authorize'>;
async function remoteEntry(context: MinecraftReadContext, path: string) {
  safeArchivePath(path);
  const parts = path.split('/');
  let directory = '';
  for (let index = 0; index < parts.length; index++) {
    const name = parts[index];
    const matches = (
      await context.adapter.listFiles(context.server.pterodactyl_identifier ?? '', directory)
    ).filter((entry) => entry.name.toLowerCase() === name?.toLowerCase());
    if (matches.length > 1 || (matches[0] && matches[0].name !== name))
      throw new DomainError('conflict');
    const entry = matches[0];
    if (!entry) return undefined;
    if (entry.is_symlink || (index < parts.length - 1 && entry.is_file))
      throw new DomainError('conflict');
    if (index === parts.length - 1) return entry;
    directory = [directory, name].filter(Boolean).join('/');
  }
  return undefined;
}
export async function hashMinecraftRemoteFile(
  context: MinecraftReadContext,
  path: string,
  options: { maxBytes?: number; onChunk?: (chunk: Uint8Array) => void } = {},
): Promise<{ sha256: string; sha1: string; size: number } | null> {
  const entry = await remoteEntry(context, path);
  if (!entry) return null;
  if (!entry.is_file || !Number.isSafeInteger(entry.size)) throw new DomainError('conflict');
  if (options.maxBytes !== undefined && entry.size > options.maxBytes)
    throw new DomainError('conflict');
  const response = await context.adapter.downloadFile(
    context.server.pterodactyl_identifier ?? '',
    path,
    {
      maxBytes: entry.size,
      authorize: context.authorize,
    },
  );
  const reader = response.body.getReader();
  const hash = createHash('sha256'),
    legacy = createHash('sha1');
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > entry.size) throw new DomainError('conflict');
      hash.update(item.value);
      legacy.update(item.value);
      options.onChunk?.(item.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (size !== entry.size) throw new DomainError('conflict');
  return { sha256: hash.digest('hex'), sha1: legacy.digest('hex'), size };
}
async function textFile(
  context: GameLifecycleContext,
  path: string,
  absent?: string,
): Promise<string> {
  const snapshot = await readTextSnapshot(context, path);
  if (snapshot === null) {
    if (absent === undefined) throw new DomainError('not_found');
    return absent;
  }
  return snapshot.content;
}
const textChangeSchema = z
  .object({
    path: z.enum(['server.properties', 'whitelist.json', 'ops.json', 'eula.txt']),
    content: z.string().max(1024 * 1024),
    beforeSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    afterSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type TextChange = z.infer<typeof textChangeSchema>;
const measureContent = <T>(context: GameLifecycleContext, name: string, work: () => Promise<T>) =>
  context.timing ? context.timing.measure(`minecraft.${name}`, work) : work();
const stepId = (kind: string, path: string) => `minecraft.${kind}.${sha256(path)}`;
async function completed(context: GameLifecycleContext, step: string): Promise<boolean> {
  return Boolean(
    await measureContent(context, 'receipt.read', () =>
      context.db
        .selectFrom('job_steps')
        .select('step')
        .where('job_id', '=', context.operation().job_id)
        .where('step', '=', step)
        .executeTakeFirst(),
    ),
  );
}
async function complete(context: GameLifecycleContext, step: string) {
  await measureContent(context, 'receipt.write', () =>
    context.db
      .insertInto('job_steps')
      .values({ job_id: context.operation().job_id, step })
      .onConflict((c) => c.columns(['job_id', 'step']).doNothing())
      .execute(),
  );
}
function uncertainEffect(context: GameLifecycleContext, phase: string): boolean {
  const operation = context.operation();
  return operation.phase === phase && operation.effect_state !== 'none';
}
/** A lost response is reconciled against the recorded desired hash, never blindly resent. */
export async function applyMinecraftTextChange(
  context: GameLifecycleContext,
  change: TextChange,
  files?: FilemanReadService,
  knownPath = false,
  comparison?: Promise<Awaited<ReturnType<typeof readTextSnapshot>>>,
): Promise<void> {
  textChangeSchema.parse(change);
  if (sha256(change.content) !== change.afterSha256) throw new DomainError('conflict');
  const step = stepId('text', change.path);
  if ((await completed(context, step)) || uncertainEffect(context, step)) {
    // Recovery observes once and never blindly replays a possible prior write.
    const current = await measureContent(context, 'text.recovery', () =>
      readTextSnapshot(context, change.path, undefined, knownPath),
    );
    if (current?.hash !== change.afterSha256) throw new DomainError('operation_uncertain');
    await complete(context, step);
    return;
  }
  if (!minecraftContentSelectsWorld(context.operation().plan.minecraftContent))
    await context.assertStopped();
  const preparedWorldSelection =
    knownPath &&
    change.path === 'server.properties' &&
    minecraftContentSelectsWorld(context.operation().plan.minecraftContent);
  // This selection owns a new Fileman scope whose first read authorizes itself.
  // Other paths keep their existing outer authorization; effect() checks again.
  if (!preparedWorldSelection) await context.authorize();
  // Directory metadata belongs to this pre-effect phase; comparison bytes come
  // from this attempt's live read, never an earlier request or preparation.
  // Absence needs a fresh listing: an external writer may have created the file.
  // Recovery above also creates a new scope after a possible mutation.
  const current =
    preparedWorldSelection && comparison
      ? await comparison
      : await measureContent(context, 'text.compare', () =>
          readTextSnapshot(
            context,
            change.path,
            change.beforeSha256 === null ? undefined : files,
            knownPath,
          ),
        );
  if (current?.hash === change.afterSha256) {
    await complete(context, step);
    return;
  }
  if ((current?.hash ?? null) !== change.beforeSha256) throw new DomainError('conflict');
  await context.effect(step, async () => {
    const identifier = context.server.pterodactyl_identifier ?? '';
    if (context.timing)
      await context.adapter.writeFile(
        identifier,
        change.path,
        change.content,
        context.timing.child('write'),
      );
    else await context.adapter.writeFile(identifier, change.path, change.content);
  });
  // The provider acknowledgement commits the write. A lost response is handled by
  // the recovery branch above; acknowledged writes do not download the file again.
  await complete(context, step);
}

async function plannedText(
  context: GameLifecycleContext,
  path: TextChange['path'],
  content: string,
  expectedBefore?: string | null,
  files?: FilemanReadService,
): Promise<TextChange> {
  // A builder already has the exact bytes/hash. The fresh comparison belongs to
  // the effect boundary, not another fetch while serializing the same plan.
  const beforeSha256 =
    expectedBefore !== undefined
      ? expectedBefore
      : ((await readTextSnapshot(context, path, files))?.hash ?? null);
  return {
    path,
    content,
    beforeSha256,
    afterSha256: sha256(content),
  };
}
async function readTextSnapshot(
  context: GameLifecycleContext,
  path: string,
  fileman?: FilemanReadService,
  knownPath = false,
) {
  safeArchivePath(path);
  const files =
    fileman ??
    createFilemanReadService({
      adapter: context.adapter,
      identifier: context.server.pterodactyl_identifier ?? '',
      authorize: context.authorize,
      timing: context.timing?.child('freshFiles'),
    });
  // These fixed configuration paths are root files. One shared root observation
  // retains the symlink/case guard; the hash is computed from the bytes we edit.
  if (path.includes('/')) throw new DomainError('validation_failed');
  if (!knownPath) {
    const matches = (await files.list('')).filter(
      (entry) => entry.name.toLowerCase() === path.toLowerCase(),
    );
    if (matches.length > 1 || (matches[0] && matches[0].name !== path))
      throw new DomainError('conflict');
    const entry = matches[0];
    if (!entry) return null;
    if (entry.kind !== 'file' || entry.size > 1024 ** 2) throw new DomainError('conflict');
  }
  const bytes = await files.read({ path, maxBytes: 1024 ** 2 });
  if (!bytes) throw new DomainError('not_found');
  const snapshot = () => ({ content: Buffer.from(bytes).toString('utf8'), hash: sha256(bytes) });
  return context.timing ? context.timing.measureSync('minecraft.text.hash', snapshot) : snapshot();
}
async function textSnapshot(
  context: GameLifecycleContext,
  path: string,
  fallback: string,
  files?: FilemanReadService,
) {
  return (await readTextSnapshot(context, path, files)) ?? { content: fallback, hash: null };
}
async function applyTextPlan(
  context: GameLifecycleContext,
  build: (files: FilemanReadService) => Promise<TextChange[]>,
  beforeEffects?: (plan: TextChange[]) => Promise<void>,
  files?: FilemanReadService,
  knownPath = false,
  comparison?: Promise<Awaited<ReturnType<typeof readTextSnapshot>>>,
) {
  if (context.operation().plan.minecraftText === undefined) {
    // Builders may persist authority (for example a verified player UUID).
    // Read the latest plan only after they finish; an earlier spread loses it.
    const changes = await measureContent(context, 'text.build', () =>
      build(
        files ??
          createFilemanReadService({
            adapter: context.adapter,
            identifier: context.server.pterodactyl_identifier ?? '',
            authorize: context.authorize,
          }),
      ),
    );
    await measureContent(context, 'text.persist', () =>
      context.update({ plan: { ...context.operation().plan, minecraftText: changes } }),
    );
  }
  const plan = z.array(textChangeSchema).max(4).parse(context.operation().plan.minecraftText);
  await beforeEffects?.(plan);
  for (const change of plan)
    await applyMinecraftTextChange(context, change, files, knownPath, comparison);
}
const initialConfigurationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), jobId: z.uuid().optional() }).strict(),
  z
    .object({
      status: z.literal('planned'),
      jobId: z.uuid(),
      files: z
        .array(
          z
            .object({
              path: z.enum(['eula.txt', 'server.properties', 'ops.json', 'whitelist.json']),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict(),
        )
        .min(1)
        .max(4),
      initialContentDigest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict(),
]);
function initialConfiguration(value: unknown) {
  if (value && typeof value === 'object' && Object.keys(value).length === 0) return undefined;
  return initialConfigurationSchema.parse(value);
}
/** Initial security settings have their own fence so unrelated content recovery cannot clear them. */
async function verifyMinecraftInitialConfiguration(context: GameLifecycleContext): Promise<void> {
  const profile = await context.db
    .selectFrom('minecraft_server_profiles')
    .select('configuration_state')
    .where('server_id', '=', context.server.id)
    .executeTakeFirstOrThrow();
  const state = initialConfiguration(profile.configuration_state);
  if (!state) return;
  if (state.status !== 'planned') throw new DomainError('operation_uncertain');
  for (const file of state.files)
    if ((await hashMinecraftRemoteFile(context, file.path))?.sha256 !== file.sha256)
      throw new DomainError('operation_uncertain');
  if (state.initialContentDigest) {
    const done = await context.db
      .selectFrom('job_steps')
      .select('step')
      .where('job_id', '=', state.jobId)
      .where('step', '=', `minecraft.initial-content.${state.initialContentDigest}`)
      .executeTakeFirst();
    if (!done) throw new DomainError('operation_uncertain');
  }
  await context.db
    .updateTable('minecraft_server_profiles')
    .set({ configuration_state: '{}', updated_at: new Date() })
    .where('server_id', '=', context.server.id)
    .execute();
}
async function verifyInstalledRuntime(
  context: MinecraftReadContext,
  options: Pick<MinecraftContentOptions, 'env' | 'observedImageDigest'>,
) {
  const env = options.env ?? {};
  const profile = await context.db
    .selectFrom('minecraft_server_profiles')
    .selectAll()
    .where('server_id', '=', context.server.id)
    .executeTakeFirstOrThrow();
  const choice = await inspectMinecraftCombination(context.db, profile.combination_id, env);
  const binding = minecraftRuntimeMappingSchema.parse(choice.row.binding);
  const runtime = choice.row.resolved_runtime as ResolvedMinecraftRuntime;
  const remote = await context.adapter.getApplicationServer(context.server.pterodactyl_id ?? 0);
  await assertMinecraftRemoteLaunch(context.db, context.server.id, remote, env, context.adapter);
  if (
    remote.egg !== choice.mapping.egg_id ||
    remote.container.image !== binding.image ||
    choice.mappingDigest !== choice.row.mapping_digest
  )
    throw new DomainError('provenance_mismatch');
  if (!options.observedImageDigest) throw new DomainError('configuration_invalid');
  const imageEvidence = await requireMinecraftRuntimeImageEvidence(
    context.db,
    context.server.id,
    await options.observedImageDigest(context.db, context.server.id),
    env,
  );
  const verified: { path: string; sha256: string; size: number }[] = [];
  if (runtime.installation.kind === 'server-jar') {
    const artifact = runtime.artifacts.find((item) => item.role === 'server');
    const path = binding.artifactPaths.server;
    if (!artifact || !path || (!artifact.sha1 && !artifact.sha256))
      throw new DomainError('configuration_invalid');
    const actual = await hashMinecraftRemoteFile(context, path, {
      maxBytes: artifact.size ?? 512 * 1024 ** 2,
    });
    if (
      !actual ||
      (artifact.sha1 && artifact.sha1 !== actual.sha1) ||
      (artifact.sha256 && artifact.sha256 !== actual.sha256) ||
      (artifact.size !== undefined && artifact.size !== actual.size)
    )
      throw new DomainError('conflict');
    verified.push({ path, sha256: actual.sha256, size: actual.size });
  } else {
    // Loader-generated outputs are not proven by downloading an installer. Only
    // the trusted runner's signed exact-combination manifest can establish them.
    const report = imageEvidence.report;
    if (!report?.server?.installedFiles?.length) throw new DomainError('integration_unavailable');
    if (report.server.installedFiles.reduce((total, file) => total + file.size, 0) > 2 * 1024 ** 3)
      throw new DomainError('configuration_invalid');
    for (const file of report.server.installedFiles) {
      const generatedLauncher = file.role === 'fabric-launcher';
      if (
        generatedLauncher &&
        (runtime.profile !== 'fabric' ||
          runtime.installation.kind !== 'fabric-installer' ||
          binding.profile !== 'fabric' ||
          binding.artifactPaths.server !== file.path ||
          !file.jarEntriesSha256 ||
          !file.minecraftServerPath)
      )
        throw new DomainError('configuration_invalid');
      const bytes = generatedLauncher
        ? Buffer.alloc(minecraftGeneratedLauncherMaxBytes)
        : undefined;
      let offset = 0;
      const actual = await hashMinecraftRemoteFile(
        context,
        file.path,
        bytes
          ? {
              maxBytes: minecraftGeneratedLauncherMaxBytes,
              onChunk(chunk) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
              },
            }
          : { maxBytes: file.size },
      );
      if (!actual) throw new DomainError('conflict');
      if (bytes) {
        if (
          (await canonicalMinecraftJarSha256(bytes.subarray(0, actual.size))) !==
          file.jarEntriesSha256
        )
          throw new DomainError('conflict');
        const serverPath = file.minecraftServerPath as string;
        safeArchivePath(serverPath);
        const propertiesPath = 'fabric-server-launcher.properties';
        const propertyBytes = Buffer.alloc(64 * 1024);
        let propertyOffset = 0;
        const properties = await hashMinecraftRemoteFile(context, propertiesPath, {
          maxBytes: propertyBytes.length,
          onChunk(chunk) {
            propertyBytes.set(chunk, propertyOffset);
            propertyOffset += chunk.byteLength;
          },
        });
        const parsed = properties
          ? parseMinecraftProperties(propertyBytes.subarray(0, properties.size).toString('latin1'))
          : {};
        // FabricServerLauncher.getServerJarPath documents server.jar when the
        // generated companion file/key is absent, including the first launch.
        if (
          Object.keys(parsed).some((key) => key !== 'serverJar') ||
          (parsed.serverJar ?? 'server.jar') !== serverPath
        )
          throw new DomainError('conflict');
        const declared = report.server.installedFiles.find(
          (entry) => entry.path === serverPath && entry.role === undefined,
        );
        const artifact = runtime.artifacts.find((entry) => entry.role === 'server');
        const server = await hashMinecraftRemoteFile(context, serverPath, {
          maxBytes: declared?.size ?? 512 * 1024 ** 2,
        });
        if (
          !declared ||
          !artifact ||
          (!artifact.sha1 && !artifact.sha256) ||
          !server ||
          (artifact.sha1 && artifact.sha1 !== server.sha1) ||
          (artifact.sha256 && artifact.sha256 !== server.sha256) ||
          (artifact.size !== undefined && artifact.size !== server.size) ||
          declared.sha256 !== server.sha256 ||
          declared.size !== server.size
        )
          throw new DomainError('conflict');
        if (properties)
          verified.push({ path: propertiesPath, sha256: properties.sha256, size: properties.size });
      } else if (actual.sha256 !== file.sha256 || actual.size !== file.size)
        throw new DomainError('conflict');
      // Persist the current target receipt, not the bootstrap JAR's timestamp-sensitive hash.
      verified.push({ path: file.path, sha256: actual.sha256, size: actual.size });
    }
  }
  return { profile, choice, verified, imageEvidence };
}
/** Recover only the first Vanilla egg installation from verified required outputs.
 * This is not evidence that an installer script succeeded, and old files cannot
 * establish completion of a reinstall or wipe. */
export async function verifyMinecraftInitialInstallation(
  context: GameLifecycleContext,
  options: Pick<MinecraftContentOptions, 'env' | 'observedImageDigest'>,
): Promise<import('./lifecycle.js').InitialInstallationOutputs | null> {
  if (context.operation().action !== 'provision' || context.operation().phase !== 'installation')
    return null;
  const profile = await context.db
    .selectFrom('minecraft_server_profiles')
    .selectAll()
    .where('server_id', '=', context.server.id)
    .executeTakeFirst();
  if (!profile || profile.installed) return null;
  const choice = await inspectMinecraftCombination(
    context.db,
    profile.combination_id,
    options.env ?? {},
  );
  const runtime = choice.row.resolved_runtime as ResolvedMinecraftRuntime;
  if (runtime.profile !== 'vanilla' || runtime.installation.kind !== 'server-jar') return null;
  await context.authorize();
  const verified = await verifyInstalledRuntime(context, options);
  await context.authorize();
  if (!verified.imageEvidence.observed) throw new DomainError('configuration_invalid');
  return {
    integrationId: 'minecraft',
    combinationId: profile.combination_id,
    mappingDigest: verified.choice.mappingDigest,
    imageDigest: verified.imageEvidence.observed,
    files: verified.verified,
  };
}
/** Explicit read-only artifact audit. Ordinary power and process observations
 * do not invoke this: installation/content/restore workflows verify their outputs. */
export async function assertMinecraftLaunchInputs(
  context: MinecraftReadContext,
  options: Pick<MinecraftContentOptions, 'env' | 'observedImageDigest'>,
): Promise<void> {
  const verified = await verifyInstalledRuntime(context, options);
  if (!verified.profile.installed) throw new DomainError('integration_unavailable');
}
export async function resolveMinecraftConfigurationPlayers(
  configuration: z.infer<typeof minecraftConfigurationSchema>,
  provider: ReturnType<typeof createMinecraftIdentityProvider>,
) {
  const operators = [];
  const whitelist = [];
  for (const name of configuration.operators)
    operators.push({
      ...(await verifyMinecraftPlayer(name, provider)),
      level: 4,
      bypassesPlayerLimit: false,
    });
  for (const name of configuration.whitelist)
    whitelist.push(await verifyMinecraftPlayer(name, provider));
  return { operators, whitelist };
}
/** Existing UUID authority is immutable across reinstalls, including reclaimed usernames. */
export async function resolveMinecraftStoredPlayers(
  input: unknown,
  provider: ReturnType<typeof createMinecraftIdentityProvider>,
) {
  const configuration = minecraftStoredConfigurationSchema.parse(input);
  if (!configuration.playerIdentities)
    configuration.playerIdentities = await resolveMinecraftConfigurationPlayers(
      configuration,
      provider,
    );
  return configuration;
}
export function applyMinecraftStoredPlayerChange(
  input: unknown,
  command: { list: 'operators' | 'whitelist'; action: 'add' | 'remove' },
  identity: unknown,
) {
  const configuration = minecraftStoredConfigurationSchema.parse(input);
  const player = minecraftStoredPlayerSchema.parse(identity);
  if (!configuration.playerIdentities) {
    if (configuration.operators.length || configuration.whitelist.length)
      throw new DomainError('configuration_invalid');
    configuration.playerIdentities = { operators: [], whitelist: [] };
  }
  const players = configuration.playerIdentities[command.list].filter(
    (entry) => entry.uuid !== player.uuid,
  );
  if (command.action === 'add') players.push(player);
  configuration.playerIdentities[command.list] = players;
  configuration[command.list] = players.map((entry) => entry.name);
  return minecraftStoredConfigurationSchema.parse(configuration);
}
/** Existing rows carry UUID authority from the current file. A renamed or reclaimed
 * name must not redirect an edit/removal to whichever account now owns that name. */
export async function resolveMinecraftPlayerChangeIdentity(
  command: Extract<MinecraftContentCommand, { kind: 'player' }>,
  source: string,
  provider: Parameters<typeof verifyMinecraftPlayer>[1],
) {
  if (!command.expectedUuid) return verifyMinecraftPlayer(command.name, provider);
  let entries: unknown;
  try {
    entries = JSON.parse(source);
  } catch {
    throw new DomainError('conflict');
  }
  if (!Array.isArray(entries) || entries.length > 100000) throw new DomainError('conflict');
  const matches = entries.filter((entry) => entry && entry.uuid === command.expectedUuid);
  if (matches.length === 0 && command.action === 'add') {
    const identity = await verifyMinecraftPlayer(command.name, provider);
    if (identity.uuid !== command.expectedUuid) throw new DomainError('conflict');
    return identity;
  }
  if (matches.length !== 1 || matches[0].name !== command.name) throw new DomainError('conflict');
  return {
    uuid: command.expectedUuid,
    name: command.name,
    source: 'server-file' as const,
    verifiedAt: new Date().toISOString(),
  };
}
/** Recover only the historical ADD receipt-loss bug against unchanged durable
 * intent and an already applied exact file. REMOVE lacks the removed identity
 * in its after-image, so missing REMOVE authority remains explicitly uncertain. */
async function recoverMinecraftPlayerReceipt(
  context: GameLifecycleContext,
  options: MinecraftContentOptions,
  command: Extract<MinecraftContentCommand, { kind: 'player' }>,
) {
  if (context.operation().plan.minecraftPlayerChange === undefined) {
    if (command.action !== 'add') throw new DomainError('operation_uncertain');
    const changes = z
      .array(textChangeSchema)
      .length(1)
      .parse(context.operation().plan.minecraftText);
    const change = changes[0];
    const path = command.list === 'operators' ? 'ops.json' : 'whitelist.json';
    if (
      !change ||
      change.path !== path ||
      sha256(change.content) !== change.afterSha256 ||
      (await hashMinecraftRemoteFile(context, path))?.sha256 !== change.afterSha256
    )
      throw new DomainError('operation_uncertain');
    const player = await resolveMinecraftPlayerChangeIdentity(
      command,
      change.content,
      options.identityProvider ?? createMinecraftIdentityProvider({ userAgent: options.userAgent }),
    );
    let entries: unknown;
    try {
      entries = JSON.parse(change.content);
    } catch {
      throw new DomainError('operation_uncertain');
    }
    if (!Array.isArray(entries)) throw new DomainError('operation_uncertain');
    const matches = entries.filter(
      (entry) => entry && entry.uuid === player.uuid && entry.name === player.name,
    );
    if (matches.length !== 1) throw new DomainError('operation_uncertain');
    const entry = matches[0];
    if (
      command.list === 'operators' &&
      ((command.operatorLevel !== undefined && command.operatorLevel !== entry.level) ||
        (command.bypassesPlayerLimit !== undefined &&
          command.bypassesPlayerLimit !== entry.bypassesPlayerLimit))
    )
      throw new DomainError('operation_uncertain');
    const identity = minecraftStoredPlayerSchema.parse({
      ...player,
      ...(command.list === 'operators'
        ? { level: entry.level, bypassesPlayerLimit: entry.bypassesPlayerLimit }
        : {}),
    });
    const reconstructed = planMinecraftPlayerList(change.content, command.list, 'add', identity, {
      operatorLevel: identity.level,
      bypassesPlayerLimit: identity.bypassesPlayerLimit,
    });
    if (
      reconstructed.content !== change.content ||
      reconstructed.afterSha256 !== change.afterSha256
    )
      throw new DomainError('operation_uncertain');
    await context.authorize();
    await context.assertStopped();
    if ((await hashMinecraftRemoteFile(context, path))?.sha256 !== change.afterSha256)
      throw new DomainError('operation_uncertain');
    await context.update({
      plan: {
        ...context.operation().plan,
        minecraftPlayerChange: identity,
        minecraftPlayerRecovery: {
          path,
          afterSha256: change.afterSha256,
          identitySha256: minecraftDigest(identity),
          verifiedAt: identity.verifiedAt,
          reason: 'missing_add_receipt_confirmed_after_image',
        },
      },
    });
  }
  const recovery = context.operation().plan.minecraftPlayerRecovery;
  if (!recovery) return;
  const marker = z
    .object({
      path: z.enum(['ops.json', 'whitelist.json']),
      afterSha256: z.string().regex(/^[a-f0-9]{64}$/),
      identitySha256: z.string().regex(/^[a-f0-9]{64}$/),
      verifiedAt: z.iso.datetime({ offset: true }),
      reason: z.literal('missing_add_receipt_confirmed_after_image'),
    })
    .strict()
    .parse(recovery);
  if (marker.identitySha256 !== minecraftDigest(context.operation().plan.minecraftPlayerChange))
    throw new DomainError('operation_uncertain');
  const auditStep = stepId('player-recovery-audit', minecraftDigest(marker));
  if (!(await completed(context, auditStep))) {
    await context.event('minecraft.player.receipt_recovered', marker);
    await complete(context, auditStep);
  }
}
export async function configureMinecraftProvision(
  context: GameLifecycleContext,
  options: MinecraftContentOptions,
): Promise<boolean> {
  const profile = await context.db
    .selectFrom('minecraft_server_profiles')
    .selectAll()
    .where('server_id', '=', context.server.id)
    .executeTakeFirst();
  if (!profile || profile.installed) return true;
  await context.authorize();
  await context.assertStopped();
  const verified = await verifyInstalledRuntime(context, options);
  if (
    context.operation().action === 'wipe' &&
    context.operation().plan.wipeComplete === true &&
    context.operation().plan.minecraftWipeReset !== true
  ) {
    await context.db.transaction().execute(async (tx) => {
      await tx
        .updateTable('minecraft_server_profiles')
        .set({ installed: false, content_state: '{}', updated_at: new Date() })
        .where('server_id', '=', context.server.id)
        .execute();
      await tx
        .deleteFrom('minecraft_content_items')
        .where('server_id', '=', context.server.id)
        .execute();
    });
    await context.update({ plan: { ...context.operation().plan, minecraftWipeReset: true } });
  }
  await context.db
    .updateTable('minecraft_server_profiles')
    .set({ installed_manifest: JSON.stringify(verified.verified), updated_at: new Date() })
    .where('server_id', '=', context.server.id)
    .execute();
  const identities =
    options.identityProvider ?? createMinecraftIdentityProvider({ userAgent: options.userAgent });
  const configuration = await resolveMinecraftStoredPlayers(profile.configuration, identities);
  assertMinecraftPlayerConfiguration(verified.choice, configuration);
  if (!minecraftStoredConfigurationSchema.parse(profile.configuration).playerIdentities) {
    // Persist UUID authority before any file effect; retries and reinstalls must
    // never resolve a reclaimed username into a different account.
    await context.db
      .updateTable('minecraft_server_profiles')
      .set({ configuration: JSON.stringify(configuration), updated_at: new Date() })
      .where('server_id', '=', context.server.id)
      .execute();
  }
  const initial = configuration.modpack
    ? (context.operation().plan.minecraftInitialContent as MinecraftPreparedContent | undefined)
    : undefined;
  if (
    configuration.modpack &&
    (!initial?.planDigest ||
      initial.combinationId !== profile.combination_id ||
      ('sourceId' in configuration.modpack
        ? initial.command.kind !== 'modpack-upload' ||
          initial.command.archiveRef !== configuration.modpack.sourceId
        : initial.command.kind !== 'modpack' ||
          initial.command.projectId !== configuration.modpack.projectId ||
          initial.command.versionId !== configuration.modpack.versionId))
  )
    throw new DomainError('configuration_invalid');
  const initialContentDigest = initial ? minecraftDigest(initial) : undefined;
  await applyTextPlan(
    context,
    async (files) => {
      const changes: TextChange[] = [
        await plannedText(context, 'eula.txt', 'eula=true\n', undefined, files),
      ];
      if (Object.keys(configuration.properties).length) {
        const snapshot = await textSnapshot(context, 'server.properties', '', files);
        const source = snapshot.content;
        const edited = editMinecraftProperties(source, configuration.properties, {
          release: verified.choice.combination.release,
          supportedKeys: source
            ? Object.keys(parseMinecraftProperties(source))
            : (verified.imageEvidence.report?.server?.supportedProperties ??
              (verified.choice.capabilities.playerManagement ? ['white-list'] : [])),
        });
        changes.push(
          await plannedText(context, 'server.properties', edited.content, snapshot.hash),
        );
      }
      for (const [kind, players, path] of [
        ['operators', configuration.playerIdentities?.operators ?? [], 'ops.json'],
        ['whitelist', configuration.playerIdentities?.whitelist ?? [], 'whitelist.json'],
      ] as const) {
        if (!players.length) continue;
        const snapshot = await textSnapshot(context, path, '[]', files);
        let content = snapshot.content;
        for (const player of players)
          content = planMinecraftPlayerList(content, kind, 'add', player, {
            operatorLevel: player.level,
            bypassesPlayerLimit: player.bypassesPlayerLimit,
          }).content;
        changes.push(await plannedText(context, path, content, snapshot.hash));
      }
      return changes;
    },
    async (changes) => {
      const current = await context.db
        .selectFrom('minecraft_server_profiles')
        .select('configuration_state')
        .where('server_id', '=', context.server.id)
        .executeTakeFirstOrThrow();
      const previous = initialConfiguration(current.configuration_state);
      const state = {
        status: 'planned' as const,
        jobId: context.operation().job_id,
        files: changes.map((change) => ({ path: change.path, sha256: change.afterSha256 })),
        ...(initialContentDigest ? { initialContentDigest } : {}),
      };
      if (
        previous?.status === 'planned' &&
        (previous.jobId === state.jobId
          ? minecraftDigest(previous) !== minecraftDigest(state)
          : !['reinstall', 'wipe'].includes(context.operation().action))
      )
        throw new DomainError('operation_uncertain');
      await context.db
        .updateTable('minecraft_server_profiles')
        .set({
          installed: false,
          configuration_state: JSON.stringify(state),
          updated_at: new Date(),
        })
        .where('server_id', '=', context.server.id)
        .execute();
    },
  );
  if (initial) {
    if (!(await applyPreparedContent(context, options, initial))) return false;
    await complete(context, `minecraft.initial-content.${initialContentDigest}`);
  }
  await verifyMinecraftPendingContent(context);
  await verifyMinecraftInitialConfiguration(context);
  await context.db
    .updateTable('minecraft_server_profiles')
    .set({
      installed: true,
      installed_manifest: JSON.stringify(verified.verified),
      updated_at: new Date(),
    })
    .where('server_id', '=', context.server.id)
    .execute();
  await context.event('minecraft.installation.verified', {
    files: verified.verified.length,
    imageObserved: verified.imageEvidence.observed,
    imageVerified: verified.imageEvidence.verified,
  });
  return true;
}

async function ensureRemoteDirectory(
  context: GameLifecycleContext,
  path: string,
  assertWritable = context.assertStopped,
) {
  const parts = path.split('/').slice(0, -1);
  for (let index = 0; index < parts.length; index++) {
    const directory = parts.slice(0, index + 1).join('/');
    const entry = await remoteEntry(context, directory);
    if (entry) {
      if (entry.is_file) throw new DomainError('conflict');
      continue;
    }
    const phase = stepId('directory', directory);
    if (uncertainEffect(context, phase)) throw new DomainError('operation_uncertain');
    await context.effect(phase, async () => {
      await assertWritable();
      await context.authorize();
      await context.adapter.createDirectory(
        context.server.pterodactyl_identifier ?? '',
        parts.slice(0, index).join('/'),
        parts[index] ?? '',
      );
    });
    if (!(await remoteEntry(context, directory))) throw new DomainError('operation_uncertain');
  }
}
async function removeContentPath(
  context: GameLifecycleContext,
  path: string,
  expectedHash?: string,
) {
  safeArchivePath(path);
  const step = stepId('remove', path);
  const entry = await remoteEntry(context, path);
  if (!entry) {
    await complete(context, step);
    return;
  }
  if ((await completed(context, step)) || uncertainEffect(context, step))
    throw new DomainError('operation_uncertain');
  if (expectedHash && (await hashMinecraftRemoteFile(context, path))?.sha256 !== expectedHash)
    throw new DomainError('conflict');
  await context.effect(step, async () => {
    await context.assertStopped();
    await context.authorize();
    if (expectedHash && (await hashMinecraftRemoteFile(context, path))?.sha256 !== expectedHash)
      throw new DomainError('conflict');
    await context.adapter.deleteFiles(context.server.pterodactyl_identifier ?? '', '', [path]);
  });
  if (await remoteEntry(context, path)) throw new DomainError('operation_uncertain');
  await complete(context, step);
}
/** Normalized selected tree, including dimension siblings and enclosing roots. */
function targetsConfiguredMinecraftWorld(configured: string, target: string): boolean {
  const active = posix.normalize(configured).replace(/\/+$/u, '').toLowerCase();
  if (
    !configured ||
    !active ||
    configured.includes('\\') ||
    /\p{Cc}/u.test(configured) ||
    /^[a-z]:/i.test(configured) ||
    posix.isAbsolute(configured) ||
    active === '.' ||
    active === '..' ||
    active.startsWith('../')
  )
    throw new DomainError('conflict');
  const selected = [active, `${active}_nether`, `${active}_the_end`];
  return selected.some(
    (path) => path === target.toLowerCase() || path.startsWith(`${target.toLowerCase()}/`),
  );
}

/** One authorized metadata scope per world preflight. The durable effect checks
 * current authority again after local staging, before any provider mutation. */
function worldFileScope(context: GameLifecycleContext): FilemanReadService {
  const hosted = context.fileman?.readScope?.();
  if (hosted) return hosted;
  let authorized: Promise<void> | undefined;
  return createFilemanReadService({
    adapter: context.adapter,
    identifier: context.server.pterodactyl_identifier ?? '',
    authorize: () => (authorized ??= context.authorize()),
    timing: context.timing?.child('files'),
  });
}

async function prepareWorldRoot(files: FilemanReadService) {
  // Ticket preparation touches no file bytes and reuses an existing valid ticket.
  // The caller still validates metadata before reading server.properties.
  const [root, prepared] = await Promise.allSettled([
    files.list(''),
    files.prepare(['server.properties']),
  ]);
  if (root.status === 'rejected') throw root.reason;
  if (prepared.status === 'rejected') throw prepared.reason;
  return root.value;
}

interface WorldFileScope {
  files: FilemanReadService;
  entries: readonly FilemanEntry[];
}
async function prepareWorldFiles(context: GameLifecycleContext): Promise<WorldFileScope> {
  const files = worldFileScope(context);
  return { files, entries: await prepareWorldRoot(files) };
}

function worldDirectoryEntry(entries: readonly FilemanEntry[], target: string) {
  const matches = entries.filter((entry) => entry.name.toLowerCase() === target.toLowerCase());
  if (
    matches.length > 1 ||
    matches.some((entry) => entry.name !== target || entry.kind !== 'directory')
  )
    throw new DomainError('conflict');
  return matches[0];
}

/** A world-folder removal is one acknowledged provider effect. It does not
 * reinstall/configure Minecraft, so it needs no binary/EULA/level.dat audit. */
export async function applyMinecraftWorldRemoval(
  context: GameLifecycleContext,
  target: string,
  options: { backupBefore: boolean },
): Promise<boolean> {
  minecraftWorldName(target);
  const step = stepId('remove', target);
  if (await completed(context, step)) return true;
  const operation = context.operation();
  if (operation.phase === step && operation.effect_state === 'confirmed') {
    // The provider acknowledged deletion before a crash could persist job_steps.
    // A recreated folder must never be removed by replaying that successful job.
    await complete(context, step);
    return true;
  }
  if (uncertainEffect(context, step)) {
    // A missing target proves the ambiguous delete took effect. Otherwise leave
    // recovery uncertain, even if the current folder looks like the original.
    if (await remoteEntry(context, target)) throw new DomainError('operation_uncertain');
    await complete(context, step);
    return true;
  }
  const pinnedRemoval = context.operation().plan.fileDirectoryRemoval !== undefined;
  if (pinnedRemoval && !context.fileman?.removeDirectory)
    throw new DomainError('operation_uncertain');
  if (
    !options.backupBefore &&
    context.fileman?.removeDirectory &&
    (pinnedRemoval ||
      (await supportsProviderFileOperations(
        context.adapter,
        context.server.pterodactyl_identifier ?? '',
      )))
  ) {
    await context.fileman.removeDirectory({
      target,
      guardFile: 'server.properties',
      validateGuard(contents) {
        const configured = parseMinecraftProperties(contents)['level-name'] ?? 'world';
        if (targetsConfiguredMinecraftWorld(configured, target)) fail('minecraft_world_selected');
      },
    });
    await complete(context, step);
    return true;
  }
  async function assertInactiveTarget() {
    const { files, entries } = await prepareWorldFiles(context);
    if (!worldDirectoryEntry(entries, target)) throw new DomainError('not_found');
    const properties = entries.filter((entry) => entry.name.toLowerCase() === 'server.properties');
    if (
      properties.length !== 1 ||
      properties[0]?.name !== 'server.properties' ||
      properties[0]?.kind !== 'file' ||
      properties[0].size > 1024 ** 2
    )
      throw new DomainError('conflict');
    const bytes = await files.read({ path: 'server.properties', maxBytes: 1024 ** 2 });
    if (!bytes) throw new DomainError('not_found');
    const configured =
      parseMinecraftProperties(Buffer.from(bytes).toString('utf8'))['level-name'] ?? 'world';
    if (targetsConfiguredMinecraftWorld(configured, target)) fail('minecraft_world_selected');
  }
  if (options.backupBefore && context.operation().plan.backupComplete !== true) {
    await context.assertStopped();
    await assertInactiveTarget();
    if (!(await context.backup())) return false;
  }
  await assertInactiveTarget();
  await context.effect(step, async () => {
    if (options.backupBefore) await context.assertStopped();
    // The enclosing durable effect performs the final authorization and managed
    // identity check after preparation, before dispatching this single mutation.
    await context.adapter.deleteFiles(context.server.pterodactyl_identifier ?? '', '', [target]);
  });
  await complete(context, step);
  return true;
}

async function installContentFile(
  context: GameLifecycleContext,
  options: MinecraftContentOptions,
  file: { path: string; size: number; sha256: string },
  localPath: string,
  previousSha256?: string,
  worldRoot?: string,
  assertWritable = context.assertStopped,
) {
  if (worldRoot) {
    safeArchivePath(file.path);
    if (!file.path.startsWith(`${minecraftWorldName(worldRoot)}/`))
      throw new DomainError('validation_failed');
  } else safeContentPath(file.path);
  const step = stepId('install', file.path);
  const current = await hashMinecraftRemoteFile(context, file.path);
  if (current?.sha256 === file.sha256 && current.size === file.size) {
    // A successful destination hash cannot prove that an interrupted Wings
    // multipart ingestion has released temporary resources.
    const claim = await context.db
      .selectFrom('upload_ingestion_claims')
      .select('id')
      .where('server_id', '=', context.server.id)
      .executeTakeFirst();
    if (claim) throw new DomainError('operation_uncertain');
    await complete(context, step);
    return;
  }
  if ((await completed(context, step)) || uncertainEffect(context, step))
    throw new DomainError('operation_uncertain');
  if (current && current.sha256 !== previousSha256) throw new DomainError('conflict');
  const stat = await lstat(localPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size)
    throw new DomainError('conflict');
  const localHash = createHash('sha256');
  for await (const chunk of createReadStream(localPath)) localHash.update(chunk);
  if (localHash.digest('hex') !== file.sha256) throw new DomainError('conflict');
  await ensureRemoteDirectory(context, file.path, assertWritable);
  await context.effect(step, async () => {
    await assertWritable();
    const actor = await options.authorizeJob(
      context.db,
      context.operation().job_id,
      context.server.id,
    );
    const latest = await hashMinecraftRemoteFile(context, file.path);
    if ((latest?.sha256 ?? null) !== (current?.sha256 ?? null)) throw new DomainError('conflict');
    const claim = await reserveUploadIngestion(
      context.db,
      actor,
      context.server.id,
      file.size,
      options.env,
      { operationId: context.operation().job_id },
    );
    try {
      await context.adapter.uploadFile(context.server.pterodactyl_identifier ?? '', file.path, {
        body: Readable.toWeb(createReadStream(localPath)) as ReadableStream<Uint8Array>,
        contentLength: file.size,
        maxBytes: file.size,
        authorize: async () => {
          await context.authorize();
          await assertWritable();
        },
      });
      const actual = await hashMinecraftRemoteFile(context, file.path);
      if (!actual || actual.sha256 !== file.sha256 || actual.size !== file.size)
        throw new DomainError('operation_uncertain');
      await claim.complete();
    } finally {
      await claim.unlock();
    }
  });
  await complete(context, step);
  await context.event('minecraft.content.file_verified', {
    path: file.path,
    sha256: file.sha256,
    size: file.size,
  });
}
const inventorySchema = z
  .object({
    path: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    projectId: z.string().optional(),
    versionId: z.string().optional(),
    provider: z.enum(['modrinth', 'curseforge']).optional(),
    dependencies: z.array(z.string()).optional(),
    incompatible: z.array(incompatibleContentSchema).optional(),
  })
  .passthrough();
const pendingContentSchema = z
  .object({
    jobId: z.uuid(),
    kind: z.enum(['content', 'world']),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/),
    filemanTransfer: z
      .object({
        id: z.string(),
        destinationRoot: z.string(),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    files: z
      .array(
        z.object({
          path: z.string(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          size: z.number().int().nonnegative(),
        }),
      )
      .max(20000),
    absentPaths: z.array(z.string()).max(20000),
    wipes: z.array(z.object({ jobId: z.uuid(), path: z.string() })).max(1000),
    inventory: z.array(inventorySchema).max(20000),
    removeInventoryPaths: z.array(z.string()).max(20000),
    changes: z
      .object({
        removePaths: z.array(z.string()),
        replacements: z.array(z.object({ path: z.string(), previousSha256: z.string() })),
      })
      .optional(),
  })
  .strict();
type PendingContent = z.infer<typeof pendingContentSchema>;
async function pendingContent(context: GameLifecycleContext): Promise<PendingContent | undefined> {
  const row = await context.db
    .selectFrom('minecraft_server_profiles')
    .select('content_state')
    .where('server_id', '=', context.server.id)
    .executeTakeFirstOrThrow();
  return pendingContentState(row.content_state);
}
function pendingContentState(state: unknown): PendingContent | undefined {
  if (state && typeof state === 'object' && Object.keys(state).length === 0) return undefined;
  return pendingContentSchema.parse(state);
}
async function beginContent(
  context: GameLifecycleContext,
  state: Omit<PendingContent, 'jobId'>,
  assertWritable = context.assertStopped,
  preserveInstallation = false,
) {
  const previous = await pendingContent(context);
  if (previous?.jobId === context.operation().job_id) return;
  await context.authorize();
  if (assertWritable !== context.authorize) await assertWritable();
  await context.db
    .updateTable('minecraft_server_profiles')
    .set({
      ...(preserveInstallation ? {} : { installed: false }),
      content_state: JSON.stringify({ ...state, jobId: context.operation().job_id }),
      updated_at: new Date(),
    })
    .where('server_id', '=', context.server.id)
    .execute();
}
/** Only the entire recorded manifest, removals and pre-wipe proofs can remove a partial-install fence. */
export async function verifyMinecraftPendingContent(context: GameLifecycleContext): Promise<void> {
  const pending = await pendingContent(context);
  if (!pending) return;
  let transferConfirmed = false;
  if (pending.filemanTransfer && pending.jobId === context.operation().job_id) {
    const digest = filemanTransferDigest({
      id: pending.filemanTransfer.id,
      destinationRoot: pending.filemanTransfer.destinationRoot,
      files: pending.files,
    });
    if (digest !== pending.filemanTransfer.digest) throw new DomainError('conflict');
    transferConfirmed = Boolean(
      await context.db
        .selectFrom('job_steps')
        .select('step')
        .where('job_id', '=', pending.jobId)
        .where('step', '=', filemanTransferReceiptStep(digest))
        .executeTakeFirst(),
    );
    if (!transferConfirmed) throw new DomainError('operation_uncertain');
  }
  for (const file of transferConfirmed ? [] : pending.files) {
    const actual = await hashMinecraftRemoteFile(context, file.path);
    if (!actual || actual.sha256 !== file.sha256 || actual.size !== file.size)
      throw new DomainError('operation_uncertain');
  }
  for (const path of pending.absentPaths)
    if (await remoteEntry(context, path)) throw new DomainError('operation_uncertain');
  for (const wipe of pending.wipes) {
    const proof = await context.db
      .selectFrom('job_steps')
      .select('step')
      .where('job_id', '=', wipe.jobId)
      .where('step', '=', stepId('remove', wipe.path))
      .executeTakeFirst();
    if (!proof) throw new DomainError('operation_uncertain');
  }
  // A confirmed world transfer only writes below its destination directory.
  // Installation owns EULA verification; importing an inactive world cannot alter it.
  if (
    !(transferConfirmed && pending.kind === 'world') &&
    parseMinecraftProperties(await textFile(context, 'eula.txt', '')).eula !== 'true'
  )
    throw new DomainError('operation_uncertain');
  await context.db.transaction().execute(async (tx) => {
    for (const path of pending.removeInventoryPaths)
      await tx
        .deleteFrom('minecraft_content_items')
        .where('server_id', '=', context.server.id)
        .where('path', '=', path)
        .execute();
    for (const file of pending.inventory)
      await tx
        .insertInto('minecraft_content_items')
        .values({
          server_id: context.server.id,
          path: file.path,
          artifact: JSON.stringify(file),
          installed_by: pending.jobId,
        })
        .onConflict((c) =>
          c.columns(['server_id', 'path']).doUpdateSet({
            artifact: JSON.stringify(file),
            installed_by: pending.jobId,
            installed_at: new Date(),
          }),
        )
        .execute();
    const profile = await tx
      .selectFrom('minecraft_server_profiles')
      .select('configuration_state')
      .where('server_id', '=', context.server.id)
      .executeTakeFirstOrThrow();
    await tx
      .updateTable('minecraft_server_profiles')
      .set({
        installed: !initialConfiguration(profile.configuration_state),
        content_state: '{}',
        updated_at: new Date(),
      })
      .where('server_id', '=', context.server.id)
      .execute();
  });
}
async function inventory(context: GameLifecycleContext): Promise<InstalledContentFile[]> {
  const rows = await context.db
    .selectFrom('minecraft_content_items')
    .selectAll()
    .where('server_id', '=', context.server.id)
    .execute();
  return rows.map((row) =>
    inventorySchema.parse({ ...(row.artifact as Record<string, unknown>), path: row.path }),
  );
}
async function applyPreparedContent(
  context: GameLifecycleContext,
  options: MinecraftContentOptions,
  prepared: MinecraftPreparedContent,
): Promise<boolean> {
  const profile = await measureContent(context, 'profile.read', () =>
    context.db
      .selectFrom('minecraft_server_profiles')
      .selectAll()
      .where('server_id', '=', context.server.id)
      .executeTakeFirstOrThrow(),
  );
  if (profile.combination_id !== prepared.combinationId) throw new DomainError('conflict');
  const choice = await measureContent(context, 'combination.inspect', () =>
    inspectMinecraftCombination(context.db, profile.combination_id, options.env),
  );
  const command = minecraftContentCommandSchema.parse(prepared.command);
  await context.authorize();
  if (!minecraftContentAllowsOnline(prepared) && !minecraftContentSelectsWorld(prepared))
    await context.assertStopped();
  const selectionStep = stepId('modpack-selection', minecraftDigest(prepared));
  assertMinecraftModpackTransition(
    minecraftStoredConfigurationSchema.parse(profile.configuration).modpack,
    prepared,
    command.kind === 'world-select' ? false : await completed(context, selectionStep),
  );
  let verifiedWorldArchive: ContentFileVerification | undefined;
  let worldFiles: WorldFileScope | undefined;
  if (prepared.archivePath) {
    if (!prepared.archiveRef) throw new DomainError('configuration_invalid');
    const actor = await options.authorizeJob(
      context.db,
      context.operation().job_id,
      context.server.id,
    );
    const sources = createMinecraftSourceStore(context.db, actor, options.env, {
      authorize: (connection) =>
        options.authorizeJob(connection, context.operation().job_id, context.server.id),
    });
    let source: { path: string; sha256?: string; verified?: ContentFileVerification };
    if (command.kind === 'world-import') {
      // Source verification uses local bytes; root/ticket reads use the provider.
      // Settle both before staging so neither outlives a failed preflight.
      const [resolved, scoped] = await Promise.allSettled([
        sources.worldArchiveResolver(prepared.archiveRef, context.server.id),
        prepareWorldFiles(context),
      ]);
      if (resolved.status === 'rejected') throw resolved.reason;
      if (scoped.status === 'rejected') throw scoped.reason;
      source = resolved.value;
      worldFiles = scoped.value;
    } else source = { path: await sources.archiveResolver(prepared.archiveRef, context.server.id) };
    if (
      source.path !== prepared.archivePath ||
      ('sha256' in source && source.sha256 !== prepared.archiveSha256)
    )
      throw new DomainError('conflict');
    if ('verified' in source) verifiedWorldArchive = source.verified;
  }
  if (command.kind === 'verify') return verifyMinecraftRestore(context, options);
  if (
    initialConfiguration(profile.configuration_state) &&
    !['provision', 'reinstall', 'wipe'].includes(context.operation().action)
  )
    throw new DomainError('operation_uncertain');
  const editsInstalledData =
    profile.installed &&
    ['properties', 'player', 'world-import', 'world-select', 'world-remove'].includes(command.kind);
  if (editsInstalledData) {
    // These operations cannot change the runtime. Installation already proved
    // its bytes; the lifecycle still corroborates provider ownership per effect.
    if (
      choice.row.mapping_id !== context.server.mapping_id ||
      choice.mappingDigest !== choice.row.mapping_digest
    )
      throw new DomainError('provenance_mismatch');
  } else await verifyInstalledRuntime(context, options);
  const pending =
    command.kind === 'world-select'
      ? pendingContentState(profile.content_state)
      : await measureContent(context, 'pending.read', () => pendingContent(context));
  if (
    pending &&
    pending.jobId !== context.operation().job_id &&
    pending.planDigest !== prepared.planDigest
  ) {
    const replace = 'replace' in command ? command.replace : undefined;
    if (!replace?.wipeConsent || !prepared.deletePaths)
      throw new DomainError('operation_uncertain');
    for (const path of [...pending.files.map((file) => file.path), ...pending.absentPaths]) {
      const covered = prepared.deletePaths.some(
        (directory) => path === directory || path.startsWith(`${directory}/`),
      );
      if (!covered && (await remoteEntry(context, path)))
        throw new DomainError('operation_uncertain');
    }
  }
  if (
    pending &&
    ['properties', 'player', 'world-select', 'world-remove', 'remove'].includes(command.kind) &&
    pending.jobId !== context.operation().job_id
  )
    throw new DomainError('operation_uncertain');
  if (
    command.kind === 'world-import' ||
    command.kind === 'world-select' ||
    command.kind === 'world-remove'
  )
    return applyWorldContent(
      context,
      options,
      prepared,
      choice,
      profile.installed_manifest,
      pending,
      verifiedWorldArchive,
      worldFiles,
    );
  if (
    command.kind === 'player' &&
    choice.supportAuthority === 'integration' &&
    !choice.capabilities.playerManagement
  )
    throw new DomainError('integration_unavailable');
  if (command.kind === 'properties' || command.kind === 'player') {
    let configuration = minecraftStoredConfigurationSchema.parse(profile.configuration);
    if (
      command.kind === 'player' &&
      !configuration.playerIdentities &&
      (configuration.operators.length || configuration.whitelist.length)
    )
      throw new DomainError('configuration_invalid');
    if (command.kind === 'player' && context.operation().plan.minecraftText !== undefined)
      await recoverMinecraftPlayerReceipt(context, options, command);
    await applyTextPlan(
      context,
      async (files) => {
        if (command.kind === 'properties') {
          const snapshot = await textSnapshot(context, 'server.properties', '', files);
          const source = snapshot.content;
          const result = editMinecraftProperties(source, command.changes, {
            release: choice.combination.release,
            supportedKeys: Object.keys(parseMinecraftProperties(source)),
          });
          return [await plannedText(context, 'server.properties', result.content, snapshot.hash)];
        }
        const path = command.list === 'operators' ? 'ops.json' : 'whitelist.json';
        const snapshot = await textSnapshot(context, path, '[]', files);
        const player = await resolveMinecraftPlayerChangeIdentity(
          command,
          snapshot.content,
          options.identityProvider ??
            createMinecraftIdentityProvider({ userAgent: options.userAgent }),
        );
        const currentList = JSON.parse(snapshot.content) as {
          uuid?: string;
          level?: number;
          bypassesPlayerLimit?: boolean;
        }[];
        const currentEntry = Array.isArray(currentList)
          ? currentList.find((entry) => entry.uuid === player.uuid)
          : undefined;
        const storedEntry = configuration.playerIdentities?.[command.list].find(
          (entry) => entry.uuid === player.uuid,
        );
        const storedPlayer = minecraftStoredPlayerSchema.parse({
          ...player,
          ...(command.list === 'operators'
            ? {
                level: command.operatorLevel ?? storedEntry?.level ?? currentEntry?.level ?? 4,
                bypassesPlayerLimit:
                  command.bypassesPlayerLimit ??
                  storedEntry?.bypassesPlayerLimit ??
                  currentEntry?.bypassesPlayerLimit ??
                  false,
              }
            : {}),
        });
        await context.update({
          plan: { ...context.operation().plan, minecraftPlayerChange: storedPlayer },
        });
        const result = planMinecraftPlayerList(
          snapshot.content,
          command.list,
          command.action,
          player,
          {
            operatorLevel: storedPlayer.level,
            bypassesPlayerLimit: storedPlayer.bypassesPlayerLimit,
          },
        );
        return [await plannedText(context, path, result.content, snapshot.hash)];
      },
      async () => {
        if (command.kind !== 'player') return;
        const receipt = minecraftStoredPlayerSchema.safeParse(
          context.operation().plan.minecraftPlayerChange,
        );
        if (
          !receipt.success ||
          (command.expectedUuid !== undefined &&
            (receipt.data.uuid !== command.expectedUuid || receipt.data.name !== command.name)) ||
          (command.list === 'operators' &&
            (receipt.data.level === undefined || receipt.data.bypassesPlayerLimit === undefined))
        )
          throw new DomainError('operation_uncertain');
      },
    );
    if (command.kind === 'properties')
      configuration.properties = { ...configuration.properties, ...command.changes };
    else {
      configuration = applyMinecraftStoredPlayerChange(
        configuration,
        command,
        context.operation().plan.minecraftPlayerChange,
      );
    }
    await context.db
      .updateTable('minecraft_server_profiles')
      .set({ configuration: JSON.stringify(configuration), updated_at: new Date() })
      .where('server_id', '=', context.server.id)
      .execute();
    return true;
  }
  const existing = await inventory(context);
  if (command.kind === 'remove') {
    const previous = context.operation().plan.minecraftRemoval;
    const changes =
      previous === undefined
        ? installedContentChange(existing, { remove: command })
        : z
            .object({
              removePaths: z.array(z.string()),
              replacements: z.array(z.object({ path: z.string(), previousSha256: z.string() })),
            })
            .parse(previous);
    if (previous === undefined)
      await context.update({ plan: { ...context.operation().plan, minecraftRemoval: changes } });
    await beginContent(context, {
      kind: 'content',
      planDigest: minecraftDigest(command),
      files: [],
      absentPaths: changes.removePaths,
      wipes: [],
      inventory: [],
      removeInventoryPaths: changes.removePaths,
      changes,
    });
    for (const path of changes.removePaths)
      await removeContentPath(
        context,
        path,
        changes.replacements.find((entry) => entry.path === path)?.previousSha256,
      );
    await context.db
      .deleteFrom('minecraft_content_items')
      .where('server_id', '=', context.server.id)
      .where('path', 'in', changes.removePaths)
      .execute();
    await verifyMinecraftPendingContent(context);
    return true;
  }
  const plan = validateContentPlan(prepared.contentPlan);
  assertMinecraftRuntimePathsPreserved(
    [...plan.artifacts, ...plan.overrides].map((file) => file.path),
    profile.installed_manifest,
  );
  assertMinecraftContentTarget(plan.target, contentTarget(choice.combination));
  if (contentPlanDigest(plan) !== prepared.planDigest) throw new DomainError('conflict');
  const jobId = context.operation().job_id;
  // A killed worker may leave a staging lock. The caller holds PostgreSQL's
  // authoritative server session lock for this exact active durable job.
  const stageOptions = {
    mountdataRoot: resolve(options.mountdataRoot),
    jobId,
    archivePath: prepared.archivePath,
    http: options.http,
  };
  const stagePath = join(stageOptions.mountdataRoot, 'content-staging', jobId, 'plan.json');
  try {
    await lstat(stagePath);
    await recoverContentStageLock({
      ...stageOptions,
      expectedPlanDigest: prepared.planDigest ?? '',
      assertExclusiveJob: context.authorize,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await reserveMinecraftStaging(
    context.db,
    await options.authorizeJob(context.db, jobId, context.server.id),
    jobId,
    context.server.id,
    [...plan.artifacts, ...plan.overrides].reduce((bytes, file) => bytes + file.size, 0),
    options.env,
  );
  const staged = await stageContent(plan, stageOptions);
  let stagedBytes = 0;
  for (const file of staged.manifest)
    if (!(await completed(context, stepId('install', file.path)))) stagedBytes += file.size;
  const usage = await context.adapter.getResources(context.server.pterodactyl_identifier ?? '');
  assertServerStorageCapacity(context.server.limits.disk, stagedBytes + usage.resources.disk_bytes);
  if (
    prepared.backupBefore &&
    context.operation().plan.backupComplete !== true &&
    !(await context.backup())
  )
    return false;
  const deletePaths = prepared.deletePaths ?? [];
  assertMinecraftRuntimePathsPreserved(deletePaths, profile.installed_manifest);
  if (deletePaths.length && !('replace' in command && command.replace?.wipeConsent))
    throw new DomainError('forbidden');
  if (
    (command.kind === 'modpack' || command.kind === 'modpack-upload') &&
    command.replace &&
    context.operation().plan.minecraftWipeValidated !== true
  ) {
    const preview = await minecraftContentWipePreview(
      context.adapter,
      context.server.pterodactyl_identifier ?? '',
    );
    if (minecraftDigest(preview) !== minecraftDigest(deletePaths))
      throw new DomainError('conflict');
    await context.update({ plan: { ...context.operation().plan, minecraftWipeValidated: true } });
  }
  const priorChanges =
    context.operation().plan.minecraftChanges ??
    (pending?.planDigest === prepared.planDigest ? pending.changes : undefined);
  const changes =
    priorChanges === undefined
      ? installedContentChange(
          existing.filter((file) => !deletePaths.some((path) => file.path.startsWith(`${path}/`))),
          plan,
        )
      : z
          .object({
            removePaths: z.array(z.string()),
            replacements: z.array(z.object({ path: z.string(), previousSha256: z.string() })),
          })
          .parse(priorChanges);
  if (priorChanges === undefined)
    await context.update({ plan: { ...context.operation().plan, minecraftChanges: changes } });
  // Verify all protected destinations and old files before the first install/delete.
  for (const file of staged.manifest) {
    if (
      (await completed(context, stepId('install', file.path))) ||
      deletePaths.some((path) => file.path.startsWith(`${path}/`))
    )
      continue;
    const current = await hashMinecraftRemoteFile(context, file.path);
    const previous = changes.replacements.find((entry) => entry.path === file.path);
    if (current && current.sha256 !== previous?.previousSha256 && current.sha256 !== file.sha256)
      throw new DomainError('conflict');
  }
  const nextInventory = staged.manifest.map((file) => {
    const source = plan.artifacts.find((entry) => entry.path === file.path);
    const project = plan.projects.find((entry) => entry.projectId === source?.projectId);
    return {
      ...file,
      ...(project
        ? {
            provider: project.provider,
            projectId: project.projectId,
            versionId: project.versionId,
            dependencies: project.dependencies,
            incompatible: project.incompatible,
          }
        : {}),
    };
  });
  const removedInventory = [
    ...changes.removePaths,
    ...existing
      .filter((file) => deletePaths.some((path) => file.path.startsWith(`${path}/`)))
      .map((file) => file.path),
  ];
  await beginContent(context, {
    kind: 'content',
    planDigest: staged.planDigest,
    files: staged.manifest,
    absentPaths: changes.removePaths,
    wipes: deletePaths.map((path) => ({ jobId, path })),
    inventory: nextInventory,
    removeInventoryPaths: removedInventory,
    changes,
  });
  for (const path of deletePaths)
    if (!(await completed(context, stepId('remove', path)))) await removeContentPath(context, path);
  if (deletePaths.length) {
    for (const file of existing)
      if (deletePaths.some((path) => file.path.startsWith(`${path}/`)))
        await context.db
          .deleteFrom('minecraft_content_items')
          .where('server_id', '=', context.server.id)
          .where('path', '=', file.path)
          .execute();
  }
  for (const file of staged.manifest) {
    await installContentFile(
      context,
      options,
      file,
      join(staged.directory, file.path),
      changes.replacements.find((entry) => entry.path === file.path)?.previousSha256,
    );
    const source = plan.artifacts.find((entry) => entry.path === file.path);
    const project = plan.projects.find((entry) => entry.projectId === source?.projectId);
    const artifact = {
      ...file,
      ...(project
        ? {
            provider: project.provider,
            projectId: project.projectId,
            versionId: project.versionId,
            dependencies: project.dependencies,
            incompatible: project.incompatible,
          }
        : {}),
    };
    await context.db
      .insertInto('minecraft_content_items')
      .values({
        server_id: context.server.id,
        path: file.path,
        artifact: JSON.stringify(artifact),
        installed_by: jobId,
      })
      .onConflict((c) =>
        c.columns(['server_id', 'path']).doUpdateSet({
          artifact: JSON.stringify(artifact),
          installed_by: jobId,
          installed_at: new Date(),
        }),
      )
      .execute();
  }
  for (const path of changes.removePaths) {
    await removeContentPath(
      context,
      path,
      changes.replacements.find((entry) => entry.path === path)?.previousSha256,
    );
    await context.db
      .deleteFrom('minecraft_content_items')
      .where('server_id', '=', context.server.id)
      .where('path', '=', path)
      .execute();
  }
  await verifyMinecraftPendingContent(context);
  await context.event('minecraft.content.verified', {
    files: staged.manifest.length,
    planDigest: staged.planDigest,
  });
  if (command.kind === 'modpack' || command.kind === 'modpack-upload') {
    await context.db.transaction().execute(async (tx) => {
      const current = await tx
        .selectFrom('minecraft_server_profiles')
        .select('configuration')
        .where('server_id', '=', context.server.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const configuration = minecraftStoredConfigurationSchema.parse(current.configuration);
      assertMinecraftModpackTransition(
        configuration.modpack,
        prepared,
        await completed({ ...context, db: tx }, selectionStep),
      );
      configuration.modpack = modpackSelection(command);
      await tx
        .updateTable('minecraft_server_profiles')
        .set({ configuration: JSON.stringify(configuration), updated_at: new Date() })
        .where('server_id', '=', context.server.id)
        .execute();
      // This exact prepared-plan receipt and selection publish atomically. A
      // crash after commit may verify the same job again without renewed wipe.
      await complete({ ...context, db: tx }, selectionStep);
    });
  }
  return true;
}
export async function processMinecraftContent(
  context: GameLifecycleContext,
  options: MinecraftContentOptions,
): Promise<boolean> {
  const prepared = context.operation().plan.minecraftContent as
    | MinecraftPreparedContent
    | undefined;
  if (!prepared) throw new DomainError('configuration_invalid');
  return applyPreparedContent(context, options, prepared);
}

export interface MinecraftWorldSnapshot {
  installed: boolean;
  supported: boolean;
  selectedWorld: string | null;
  release: string;
  compatibility: 'available' | 'unavailable';
  worlds: Awaited<ReturnType<typeof discoverMinecraftWorlds>>;
}
/** Caller establishes authorization and managed identity through ManagementRuntime.fileReadAccess. */
export async function inspectMinecraftWorlds(
  db: Kysely<Database>,
  adapter: PterodactylAdapter,
  serverId: string,
  authorize: () => Promise<void>,
  env: Environment = {},
  signal?: AbortSignal,
  fileman?: FilemanReadService,
  preparation?: MinecraftContentOptions['worldPreparation'],
): Promise<MinecraftWorldSnapshot> {
  const profile = await db
    .selectFrom('minecraft_server_profiles')
    .selectAll()
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  const server = await db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!profile || !server) throw new DomainError('not_found');
  if (!server.pterodactyl_identifier) throw new DomainError('conflict');
  const choice = await inspectMinecraftCombination(db, profile.combination_id, env);
  const expectedDataVersion = minecraftWorldDataVersion(choice.combination.release);
  const snapshot: MinecraftWorldSnapshot = {
    installed: profile.installed,
    supported: minecraftManifest.capabilities.worlds,
    selectedWorld: null,
    release: choice.combination.release,
    compatibility: expectedDataVersion === undefined ? 'unavailable' : 'available',
    worlds: [],
  };
  if (!snapshot.installed || !snapshot.supported) {
    await preparation?.invalidate(server, profile.combination_id);
    return snapshot;
  }
  signal?.throwIfAborted();
  const files =
    fileman ??
    createFilemanReadService({
      adapter,
      identifier: server.pterodactyl_identifier,
      authorize,
      signal,
    });
  const [propertiesBytes, root] = await Promise.all([
    files.read({ path: 'server.properties', maxBytes: 1048576 }),
    files.list(''),
  ]);
  if (!propertiesBytes) throw new DomainError('not_found');
  const properties = parseMinecraftProperties(Buffer.from(propertiesBytes).toString('utf8'));
  // Preserve the observed value, including legacy names that managed mutations cannot accept.
  snapshot.selectedWorld = properties['level-name'] ?? 'world';
  const directories = new Map<string, FilemanDirectoryResult>();
  snapshot.worlds = await discoverMinecraftWorlds(
    {
      listRoot: async () => {
        // The same candidates as discovery, bounded before any remote fan-out.
        const candidates = root.filter((entry) => {
          if (entry.kind !== 'directory') return false;
          try {
            minecraftWorldName(entry.name);
            return true;
          } catch {
            return false;
          }
        });
        if (candidates.length > 100) throw new DomainError('validation_failed');
        if (candidates.length) {
          const results = await files.listMany(candidates.map(({ name }) => name));
          const paths: string[] = [];
          for (const result of results) {
            directories.set(result.directory, result);
            if (
              'files' in result &&
              result.files.some(
                (entry) =>
                  entry.name === 'level.dat' &&
                  entry.kind === 'file' &&
                  entry.size <= 8 * 1024 ** 2,
              )
            )
              paths.push(`${result.directory}/level.dat`);
          }
          if (paths.length) await files.prepare(paths);
        }
        return root.map((entry) => ({
          name: entry.name,
          isDirectory: entry.kind === 'directory',
          isSymlink: entry.kind === 'symlink',
        }));
      },
      readLevelDat: async (world, maxBytes) => {
        const directory = directories.get(world);
        if (!directory || 'error' in directory) {
          if (directory && 'error' in directory && directory.error === 'not_found')
            return undefined;
          throw new DomainError(
            directory && 'error' in directory && directory.error === 'forbidden'
              ? 'forbidden'
              : 'integration_unavailable',
          );
        }
        const level = directory.files.find((entry) => entry.name === 'level.dat');
        if (!level) return undefined;
        if (level.kind !== 'file' || level.size > maxBytes) throw new DomainError('conflict');
        return files.read({ path: `${world}/level.dat`, maxBytes });
      },
    },
    { expectedDataVersion, release: choice.combination.release, signal },
  );
  await authorize();
  // Reuse the root already inspected, including the fixed configuration file's
  // case/type guard. No later selection needs another directory listing.
  const propertiesEntries = root.filter(
    (entry) => entry.name.toLowerCase() === 'server.properties',
  );
  if (
    propertiesEntries.length === 1 &&
    propertiesEntries[0]?.name === 'server.properties' &&
    propertiesEntries[0].kind === 'file' &&
    propertiesEntries[0].size <= 1048576
  ) {
    await preparation?.save(server, profile.combination_id, {
      worlds: snapshot.worlds,
      properties: {
        content: Buffer.from(propertiesBytes).toString('utf8'),
        hash: sha256(propertiesBytes),
      },
    });
  } else await preparation?.invalidate(server, profile.combination_id);
  return snapshot;
}
/** Array contract retained for trusted integration scripts. */
export async function listMinecraftWorlds(
  db: Kysely<Database>,
  adapter: PterodactylAdapter,
  serverId: string,
  authorize: () => Promise<void>,
  env: Environment = {},
) {
  return (await inspectMinecraftWorlds(db, adapter, serverId, authorize, env)).worlds;
}
async function applyWorldContent(
  context: GameLifecycleContext,
  options: MinecraftContentOptions,
  prepared: MinecraftPreparedContent,
  choice: Awaited<ReturnType<typeof inspectMinecraftCombination>>,
  installedManifest: unknown,
  pending?: PendingContent,
  verifiedArchive?: ContentFileVerification,
  preparedFiles?: WorldFileScope,
): Promise<boolean> {
  const command = prepared.command;
  if (
    command.kind !== 'world-import' &&
    command.kind !== 'world-select' &&
    command.kind !== 'world-remove'
  )
    throw new DomainError('validation_failed');
  const target = minecraftWorldName(
    command.kind === 'world-import' ? command.targetWorld : command.world,
  );
  if (
    !prepared.world ||
    prepared.world.dataVersion !== minecraftWorldDataVersion(choice.combination.release)
  )
    throw new DomainError('conflict');
  assertMinecraftRuntimePathsPreserved([target], installedManifest);
  if (command.kind === 'world-select') {
    if (prepared.world.dataVersion === undefined) throw new DomainError('integration_unavailable');
    const files = worldFileScope(context);
    if (prepared.world.observation) {
      const observation = prepared.world.observation;
      if (observation.name !== target) throw new DomainError('conflict');
      // Overlap fresh provider bytes with local intent construction/persistence.
      // Persisted plans and uncertain effects retain their fresh recovery reads.
      const comparison =
        context.operation().plan.minecraftText === undefined &&
        context.operation().effect_state === 'none'
          ? measureContent(context, 'text.compare', () =>
              readTextSnapshot(context, 'server.properties', files, true),
            )
          : undefined;
      // The read may reject while local preparation is still running. Observe it
      // immediately, then await its actual result before an effect or on failure.
      void comparison?.catch(() => {});
      try {
        await applyTextPlan(
          context,
          async () => {
            const cached = await options.worldPreparation?.read(
              context.server,
              prepared.combinationId,
            );
            const snapshot =
              cached?.properties ??
              (await (comparison ?? readTextSnapshot(context, 'server.properties', files, true)));
            if (!snapshot) throw new DomainError('not_found');
            const selected = planMinecraftWorldSelection(
              snapshot.content,
              {
                name: target,
                verifiedDataVersion: observation.dataVersion,
                sha256: observation.sha256,
              },
              { allowedDataVersions: [prepared.world?.dataVersion ?? -1] },
            );
            return [
              await plannedText(context, 'server.properties', selected.content, snapshot.hash),
            ];
          },
          undefined,
          files,
          true,
          comparison,
        );
      } finally {
        await comparison?.catch(() => {});
      }
      const changes = z
        .array(textChangeSchema)
        .max(4)
        .parse(context.operation().plan.minecraftText);
      const change = changes.find((item) => item.path === 'server.properties');
      if (change)
        await options.worldPreparation?.updateProperties(
          context.server,
          prepared.combinationId,
          change.beforeSha256,
          change.content,
        );
      return true;
    }
    const [directories, tickets] = await measureContent(context, 'world.prepare', () =>
      Promise.allSettled([
        files.listMany(['', target]),
        files.prepare(['server.properties', `${target}/level.dat`]),
      ]),
    );
    if (directories.status === 'rejected') throw directories.reason;
    if (tickets.status === 'rejected') throw tickets.reason;
    for (const result of directories.value) {
      if ('error' in result)
        throw new DomainError(
          result.error === 'not_found'
            ? 'not_found'
            : result.error === 'forbidden'
              ? 'forbidden'
              : 'integration_unavailable',
        );
    }
    const root = await files.list('');
    if (!worldDirectoryEntry(root, target)) throw new DomainError('not_found');
    const level = (await files.list(target)).filter(
      (entry) => entry.name.toLowerCase() === 'level.dat',
    );
    if (
      level.length !== 1 ||
      level[0]?.name !== 'level.dat' ||
      level[0].kind !== 'file' ||
      level[0].size < 1 ||
      level[0].size > 8 * 1024 ** 2
    )
      throw new DomainError('conflict');
    const levelSize = level[0].size;
    const [bytes, snapshot] = await Promise.all([
      measureContent(context, 'world.levelRead', () =>
        files.read({ path: `${target}/level.dat`, maxBytes: levelSize }),
      ),
      measureContent(context, 'world.propertiesRead', () =>
        textSnapshot(context, 'server.properties', '', files),
      ),
    ]);
    if (!bytes) throw new DomainError('not_found');
    const dataVersion = prepared.world.dataVersion;
    const validateLevel = () =>
      validateMinecraftLevelDat(bytes, dataVersion, {
        release: choice.combination.release,
      });
    const validation = context.timing
      ? context.timing.measureSync('minecraft.world.validate', validateLevel)
      : validateLevel();
    await applyTextPlan(
      context,
      async () => {
        const source = snapshot.content;
        const selected = planMinecraftWorldSelection(
          source,
          { name: target, verifiedDataVersion: validation.dataVersion, sha256: validation.sha256 },
          { allowedDataVersions: [prepared.world?.dataVersion ?? -1] },
        );
        return [await plannedText(context, 'server.properties', selected.content, snapshot.hash)];
      },
      undefined,
      files,
    );
    return true;
  }
  if (command.kind === 'world-remove') {
    if (
      !(await applyMinecraftWorldRemoval(context, target, { backupBefore: prepared.backupBefore }))
    )
      return false;
    // Upgrade compatibility: a job started by the previous implementation may
    // already have an installation fence. New removals never create one.
    if (pending) await verifyMinecraftPendingContent(context);
    return true;
  }
  const onlineImport = minecraftContentAllowsOnline(prepared);
  const { files, entries: rootEntries } = preparedFiles ?? (await prepareWorldFiles(context));
  const originalTarget = worldDirectoryEntry(rootEntries, target);
  if (
    context.operation().plan.minecraftWorldPrepared !== true &&
    context.operation().plan.fileArchive === undefined
  ) {
    if (Boolean(originalTarget) !== prepared.world.existing) throw new DomainError('conflict');
    planMinecraftWorldReplacement(target, Boolean(originalTarget), command.replace);
  }
  if (!prepared.archivePath || !prepared.world.archiveSha256)
    throw new DomainError('configuration_invalid');
  const stageOptions = {
    mountdataRoot: resolve(options.mountdataRoot),
    sourceRoot: options.sourceRoot,
    jobId: context.operation().job_id,
    targetWorld: target,
    release: choice.combination.release,
    expectedDataVersion: prepared.world.dataVersion,
    archiveSha256: prepared.world.archiveSha256,
  };
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        archiveSha256: stageOptions.archiveSha256,
        targetWorld: target,
        release: stageOptions.release,
        expectedDataVersion: stageOptions.expectedDataVersion,
      }),
    )
    .digest('hex');
  const archivePath = prepared.archivePath;
  const preparedWorld = prepared.world;
  // Additive imports transfer one normalized compressed archive. Replacement
  // retains its existing offline/backup recovery path and never borrows this path.
  const pinnedArchive = context.operation().plan.fileArchive !== undefined;
  if (pinnedArchive && (!verifiedArchive || !context.fileman?.uploadArchive))
    throw new DomainError('operation_uncertain');
  const tryArchiveTransfer = async () => {
    if (
      verifiedArchive &&
      context.fileman?.uploadArchive &&
      !preparedWorld.existing &&
      !prepared.backupBefore &&
      (pinnedArchive ||
        (await supportsProviderFileOperations(
          context.adapter,
          context.server.pterodactyl_identifier ?? '',
        )))
    ) {
      const [selected, snapshot] = await Promise.all([
        inspectMinecraftWorldTransfer(archivePath, { targetWorld: target, verifiedArchive }),
        readTextSnapshot(context, 'server.properties', files),
      ]);
      if (!snapshot) throw new DomainError('not_found');
      const configured = parseMinecraftProperties(snapshot.content)['level-name'] ?? 'world';
      if (targetsConfiguredMinecraftWorld(configured, target)) {
        if (pinnedArchive) throw new DomainError('conflict');
        return false; // Existing offline/compatible active-world workflow.
      }
      // Large ZIP64/manifest transfers retain the existing bounded staging path.
      if (
        selected.mappings.length > 10000 ||
        Buffer.byteLength(JSON.stringify(selected.mappings)) > 3 * 1024 ** 2
      ) {
        if (pinnedArchive) throw new DomainError('operation_uncertain');
        return false;
      }
      let stream: Awaited<ReturnType<typeof prepareArchiveTransfer>>;
      try {
        stream = await prepareArchiveTransfer(archivePath, selected.mappings, {
          verification: verifiedArchive,
        });
      } catch (error) {
        if (
          !pinnedArchive &&
          error instanceof DomainError &&
          error.details?.contentReason === 'archive_zip64'
        )
          return false;
        throw error;
      }
      try {
        const transfer = await context.fileman.uploadArchive({
          id: 'minecraft.world-import',
          destinationRoot: target,
          sourceSha256: stageOptions.archiveSha256,
          files: stream.files,
          contentLength: stream.contentLength,
          open: () => stream.open(),
          completion: stream.completion,
          cancel: (reason) => stream.cancel(reason),
          beforePublish: async (manifest) => {
            // This small current configuration read is the game's only publication
            // precondition; archive bytes/paths/admission belong to shared Fileman.
            const current = await worldFileScope(context).read({
              path: 'server.properties',
              maxBytes: 1024 ** 2,
            });
            if (
              !current ||
              targetsConfiguredMinecraftWorld(
                parseMinecraftProperties(Buffer.from(current).toString('utf8'))['level-name'] ??
                  'world',
                target,
              )
            )
              throw new DomainError('conflict');
            await beginContent(
              context,
              {
                kind: 'world',
                planDigest: digest,
                filemanTransfer: {
                  id: manifest.id,
                  destinationRoot: target,
                  digest: filemanTransferDigest(manifest),
                },
                files: manifest.files,
                absentPaths: [],
                wipes: [],
                inventory: [],
                removeInventoryPaths: [],
              },
              context.authorize,
              true,
            );
          },
        });
        await verifyMinecraftPendingContent(context);
        await context.event('minecraft.world.imported', {
          world: target,
          files: transfer.files,
          levelDatSha256: selected.validation.sha256,
        });
        return true;
      } finally {
        stream.cancel();
      }
    }
    return false;
  };
  if (await tryArchiveTransfer()) return true;
  const stage = async () => {
    try {
      await lstat(
        join(stageOptions.mountdataRoot, 'world-staging', stageOptions.jobId, 'plan.json'),
      );
      await recoverMinecraftWorldStageLock({
        ...stageOptions,
        expectedPlanDigest: digest,
        assertExclusiveJob: context.authorize,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return stageMinecraftWorld(archivePath, {
      ...stageOptions,
      verifiedArchive,
      // Count/reserve once from the validated inventory, before extracting files.
      reserve: async (expandedBytes) => {
        await reserveMinecraftStaging(
          context.db,
          await options.authorizeJob(context.db, stageOptions.jobId, context.server.id),
          stageOptions.jobId,
          context.server.id,
          expandedBytes,
          options.env,
        );
      },
    });
  };
  // The root already guards the properties path. Read its small payload while
  // preparing the independent local archive, settling both before any effect.
  const [propertiesResult, stageResult] = await Promise.allSettled([
    readTextSnapshot(context, 'server.properties', files),
    stage(),
  ]);
  if (propertiesResult.status === 'rejected') throw propertiesResult.reason;
  if (stageResult.status === 'rejected') throw stageResult.reason;
  if (propertiesResult.value === null) throw new DomainError('not_found');
  const properties = parseMinecraftProperties(propertiesResult.value.content);
  const activeTarget = targetsConfiguredMinecraftWorld(properties['level-name'] ?? 'world', target);
  // Even a missing folder is the running world's target when level-name points
  // to it; importing there would race the game's own writes.
  if (onlineImport && activeTarget) await context.assertStopped();
  const assertWritable = onlineImport && !activeTarget ? context.authorize : context.assertStopped;
  const staged = stageResult.value;
  // Replacing the selected folder would activate its data on the next start.
  // Cross-version imports belong in an inactive folder, without conversion.
  if (
    activeTarget &&
    assessMinecraftWorldCompatibility(staged.validation, {
      expectedDataVersion: prepared.world.dataVersion,
      release: choice.combination.release,
    }) !== 'verified'
  )
    fail('minecraft_world_active_version');
  if (!context.fileman) throw new DomainError('configuration_invalid');
  const transfer = {
    id: 'minecraft.world-import',
    destinationRoot: target,
    files: staged.manifest.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
  };
  // Additive online imports have no game-specific destructive preflight. Fileman
  // checks their destination after the durable effect checkpoint, immediately
  // before creation. An earlier observation must not cross that checkpoint.
  const additiveOnline =
    onlineImport && !activeTarget && !prepared.world.existing && !prepared.backupBefore;
  if (context.operation().plan.minecraftWorldPrepared !== true) {
    if (!additiveOnline) {
      const currentTarget = worldDirectoryEntry(await worldFileScope(context).list(''), target);
      if (Boolean(currentTarget) !== prepared.world.existing) throw new DomainError('conflict');
      planMinecraftWorldReplacement(target, Boolean(currentTarget), command.replace);
    }
    if (prepared.backupBefore && context.operation().plan.backupComplete !== true) {
      if (!(await context.backup())) return false;
    }
    await context.update({ plan: { ...context.operation().plan, minecraftWorldPrepared: true } });
  }
  await beginContent(
    context,
    {
      kind: 'world',
      planDigest: staged.planDigest,
      filemanTransfer: {
        id: transfer.id,
        destinationRoot: target,
        digest: filemanTransferDigest(transfer),
      },
      files: staged.manifest,
      absentPaths: [],
      wipes: prepared.world.existing ? [{ jobId: context.operation().job_id, path: target }] : [],
      inventory: [],
      removeInventoryPaths: [],
    },
    assertWritable,
    onlineImport,
  );
  if (prepared.world.existing && !(await completed(context, stepId('remove', target))))
    await removeContentPath(context, target);
  await context.fileman.uploadStaged({
    ...transfer,
    beforeWrite: onlineImport && !activeTarget ? undefined : context.assertStopped,
    open: async (path) => {
      const source = join(staged.directory, path);
      const metadata = await lstat(source);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new DomainError('conflict');
      return Readable.toWeb(createReadStream(source)) as ReadableStream<Uint8Array>;
    },
  });
  const levelDatSha256 = staged.validation.levelDatSha256;
  await verifyMinecraftPendingContent(context);
  await context.event('minecraft.world.imported', {
    world: target,
    files: staged.manifest.length,
    levelDatSha256,
  });
  return true;
}

/** Restoration verifies binaries but never overwrites the restored configuration. */
export async function verifyMinecraftRestore(
  context: GameLifecycleContext,
  options: MinecraftContentOptions,
): Promise<boolean> {
  const profile = await context.db
    .selectFrom('minecraft_server_profiles')
    .select('server_id')
    .where('server_id', '=', context.server.id)
    .executeTakeFirst();
  if (!profile) return true;
  await context.authorize();
  await context.assertStopped();
  const verified = await verifyInstalledRuntime(context, options);
  if (parseMinecraftProperties(await textFile(context, 'eula.txt', '')).eula !== 'true')
    throw new DomainError('conflict');
  parseMinecraftProperties(await textFile(context, 'server.properties', ''));
  const pending = await pendingContent(context);
  const configuration = initialConfiguration(verified.profile.configuration_state);
  if (configuration?.jobId && context.operation().action === 'restore') {
    const original = await context.db
      .selectFrom('server_operations')
      .select('plan')
      .where('job_id', '=', configuration.jobId)
      .where('server_id', '=', context.server.id)
      .executeTakeFirst();
    if (
      original?.plan.backupComplete === true &&
      original.plan.backupId === context.operation().plan.backupId
    )
      await context.db
        .updateTable('minecraft_server_profiles')
        .set({ configuration_state: '{}', updated_at: new Date() })
        .where('server_id', '=', context.server.id)
        .execute();
  }
  if (pending && context.operation().action === 'restore') {
    const original = await context.db
      .selectFrom('server_operations')
      .select('plan')
      .where('job_id', '=', pending.jobId)
      .where('server_id', '=', context.server.id)
      .executeTakeFirst();
    if (
      original?.plan.backupComplete === true &&
      original.plan.backupId === context.operation().plan.backupId
    ) {
      await context.db
        .updateTable('minecraft_server_profiles')
        .set({ content_state: '{}', updated_at: new Date() })
        .where('server_id', '=', context.server.id)
        .execute();
      await context.event('minecraft.content.backup_restored', {
        sourceJobId: pending.jobId,
        backupId: context.operation().plan.backupId,
      });
    }
  }
  await verifyMinecraftPendingContent(context);
  await verifyMinecraftInitialConfiguration(context);
  await context.db
    .updateTable('minecraft_server_profiles')
    .set({
      installed: true,
      installed_manifest: JSON.stringify(verified.verified),
      updated_at: new Date(),
    })
    .where('server_id', '=', context.server.id)
    .execute();
  // Only a real backup restore invalidates historical inventory. A read-only
  // verification retains existing ownership and any reconstructed pending manifest.
  if (context.operation().action === 'restore')
    await context.db
      .deleteFrom('minecraft_content_items')
      .where('server_id', '=', context.server.id)
      .execute();
  return true;
}
