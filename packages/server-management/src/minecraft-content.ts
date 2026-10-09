import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import {
  type ContentHttp,
  type ContentTarget,
  type CurseForgeProvider,
  contentPlanDigest,
  type InstalledContentFile,
  incompatibleContentSchema,
  inspectModpack,
  installedContentChange,
  ModrinthProvider,
  recoverContentStageLock,
  safeArchivePath,
  safeContentPath,
  stageContent,
  validateContentPlan,
  visitArchive,
} from '@nickhosting/content-providers';
import { type AuthContext, DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import { minecraftCombinationSchema, minecraftDigest } from '@nickhosting/minecraft';
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
  planMinecraftWorldReplacement,
  recoverMinecraftWorldStageLock,
  stageMinecraftWorld,
  validateMinecraftLevelDat,
} from '../../../games/minecraft/src/world.js';
import type { Environment } from './admission.js';
import type { GameLifecycleContext } from './lifecycle.js';
import { inspectMinecraftCombination } from './minecraft-registry.js';
import { requireMinecraftRuntimeImageEvidence } from './minecraft-runtime-evidence.js';
import { createMinecraftSourceStore, reserveMinecraftStaging } from './minecraft-sources.js';
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
  type MinecraftPreparedContent,
  minecraftConfigurationSchema,
  minecraftContentCommandSchema,
  minecraftStoredConfigurationSchema,
  minecraftStoredPlayerSchema,
} from './minecraft-content-contracts.js';
export interface MinecraftContentOptions {
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
    const actual = (await options.adapter.listFiles(server.pterodactyl_identifier)).filter(
      (entry) => entry.name.toLowerCase() === name.toLowerCase(),
    );
    if (
      actual.length > 1 ||
      actual.some((entry) => entry.name !== name || entry.is_file || entry.is_symlink)
    )
      throw new DomainError('conflict');
    assertMinecraftRuntimePathsPreserved([name], profile.installed_manifest);
    result.world = { dataVersion: worldDataVersion(choice), existing: actual.length === 1 };
    if (command.kind === 'world-import') {
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
export async function prepareMinecraftCreationConfig(
  db: Kysely<Database>,
  choiceId: string,
  input: unknown,
  options: MinecraftContentOptions,
) {
  const configuration = minecraftConfigurationSchema.parse(input);
  if (!configuration.modpack) return { configuration };
  const choice = await inspectMinecraftCombination(db, choiceId, options.env);
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
  const now = Date.now();
  const reports = choice.evidence
    .filter(
      (report) =>
        (report.kind === 'real-server' || report.kind === 'installation-bootstrap') &&
        report.choiceDigest === choice.row.identity_digest &&
        report.mappingDigest === choice.mappingDigest &&
        report.combinationDigest === minecraftDigest(choice.combination) &&
        Date.parse(report.recordedAt) <= now &&
        now - Date.parse(report.recordedAt) < 180 * 86400000,
    )
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
  const report = reports[0];
  if (
    !report?.checks.installation ||
    report.server?.worldDataVersion === undefined ||
    (reports[1] && Date.parse(reports[1].recordedAt) === Date.parse(report.recordedAt))
  )
    throw new DomainError('integration_unavailable');
  return report.server.worldDataVersion;
}

/** Every ancestor is checked; Wings accepts paths but does not make symlink ownership ours. */
async function remoteEntry(context: GameLifecycleContext, path: string) {
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
  context: GameLifecycleContext,
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
  absent: string,
): Promise<string> {
  const entry = await remoteEntry(context, path);
  if (!entry) return absent;
  if (!entry.is_file || entry.size > 1024 * 1024) throw new DomainError('conflict');
  return Buffer.from(
    await context.adapter.readFile(context.server.pterodactyl_identifier ?? '', path),
  ).toString('utf8');
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
const stepId = (kind: string, path: string) => `minecraft.${kind}.${sha256(path)}`;
async function completed(context: GameLifecycleContext, step: string): Promise<boolean> {
  return Boolean(
    await context.db
      .selectFrom('job_steps')
      .select('step')
      .where('job_id', '=', context.operation().job_id)
      .where('step', '=', step)
      .executeTakeFirst(),
  );
}
async function complete(context: GameLifecycleContext, step: string) {
  await context.db
    .insertInto('job_steps')
    .values({ job_id: context.operation().job_id, step })
    .onConflict((c) => c.columns(['job_id', 'step']).doNothing())
    .execute();
}
function uncertainEffect(context: GameLifecycleContext, phase: string): boolean {
  const operation = context.operation();
  return operation.phase === phase && operation.effect_state !== 'none';
}
/** A lost response is reconciled against the recorded desired hash, never blindly resent. */
export async function applyMinecraftTextChange(
  context: GameLifecycleContext,
  change: TextChange,
): Promise<void> {
  textChangeSchema.parse(change);
  if (sha256(change.content) !== change.afterSha256) throw new DomainError('conflict');
  const step = stepId('text', change.path);
  const current = await hashMinecraftRemoteFile(context, change.path);
  if (current?.sha256 === change.afterSha256) {
    await complete(context, step);
    return;
  }
  if ((await completed(context, step)) || uncertainEffect(context, step))
    throw new DomainError('operation_uncertain');
  if ((current?.sha256 ?? null) !== change.beforeSha256) throw new DomainError('conflict');
  await context.effect(step, async () => {
    await context.assertStopped();
    await context.authorize();
    if (
      ((await hashMinecraftRemoteFile(context, change.path))?.sha256 ?? null) !==
      change.beforeSha256
    )
      throw new DomainError('conflict');
    await context.adapter.writeFile(
      context.server.pterodactyl_identifier ?? '',
      change.path,
      change.content,
    );
  });
  if ((await hashMinecraftRemoteFile(context, change.path))?.sha256 !== change.afterSha256)
    throw new DomainError('operation_uncertain');
  await complete(context, step);
}
async function plannedText(
  context: GameLifecycleContext,
  path: TextChange['path'],
  content: string,
  expectedBefore?: string | null,
): Promise<TextChange> {
  const beforeSha256 = (await hashMinecraftRemoteFile(context, path))?.sha256 ?? null;
  if (expectedBefore !== undefined && expectedBefore !== beforeSha256)
    throw new DomainError('conflict');
  return {
    path,
    content,
    beforeSha256,
    afterSha256: sha256(content),
  };
}
async function textSnapshot(context: GameLifecycleContext, path: string, fallback: string) {
  const before = await hashMinecraftRemoteFile(context, path);
  const content = await textFile(context, path, fallback);
  if (before && sha256(content) !== before.sha256) throw new DomainError('conflict');
  if (!before && (await remoteEntry(context, path))) throw new DomainError('conflict');
  return { content, hash: before?.sha256 ?? null };
}
async function applyTextPlan(
  context: GameLifecycleContext,
  build: () => Promise<TextChange[]>,
  beforeEffects?: (plan: TextChange[]) => Promise<void>,
) {
  if (context.operation().plan.minecraftText === undefined)
    await context.update({ plan: { ...context.operation().plan, minecraftText: await build() } });
  const plan = z.array(textChangeSchema).max(4).parse(context.operation().plan.minecraftText);
  await beforeEffects?.(plan);
  for (const change of plan) await applyMinecraftTextChange(context, change);
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
  context: GameLifecycleContext,
  options: MinecraftContentOptions,
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
    const actual = await hashMinecraftRemoteFile(context, path);
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
          : {},
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
        const server = await hashMinecraftRemoteFile(context, serverPath);
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
    async () => {
      const changes: TextChange[] = [await plannedText(context, 'eula.txt', 'eula=true\n')];
      if (Object.keys(configuration.properties).length) {
        const snapshot = await textSnapshot(context, 'server.properties', '');
        const source = snapshot.content;
        const edited = editMinecraftProperties(source, configuration.properties, {
          release: verified.choice.combination.release,
          supportedKeys: source
            ? Object.keys(parseMinecraftProperties(source))
            : (verified.imageEvidence.report.server?.supportedProperties ?? []),
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
        const snapshot = await textSnapshot(context, path, '[]');
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

async function ensureRemoteDirectory(context: GameLifecycleContext, path: string) {
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
      await context.assertStopped();
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
async function installContentFile(
  context: GameLifecycleContext,
  options: MinecraftContentOptions,
  file: { path: string; size: number; sha256: string },
  localPath: string,
  previousSha256?: string,
  worldRoot?: string,
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
  await ensureRemoteDirectory(context, file.path);
  await context.effect(step, async () => {
    await context.assertStopped();
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
          await context.assertStopped();
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
  if (
    row.content_state &&
    typeof row.content_state === 'object' &&
    Object.keys(row.content_state).length === 0
  )
    return undefined;
  return pendingContentSchema.parse(row.content_state);
}
async function beginContent(context: GameLifecycleContext, state: Omit<PendingContent, 'jobId'>) {
  const previous = await pendingContent(context);
  if (previous?.jobId === context.operation().job_id) return;
  await context.authorize();
  await context.assertStopped();
  await context.db
    .updateTable('minecraft_server_profiles')
    .set({
      installed: false,
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
  for (const file of pending.files) {
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
  if (parseMinecraftProperties(await textFile(context, 'eula.txt', '')).eula !== 'true')
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
  const profile = await context.db
    .selectFrom('minecraft_server_profiles')
    .selectAll()
    .where('server_id', '=', context.server.id)
    .executeTakeFirstOrThrow();
  if (profile.combination_id !== prepared.combinationId) throw new DomainError('conflict');
  const choice = await inspectMinecraftCombination(context.db, profile.combination_id, options.env);
  const command = minecraftContentCommandSchema.parse(prepared.command);
  await context.authorize();
  await context.assertStopped();
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
    const source =
      command.kind === 'world-import'
        ? await sources.worldArchiveResolver(prepared.archiveRef, context.server.id)
        : { path: await sources.archiveResolver(prepared.archiveRef, context.server.id) };
    if (
      source.path !== prepared.archivePath ||
      ('sha256' in source && source.sha256 !== prepared.archiveSha256)
    )
      throw new DomainError('conflict');
  }
  if (command.kind === 'verify') return verifyMinecraftRestore(context, options);
  if (
    initialConfiguration(profile.configuration_state) &&
    !['provision', 'reinstall', 'wipe'].includes(context.operation().action)
  )
    throw new DomainError('operation_uncertain');
  await verifyInstalledRuntime(context, options);
  const pending = await pendingContent(context);
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
    return applyWorldContent(context, options, prepared, choice);
  if (command.kind === 'properties' || command.kind === 'player') {
    let configuration = minecraftStoredConfigurationSchema.parse(profile.configuration);
    if (
      command.kind === 'player' &&
      !configuration.playerIdentities &&
      (configuration.operators.length || configuration.whitelist.length)
    )
      throw new DomainError('configuration_invalid');
    await applyTextPlan(context, async () => {
      if (command.kind === 'properties') {
        const snapshot = await textSnapshot(context, 'server.properties', '');
        const source = snapshot.content;
        const result = editMinecraftProperties(source, command.changes, {
          release: choice.combination.release,
          supportedKeys: Object.keys(parseMinecraftProperties(source)),
        });
        return [await plannedText(context, 'server.properties', result.content, snapshot.hash)];
      }
      const path = command.list === 'operators' ? 'ops.json' : 'whitelist.json';
      const player = await verifyMinecraftPlayer(
        command.name,
        options.identityProvider ??
          createMinecraftIdentityProvider({ userAgent: options.userAgent }),
      );
      const snapshot = await textSnapshot(context, path, '[]');
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
    });
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
  if (
    !Number.isSafeInteger(stagedBytes) ||
    stagedBytes + usage.resources.disk_bytes > Number(context.server.limits.disk) * 1024 ** 2
  )
    throw new DomainError('resources_unavailable');
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
  if (deletePaths.length && context.operation().plan.minecraftWipeValidated !== true) {
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
    const configuration = minecraftStoredConfigurationSchema.parse(profile.configuration);
    configuration.modpack =
      command.kind === 'modpack'
        ? { provider: 'modrinth', projectId: command.projectId, versionId: command.versionId }
        : { sourceId: command.archiveRef };
    await context.db
      .updateTable('minecraft_server_profiles')
      .set({ configuration: JSON.stringify(configuration), updated_at: new Date() })
      .where('server_id', '=', context.server.id)
      .execute();
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

async function readWorldLevel(
  context: Pick<GameLifecycleContext, 'adapter' | 'server' | 'authorize'>,
  world: string,
  maxBytes = 8 * 1024 ** 2,
) {
  const response = await context.adapter.downloadFile(
    context.server.pterodactyl_identifier ?? '',
    `${minecraftWorldName(world)}/level.dat`,
    { maxBytes, authorize: context.authorize },
  );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxBytes) throw new DomainError('validation_failed');
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
/** Called through ManagementRuntime.access after current managed identity and user authorization. */
export async function listMinecraftWorlds(
  db: Kysely<Database>,
  adapter: PterodactylAdapter,
  serverId: string,
  authorize: () => Promise<void>,
  env: Environment = {},
) {
  const profile = await db
    .selectFrom('minecraft_server_profiles')
    .selectAll()
    .where('server_id', '=', serverId)
    .executeTakeFirstOrThrow();
  const server = await db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  const choice = await inspectMinecraftCombination(db, profile.combination_id, env);
  return discoverMinecraftWorlds(
    {
      listRoot: async () =>
        (await adapter.listFiles(server.pterodactyl_identifier ?? '')).map((entry) => ({
          name: entry.name,
          isDirectory: !entry.is_file,
          isSymlink: entry.is_symlink,
        })),
      readLevelDat: async (world, maxBytes) => {
        const entries = await adapter.listFiles(server.pterodactyl_identifier ?? '', world);
        const level = entries.find((entry) => entry.name === 'level.dat');
        if (!level) return undefined;
        if (!level.is_file || level.is_symlink || level.size > maxBytes)
          throw new DomainError('conflict');
        return readWorldLevel({ adapter, server, authorize }, world, maxBytes);
      },
    },
    { expectedDataVersion: worldDataVersion(choice), release: choice.combination.release },
  );
}
async function applyWorldContent(
  context: GameLifecycleContext,
  options: MinecraftContentOptions,
  prepared: MinecraftPreparedContent,
  choice: Awaited<ReturnType<typeof inspectMinecraftCombination>>,
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
  if (!prepared.world || prepared.world.dataVersion !== worldDataVersion(choice))
    throw new DomainError('conflict');
  const profile = await context.db
    .selectFrom('minecraft_server_profiles')
    .select('installed_manifest')
    .where('server_id', '=', context.server.id)
    .executeTakeFirstOrThrow();
  assertMinecraftRuntimePathsPreserved([target], profile.installed_manifest);
  if (command.kind === 'world-select') {
    if (!(await remoteEntry(context, `${target}/level.dat`))) throw new DomainError('not_found');
    const validation = validateMinecraftLevelDat(
      await readWorldLevel(context, target),
      prepared.world.dataVersion,
      { release: choice.combination.release },
    );
    await applyTextPlan(context, async () => {
      const snapshot = await textSnapshot(context, 'server.properties', '');
      const source = snapshot.content;
      const selected = planMinecraftWorldSelection(
        source,
        { name: target, verifiedDataVersion: validation.dataVersion, sha256: validation.sha256 },
        { allowedDataVersions: [prepared.world?.dataVersion ?? -1] },
      );
      return [await plannedText(context, 'server.properties', selected.content, snapshot.hash)];
    });
    return true;
  }
  if (command.kind === 'world-remove') {
    const source = parseMinecraftProperties(await textFile(context, 'server.properties', ''));
    if ((source['level-name'] ?? 'world') === target) fail('minecraft_world_selected');
    if (!(await completed(context, stepId('remove', target)))) {
      if (!(await remoteEntry(context, `${target}/level.dat`))) throw new DomainError('not_found');
      validateMinecraftLevelDat(await readWorldLevel(context, target), prepared.world.dataVersion, {
        release: choice.combination.release,
      });
      if (
        prepared.backupBefore &&
        context.operation().plan.backupComplete !== true &&
        !(await context.backup())
      )
        return false;
      await beginContent(context, {
        kind: 'world',
        planDigest: minecraftDigest(command),
        files: [],
        absentPaths: [target],
        wipes: [],
        inventory: [],
        removeInventoryPaths: [],
      });
      await removeContentPath(context, target);
    }
    await verifyMinecraftPendingContent(context);
    return true;
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
  try {
    await lstat(join(stageOptions.mountdataRoot, 'world-staging', stageOptions.jobId, 'plan.json'));
    await recoverMinecraftWorldStageLock({
      ...stageOptions,
      expectedPlanDigest: digest,
      assertExclusiveJob: context.authorize,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Complete ZIP, hash and NBT validation must precede optional backup and deletion.
  let expandedBytes = 0;
  await visitArchive(prepared.archivePath, async (file) => {
    expandedBytes += file.size;
  });
  await reserveMinecraftStaging(
    context.db,
    await options.authorizeJob(context.db, stageOptions.jobId, context.server.id),
    stageOptions.jobId,
    context.server.id,
    expandedBytes,
    options.env,
  );
  const staged = await stageMinecraftWorld(prepared.archivePath, stageOptions);
  let bytes = 0;
  for (const file of staged.manifest)
    if (!(await completed(context, stepId('install', file.path)))) bytes += file.size;
  const usage = await context.adapter.getResources(context.server.pterodactyl_identifier ?? '');
  if (
    !Number.isSafeInteger(bytes) ||
    usage.resources.disk_bytes + bytes > Number(context.server.limits.disk) * 1024 ** 2
  )
    throw new DomainError('resources_unavailable');
  if (context.operation().plan.minecraftWorldPrepared !== true) {
    const actual = await remoteEntry(context, target);
    if (Boolean(actual) !== prepared.world.existing || actual?.is_file)
      throw new DomainError('conflict');
    planMinecraftWorldReplacement(target, Boolean(actual), command.replace);
    if (
      prepared.backupBefore &&
      context.operation().plan.backupComplete !== true &&
      !(await context.backup())
    )
      return false;
    await context.update({ plan: { ...context.operation().plan, minecraftWorldPrepared: true } });
  }
  await beginContent(context, {
    kind: 'world',
    planDigest: staged.planDigest,
    files: staged.manifest,
    absentPaths: [],
    wipes: prepared.world.existing ? [{ jobId: context.operation().job_id, path: target }] : [],
    inventory: [],
    removeInventoryPaths: [],
  });
  if (prepared.world.existing && !(await completed(context, stepId('remove', target))))
    await removeContentPath(context, target);
  for (const file of staged.manifest)
    await installContentFile(
      context,
      options,
      file,
      join(staged.directory, file.path),
      undefined,
      target,
    );
  const level = validateMinecraftLevelDat(
    await readWorldLevel(context, target),
    prepared.world.dataVersion,
    { release: choice.combination.release },
  );
  if (level.sha256 !== staged.validation.levelDatSha256)
    throw new DomainError('operation_uncertain');
  await verifyMinecraftPendingContent(context);
  await context.event('minecraft.world.verified', {
    world: target,
    files: staged.manifest.length,
    levelDatSha256: level.sha256,
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
