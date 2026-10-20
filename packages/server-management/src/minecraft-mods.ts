import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import {
  type ContentArtifact,
  type ContentHttp,
  type ContentTarget,
  type CurseForgeProvider,
  inspectJarMetadata,
  ModrinthProvider,
} from '@nickhosting/content-providers';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { type Database, getSettings, recordAudit } from '@nickhosting/database';
import type { FilemanEntry, FilemanReadService } from '@nickhosting/game-sdk';
import { isUploadNotDispatched, isUploadNotPublished } from '@nickhosting/pterodactyl-adapter';
import { type Kysely, type Selectable, sql } from 'kysely';
import { z } from 'zod';
import { minecraftContentCapabilities } from '../../../games/minecraft/src/content-capabilities.js';
import {
  type MinecraftModAlternatives,
  type MinecraftModMetadata,
  type MinecraftModSelection,
  type MinecraftModsSnapshot,
  type MinecraftModUpdates,
  minecraftModApplySchema,
  minecraftModBlockerSchema,
  minecraftModInstalledChangeSchema,
  minecraftModSelectionSchema,
  minecraftModToggleSchema,
} from '../../../games/minecraft/src/mod-contracts.js';
import type { ModResolutionItem } from '../../content-providers/src/mod-catalog.js';
import type { Environment } from './admission.js';
import { currentInteractiveContext } from './interactive-context.js';
import { datapackReceipts, datapackStateRows } from './minecraft-datapack-dependencies.js';
import { modAlternativeAdvice, modUpdateAdvice } from './minecraft-mod-advice.js';
import { resolveModsAutomatically } from './minecraft-mod-auto-resolution.js';
import { inspectMinecraftCombination } from './minecraft-registry.js';
import { createMinecraftSourceStore } from './minecraft-sources.js';
import { authorizeServer, parse } from './registry.js';
import type { ManagementRuntime } from './runtime.js';
import { assertServerStorageCapacity, serverStorageLimitBytes } from './storage-capacity.js';
import { reserveUploadIngestion } from './upload-admission.js';

const ref = z.object({
  provider: z.enum(['modrinth', 'curseforge']),
  projectId: z.string(),
  versionId: z.string().optional(),
});
const meta = z.object({
  provider: z.enum(['modrinth', 'curseforge']),
  projectId: z.string(),
  versionId: z.string(),
  name: z.string(),
  version: z.string(),
  channel: z.enum(['release', 'beta', 'alpha']),
  iconUrl: z.string().optional(),
  side: z.enum(['server', 'client', 'both', 'unknown']),
  tags: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      source: z.enum(['modrinth', 'curseforge']).optional(),
      original: z.string().optional(),
    }),
  ),
  environment: z
    .object({
      kind: z.enum(['server', 'client', 'both', 'unknown']),
      detail: z.string().optional(),
      source: z.string(),
      original: z.array(z.string()),
    })
    .optional(),
  minecraftVersions: z.array(z.string()),
  loaders: z.array(z.string()),
});
const planSchema = z.object({
  // Immediate installed-mod toggles never consume the installation draft.
  isolated: z.boolean().optional(),
  from: z.string(),
  to: z.string(),
  size: z.number().nonnegative(),
  modifiedAt: z.string().optional(),
  sha256: z.string().optional(),
  metadata: meta.nullable(),
  dependency: z.boolean(),
  requiredBy: z.array(z.string()),
  forceIncompatible: z.boolean(),
  incompatibilities: z.array(z.enum(['minecraft', 'loader', 'client-only'])),
  aliases: z.array(ref).default([]),
  reuse: z.boolean().default(false),
  dependencies: z.array(ref),
  conflicts: z.array(ref),
  sourceId: z.string().optional(),
  claimId: z.uuid().optional(),
  claimScope: z.string().optional(),
  runtimeModId: z.string().optional(),
  runtimeModVersion: z.string().optional(),
  target: z
    .object({
      minecraftVersion: z.string(),
      loader: z.string(),
      loaderVersion: z.string().optional(),
    })
    .optional(),
  retired: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        size: z.number(),
        modifiedAt: z.string().optional(),
      }),
    )
    .default([]),
});
type Plan = z.infer<typeof planSchema>;
const identities = (plan: Plan) => [
  ...(plan.metadata
    ? [
        {
          provider: plan.metadata.provider,
          projectId: plan.metadata.projectId,
          versionId: plan.metadata.versionId,
        },
      ]
    : []),
  ...plan.aliases,
];
const uniqueRefs = (values: z.infer<typeof ref>[]) => [
  ...new Map(values.map((value) => [JSON.stringify(value), value])).values(),
];
type Change = Selectable<Database['minecraft_mod_changes']>;
const active = ['queued', 'preparing', 'ready', 'failed', 'uncertain', 'dispatched'] as const;
const leaf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const code = (error: unknown) =>
  error instanceof DomainError ? error.code : 'integration_unavailable';
const cleanups = new WeakMap<Kysely<Database>, Map<string, Promise<void>>>();
const inventories = new WeakMap<
  Kysely<Database>,
  Map<string, { expires: number; entries: readonly FilemanEntry[] }>
>();
const tasks = new WeakMap<
  Kysely<Database>,
  Map<string, { revision: number; abort: AbortController; promise: Promise<void> }>
>();
const adviceCaches = new WeakMap<
  Kysely<Database>,
  Map<string, { expires: number; promise: Promise<MinecraftModUpdates | MinecraftModAlternatives> }>
>();
function cachedAdvice<T extends MinecraftModUpdates | MinecraftModAlternatives>(
  db: Kysely<Database>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  let cache = adviceCaches.get(db);
  if (!cache) {
    cache = new Map();
    adviceCaches.set(db, cache);
  }
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) return existing.promise as Promise<T>;
  if (cache.size >= 32) cache.delete(cache.keys().next().value as string);
  const promise = load();
  cache.set(key, { expires: Date.now() + 300_000, promise });
  const owned = cache;
  void promise.then(
    (value) => {
      if ('checkedAt' in value && value.items.some((item) => item.status === 'unavailable')) {
        if (owned.get(key)?.promise === promise) owned.delete(key);
      }
    },
    () => {
      if (owned.get(key)?.promise === promise) owned.delete(key);
    },
  );
  return promise;
}
const recordSchema = planSchema.extend({ modifiedAt: z.string() });
const moveSchema = z.object({
  from: z.string(),
  to: z.string(),
  size: z.number(),
  modifiedAt: z.string().optional(),
});

/** Catalog metadata is immutable provenance; only unchanged on-disk receipts lend it authority. */
function metadata(item: ModResolutionItem): MinecraftModMetadata {
  return {
    provider: item.project.provider,
    projectId: item.project.id,
    versionId: item.version.id,
    name: item.project.name,
    version: item.version.version,
    channel: item.version.channel,
    iconUrl: item.project.imageUrl,
    side: item.version.environment.kind,
    tags: item.project.tags,
    environment: item.version.environment,
    minecraftVersions: item.version.gameVersions,
    loaders: item.version.loaders,
  };
}
export function createMinecraftModsService(options: {
  db: Kysely<Database>;
  runtime: ManagementRuntime;
  env?: Environment;
  http?: ContentHttp;
  curseforge?: CurseForgeProvider;
}) {
  const { db, runtime, env = {} } = options;
  const runningTasks = tasks.get(db) ?? new Map();
  tasks.set(db, runningTasks);
  const cleanupTasks = cleanups.get(db) ?? new Map<string, Promise<void>>();
  cleanups.set(db, cleanupTasks);
  const inventoryCache =
    inventories.get(db) ?? new Map<string, { expires: number; entries: readonly FilemanEntry[] }>();
  inventories.set(db, inventoryCache);
  function queueCleanup(context: AuthContext, serverId: string) {
    if (cleanupTasks.has(serverId)) return;
    const promise = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const candidates = await db
        .selectFrom('minecraft_mod_changes')
        .selectAll()
        .where('server_id', '=', serverId)
        .where('state', 'in', ['cancelled', 'applied'])
        .where('cleanup_done', '=', false)
        .limit(1000)
        .execute();
      if (!candidates.length) return;
      if (
        candidates.every((row) => {
          const plan = parse(planSchema, row.plan);
          return (
            row.state === 'applied' &&
            row.action !== 'delete' &&
            !plan.retired.length &&
            !(plan.reuse && plan.from === `mods/.nh-${row.id}.jar.pending`)
          );
        })
      ) {
        await db
          .updateTable('minecraft_mod_changes')
          .set({ cleanup_done: true })
          .where(
            'id',
            'in',
            candidates.map((row) => row.id),
          )
          .execute();
        return;
      }
      await runtime.fileMutationAccess(
        context,
        serverId,
        async (identifier, connection, current, server) => {
          const paths: string[] = [];
          for (const row of candidates) {
            const plan = parse(planSchema, row.plan);
            if (
              row.state === 'cancelled' &&
              row.action === 'install' &&
              plan.from === `mods/.nh-${row.id}.jar.pending`
            )
              paths.push(plan.from);
            if (row.state === 'applied') {
              if (plan.reuse && plan.from === `mods/.nh-${row.id}.jar.pending`)
                paths.push(plan.from);
              for (const retired of plan.retired)
                if (retired.to.startsWith(`mods/.nh-${row.id}-`) && retired.to.endsWith('.retired'))
                  paths.push(retired.to);
              if (row.action === 'delete' && plan.to === `mods/.nh-${row.id}.retired`)
                paths.push(plan.to);
            }
          }
          if (paths.length) {
            await runtime.authorizeTransfer(current, serverId, true, connection, undefined, server);
            const unique = [...new Set(paths)];
            for (let offset = 0; offset < unique.length; offset += 1000)
              await runtime.adapter.deleteFiles(
                identifier,
                '',
                unique.slice(offset, offset + 1000),
              );
            const remaining = await list(runtime.fileReadPhase(identifier, server));
            if (paths.some((path) => remaining.some((entry) => entry.name === leaf(path))))
              throw new DomainError('operation_uncertain');
          }
          await connection
            .updateTable('minecraft_mod_changes')
            .set({ cleanup_done: true })
            .where(
              'id',
              'in',
              candidates.map((row) => row.id),
            )
            .where('state', 'in', ['cancelled', 'applied'])
            .execute();
        },
      );
    })().catch(() => {
      /* Durable cleanup flags allow a later visit/selection to retry only generated retired paths. */
    });
    cleanupTasks.set(serverId, promise);
    void promise.finally(() => {
      if (cleanupTasks.get(serverId) === promise) cleanupTasks.delete(serverId);
    });
  }
  const provider = (name: 'modrinth' | 'curseforge') => {
    const result =
      name === 'modrinth' && options.http
        ? new ModrinthProvider(options.http)
        : name === 'curseforge'
          ? options.curseforge
          : undefined;
    if (!result) throw new DomainError('integration_unavailable');
    return result;
  };
  async function authorized(
    context: AuthContext,
    serverId: string,
    write = false,
    connection = db,
  ) {
    const actor = await currentInteractiveContext(connection, context, env);
    const server = await authorizeServer(
      connection,
      actor,
      serverId,
      write ? 'server:manage' : undefined,
    );
    return { actor, server };
  }
  async function profile(connection: Kysely<Database>, serverId: string) {
    const value = await connection
      .selectFrom('minecraft_server_profiles')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (!value) throw new DomainError('not_found');
    const choice = await inspectMinecraftCombination(connection, value.combination_id, env);
    const target: ContentTarget = {
      minecraftVersion: choice.combination.release,
      loader: choice.combination.profile as ContentTarget['loader'],
      ...(choice.combination.loaderVersion
        ? { loaderVersion: choice.combination.loaderVersion }
        : {}),
    };
    return {
      installed: value.installed,
      target,
      supported: minecraftContentCapabilities(target.loader).mods,
    };
  }
  async function draft(connection: Kysely<Database>, serverId: string) {
    return connection
      .selectFrom('minecraft_mod_drafts')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirst();
  }
  async function rows(connection: Kysely<Database>, serverId: string) {
    return connection
      .selectFrom('minecraft_mod_changes')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('state', 'in', active)
      .orderBy('created_at', 'asc')
      .execute();
  }
  async function list(files: FilemanReadService) {
    const result = (await files.listMany(['mods']))[0];
    if (result && 'files' in result) return result.files;
    if (result && 'error' in result && result.error === 'not_found') return [];
    // Wings can report a missing directory as HTTP 500. Confirm absence from
    // the same authorized Fileman root before treating that response as empty;
    // an inaccessible existing mods directory must remain an error.
    if (
      result &&
      'error' in result &&
      result.error === 'unavailable' &&
      !(await files.list('')).some((entry) => entry.name === 'mods')
    )
      return [];
    throw new DomainError('integration_unavailable');
  }
  async function receipts(
    connection: Kysely<Database>,
    serverId: string,
    entries: readonly FilemanEntry[],
  ) {
    const stored = await connection
      .selectFrom('minecraft_mod_receipts')
      .selectAll()
      .where('server_id', '=', serverId)
      .execute();
    return stored.flatMap((row) => {
      const parsed = recordSchema.safeParse(row.receipt),
        entry = entries.find((file) => file.name === leaf(row.path));
      return parsed.success &&
        entry?.kind === 'file' &&
        entry.size === parsed.data.size &&
        entry.modifiedAt === parsed.data.modifiedAt
        ? [{ path: row.path, plan: parsed.data }]
        : [];
    });
  }
  async function restartStatus(context: AuthContext, serverId: string, alreadyAuthorized = false) {
    if (!alreadyAuthorized) await authorized(context, serverId);
    const marker = await db
      .selectFrom('minecraft_mod_restart')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (!marker) return { required: false };
    const gateway = await db
      .selectFrom('gateway_server_states')
      .select('process_started_at')
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    let started = gateway?.process_started_at;
    if (!started || Date.parse(started) <= marker.changed_at.getTime())
      try {
        started = await runtime.lifecycle.observeProviderProcessStart?.(serverId, db);
      } catch {
        /* Unavailable observations retain the warning. */
      }
    const required =
      !started ||
      !Number.isFinite(Date.parse(started)) ||
      Date.parse(started) <= marker.changed_at.getTime();
    if (!required) {
      const removed = await db
        .deleteFrom('minecraft_mod_restart')
        .where('server_id', '=', serverId)
        .where('changed_at', '=', marker.changed_at)
        .returning('server_id')
        .executeTakeFirst();
      if (!removed) {
        const newer = await db
          .selectFrom('minecraft_mod_restart')
          .select('changed_at')
          .where('server_id', '=', serverId)
          .executeTakeFirst();
        if (newer) return { required: true, changedAt: newer.changed_at.toISOString() };
      }
    }
    return { required, changedAt: marker.changed_at.toISOString() };
  }
  async function checkRevision(connection: Kysely<Database>, serverId: string, revision: number) {
    const value = await draft(connection, serverId);
    if (value?.revision !== revision) throw new DomainError('conflict');
    return value;
  }
  async function reconcileGraph(
    connection: Kysely<Database>,
    serverId: string,
    entries: readonly FilemanEntry[],
    changes: Change[],
    files: FilemanReadService,
    installed?: Awaited<ReturnType<typeof receipts>>,
  ) {
    const old = installed ?? (await receipts(connection, serverId, entries));
    const destinations = new Set<string>();
    for (const change of changes) {
      const plan = parse(planSchema, change.plan);
      if (change.action === 'delete') continue;
      if (destinations.has(plan.to))
        throw new DomainError('content_dependency_conflict', 409, {
          projectId: plan.metadata?.projectId,
          name: plan.metadata?.name,
        });
      destinations.add(plan.to);
    }
    const final = new Map<string, Plan>(old.map((item) => [item.path, item.plan]));
    for (const change of changes) {
      const plan = parse(planSchema, change.plan);
      final.delete(plan.from);
      for (const retired of plan.retired) final.delete(retired.from);
      if (change.action === 'delete' || change.action === 'disable') {
        final.delete(plan.to);
        continue;
      }
      final.set(plan.to, plan);
    }
    const enabled = [...final]
      .filter(([path]) => path.endsWith('.jar'))
      .map(([, plan]) => plan)
      .filter((plan) => plan.metadata);
    const matches = (reference: z.infer<typeof ref>) =>
      enabled.some((plan) =>
        identities(plan).some(
          (identity) =>
            identity.provider === reference.provider &&
            identity.projectId === reference.projectId &&
            (!reference.versionId || identity.versionId === reference.versionId),
        ),
      );
    const runtimeIds = new Set<string>();
    for (const plan of enabled) {
      if (plan.runtimeModId) {
        if (runtimeIds.has(plan.runtimeModId))
          throw new DomainError('content_dependency_conflict', 409, {
            projectId: plan.metadata?.projectId,
            name: plan.metadata?.name,
          });
        runtimeIds.add(plan.runtimeModId);
      }
      if (plan.dependencies.some((reference) => !matches(reference)))
        throw new DomainError('content_dependency_missing', 409, {
          projectId: plan.metadata?.projectId,
          name: plan.metadata?.name,
        });
      if (plan.conflicts.some(matches))
        throw new DomainError('content_dependency_conflict', 409, {
          projectId: plan.metadata?.projectId,
          name: plan.metadata?.name,
        });
    }
    // Retained catalog datapacks share this graph. One directory batch, no per-file requests.
    const worlds = await connection
      .selectFrom('minecraft_datapack_changes')
      .select('world')
      .distinct()
      .where('server_id', '=', serverId)
      .execute();
    const packs = (
      await Promise.all(
        worlds.map(async ({ world }) =>
          datapackReceipts(await datapackStateRows(connection, serverId, world)),
        ),
      )
    )
      .flat()
      .filter((pack) => pack.enabled);
    const dirs = [...new Set(packs.map((pack) => pack.path.slice(0, pack.path.lastIndexOf('/'))))];
    const found = dirs.length ? await files.listMany(dirs) : [];
    for (const pack of packs) {
      const dir = found.find(
        (item) => item.directory === pack.path.slice(0, pack.path.lastIndexOf('/')),
      );
      if (!dir || !('files' in dir)) {
        if (dir && 'error' in dir && dir.error === 'not_found') continue;
        throw new DomainError('integration_unavailable');
      }
      const entry = dir.files.find((item) => item.name === leaf(pack.path));
      if (!entry || entry.size !== pack.size || entry.modifiedAt !== pack.modifiedAt) continue;
      for (const mod of pack.catalog.mods)
        if (
          !matches({
            provider: pack.catalog.provider,
            projectId: mod.projectId,
            versionId: mod.versionId,
          })
        )
          throw new DomainError('content_dependency_missing');
      if (
        pack.catalog.conflicts.some((item) => matches({ provider: pack.catalog.provider, ...item }))
      )
        throw new DomainError('content_dependency_conflict');
      if (
        enabled.some((plan) =>
          plan.conflicts.some(
            (item) =>
              item.provider === pack.catalog.provider &&
              item.projectId === pack.catalog.projectId &&
              (!item.versionId || item.versionId === pack.catalog.versionId),
          ),
        )
      )
        throw new DomainError('content_dependency_conflict');
    }
  }
  async function refreshDraftGraph(
    connection: Kysely<Database>,
    serverId: string,
    current: NonNullable<Awaited<ReturnType<typeof draft>>>,
    files: FilemanReadService,
    entries?: readonly FilemanEntry[],
  ) {
    const changes = (await rows(connection, serverId)).filter(
      (row) => row.action !== 'install' || row.revision === current.revision,
    );
    if (changes.some((row) => row.state !== 'ready')) return;
    const blockers = (Array.isArray(current.blockers) ? current.blockers : []).filter(
      (item) => !(item && typeof item === 'object' && 'source' in item && item.source === 'graph'),
    );
    try {
      await reconcileGraph(connection, serverId, entries ?? (await list(files)), changes, files);
    } catch (error) {
      if (
        !(error instanceof DomainError) ||
        !['content_dependency_conflict', 'content_dependency_missing'].includes(error.code)
      )
        throw error;
      blockers.push({
        source: 'graph',
        projectId: error.details?.projectId ?? 'retained-content',
        name: error.details?.name ?? '',
        reason: error.code === 'content_dependency_missing' ? 'unresolved' : 'conflict',
      });
    }
    await connection
      .updateTable('minecraft_mod_drafts')
      .set({ blockers: JSON.stringify(blockers) })
      .where('server_id', '=', serverId)
      .where('revision', '=', current.revision)
      .execute();
  }
  async function refreshGraph(context: AuthContext, serverId: string, revision: number) {
    await runtime.fileReadScope(context, serverId, async (files, _identifier, connection) => {
      const current = await checkRevision(connection, serverId, revision);
      await refreshDraftGraph(connection, serverId, current, files);
    });
  }
  async function coalesce(context: AuthContext, serverId: string, revision: number) {
    await runtime.fileMutationAccess(
      context,
      serverId,
      async (identifier, connection, _current, server) => {
        await checkRevision(connection, serverId, revision);
        const changes = (await rows(connection, serverId)).filter(
          (row) => row.revision === revision && row.action === 'install' && row.state === 'ready',
        );
        const installed = await receipts(
          connection,
          serverId,
          await list(runtime.fileReadPhase(identifier, server)),
        );
        const canonical = new Map<string, { row: Change; plan: Plan }>();
        for (const row of changes) {
          const plan = parse(planSchema, row.plan);
          if (!plan.runtimeModId || !plan.sha256) continue;
          const other = canonical.get(plan.runtimeModId);
          if (other && other.plan.sha256 === plan.sha256) {
            other.plan.aliases = uniqueRefs([...other.plan.aliases, ...identities(plan)]).filter(
              (value) =>
                !(
                  value.provider === other.plan.metadata?.provider &&
                  value.projectId === other.plan.metadata.projectId &&
                  value.versionId === other.plan.metadata.versionId
                ),
            );
            other.plan.dependencies = uniqueRefs([
              ...other.plan.dependencies,
              ...plan.dependencies,
            ]);
            other.plan.conflicts = uniqueRefs([...other.plan.conflicts, ...plan.conflicts]);
            other.plan.requiredBy = [...new Set([...other.plan.requiredBy, ...plan.requiredBy])];
            other.plan.dependency &&= plan.dependency;
            await connection
              .updateTable('minecraft_mod_changes')
              .set({ plan: JSON.stringify(other.plan) })
              .where('id', '=', other.row.id)
              .execute();
            await connection
              .updateTable('minecraft_mod_changes')
              .set({ state: 'cancelled' })
              .where('id', '=', row.id)
              .execute();
            continue;
          }
          const existing = installed.find(
            (item) =>
              item.path.endsWith('.jar') &&
              item.plan.runtimeModId === plan.runtimeModId &&
              item.plan.sha256 === plan.sha256,
          );
          if (existing) {
            plan.reuse = true;
            plan.to = existing.path;
            plan.retired = [];
            plan.modifiedAt = existing.plan.modifiedAt;
            plan.aliases = uniqueRefs([...plan.aliases, ...identities(existing.plan)]);
            plan.dependencies = uniqueRefs([...plan.dependencies, ...existing.plan.dependencies]);
            plan.conflicts = uniqueRefs([...plan.conflicts, ...existing.plan.conflicts]);
            await connection
              .updateTable('minecraft_mod_changes')
              .set({ plan: JSON.stringify(plan) })
              .where('id', '=', row.id)
              .execute();
          }
          if (!other) canonical.set(plan.runtimeModId, { row, plan });
        }
      },
    );
  }
  async function prepare(
    context: AuthContext,
    serverId: string,
    revision: number,
    selection: MinecraftModSelection,
    signal: AbortSignal,
  ) {
    await cleanupTasks.get(serverId);
    const [info, config] = await Promise.all([profile(db, serverId), getSettings(db, env)]);
    if (!info.supported || !info.installed) throw new DomainError('integration_unavailable');
    const observed = await runtime.fileReadScope(
      context,
      serverId,
      async (files, _id, connection) => receipts(connection, serverId, await list(files)),
    );
    const resolved = await Promise.all(
      (['modrinth', 'curseforge'] as const)
        .filter((name) => selection.roots.some((root) => root.provider === name))
        .map(async (name) => {
          const output = await resolveModsAutomatically({
            provider: provider(name),
            roots: selection.roots
              .filter((root) => root.provider === name)
              .map(({ provider: _, ...root }) => root),
            target: info.target,
            maxVersions: config.values.minecraftModAlternativeLimit,
            replacePinned: true,
            preferBeta: selection.preferBeta,
            signal,
            installedVersions: new Map(
              observed
                .filter((row) => row.path.endsWith('.jar'))
                .flatMap((row) =>
                  identities(row.plan)
                    .filter((identity) => identity.provider === name && identity.versionId)
                    .map((identity) => [identity.projectId, identity.versionId as string] as const),
                ),
            ),
          });
          return { name, ...output };
        }),
    );
    signal.throwIfAborted();
    const blockers: MinecraftModsSnapshot['blockers'] = resolved.flatMap((result) =>
      result.catalog.blocked.map((item) => {
        const byId = new Map(result.catalog.items.map((entry) => [entry.project.id, entry]));
        const names = new Map(
          result.catalog.items.map((entry) => [entry.project.id, entry.project.name]),
        );
        names.set(item.projectId, item.name);
        const pending = [item.requiredBy];
        const visited = new Set<string>();
        const roots: { projectId: string; name: string }[] = [];
        while (pending.length) {
          const id = pending.pop();
          if (!id || visited.has(id)) continue;
          visited.add(id);
          if (
            selection.roots.some((root) => root.provider === item.provider && root.projectId === id)
          )
            roots.push({ projectId: id, name: names.get(id) ?? id });
          pending.push(...(byId.get(id)?.requiredBy ?? []));
        }
        return { ...item, requiredByName: names.get(item.requiredBy) ?? item.requiredBy, roots };
      }),
    );
    const optionalByProject = new Map<string, MinecraftModsSnapshot['optional'][number]>();
    for (const result of resolved)
      for (const item of result.catalog.optional) {
        const key = `${item.provider}:${item.projectId}`;
        const previous = optionalByProject.get(key);
        optionalByProject.set(key, {
          provider: item.provider,
          projectId: item.projectId,
          name: item.name,
          requiredBy: [...new Set([...(previous?.requiredBy ?? []), item.requiredBy])],
        });
      }
    const optional = [...optionalByProject.values()];
    const planned: { item: ModResolutionItem; artifact: ContentArtifact; id: string }[] = [];
    const prior = (await rows(db, serverId)).filter(
      (row) => row.action === 'install' && row.state === 'ready',
    );
    const reused = new Set<string>();
    for (const result of resolved)
      for (const item of result.catalog.items) {
        const artifact = result.plan.artifacts.find(
          (artifact) =>
            artifact.projectId === item.project.id && artifact.versionId === item.version.id,
        );
        if (!artifact) {
          blockers.push({
            projectId: item.project.id,
            name: item.project.name,
            reason: 'unavailable',
          });
          continue;
        }
        if (
          observed.some(
            (row) =>
              row.path.endsWith('.jar') &&
              identities(row.plan).some(
                (identity) =>
                  identity.provider === item.project.provider &&
                  identity.projectId === item.project.id &&
                  identity.versionId === item.version.id,
              ),
          )
        )
          continue;
        const reusable = prior.find((row) => {
          const plan = parse(planSchema, row.plan);
          return (
            !reused.has(row.id) &&
            plan.metadata?.provider === item.project.provider &&
            plan.metadata.projectId === item.project.id &&
            plan.metadata.versionId === item.version.id &&
            plan.forceIncompatible === item.forced &&
            digest(plan.target) === digest(info.target)
          );
        });
        if (reusable) {
          reused.add(reusable.id);
        } else planned.push({ item, artifact, id: randomUUID() });
      }
    await runtime.fileMutationAccess(context, serverId, async (_identifier, connection) => {
      await checkRevision(connection, serverId, revision);
      signal.throwIfAborted();
      await connection
        .updateTable('minecraft_mod_drafts')
        .set({ blockers: JSON.stringify(blockers), optional: JSON.stringify(optional) })
        .where('server_id', '=', serverId)
        .execute();
      for (const row of prior.filter((row) => reused.has(row.id))) {
        const plan = parse(planSchema, row.plan),
          item = resolved
            .flatMap((result) => result.catalog.items)
            .find(
              (item) =>
                item.project.provider === plan.metadata?.provider &&
                item.project.id === plan.metadata.projectId,
            );
        if (item) {
          plan.dependency = !item.root;
          plan.requiredBy = item.requiredBy;
          plan.dependencies = item.dependencies;
          plan.conflicts = item.conflicts;
        }
        await connection
          .updateTable('minecraft_mod_changes')
          .set({ revision, plan: JSON.stringify(plan) })
          .where('id', '=', row.id)
          .execute();
      }
      const cancelled = prior.filter((row) => !reused.has(row.id));
      if (cancelled.length)
        await connection
          .updateTable('minecraft_mod_changes')
          .set({ state: 'cancelled', updated_at: new Date() })
          .where(
            'id',
            'in',
            cancelled.map((row) => row.id),
          )
          .execute();
      if (blockers.length) return;
      for (const { item, artifact, id } of planned) {
        const replaced = observed.filter((row) =>
          identities(row.plan).some(
            (identity) =>
              identity.provider === item.project.provider && identity.projectId === item.project.id,
          ),
        );
        const preserveDisabled =
          item.root &&
          replaced.length > 0 &&
          replaced.every((row) => row.path.endsWith('.disabled'));
        const plan: Plan = {
          from: `mods/.nh-${id}.jar.pending`,
          to: `${artifact.path}${preserveDisabled ? '.disabled' : ''}`,
          size: artifact.size,
          metadata: metadata(item),
          target: info.target,
          aliases: [],
          reuse: false,
          dependency: !item.root,
          requiredBy: item.requiredBy,
          forceIncompatible: item.forced,
          incompatibilities: item.version.compatibility.map((reason) =>
            reason === 'minecraft-version'
              ? 'minecraft'
              : reason === 'loader'
                ? 'loader'
                : 'client-only',
          ),
          dependencies: item.dependencies,
          conflicts: item.conflicts,
          retired: observed
            .filter((row) =>
              identities(row.plan).some(
                (identity) =>
                  identity.provider === item.project.provider &&
                  identity.projectId === item.project.id,
              ),
            )
            .map((row) => ({
              from: row.path,
              to: `mods/.nh-${id}-${digest(row.path).slice(0, 8)}.retired`,
              size: row.plan.size,
              modifiedAt: row.plan.modifiedAt,
            })),
        };
        await connection
          .insertInto('minecraft_mod_changes')
          .values({
            id,
            server_id: serverId,
            revision,
            actor_user_id: context.actorUserId,
            action: 'install',
            state: 'queued',
            idempotency_key: `${revision}-${id}`,
            plan: JSON.stringify(plan),
            error: null,
          })
          .execute();
      }
    });
    if (blockers.length) return;
    // Downloads use the existing bounded source store outside the short publication lock.
    // Two independent preparations avoid serial provider latency without flooding Wings.
    let cursor = 0;
    let modsDirectoryReady = false;
    let uploadTail: Promise<unknown> = Promise.resolve();
    const uploadSerial = <T>(work: () => Promise<T>): Promise<T> => {
      const next = uploadTail.catch(() => {}).then(work);
      uploadTail = next;
      return next;
    };
    async function next() {
      for (;;) {
        const value = planned[cursor++];
        if (!value) return;
        signal.throwIfAborted();
        await prepareItem(value);
      }
    }
    async function prepareItem({
      item,
      artifact,
      id,
    }: {
      item: ModResolutionItem;
      artifact: ContentArtifact;
      id: string;
    }) {
      let dispatched = false;
      try {
        await db
          .updateTable('minecraft_mod_changes')
          .set({ state: 'preparing', updated_at: new Date() })
          .where('id', '=', id)
          .execute();
        const store = createMinecraftSourceStore(db, context, env, {
          http: provider(item.project.provider).http,
          curseforge: options.curseforge,
        });
        const source = await store.acquireMod(
          {
            provider: item.project.provider,
            projectId: item.project.id,
            versionId: item.version.id,
            serverId,
            idempotencyKey: digest([serverId, revision, id]),
          },
          artifact,
        );
        const archive = await store.modArchiveResolver(source.id, serverId);
        const jar = await inspectJarMetadata(archive.path);
        const side = jar.environment;
        if (side === 'client' && !item.forced) {
          const row = await db
            .selectFrom('minecraft_mod_changes')
            .select('plan')
            .where('id', '=', id)
            .executeTakeFirstOrThrow();
          const plan = parse(planSchema, row.plan);
          plan.incompatibilities = [
            ...new Set([...plan.incompatibilities, 'client-only' as const]),
          ];
          if (plan.metadata) {
            plan.metadata.side = 'client';
            plan.metadata.environment = { kind: 'client', source: 'archive', original: [] };
          }
          await db
            .updateTable('minecraft_mod_changes')
            .set({ plan: JSON.stringify(plan), error: 'client_only' })
            .where('id', '=', id)
            .execute();
          throw new DomainError('validation_failed', 400, { contentReason: 'client_only' });
        }
        signal.throwIfAborted();
        await uploadSerial(() =>
          runtime.fileMutationAccess(
            context,
            serverId,
            async (identifier, connection, current, server) => {
              await checkRevision(connection, serverId, revision);
              if (digest((await profile(connection, serverId)).target) !== digest(info.target))
                throw new DomainError('content_plan_expired');
              signal.throwIfAborted();
              const row = await connection
                .selectFrom('minecraft_mod_changes')
                .selectAll()
                .where('id', '=', id)
                .executeTakeFirstOrThrow();
              if (row.state !== 'preparing') throw new DomainError('conflict');
              const plan = parse(planSchema, row.plan);
              plan.sourceId = source.id;
              plan.sha256 = archive.sha256;
              plan.runtimeModId = jar.fabric?.id;
              plan.runtimeModVersion = jar.fabric?.version;
              if (side !== 'unknown' && plan.metadata && plan.metadata.side !== side) {
                plan.metadata.side = side;
                plan.metadata.environment = { kind: side, source: 'archive', original: [] };
              }
              const files = runtime.fileReadPhase(identifier, server);
              if (!modsDirectoryReady) {
                const root = await files.list('');
                const mods = root.find((entry) => entry.name === 'mods');
                if (mods && mods.kind !== 'directory') throw new DomainError('conflict');
                if (!mods) await runtime.adapter.createDirectory(identifier, '', 'mods');
                modsDirectoryReady = true;
              }
              if (serverStorageLimitBytes(server.limits.disk) !== null)
                assertServerStorageCapacity(
                  server.limits.disk,
                  (await runtime.fileDiskUsage(server, identifier)) + artifact.size,
                );
              const claim = await reserveUploadIngestion(
                connection,
                current,
                serverId,
                artifact.size,
                env,
              );
              try {
                plan.claimId = claim.id;
                plan.claimScope = (
                  await connection
                    .selectFrom('upload_ingestion_claims')
                    .select('scope_hash')
                    .where('id', '=', claim.id)
                    .executeTakeFirstOrThrow()
                ).scope_hash;
                await connection
                  .updateTable('minecraft_mod_changes')
                  .set({ plan: JSON.stringify(plan) })
                  .where('id', '=', id)
                  .execute();
                await runtime.authorizeTransfer(
                  current,
                  serverId,
                  true,
                  connection,
                  undefined,
                  server,
                );
                signal.throwIfAborted();
                dispatched = true;
                await runtime.adapter.uploadFile(identifier, plan.from, {
                  body: Readable.toWeb(
                    createReadStream(archive.path),
                  ) as ReadableStream<Uint8Array>,
                  contentLength: artifact.size,
                  maxBytes: artifact.size,
                  authorize: () =>
                    runtime.authorizeTransfer(
                      current,
                      serverId,
                      true,
                      connection,
                      undefined,
                      server,
                    ),
                });
                await claim.complete();
                await connection
                  .updateTable('minecraft_mod_changes')
                  .set({ state: 'ready', updated_at: new Date() })
                  .where('id', '=', id)
                  .where('state', '=', 'preparing')
                  .execute();
              } catch (error) {
                if (!dispatched || isUploadNotDispatched(error)) {
                  await claim.rejectBeforeDispatch();
                  dispatched = false;
                } else if (isUploadNotPublished(error)) {
                  await claim.rejectBeforePublication();
                  dispatched = false;
                }
                throw error;
              } finally {
                await claim.unlock();
              }
            },
          ),
        );
      } catch (error) {
        await db
          .updateTable('minecraft_mod_changes')
          .set({
            state: dispatched ? 'uncertain' : 'failed',
            error:
              error instanceof DomainError && error.details?.contentReason === 'client_only'
                ? 'client_only'
                : code(error),
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .where('state', 'in', ['preparing', 'queued'])
          .execute();
        if (signal.aborted) throw error;
      }
    }
    await Promise.all([next(), next()]);
    await coalesce(context, serverId, revision);
    await refreshGraph(context, serverId, revision);
  }
  function launch(
    context: AuthContext,
    serverId: string,
    revision: number,
    selection: MinecraftModSelection,
  ) {
    const abort = new AbortController();
    const old = runningTasks.get(serverId);
    old?.abort.abort();
    const promise = (async () => {
      await old?.promise.catch(() => {});
      try {
        await prepare(context, serverId, revision, selection, abort.signal);
        await db
          .updateTable('minecraft_mod_drafts')
          .set({ state: 'ready', updated_at: new Date() })
          .where('server_id', '=', serverId)
          .where('revision', '=', revision)
          .execute();
        queueCleanup(context, serverId);
      } catch (error) {
        await db
          .updateTable('minecraft_mod_drafts')
          .set({ state: 'failed', error: code(error), updated_at: new Date() })
          .where('server_id', '=', serverId)
          .where('revision', '=', revision)
          .execute();
      }
    })();
    runningTasks.set(serverId, { revision, abort, promise });
    void promise
      .catch(() => {})
      .finally(() => {
        if (runningTasks.get(serverId)?.revision === revision) runningTasks.delete(serverId);
      });
  }
  async function finish(
    connection: Kysely<Database>,
    serverId: string,
    changes: Change[],
    entries: readonly FilemanEntry[],
    applyId: string,
    current: AuthContext,
    files: FilemanReadService,
  ) {
    for (const row of changes) {
      const plan = parse(planSchema, row.plan);
      const entry = entries.find((item) => item.name === leaf(plan.to));
      await connection
        .deleteFrom('minecraft_mod_receipts')
        .where('server_id', '=', serverId)
        .where('path', 'in', [plan.from, ...plan.retired.map((item) => item.from), plan.to])
        .execute();
      if (row.action !== 'delete' && entry?.modifiedAt)
        await connection
          .insertInto('minecraft_mod_receipts')
          .values({
            server_id: serverId,
            path: plan.to,
            receipt: JSON.stringify({ ...plan, modifiedAt: entry.modifiedAt }),
          })
          .execute();
      await connection
        .updateTable('minecraft_mod_changes')
        .set({ state: 'applied', updated_at: new Date() })
        .where('id', '=', row.id)
        .execute();
    }
    const now = new Date();
    if (changes.some((row) => !parse(planSchema, row.plan).reuse))
      await connection
        .insertInto('minecraft_mod_restart')
        .values({ server_id: serverId, changed_at: now })
        .onConflict((c) => c.column('server_id').doUpdateSet({ changed_at: now }))
        .execute();
    await connection
      .updateTable('managed_servers')
      .set({ updated_at: now })
      .where('id', '=', serverId)
      .execute();
    await connection
      .updateTable('minecraft_mod_applies')
      .set({ state: 'published', updated_at: now })
      .where('id', '=', applyId)
      .execute();
    if (!changes.every((row) => parse(planSchema, row.plan).isolated))
      await connection
        .updateTable('minecraft_mod_drafts')
        .set({
          selection: JSON.stringify({
            roots: [],
            preferBeta: parse(
              minecraftModSelectionSchema,
              (await draft(connection, serverId))?.selection,
            ).preferBeta,
            idempotencyKey: applyId,
          }),
          state: 'ready',
          updated_at: now,
        })
        .where('server_id', '=', serverId)
        .execute();
    if (changes.every((row) => parse(planSchema, row.plan).isolated)) {
      const pendingDraft = await draft(connection, serverId);
      if (pendingDraft && pendingDraft.state !== 'preparing')
        await refreshDraftGraph(connection, serverId, pendingDraft, files, entries);
    }
    await recordAudit(connection, current, 'minecraft.mods.applied', {
      serverId,
      applyId,
      count: changes.length,
      paths: changes.slice(0, 100).map((row) => {
        const plan = parse(planSchema, row.plan);
        return row.action === 'delete' ? plan.from : plan.to;
      }),
    });
    inventoryCache.delete(serverId);
  }
  async function verifyMoves(files: FilemanReadService, moves: z.infer<typeof moveSchema>[]) {
    const entries = await list(files);
    for (const move of moves) {
      const target = entries.find((entry) => entry.name === leaf(move.to));
      if (
        target?.kind !== 'file' ||
        target.size !== move.size ||
        (!moves.some((other) => other.to === move.from) &&
          entries.some((entry) => entry.name === leaf(move.from)))
      )
        throw new DomainError('operation_uncertain');
    }
    return entries;
  }
  async function publish(
    identifier: string,
    connection: Kysely<Database>,
    current: AuthContext,
    server: Parameters<ManagementRuntime['fileReadPhase']>[1],
    serverId: string,
    dispatch: { id: string; changes: Change[]; moves: z.infer<typeof moveSchema>[] },
  ) {
    const { id, changes, moves } = dispatch;
    try {
      await runtime.authorizeTransfer(current, serverId, true, connection, undefined, server);
      for (let offset = 0; offset < moves.length; offset += 1000)
        await runtime.adapter.renameFiles(
          identifier,
          '',
          moves.slice(offset, offset + 1000).map(({ from, to }) => ({ from, to })),
        );
      const files = runtime.fileReadPhase(identifier, server);
      const after = await verifyMoves(files, moves);
      await connection
        .transaction()
        .execute((tx) => finish(tx, serverId, changes, after, id, current, files));
      return {
        state: 'published' as const,
        restartRequired: changes.some((row) => !parse(planSchema, row.plan).reuse),
      };
    } catch (error) {
      await connection
        .updateTable('minecraft_mod_applies')
        .set({ state: 'uncertain', updated_at: new Date() })
        .where('id', '=', id)
        .execute();
      await connection
        .updateTable('minecraft_mod_changes')
        .set({ state: 'uncertain', error: code(error), updated_at: new Date() })
        .where(
          'id',
          'in',
          changes.map((row) => row.id),
        )
        .execute();
      throw new DomainError('operation_uncertain');
    }
  }
  return {
    profile: (serverId: string) => profile(db, serverId),
    restartStatus,
    async updates(
      context: AuthContext,
      serverId: string,
      preferBeta = false,
    ): Promise<MinecraftModUpdates> {
      await authorized(context, serverId);
      const [info, stored] = await Promise.all([
        profile(db, serverId),
        db
          .selectFrom('minecraft_mod_receipts')
          .select(['path', 'receipt'])
          .where('server_id', '=', serverId)
          .orderBy('path')
          .execute(),
      ]);
      if (!info.supported || !info.installed) throw new DomainError('integration_unavailable');
      // Advice uses local receipts, never another Wings inventory poll. The UI matches
      // these exact path/version identities against its current observed inventory.
      const allPacks = stored.flatMap((row) => {
        const parsed = recordSchema.safeParse(row.receipt);
        const metadata = parsed.success ? parsed.data.metadata : null;
        return metadata
          ? [
              {
                path: row.path,
                provider: metadata.provider,
                projectId: metadata.projectId,
                versionId: metadata.versionId,
              },
            ]
          : [];
      });
      const packs = allPacks.slice(0, 512);
      const limited = packs.length !== allPacks.length;
      return cachedAdvice(
        db,
        digest(['updates', serverId, info.target, preferBeta, packs, limited]),
        async () => ({
          ...(await modUpdateAdvice({
            packs,
            target: info.target,
            preferBeta,
            provider,
            signal: AbortSignal.timeout(30_000),
          })),
          limited,
        }),
      );
    },
    async alternatives(
      context: AuthContext,
      serverId: string,
      name: 'modrinth' | 'curseforge',
      projectId: string,
      revision: number,
    ): Promise<MinecraftModAlternatives> {
      await authorized(context, serverId);
      const [info, current, config] = await Promise.all([
        profile(db, serverId),
        draft(db, serverId),
        getSettings(db, env),
      ]);
      const maxVersions = config.values.minecraftModAlternativeLimit;
      if (!info.supported || !info.installed) throw new DomainError('integration_unavailable');
      if (!current || current.revision !== revision) throw new DomainError('conflict');
      const selection = parse(minecraftModSelectionSchema, current.selection);
      const roots = selection.roots
        .filter((root) => root.provider === name)
        .map(({ provider: _, ...root }) => root);
      if (!roots.some((root) => root.projectId === projectId)) throw new DomainError('not_found');
      return cachedAdvice(
        db,
        digest([
          'alternatives-v2',
          serverId,
          info.target,
          revision,
          name,
          projectId,
          selection,
          maxVersions,
        ]),
        () =>
          modAlternativeAdvice({
            provider: provider(name),
            name,
            projectId,
            roots,
            revision,
            maxVersions,
            target: info.target,
            preferBeta: selection.preferBeta,
            signal: AbortSignal.timeout(30_000),
          }),
      );
    },
    async drain() {
      await Promise.allSettled([...runningTasks.values()].map((item) => item.promise));
      await Promise.allSettled([...cleanupTasks.values()]);
    },
    async snapshot(context: AuthContext, serverId: string): Promise<MinecraftModsSnapshot> {
      return runtime.fileReadScope(
        context,
        serverId,
        async (files, _identifier, connection, _actor, server) => {
          const restart = await restartStatus(context, serverId, true);
          queueCleanup(context, serverId);
          const [info, current, changes] = await Promise.all([
            profile(connection, serverId),
            draft(connection, serverId),
            rows(connection, serverId),
          ]);
          const cached = inventoryCache.get(serverId);
          const preparing = current?.state === 'preparing' && !!runningTasks.get(serverId);
          const entries =
            info.installed && info.supported
              ? preparing && cached && cached.expires > Date.now()
                ? cached.entries
                : await list(files)
              : [];
          if (!cached || entries !== cached.entries) {
            if (inventoryCache.size >= 32)
              inventoryCache.delete(inventoryCache.keys().next().value as string);
            // Metadata only; a final non-preparing snapshot always refreshes the directory.
            if (entries.length <= 2000 && JSON.stringify(entries).length <= 1024 ** 2)
              inventoryCache.set(serverId, { expires: Date.now() + 30_000, entries });
          }
          const existing = await receipts(connection, serverId, entries);
          const selected = current
            ? parse(minecraftModSelectionSchema, current.selection)
            : { roots: [], preferBeta: false };
          const own = changes.filter(
            (row) => row.action !== 'install' || row.revision === current?.revision,
          );
          return {
            supported: info.supported,
            installed: info.installed,
            running: server.runtime_state === 'running',
            version: info.target.minecraftVersion,
            loader: info.target.loader,
            revision: current?.revision ?? 0,
            preferBeta: selected.preferBeta,
            roots: selected.roots,
            preparing,
            ...(current?.error
              ? { error: current.error }
              : current?.state === 'preparing' && !preparing
                ? { error: 'operation_uncertain' }
                : {}),
            packs: entries
              .filter(
                (entry) =>
                  entry.kind === 'file' &&
                  /\.jar(?:\.disabled)?$/.test(entry.name) &&
                  !entry.name.startsWith('.'),
              )
              .map((entry) => ({
                id: `mods/${entry.name}`,
                path: `mods/${entry.name}`,
                name: entry.name,
                size: entry.size,
                state: entry.name.endsWith('.disabled')
                  ? ('disabled' as const)
                  : ('enabled' as const),
                metadata:
                  existing.find((item) => item.path === `mods/${entry.name}`)?.plan.metadata ??
                  null,
                aliases:
                  existing.find((item) => item.path === `mods/${entry.name}`)?.plan.aliases ?? [],
              })),
            changes: own.map((row) => {
              const plan = parse(planSchema, row.plan);
              return {
                id: row.id,
                action: row.action,
                name: plan.metadata?.name ?? leaf(plan.to),
                path: row.action === 'install' ? plan.to : plan.from,
                size: plan.size,
                metadata: plan.metadata,
                aliases: plan.aliases,
                dependency: plan.dependency,
                requiredBy: plan.requiredBy,
                forceIncompatible: plan.forceIncompatible,
                incompatibilities: plan.incompatibilities,
                ...(plan.isolated ? { immediate: true } : {}),
                state:
                  row.state === 'dispatched' ||
                  (!preparing && ['queued', 'preparing'].includes(row.state))
                    ? 'uncertain'
                    : (row.state as 'queued' | 'preparing' | 'ready' | 'failed' | 'uncertain'),
                ...(row.error ? { error: row.error } : {}),
              };
            }),
            blockers: z.array(minecraftModBlockerSchema).parse(current?.blockers ?? []),
            optional: (current?.optional ?? []) as MinecraftModsSnapshot['optional'],
            restart,
          };
        },
      );
    },
    async select(context: AuthContext, serverId: string, input: unknown) {
      const value = parse(minecraftModSelectionSchema, input);
      const { actor } = await authorized(context, serverId, true);
      const info = await profile(db, serverId);
      if (!info.supported || !info.installed) throw new DomainError('integration_unavailable');
      if (
        new Set(value.roots.map((root) => `${root.provider}:${root.projectId}`)).size !==
        value.roots.length
      )
        throw new DomainError('validation_failed');
      const outcome = await db.transaction().execute(async (tx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mods:${serverId}`},0))`.execute(
          tx,
        );
        const previous = await draft(tx, serverId);
        if (previous) {
          const old = parse(minecraftModSelectionSchema, previous.selection);
          if (old.idempotencyKey === value.idempotencyKey) {
            if (digest(old) !== digest(value)) throw new DomainError('conflict');
            return { revision: previous.revision, fresh: false };
          }
        }
        if (
          (await rows(tx, serverId)).some((row) => ['dispatched', 'uncertain'].includes(row.state))
        )
          throw new DomainError('operation_uncertain');
        const next = (previous?.revision ?? 0) + 1;
        await tx
          .insertInto('minecraft_mod_drafts')
          .values({
            server_id: serverId,
            revision: next,
            actor_user_id: actor.actorUserId,
            selection: JSON.stringify(value),
            state: 'preparing',
            blockers: '[]',
            optional: '[]',
            error: null,
          })
          .onConflict((c) =>
            c.column('server_id').doUpdateSet({
              revision: next,
              actor_user_id: actor.actorUserId,
              selection: JSON.stringify(value),
              state: 'preparing',
              blockers: '[]',
              optional: '[]',
              error: null,
              updated_at: new Date(),
            }),
          )
          .execute();
        await tx
          .updateTable('minecraft_mod_changes')
          .set({ state: 'cancelled', updated_at: new Date() })
          .where('server_id', '=', serverId)
          .where('action', '=', 'install')
          .where('state', 'in', ['queued', 'failed'])
          .execute();
        return { revision: next, fresh: true };
      });
      const { revision } = outcome;
      if (
        outcome.fresh &&
        (!runningTasks.has(serverId) || runningTasks.get(serverId)?.revision !== revision)
      )
        launch(actor, serverId, revision, value);
      return { revision };
    },
    async change(context: AuthContext, serverId: string, input: unknown) {
      const value = parse(minecraftModInstalledChangeSchema, input);
      await authorized(context, serverId, true);
      await cleanupTasks.get(serverId);
      const result = await runtime.fileMutationAccess(
        context,
        serverId,
        async (identifier, connection, current, server) => {
          const previous = await connection
            .selectFrom('minecraft_mod_changes')
            .selectAll()
            .where('server_id', '=', serverId)
            .where('actor_user_id', '=', current.actorUserId)
            .where('idempotency_key', '=', value.idempotencyKey)
            .executeTakeFirst();
          if (previous) {
            const plan = parse(planSchema, previous.plan);
            if (plan.from !== value.path || previous.action !== value.action)
              throw new DomainError('conflict');
            return { changeId: previous.id };
          }
          const info = await profile(connection, serverId);
          if (!info.supported) throw new DomainError('integration_unavailable');
          const entries = await list(runtime.fileReadPhase(identifier, server)),
            entry = entries.find((entry) => entry.name === leaf(value.path));
          if (entry?.kind !== 'file') throw new DomainError('not_found');
          const old = (await receipts(connection, serverId, entries)).find(
            (item) => item.path === value.path,
          )?.plan;
          const id = randomUUID(),
            to =
              value.action === 'delete'
                ? `mods/.nh-${id}.retired`
                : value.action === 'enable'
                  ? value.path.replace(/\.disabled$/, '')
                  : `${value.path}.disabled`;
          if (to === value.path || entries.some((entry) => entry.name === leaf(to)))
            throw new DomainError('conflict');
          if (
            (await rows(connection, serverId)).some((row) => {
              const plan = parse(planSchema, row.plan);
              return plan.from === value.path || plan.to === to;
            })
          )
            throw new DomainError('conflict');
          const currentDraft = await draft(connection, serverId);
          if (!currentDraft)
            await connection
              .insertInto('minecraft_mod_drafts')
              .values({
                server_id: serverId,
                revision: 0,
                actor_user_id: current.actorUserId,
                state: 'ready',
                selection: JSON.stringify({ roots: [], preferBeta: false, idempotencyKey: id }),
                blockers: '[]',
                optional: '[]',
                error: null,
              })
              .execute();
          const plan: Plan = {
            from: value.path,
            to,
            size: entry.size,
            modifiedAt: entry.modifiedAt,
            metadata: old?.metadata ?? null,
            sha256: old?.sha256,
            aliases: old?.aliases ?? [],
            reuse: false,
            dependencies: old?.dependencies ?? [],
            conflicts: old?.conflicts ?? [],
            dependency: false,
            requiredBy: [],
            forceIncompatible: false,
            incompatibilities: [],
            retired: [],
          };
          await connection
            .insertInto('minecraft_mod_changes')
            .values({
              id,
              server_id: serverId,
              revision: currentDraft?.revision ?? 0,
              actor_user_id: current.actorUserId,
              action: value.action,
              state: 'ready',
              idempotency_key: value.idempotencyKey,
              plan: JSON.stringify(plan),
              error: null,
            })
            .execute();
          return { changeId: id };
        },
      );
      await refreshGraph(context, serverId, (await draft(db, serverId))?.revision ?? 0);
      return result;
    },
    async toggle(context: AuthContext, serverId: string, input: unknown) {
      const value = parse(minecraftModToggleSchema, input);
      await authorized(context, serverId, true);
      await cleanupTasks.get(serverId);
      const result = await runtime.fileMutationAccess(
        context,
        serverId,
        async (identifier, connection, current, server) => {
          const dispatch = await connection.transaction().execute(
            async (
              tx,
            ): Promise<
              | {
                  replay: {
                    state: 'published' | 'dispatched' | 'uncertain';
                    path: string;
                    restartRequired: boolean;
                  };
                }
              | {
                  id: string;
                  changes: Change[];
                  moves: z.infer<typeof moveSchema>[];
                  path: string;
                }
            > => {
              await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mods:${serverId}`},0))`.execute(
                tx,
              );
              const previous = await tx
                .selectFrom('minecraft_mod_changes')
                .selectAll()
                .where('server_id', '=', serverId)
                .where('actor_user_id', '=', current.actorUserId)
                .where('idempotency_key', '=', value.idempotencyKey)
                .executeTakeFirst();
              const previousApply = await tx
                .selectFrom('minecraft_mod_applies')
                .selectAll()
                .where('server_id', '=', serverId)
                .where('actor_user_id', '=', current.actorUserId)
                .where('idempotency_key', '=', value.idempotencyKey)
                .executeTakeFirst();
              if (previous || previousApply) {
                if (!previous || !previousApply) throw new DomainError('conflict');
                const plan = parse(planSchema, previous.plan);
                if (
                  !plan.isolated ||
                  previous.action !== value.action ||
                  plan.from !== value.path ||
                  digest(previousApply.changes) !== digest([previous.id])
                )
                  throw new DomainError('conflict');
                return {
                  replay: {
                    state:
                      previousApply.state === 'published'
                        ? ('published' as const)
                        : previousApply.state === 'dispatched'
                          ? ('dispatched' as const)
                          : ('uncertain' as const),
                    path: plan.to,
                    restartRequired: previousApply.state === 'published',
                  },
                };
              }
              const info = await profile(tx, serverId);
              if (!info.supported || !info.installed)
                throw new DomainError('integration_unavailable');
              const to =
                value.action === 'enable'
                  ? value.path.replace(/\.disabled$/, '')
                  : `${value.path}.disabled`;
              const pending = await rows(tx, serverId);
              // An unconfirmed publication may have changed the installed dependency graph.
              if (pending.some((row) => ['dispatched', 'uncertain'].includes(row.state)))
                throw new DomainError('operation_uncertain');
              if (
                pending.some((row) => {
                  const plan = parse(planSchema, row.plan);
                  return [
                    plan.from,
                    plan.to,
                    ...plan.retired.flatMap((item) => [item.from, item.to]),
                  ].some((path) => path === value.path || path === to);
                })
              )
                throw new DomainError('conflict');
              const files = runtime.fileReadPhase(identifier, server);
              const entries = await list(files);
              const entry = entries.find((item) => item.name === leaf(value.path));
              if (entry?.kind !== 'file') throw new DomainError('not_found');
              if (entries.some((item) => item.name === leaf(to))) throw new DomainError('conflict');
              const installed = await receipts(tx, serverId, entries);
              const old = installed.find((item) => item.path === value.path)?.plan;
              const plan: Plan = {
                isolated: true,
                from: value.path,
                to,
                size: entry.size,
                modifiedAt: entry.modifiedAt,
                metadata: old?.metadata ?? null,
                sha256: old?.sha256,
                aliases: old?.aliases ?? [],
                dependencies: old?.dependencies ?? [],
                conflicts: old?.conflicts ?? [],
                runtimeModId: old?.runtimeModId,
                runtimeModVersion: old?.runtimeModVersion,
                target: old?.target,
                dependency: false,
                requiredBy: [],
                forceIncompatible: false,
                incompatibilities: [],
                retired: [],
                reuse: false,
              };
              const id = randomUUID();
              const revision = (await draft(tx, serverId))?.revision ?? 0;
              const change = await tx
                .insertInto('minecraft_mod_changes')
                .values({
                  id,
                  server_id: serverId,
                  revision,
                  actor_user_id: current.actorUserId,
                  action: value.action,
                  state: 'dispatched',
                  idempotency_key: value.idempotencyKey,
                  plan: JSON.stringify(plan),
                  error: null,
                })
                .returningAll()
                .executeTakeFirstOrThrow();
              // Only installed receipts plus this one toggle participate. A prepared
              // dependency is not installed until the user publishes their draft.
              await reconcileGraph(tx, serverId, entries, [change], files, installed);
              const moves = [
                { from: plan.from, to: plan.to, size: plan.size, modifiedAt: plan.modifiedAt },
              ];
              await tx
                .insertInto('minecraft_mod_applies')
                .values({
                  id,
                  server_id: serverId,
                  revision,
                  actor_user_id: current.actorUserId,
                  idempotency_key: value.idempotencyKey,
                  changes: JSON.stringify([change.id]),
                  moves: JSON.stringify(moves),
                  state: 'dispatched',
                })
                .execute();
              return { id, changes: [change], moves, path: to };
            },
          );
          if ('replay' in dispatch) return dispatch.replay;
          try {
            return {
              ...(await publish(identifier, connection, current, server, serverId, dispatch)),
              path: dispatch.path,
            };
          } catch (error) {
            if (!(error instanceof DomainError) || error.code !== 'operation_uncertain')
              throw error;
            return { state: 'uncertain' as const, path: dispatch.path, restartRequired: false };
          }
        },
      );
      queueCleanup(context, serverId);
      return result;
    },
    async cancel(context: AuthContext, serverId: string, changeId: string) {
      parse(z.uuid(), changeId);
      await authorized(context, serverId, true);
      await cleanupTasks.get(serverId);
      await runtime.fileMutationAccess(context, serverId, async (_id, connection) => {
        const row = await connection
          .selectFrom('minecraft_mod_changes')
          .selectAll()
          .where('id', '=', changeId)
          .where('server_id', '=', serverId)
          .executeTakeFirst();
        if (!row) throw new DomainError('not_found');
        if (['dispatched', 'uncertain', 'applied'].includes(row.state))
          throw new DomainError('operation_uncertain');
        if (row.action === 'install') throw new DomainError('validation_failed');
        await connection
          .updateTable('minecraft_mod_changes')
          .set({ state: 'cancelled', updated_at: new Date() })
          .where('id', '=', changeId)
          .execute();
      });
      await refreshGraph(context, serverId, (await draft(db, serverId))?.revision ?? 0);
    },
    async apply(context: AuthContext, serverId: string, input: unknown) {
      const value = parse(minecraftModApplySchema, input);
      await authorized(context, serverId, true);
      await cleanupTasks.get(serverId);
      const result = await runtime.fileMutationAccess(
        context,
        serverId,
        async (identifier, connection, current, server) => {
          const dispatch = await connection.transaction().execute(async (tx) => {
            await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mods:${serverId}`},0))`.execute(
              tx,
            );
            const previous = await tx
              .selectFrom('minecraft_mod_applies')
              .selectAll()
              .where('server_id', '=', serverId)
              .where('actor_user_id', '=', current.actorUserId)
              .where('idempotency_key', '=', value.idempotencyKey)
              .executeTakeFirst();
            if (previous) {
              if (previous.revision !== value.revision) throw new DomainError('conflict');
              return { replay: { state: previous.state, restartRequired: true } };
            }
            const currentDraft = await draft(tx, serverId);
            if (
              (currentDraft?.revision ?? 0) !== value.revision ||
              currentDraft?.state === 'preparing'
            )
              throw new DomainError('conflict');
            if (Array.isArray(currentDraft?.blockers) && currentDraft.blockers.length) {
              const missing = currentDraft.blockers.some(
                (blocker) =>
                  blocker &&
                  typeof blocker === 'object' &&
                  'reason' in blocker &&
                  blocker.reason === 'unresolved',
              );
              throw new DomainError(
                missing ? 'content_dependency_missing' : 'content_dependency_conflict',
              );
            }
            const changes = (await rows(tx, serverId)).filter(
              (row) => row.action !== 'install' || row.revision === value.revision,
            );
            if (!changes.length || changes.some((row) => row.state !== 'ready'))
              throw new DomainError('conflict');
            const currentTarget = (await profile(tx, serverId)).target;
            if (
              changes.some(
                (row) =>
                  row.action === 'install' &&
                  digest(parse(planSchema, row.plan).target) !== digest(currentTarget),
              )
            )
              throw new DomainError('content_plan_expired');
            const files = runtime.fileReadPhase(identifier, server),
              entries = await list(files);
            await reconcileGraph(tx, serverId, entries, changes, files);
            const moves = changes.flatMap((row) => {
              const plan = parse(planSchema, row.plan);
              if (plan.reuse) return [];
              return [
                ...plan.retired,
                { from: plan.from, to: plan.to, size: plan.size, modifiedAt: plan.modifiedAt },
              ];
            });
            const sources = new Set(moves.map((move) => move.from));
            if (
              sources.size !== moves.length ||
              new Set(moves.map((move) => move.to)).size !== moves.length
            )
              throw new DomainError('conflict');
            for (const move of moves) {
              const entry = entries.find((entry) => entry.name === leaf(move.from));
              if (
                entry?.kind !== 'file' ||
                entry.size !== move.size ||
                (move.modifiedAt && move.modifiedAt !== entry.modifiedAt) ||
                (!sources.has(move.to) && entries.some((entry) => entry.name === leaf(move.to)))
              )
                throw new DomainError('conflict');
            }
            const id = randomUUID();
            await tx
              .insertInto('minecraft_mod_applies')
              .values({
                id,
                server_id: serverId,
                revision: value.revision,
                actor_user_id: current.actorUserId,
                idempotency_key: value.idempotencyKey,
                changes: JSON.stringify(changes.map((row) => row.id)),
                moves: JSON.stringify(moves),
                state: 'dispatched',
              })
              .execute();
            await tx
              .updateTable('minecraft_mod_changes')
              .set({ state: 'dispatched', updated_at: new Date() })
              .where(
                'id',
                'in',
                changes.map((row) => row.id),
              )
              .execute();
            return { id, changes, moves };
          });
          if ('replay' in dispatch) return dispatch.replay;
          return publish(identifier, connection, current, server, serverId, dispatch);
        },
      );
      queueCleanup(context, serverId);
      return result;
    },
    async recover(context: AuthContext, serverId: string) {
      await authorized(context, serverId, true);
      await cleanupTasks.get(serverId);
      return runtime.uploadBatchAccess(
        context,
        serverId,
        async (identifier, connection, current, server) => {
          const applies = await connection
            .selectFrom('minecraft_mod_applies')
            .selectAll()
            .where('server_id', '=', serverId)
            .where('state', 'in', ['dispatched', 'uncertain'])
            .execute();
          const pendingChanges = applies.length
            ? await connection
                .selectFrom('minecraft_mod_changes')
                .selectAll()
                .where('server_id', '=', serverId)
                .where(
                  'id',
                  'in',
                  applies.flatMap((apply) => parse(z.array(z.string()), apply.changes)),
                )
                .execute()
            : [];
          const isolated = applies.filter((apply) => {
            const ids = parse(z.array(z.string()), apply.changes);
            return (
              ids.length > 0 &&
              ids.every((id) => {
                const row = pendingChanges.find((change) => change.id === id);
                return row && parse(planSchema, row.plan).isolated;
              })
            );
          });
          if (!isolated.length && runningTasks.has(serverId)) throw new DomainError('conflict');
          let recovered = 0;
          for (const apply of isolated.length ? isolated : applies) {
            const moves = parse(z.array(moveSchema), apply.moves);
            const ids = parse(z.array(z.string()), apply.changes);
            const changes = pendingChanges.filter((change) => ids.includes(change.id));
            try {
              const files = runtime.fileReadPhase(identifier, server);
              const after = await verifyMoves(files, moves);
              await connection
                .transaction()
                .execute((tx) => finish(tx, serverId, changes, after, apply.id, current, files));
              recovered++;
            } catch {
              /* Partial external effects require explicit repair; never replay a rename batch. */
            }
          }
          if (isolated.length)
            return {
              recovered,
              uncertain: (await rows(connection, serverId)).filter((row) =>
                ['dispatched', 'uncertain'].includes(row.state),
              ).length,
            };
          const fenced = new Set(
            applies.flatMap((apply) => parse(z.array(z.string()), apply.changes)),
          );
          const interrupted = (await rows(connection, serverId)).filter(
            (row) =>
              row.action === 'install' &&
              !fenced.has(row.id) &&
              ['preparing', 'uncertain'].includes(row.state),
          );
          for (const row of interrupted) {
            const plan = parse(planSchema, row.plan);
            if (
              plan.from !== `mods/.nh-${row.id}.jar.pending` ||
              !plan.sha256 ||
              !plan.claimId ||
              !plan.claimScope
            )
              continue;
            const files = runtime.fileReadPhase(identifier, server),
              entries = await list(files),
              entry = entries.find((entry) => entry.name === leaf(plan.from));
            if (entry?.kind !== 'file' || entry.size !== plan.size) continue;
            const acquired = await sql<{
              acquired: boolean;
            }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${`:nickhosting:upload:${plan.claimId}`},0)) as acquired`.execute(
              connection,
            );
            if (!acquired.rows[0]?.acquired) continue;
            try {
              const claim = await connection
                .selectFrom('upload_ingestion_claims')
                .selectAll()
                .where('id', '=', plan.claimId)
                .executeTakeFirst();
              if (
                claim &&
                (claim.server_id !== serverId ||
                  claim.actor_user_id !== row.actor_user_id ||
                  claim.scope_hash !== plan.claimScope ||
                  Number(claim.declared_bytes) !== plan.size ||
                  claim.scope.pterodactylServerUuid !== server.pterodactyl_uuid ||
                  claim.scope.externalId !== server.external_id)
              )
                continue;
              const download = await runtime.adapter.downloadFile(identifier, plan.from, {
                maxBytes: plan.size,
                authorize: () =>
                  runtime.authorizeTransfer(
                    current,
                    serverId,
                    false,
                    connection,
                    undefined,
                    server,
                  ),
              });
              const hash = createHash('sha256');
              let bytes = 0;
              if (!download.body) continue;
              const reader = download.body.getReader();
              try {
                for (;;) {
                  const next = await reader.read();
                  if (next.done) break;
                  bytes += next.value.length;
                  if (bytes > plan.size) {
                    await reader.cancel();
                    throw new DomainError('operation_uncertain');
                  }
                  hash.update(next.value);
                }
              } finally {
                reader.releaseLock();
              }
              if (bytes !== plan.size || hash.digest('hex') !== plan.sha256) continue;
              // This unique destination is published only after the adapter finished
              // its isolated upload and renamed away the temporary file. Matching
              // verified bytes prove publication; no body is replayed during recovery.
              await connection.transaction().execute(async (tx) => {
                await runtime.authorizeTransfer(current, serverId, true, tx, undefined, server);
                await tx
                  .deleteFrom('upload_ingestion_claims')
                  .where('id', '=', plan.claimId as string)
                  .where('server_id', '=', serverId)
                  .where('scope_hash', '=', plan.claimScope as string)
                  .execute();
                await tx
                  .updateTable('minecraft_mod_changes')
                  .set({ state: 'ready', error: null, updated_at: new Date() })
                  .where('id', '=', row.id)
                  .execute();
                await recordAudit(tx, current, 'minecraft.mods.preparation_reconciled', {
                  serverId,
                  changeId: row.id,
                });
              });
              recovered++;
            } finally {
              await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${`:nickhosting:upload:${plan.claimId}`},0))`.execute(
                connection,
              );
            }
          }
          await connection
            .updateTable('minecraft_mod_changes')
            .set({ state: 'failed', error: 'operation_uncertain', updated_at: new Date() })
            .where('server_id', '=', serverId)
            .where('state', 'in', ['preparing', 'queued'])
            .execute();
          const currentDraft = await draft(connection, serverId);
          if (currentDraft?.state === 'preparing')
            await connection
              .updateTable('minecraft_mod_drafts')
              .set({ state: 'failed', error: 'operation_uncertain' })
              .where('server_id', '=', serverId)
              .execute();
          return {
            recovered,
            uncertain: (await rows(connection, serverId)).filter((row) =>
              ['dispatched', 'uncertain'].includes(row.state),
            ).length,
          };
        },
        true,
      );
    },
  };
}
