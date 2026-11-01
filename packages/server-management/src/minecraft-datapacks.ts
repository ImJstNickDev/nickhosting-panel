import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { type Database, recordAudit } from '@nickhosting/database';
import type { FilemanEntry, FilemanReadService } from '@nickhosting/game-sdk';
import {
  inspectMinecraftDatapackSelection,
  parseMinecraftProperties,
} from '@nickhosting/minecraft';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { inspectMinecraftDatapackArchive } from '../../../games/minecraft/src/datapack-archive.js';
import {
  type MinecraftDatapackSnapshot,
  minecraftDatapackApplySchema,
  minecraftDatapackChangeSchema,
  minecraftDatapackNameSchema,
  minecraftDatapackWorldSchema,
} from '../../../games/minecraft/src/datapack-contracts.js';
import {
  inspectMinecraftDatapackMetadata,
  minecraftSupportsDatapacks,
} from '../../../games/minecraft/src/datapacks.js';
import type { Environment } from './admission.js';
import {
  assertDatapackDependencyGraph,
  type DatapackProvenance,
  datapackProvenanceSchema,
  datapackReceipts,
  datapackStateRows,
} from './minecraft-datapack-dependencies.js';
import { minecraftModContentReceipts } from './minecraft-mod-receipts.js';
import { inspectMinecraftCombination } from './minecraft-registry.js';
import { createMinecraftSourceStore } from './minecraft-sources.js';
import { permissionRuntime } from './permission-runtime.js';
import { authorizeServer, parse } from './registry.js';
import type { ManagementRuntime } from './runtime.js';
import { assertServerStorageCapacity, serverStorageLimitBytes } from './storage-capacity.js';
import { reserveUploadIngestion } from './upload-admission.js';

const planSchema = z.object({
  catalog: datapackProvenanceSchema.optional(),
  from: z.string(),
  to: z.string().nullable(),
  kind: z.enum(['zip', 'directory']),
  size: z.number().nonnegative(),
  metadata: z.unknown().nullable(),
  nativeEnable: z.boolean().optional(),
  metadataRelease: z.string().optional(),
  modifiedAt: z.string().optional(),
  replacement: z
    .object({
      from: z.string(),
      to: z.string(),
      kind: z.enum(['zip', 'directory']),
      size: z.number().nonnegative(),
      modifiedAt: z.string().optional(),
    })
    .optional(),
});
type Plan = z.infer<typeof planSchema>;
const activeStates = ['preparing', 'ready', 'dispatched', 'uncertain', 'failed'] as const;
const hiddenRoot = '.nickhosting-datapacks';
const directory = (world: string) => `${world}/datapacks`;
const disabledRoot = (world: string) => `${hiddenRoot}/${world}/disabled`;
const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const leaf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const failureCode = (error: unknown) =>
  error instanceof DomainError ? error.code : 'integration_unavailable';
export const datapacksSupported = minecraftSupportsDatapacks;
/** A single bounded snapshot after a batch, not a directory request per file.
 * Wings rename can return 204 for a missing source: response status alone is not a receipt. */
export async function verifyDatapackMoves(
  files: FilemanReadService,
  moves: readonly { from: string; to: string; size: number; kind: 'zip' | 'directory' }[],
) {
  const dirs = [...new Set(moves.flatMap((move) => [parent(move.from), parent(move.to)]))];
  const listings = new Map(
    (await files.listMany(dirs)).map((result) => [result.directory, result]),
  );
  const receipts = new Map<string, FilemanEntry>();
  for (const move of moves) {
    const before = listings.get(parent(move.from));
    const after = listings.get(parent(move.to));
    if (!before || !after || !('files' in before) || !('files' in after))
      throw new DomainError('operation_uncertain');
    const target = after.files.find((file) => file.name === leaf(move.to));
    if (
      (!moves.some((other) => other.to === move.from) &&
        before.files.some((file) => file.name === leaf(move.from))) ||
      !target ||
      target.kind !== (move.kind === 'zip' ? 'file' : 'directory') ||
      (move.kind === 'zip' && target.size !== move.size)
    )
      throw new DomainError('operation_uncertain');
    receipts.set(move.to, target);
  }
  return receipts;
}
export function createMinecraftDatapackService(options: {
  db: Kysely<Database>;
  runtime: ManagementRuntime;
  env?: Environment;
}) {
  const { db, env = {} } = options;
  const runtime = permissionRuntime(options.runtime, 'game.minecraft.datapacks');
  async function profile(connection: Kysely<Database>, serverId: string) {
    const value = await connection
      .selectFrom('minecraft_server_profiles')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (!value) throw new DomainError('not_found');
    const choice = await inspectMinecraftCombination(connection, value.combination_id, env);
    return { installed: value.installed, version: choice.combination.release };
  }
  async function worlds(files: FilemanReadService) {
    const [properties, root] = await Promise.all([
      files.read({ path: 'server.properties', maxBytes: 1048576, missing: 'allow' }),
      files.list(''),
    ]);
    const selected =
      parseMinecraftProperties(Buffer.from(properties ?? []).toString('utf8'))['level-name'] ??
      'world';
    const candidates = root.filter(
      (entry) =>
        entry.kind === 'directory' && minecraftDatapackWorldSchema.safeParse(entry.name).success,
    );
    if (candidates.length > 100) throw new DomainError('validation_failed');
    const results = candidates.length
      ? await files.listMany(candidates.map((entry) => entry.name))
      : [];
    if (results.some((result) => 'error' in result && result.error !== 'not_found'))
      throw new DomainError('integration_unavailable');
    return {
      selected,
      worlds: results
        .filter(
          (result) =>
            'files' in result &&
            result.files.some((entry) => entry.name === 'level.dat' && entry.kind === 'file'),
        )
        .map((result) => ({ name: result.directory, selected: result.directory === selected })),
    };
  }
  async function listOptional(
    files: FilemanReadService,
    path: string,
  ): Promise<readonly FilemanEntry[]> {
    if (path) {
      // Missing optional directories are normal on the first visit. Some Wings
      // versions report them as a generic error, so prove absence from the
      // cached parent listing instead of probing a path that does not exist.
      const entries = await listOptional(files, parent(path));
      const entry = entries.find((item) => item.name === leaf(path));
      if (!entry) return [];
      if (entry.kind !== 'directory') throw new DomainError('provenance_mismatch');
    }
    return files.list(path);
  }
  async function inventory(
    files: FilemanReadService,
    world: string,
    version: string,
    changes: Awaited<ReturnType<typeof changeRows>>,
  ) {
    const roots = [directory(world), disabledRoot(world)];
    const results = await Promise.all(roots.map((root) => listOptional(files, root)));
    const packs: MinecraftDatapackSnapshot['packs'] = [];
    for (let i = 0; i < roots.length; i++)
      for (const entry of results[i] ?? []) {
        if (entry.kind === 'symlink') continue;
        const name = entry.kind === 'file' ? entry.name.replace(/\.disabled$/, '') : entry.name;
        const pending = entry.kind === 'file' && entry.name.endsWith('.pending');
        if (
          pending ||
          !minecraftDatapackNameSchema.safeParse(name).success ||
          (entry.kind === 'file' && !name.endsWith('.zip'))
        )
          continue;
        const path = `${roots[i]}/${entry.name}`;
        // ZIP metadata is inspected on demand. A prior installation receipt
        // cannot prove the bytes are unchanged after Fileman/SFTP edits.
        const receipt = changes.find((change) => {
          const plan = parse(planSchema, change.plan);
          return (
            change.state === 'applied' &&
            plan.to === path &&
            plan.size === entry.size &&
            !!entry.modifiedAt &&
            plan.modifiedAt === entry.modifiedAt &&
            plan.metadataRelease === version
          );
        });
        const metadata = receipt
          ? (parse(planSchema, receipt.plan)
              .metadata as MinecraftDatapackSnapshot['packs'][number]['metadata'])
          : null;
        packs.push({
          id: path,
          path,
          name,
          kind: entry.kind === 'directory' ? 'directory' : 'zip',
          state:
            i === 1 || (entry.kind === 'file' && entry.name.endsWith('.disabled'))
              ? 'disabled'
              : 'enabled',
          nativeState: 'unknown',
          metadata,
          compatibility: metadata?.compatibility ?? 'unknown',
        });
      }
    // Only small pack.mcmeta files for folders, in the shared four-reader Fileman scope.
    const folders = packs.filter((pack) => pack.kind === 'directory');
    if (folders.length > 128 || packs.length > 1000) throw new DomainError('validation_failed');
    if (folders.length) {
      const values = await files.readMany(
        folders.map((pack) => ({
          path: `${pack.path}/pack.mcmeta`,
          maxBytes: 65536,
          missing: 'allow',
        })),
      );
      for (const pack of folders) {
        const bytes = values.get(`${pack.path}/pack.mcmeta`);
        if (!bytes) continue;
        try {
          pack.metadata = inspectMinecraftDatapackMetadata(
            JSON.parse(Buffer.from(bytes).toString('utf8')),
            version,
          );
          pack.compatibility = pack.metadata.compatibility;
        } catch {
          pack.compatibility = 'invalid';
        }
      }
    }
    const level = await files.read({
      path: `${world}/level.dat`,
      maxBytes: 8 * 1024 ** 2,
      missing: 'allow',
    });
    let selection: ReturnType<typeof inspectMinecraftDatapackSelection>;
    try {
      selection = level ? inspectMinecraftDatapackSelection(level) : undefined;
    } catch {
      selection = undefined;
    }
    for (const pack of packs) {
      const id = `file/${pack.name}`;
      pack.nativeState = selection?.disabled.includes(id)
        ? 'disabled'
        : selection?.enabled.includes(id)
          ? 'enabled'
          : 'unknown';
    }
    return packs;
  }
  async function ensureDirectories(identifier: string, files: FilemanReadService, path: string) {
    let root = '';
    for (const name of path.split('/')) {
      const existing = (await files.list(root)).find((file) => file.name === name);
      if (existing && existing.kind !== 'directory') throw new DomainError('conflict');
      if (!existing) await runtime.adapter.createDirectory(identifier, root, name);
      root = [root, name].filter(Boolean).join('/');
    }
  }
  async function changeRows(connection: Kysely<Database>, serverId: string, world: string) {
    return datapackStateRows(connection, serverId, world);
  }
  const cleanupTasks = new Set<Promise<void>>();
  function queueCleanup(context: AuthContext, serverId: string, applyId: string) {
    const runtime = permissionRuntime(options.runtime, 'game.minecraft.datapacks', 'delete');
    const task = (async () => {
      // Leave the publication lock before reclaiming known, retired paths. A
      // normal UI operation always wins over this optional cleanup acquisition.
      await delay(25);
      try {
        await runtime.fileMutationAccess(
          context,
          serverId,
          async (identifier, connection, current) => {
            const apply = await connection
              .selectFrom('minecraft_datapack_applies')
              .selectAll()
              .where('id', '=', applyId)
              .where('server_id', '=', serverId)
              .where('state', 'in', ['published', 'reconciled'])
              .executeTakeFirst();
            if (!apply || apply.cleanup_state === 'complete' || !apply.cleanup.length) return;
            const changes = await connection
              .selectFrom('minecraft_datapack_changes')
              .selectAll()
              .where('server_id', '=', serverId)
              .where('id', 'in', apply.changes)
              .execute();
            // A retried change reuses its retirement path. Only the latest
            // successful publication owns cleanup; an older receipt must never
            // remove the rollback bytes of an interrupted retry.
            const laterApplies = await connection
              .selectFrom('minecraft_datapack_applies')
              .select('changes')
              .where('server_id', '=', serverId)
              .where('world', '=', apply.world)
              .where('id', '!=', applyId)
              .where('created_at', '>=', apply.created_at)
              .execute();
            const superseded = new Set(laterApplies.flatMap((item) => item.changes));
            const owned = new Set<string>();
            const allowed = new Set(
              changes.flatMap((change) => {
                const plan = parse(planSchema, change.plan);
                const paths = [
                  ...(plan.replacement ? [plan.replacement.to] : []),
                  ...(change.action === 'delete'
                    ? [`${hiddenRoot}/${change.world}/trash/${change.id}-${change.name}`]
                    : []),
                ];
                if (change.state === 'applied' && !superseded.has(change.id))
                  for (const path of paths) owned.add(path);
                return paths;
              }),
            );
            if (apply.cleanup.some((path) => !allowed.has(path)))
              throw new DomainError('provenance_mismatch');
            const cleanup = apply.cleanup.filter((path) => owned.has(path));
            if (cleanup.length) {
              await runtime.authorizeTransfer(current, serverId, true, connection);
              await authorizeServer(
                connection,
                current,
                serverId,
                'game.minecraft.datapacks.delete',
              );
              await runtime.adapter.deleteFiles(identifier, '', cleanup);
            }
            await connection
              .updateTable('minecraft_datapack_applies')
              .set({ cleanup_state: 'complete', updated_at: new Date() })
              .where('id', '=', applyId)
              .execute();
            await recordAudit(connection, current, 'minecraft.datapack.cleanup', {
              serverId,
              applyId,
              state: 'complete',
            });
          },
        );
      } catch (error) {
        await db
          .updateTable('minecraft_datapack_applies')
          .set({ cleanup_state: 'failed', updated_at: new Date() })
          .where('id', '=', applyId)
          .where('server_id', '=', serverId)
          .execute();
        await recordAudit(db, context, 'minecraft.datapack.cleanup', {
          serverId,
          applyId,
          state: 'failed',
          error: failureCode(error),
        });
      }
    })();
    cleanupTasks.add(task);
    void task.catch(() => {}).finally(() => cleanupTasks.delete(task));
  }
  return {
    /** Isolated tests/shutdown can wait for authorized cleanup without blocking Apply. */
    async drainCleanup() {
      await Promise.allSettled([...cleanupTasks]);
    },
    async snapshot(
      context: AuthContext,
      serverId: string,
      requestedWorld?: string,
    ): Promise<MinecraftDatapackSnapshot> {
      return runtime.fileReadScope(
        context,
        serverId,
        async (files, _identifier, connection, _current, server) => {
          const info = await profile(connection, serverId);
          if (!info.installed)
            return {
              world: '',
              selectedWorld: null,
              worlds: [],
              running: false,
              version: info.version,
              supported: datapacksSupported(info.version),
              installed: false,
              packs: [],
              changes: [],
              reload: { state: 'not_required' },
            };
          const available = await worlds(files);
          // An installed server may not have generated its first world yet.
          // An explicitly requested missing world remains a genuine 404.
          if (requestedWorld === undefined && available.worlds.length === 0)
            return {
              world: '',
              selectedWorld: available.selected,
              worlds: [],
              running: server.runtime_state === 'running',
              version: info.version,
              supported: datapacksSupported(info.version),
              installed: info.installed,
              packs: [],
              changes: [],
              reload: { state: 'not_required' },
            };
          const world = parse(minecraftDatapackWorldSchema, requestedWorld ?? available.selected);
          if (!available.worlds.some((item) => item.name === world))
            throw new DomainError('not_found');
          const [changes, applies] = await Promise.all([
            changeRows(connection, serverId, world),
            connection
              .selectFrom('minecraft_datapack_applies')
              .selectAll()
              .where('server_id', '=', serverId)
              .where('world', '=', world)
              .orderBy('created_at', 'desc')
              .execute(),
          ]);
          const apply = applies[0];
          const fenced = new Set(applies.flatMap((item) => item.changes));
          return {
            world,
            selectedWorld: available.selected,
            worlds: available.worlds,
            running: server.runtime_state === 'running',
            version: info.version,
            supported: datapacksSupported(info.version),
            installed: info.installed,
            packs: await inventory(files, world, info.version, changes),
            changes: changes
              .filter((change) =>
                activeStates.includes(change.state as (typeof activeStates)[number]),
              )
              .map((change) => ({
                id: change.id,
                action: change.action,
                name: change.name,
                cancellable:
                  !fenced.has(change.id) &&
                  ['preparing', 'ready', 'failed', 'uncertain'].includes(change.state),
                state:
                  change.state === 'dispatched'
                    ? 'uncertain'
                    : (change.state as 'preparing' | 'ready' | 'failed' | 'uncertain'),
                ...(change.error ? { error: change.error } : {}),
              })),
            reload: {
              state: apply?.state === 'uncertain' ? 'uncertain' : (apply?.reload ?? 'not_required'),
            },
          };
        },
      );
    },
    async inspect(context: AuthContext, serverId: string, input: unknown) {
      const value = parse(
        z.strictObject({ world: minecraftDatapackWorldSchema, path: z.string().max(512) }),
        input,
      );
      if (![directory(value.world), disabledRoot(value.world)].includes(parent(value.path)))
        throw new DomainError('validation_failed');
      return runtime.fileReadScope(context, serverId, async (files, _identifier, connection) => {
        const [info, entries] = await Promise.all([
          profile(connection, serverId),
          files.list(parent(value.path)),
        ]);
        const entry = entries.find((item) => item.name === leaf(value.path));
        if (!entry || entry.kind === 'symlink') throw new DomainError('not_found');
        if (entry.kind === 'directory') {
          const bytes = await files.read({ path: `${value.path}/pack.mcmeta`, maxBytes: 65536 });
          let raw: unknown;
          try {
            raw = JSON.parse(Buffer.from(bytes ?? []).toString('utf8'));
          } catch {
            raw = undefined;
          }
          return { metadata: inspectMinecraftDatapackMetadata(raw, info.version) };
        }
        if (!/\.zip(?:\.disabled)?$/.test(entry.name)) throw new DomainError('validation_failed');
        if (entry.size > 8 * 1024 ** 2) return { metadata: null, reason: 'too_large' as const };
        const bytes = await files.read({ path: value.path, maxBytes: Math.max(1, entry.size) });
        if (!bytes) throw new DomainError('not_found');
        return { metadata: await inspectMinecraftDatapackArchive(bytes, info.version) };
      });
    },
    async recover(context: AuthContext, serverId: string, input: unknown) {
      const { world } = parse(z.strictObject({ world: minecraftDatapackWorldSchema }), input);
      const pending = await changeRows(db, serverId, world);
      const runtime = permissionRuntime(
        options.runtime,
        'game.minecraft.datapacks',
        pending.length && pending.every((row) => row.action === 'delete') ? 'delete' : 'write',
      );
      return runtime.fileMutationAccess(
        context,
        serverId,
        async (identifier, connection, current, server) => {
          const rows = (await changeRows(connection, serverId, world)).filter((row) =>
            ['uncertain', 'dispatched', 'preparing'].includes(row.state),
          );
          const applies = await connection
            .selectFrom('minecraft_datapack_applies')
            .selectAll()
            .where('server_id', '=', serverId)
            .where('world', '=', world)
            .execute();
          const fenced = new Set(applies.flatMap((apply) => apply.changes));
          const plans = rows.map((row) => ({ row, plan: parse(planSchema, row.plan) }));
          const paths = [
            ...new Set(
              plans.flatMap(({ row, plan }) => [
                parent(plan.from),
                parent(plan.to ?? `${hiddenRoot}/${world}/trash/${row.id}-${row.name}`),
                ...(plan.replacement ? [parent(plan.replacement.to)] : []),
              ]),
            ),
          ];
          const results = paths.length
            ? await runtime.fileReadPhase(identifier, server).listMany(paths)
            : [];
          const entry = (path: string) => {
            const result = results.find((item) => item.directory === parent(path));
            if (!result || ('error' in result && result.error !== 'not_found'))
              throw new DomainError('integration_unavailable');
            if (!('files' in result)) return undefined;
            return result.files.find((file) => file.name === leaf(path));
          };
          const matches = (path: string, kind: Plan['kind'], size: number) => {
            const item = entry(path);
            return (
              item?.kind === (kind === 'zip' ? 'file' : 'directory') &&
              (kind === 'directory' || item.size === size)
            );
          };
          let recovered = 0;
          const relinquishedCleanup = new Set<string>();
          for (const { row, plan } of plans) {
            if (plan.nativeEnable) continue;
            if (row.action === 'install' && !fenced.has(row.id)) {
              await connection
                .updateTable('minecraft_datapack_changes')
                .set({ state: 'failed', error: 'operation_uncertain', updated_at: new Date() })
                .where('id', '=', row.id)
                .execute();
              recovered++;
              continue;
            }
            const target = plan.to ?? `${hiddenRoot}/${world}/trash/${row.id}-${row.name}`;
            const retired = plan.replacement;
            const published =
              !entry(plan.from) &&
              matches(target, plan.kind, plan.size) &&
              (!retired || matches(retired.to, retired.kind, retired.size));
            const original =
              matches(plan.from, plan.kind, plan.size) &&
              (retired
                ? matches(retired.from, retired.kind, retired.size) && !entry(retired.to)
                : !entry(target));
            if (
              retired &&
              !entry(retired.from) &&
              matches(plan.from, plan.kind, plan.size) &&
              matches(retired.to, retired.kind, retired.size)
            ) {
              const old = entry(retired.to);
              if (retired.modifiedAt && old?.modifiedAt !== retired.modifiedAt) continue;
              await runtime.authorizeTransfer(
                current,
                serverId,
                true,
                connection,
                undefined,
                server,
              );
              await runtime.adapter.renameFiles(identifier, '', [
                { from: retired.to, to: retired.from },
              ]);
              await verifyDatapackMoves(runtime.fileReadPhase(identifier, server), [
                { from: retired.to, to: retired.from, size: retired.size, kind: retired.kind },
              ]);
              await connection
                .updateTable('minecraft_datapack_changes')
                .set({ state: 'ready', error: null, updated_at: new Date() })
                .where('id', '=', row.id)
                .execute();
              relinquishedCleanup.add(retired.to);
              recovered++;
              continue;
            }
            if (!published && !original) continue;
            await connection
              .updateTable('minecraft_datapack_changes')
              .set({ state: published ? 'applied' : 'ready', error: null, updated_at: new Date() })
              .where('id', '=', row.id)
              .execute();
            if (original && retired) relinquishedCleanup.add(retired.to);
            recovered++;
          }
          // Restoring the old file relinquishes this attempt's cleanup receipt
          // before a later Apply can reuse the same retirement path.
          if (relinquishedCleanup.size)
            for (const apply of applies) {
              const cleanup = apply.cleanup.filter((path) => !relinquishedCleanup.has(path));
              if (cleanup.length === apply.cleanup.length) continue;
              await connection
                .updateTable('minecraft_datapack_applies')
                .set({
                  cleanup: JSON.stringify(cleanup),
                  cleanup_state: cleanup.length ? apply.cleanup_state : 'complete',
                  updated_at: new Date(),
                })
                .where('id', '=', apply.id)
                .execute();
            }
          const remaining = await connection
            .selectFrom('minecraft_datapack_changes')
            .select('id')
            .where('server_id', '=', serverId)
            .where('world', '=', world)
            .where('state', 'in', ['uncertain', 'dispatched'])
            .execute();
          if (!remaining.length)
            await connection
              .updateTable('minecraft_datapack_applies')
              .set({ state: 'reconciled', reload: 'required', updated_at: new Date() })
              .where('server_id', '=', serverId)
              .where('world', '=', world)
              .where('state', 'in', ['uncertain', 'dispatched'])
              .execute();
          await recordAudit(connection, current, 'minecraft.datapack.reconciled', {
            serverId,
            world,
            recovered,
            uncertain: remaining.length,
          });
          if (!remaining.length) {
            const cleanups = await connection
              .selectFrom('minecraft_datapack_applies')
              .select('id')
              .where('server_id', '=', serverId)
              .where('world', '=', world)
              .where('state', 'in', ['published', 'reconciled'])
              .where('cleanup_state', 'in', ['pending', 'failed'])
              .execute();
            for (const apply of cleanups) queueCleanup(current, serverId, apply.id);
          }
          return { recovered, uncertain: remaining.length };
        },
      );
    },
    async prepare(
      context: AuthContext,
      serverId: string,
      input: unknown,
      catalog?: DatapackProvenance,
    ) {
      const value = parse(minecraftDatapackChangeSchema, input);
      // Resolve and inspect source before taking the short exclusive provider lock.
      const runtime = permissionRuntime(
        options.runtime,
        'game.minecraft.datapacks',
        value.action === 'delete' ? 'delete' : 'write',
      );
      let archive:
        | Awaited<
            ReturnType<ReturnType<typeof createMinecraftSourceStore>['datapackArchiveResolver']>
          >
        | undefined;
      let metadata: MinecraftDatapackSnapshot['packs'][number]['metadata'] = null;
      let sourceSize = 0;
      if (value.action === 'install') {
        if (!value.sourceId || !value.name?.toLowerCase().endsWith('.zip'))
          throw new DomainError('validation_failed');
        archive = await createMinecraftSourceStore(db, context, env).datapackArchiveResolver(
          value.sourceId,
          serverId,
        );
        if (
          archive.catalogSource &&
          archive.catalogSource.provider !== 'upload' &&
          (!catalog ||
            catalog.provider !== archive.catalogSource.provider ||
            catalog.projectId !== archive.catalogSource.projectId ||
            catalog.versionId !== archive.catalogSource.versionId)
        )
          throw new DomainError('content_dependency_missing');
        const info = await profile(db, serverId);
        metadata = await inspectMinecraftDatapackArchive(archive.path, info.version);
        sourceSize = (await stat(archive.path)).size;
      }
      return runtime.fileMutationAccess(
        context,
        serverId,
        async (identifier, connection, current, server) => {
          const previous = await connection
            .selectFrom('minecraft_datapack_changes')
            .selectAll()
            .where('server_id', '=', serverId)
            .where('actor_user_id', '=', current.actorUserId)
            .where('idempotency_key', '=', value.idempotencyKey)
            .executeTakeFirst();
          if (previous) {
            const old = parse(planSchema, previous.plan);
            if (
              previous.world !== value.world ||
              previous.action !== value.action ||
              previous.source_id !== (value.sourceId ?? null) ||
              (value.name && previous.name !== value.name.replace(/\.zip$/i, '.zip')) ||
              (value.path && value.path !== (old.replacement?.from ?? old.from))
            )
              throw new DomainError('conflict');
            return { changeId: previous.id, state: previous.state };
          }
          const info = await profile(connection, serverId);
          if (!info.installed || !datapacksSupported(info.version))
            throw new DomainError('integration_unavailable');
          const files = runtime.fileReadPhase(identifier, server);
          const worldEntries = await files.list(value.world);
          if (!worldEntries.some((entry) => entry.name === 'level.dat' && entry.kind === 'file'))
            throw new DomainError('not_found');
          const id = randomUUID();
          let name = value.name?.replace(/\.zip$/i, '.zip') ?? '',
            plan: Plan;
          if (value.action === 'install') {
            if (!archive) throw new DomainError('validation_failed');
            const entries = await listOptional(files, directory(value.world));
            const existing = entries.find((entry) =>
              [name, `${name}.disabled`].includes(entry.name),
            );
            if (
              existing &&
              (!value.path ||
                value.path !== `${directory(value.world)}/${existing.name}` ||
                existing.kind === 'symlink')
            )
              throw new DomainError('conflict');
            if (value.path && !existing) throw new DomainError('conflict');
            plan = {
              from: `${directory(value.world)}/${name}.${id}.pending`,
              to: `${directory(value.world)}/${existing?.name ?? name}`,
              kind: 'zip',
              size: sourceSize,
              metadata,
              metadataRelease: info.version,
              ...(catalog ? { catalog } : {}),
              ...(existing
                ? {
                    replacement: {
                      from: `${directory(value.world)}/${existing.name}`,
                      to: `${hiddenRoot}/${value.world}/retired/${id}-${existing.name}`,
                      kind: existing.kind === 'file' ? ('zip' as const) : ('directory' as const),
                      size: existing.size,
                      modifiedAt: existing.modifiedAt,
                    },
                  }
                : {}),
            };
          } else {
            if (!value.path) throw new DomainError('validation_failed');
            const sourcePath = value.path;
            const receipt = datapackReceipts(
              await changeRows(connection, serverId, value.world),
            ).find((item) => item.path === sourcePath);
            const roots = [directory(value.world), disabledRoot(value.world)];
            if (!roots.includes(parent(value.path))) throw new DomainError('validation_failed');
            const entry = (await listOptional(files, parent(value.path))).find(
              (item) => item.name === leaf(sourcePath),
            );
            if (!entry || entry.kind === 'symlink') throw new DomainError('not_found');
            name = parse(
              minecraftDatapackNameSchema,
              entry.kind === 'file' ? entry.name.replace(/\.disabled$/, '') : entry.name,
            );
            const disabled =
              parent(value.path) === disabledRoot(value.world) ||
              (entry.kind === 'file' && entry.name.endsWith('.disabled'));
            let nativeEnable = false;
            if (value.action === 'enable') {
              const bytes = await files.read({
                path: `${value.world}/level.dat`,
                maxBytes: 8 * 1024 ** 2,
              });
              nativeEnable =
                !!bytes &&
                !!inspectMinecraftDatapackSelection(bytes)?.disabled.includes(`file/${name}`);
              if (!disabled && !nativeEnable) throw new DomainError('conflict');
              if (nativeEnable && server.runtime_state !== 'running')
                throw new DomainError('conflict');
            }
            if (value.action === 'disable' && disabled) throw new DomainError('conflict');
            if (entry.kind === 'file' && !name.endsWith('.zip'))
              throw new DomainError('validation_failed');
            plan = {
              from: value.path,
              to:
                value.action === 'delete'
                  ? null
                  : value.action === 'enable'
                    ? `${directory(value.world)}/${name}`
                    : entry.kind === 'file'
                      ? `${directory(value.world)}/${name}.disabled`
                      : `${disabledRoot(value.world)}/${name}`,
              kind: entry.kind === 'file' ? 'zip' : 'directory',
              size: entry.size,
              modifiedAt: entry.modifiedAt,
              metadata: null,
              ...(receipt &&
              receipt.size === entry.size &&
              receipt.modifiedAt &&
              receipt.modifiedAt === entry.modifiedAt
                ? { catalog: receipt.catalog }
                : {}),
              ...(nativeEnable ? { nativeEnable: true } : {}),
            };
            if (
              plan.to &&
              plan.to !== plan.from &&
              (await listOptional(files, parent(plan.to))).some(
                (item) => item.name === leaf(plan.to ?? ''),
              )
            )
              throw new DomainError('conflict');
          }
          const queued = (await changeRows(connection, serverId, value.world)).filter(
            (row) =>
              activeStates.includes(row.state as (typeof activeStates)[number]) &&
              row.state !== 'failed',
          );
          if (queued.some((row) => row.name === name)) throw new DomainError('conflict');
          if (
            queued.some((row) => parse(planSchema, row.plan).nativeEnable) ||
            (plan.nativeEnable && queued.length)
          )
            throw new DomainError('conflict');
          await connection
            .insertInto('minecraft_datapack_changes')
            .values({
              id,
              server_id: serverId,
              actor_user_id: current.actorUserId,
              world: value.world,
              name,
              action: value.action,
              state: value.action === 'install' ? 'preparing' : 'ready',
              idempotency_key: value.idempotencyKey,
              source_id: value.sourceId ?? null,
              plan: JSON.stringify(plan),
              error: null,
            })
            .execute();
          if (value.action !== 'install') {
            try {
              await ensureDirectories(
                identifier,
                files,
                parent(plan.to ?? `${hiddenRoot}/${value.world}/trash/${id}-${name}`),
              );
              return { changeId: id, state: 'ready' };
            } catch (error) {
              await connection
                .updateTable('minecraft_datapack_changes')
                .set({ state: 'failed', error: failureCode(error), updated_at: new Date() })
                .where('id', '=', id)
                .execute();
              throw error;
            }
          }
          if (!archive) throw new DomainError('validation_failed');
          const sourcePath = archive.path;
          let dispatched = false;
          let claim: Awaited<ReturnType<typeof reserveUploadIngestion>> | undefined;
          try {
            await ensureDirectories(identifier, files, directory(value.world));
            if (plan.replacement)
              await ensureDirectories(identifier, files, parent(plan.replacement.to));
            if (serverStorageLimitBytes(server.limits.disk) !== null) {
              const usage = await runtime.adapter.getResources(identifier);
              assertServerStorageCapacity(
                server.limits.disk,
                usage.resources.disk_bytes + sourceSize,
              );
            }
            claim = await reserveUploadIngestion(connection, current, serverId, sourceSize, env);
            await runtime.authorizeTransfer(current, serverId, true, connection, undefined, server);
            dispatched = true;
            await runtime.adapter.uploadFile(identifier, plan.from, {
              body: Readable.toWeb(createReadStream(sourcePath)) as ReadableStream<Uint8Array>,
              contentLength: sourceSize,
              maxBytes: sourceSize,
              authorize: () =>
                runtime.authorizeTransfer(current, serverId, true, connection, undefined, server),
            });
            await claim.complete();
            await claim.unlock();
            claim = undefined;
            await connection
              .updateTable('minecraft_datapack_changes')
              .set({ state: 'ready', updated_at: new Date() })
              .where('id', '=', id)
              .execute();
            await recordAudit(connection, current, 'minecraft.datapack.prepared', {
              serverId,
              world: value.world,
              changeId: id,
              name,
            });
            return { changeId: id, state: 'ready' };
          } catch (error) {
            if (claim && !dispatched) await claim.rejectBeforeDispatch();
            await connection
              .updateTable('minecraft_datapack_changes')
              .set({
                state: dispatched ? 'uncertain' : 'failed',
                error: failureCode(error),
                updated_at: new Date(),
              })
              .where('id', '=', id)
              .execute();
            throw error;
          } finally {
            await claim?.unlock();
          }
        },
      );
    },
    async cancel(context: AuthContext, serverId: string, changeId: string) {
      parse(z.uuid(), changeId);
      const candidate = await db
        .selectFrom('minecraft_datapack_changes')
        .select('action')
        .where('id', '=', changeId)
        .where('server_id', '=', serverId)
        .executeTakeFirst();
      const runtime = permissionRuntime(
        options.runtime,
        'game.minecraft.datapacks',
        candidate?.action === 'delete' ? 'delete' : 'write',
      );
      await runtime.uploadBatchAccess(
        context,
        serverId,
        async (identifier, connection, current, server) => {
          const row = await connection
            .selectFrom('minecraft_datapack_changes')
            .selectAll()
            .where('server_id', '=', serverId)
            .where('id', '=', changeId)
            .executeTakeFirst();
          if (!row) throw new DomainError('not_found');
          const fence = await connection
            .selectFrom('minecraft_datapack_applies')
            .select('id')
            .where('server_id', '=', serverId)
            .where(sql<boolean>`${row.id} = ANY(ARRAY(SELECT jsonb_array_elements_text(changes)))`)
            .executeTakeFirst();
          if (fence || ['dispatched', 'applied'].includes(row.state))
            throw new DomainError('operation_uncertain');
          if (row.state === 'cancelled') return;
          if (row.action === 'install') {
            const plan = parse(planSchema, row.plan);
            // The exclusive upload-prepare access proves no other application
            // writer is active. Only this unpublished, generated pending path
            // may be discarded; an uncertain ingestion capacity claim is retained.
            if (plan.from !== `${directory(row.world)}/${row.name}.${row.id}.pending`)
              throw new DomainError('provenance_mismatch');
            await runtime.authorizeTransfer(current, serverId, true, connection, undefined, server);
            await runtime.adapter.deleteFiles(identifier, parent(plan.from), [leaf(plan.from)]);
            const after = await listOptional(
              runtime.fileReadPhase(identifier, server),
              parent(plan.from),
            );
            if (after.some((entry) => entry.name === leaf(plan.from)))
              throw new DomainError('operation_uncertain');
          }
          await connection
            .updateTable('minecraft_datapack_changes')
            .set({ state: 'cancelled', updated_at: new Date() })
            .where('id', '=', row.id)
            .execute();
          await recordAudit(connection, current, 'minecraft.datapack.cancelled', {
            serverId,
            changeId,
          });
        },
        true,
      );
    },
    async apply(context: AuthContext, serverId: string, input: unknown) {
      const value = parse(minecraftDatapackApplySchema, input);
      const pending = await changeRows(db, serverId, value.world);
      const action =
        pending.length && pending.every((row) => row.action === 'delete') ? 'delete' : 'write';
      const runtime = permissionRuntime(options.runtime, 'game.minecraft.datapacks', action);
      return runtime.fileMutationAccess(
        context,
        serverId,
        async (identifier, connection, current, server) => {
          const previous = await connection
            .selectFrom('minecraft_datapack_applies')
            .selectAll()
            .where('server_id', '=', serverId)
            .where('actor_user_id', '=', current.actorUserId)
            .where('idempotency_key', '=', value.idempotencyKey)
            .executeTakeFirst();
          if (previous) {
            if (previous.world !== value.world) throw new DomainError('conflict');
            return { state: previous.state, reload: previous.reload };
          }
          const allChanges = await changeRows(connection, serverId, value.world);
          const changes = allChanges.filter((change) =>
            activeStates.includes(change.state as (typeof activeStates)[number]),
          );
          if (changes.some((change) => change.action !== 'delete'))
            await authorizeServer(connection, current, serverId, 'game.minecraft.datapacks.write');
          if (changes.some((change) => change.action === 'delete'))
            await authorizeServer(connection, current, serverId, 'game.minecraft.datapacks.delete');
          if (changes.some((change) => change.state !== 'ready') || changes.length > 1000)
            throw new DomainError('conflict');
          if (!changes.length) {
            const latest = await connection
              .selectFrom('minecraft_datapack_applies')
              .select(['reload'])
              .where('server_id', '=', serverId)
              .where('world', '=', value.world)
              .orderBy('created_at', 'desc')
              .executeTakeFirst();
            if (latest?.reload !== 'required') throw new DomainError('conflict');
          }
          const files = runtime.fileReadPhase(identifier, server);
          const properties = await files.read({ path: 'server.properties', maxBytes: 1048576 });
          const selected =
            parseMinecraftProperties(Buffer.from(properties ?? []).toString('utf8'))[
              'level-name'
            ] ?? 'world';
          const running = server.runtime_state === 'running';
          if (!changes.length && (!running || selected !== value.world))
            throw new DomainError('conflict');
          if (!['running', 'offline', 'unknown'].includes(server.runtime_state))
            throw new DomainError('conflict');
          const plans = changes.map((change) => {
            const plan = parse(planSchema, change.plan);
            return {
              ...plan,
              action: change.action,
              name: change.name,
              to: plan.to ?? `${hiddenRoot}/${value.world}/trash/${change.id}-${change.name}`,
            };
          });
          const native = plans.filter((plan) => plan.nativeEnable);
          if (
            native.length &&
            (native.length !== 1 || changes.length !== 1 || !running || selected !== value.world)
          )
            throw new DomainError('conflict');
          const publications = plans.filter((plan) => plan.from !== plan.to);
          const retirements = publications.flatMap((plan) =>
            plan.replacement ? [plan.replacement] : [],
          );
          const moves = [...retirements, ...publications];
          // Prepare only absent destination parents; all network work happens before
          // the dispatch fence. No archive download/extraction/inspection during Apply.
          // Destination directories were prepared alongside the draft, not here.
          const receipts = datapackReceipts(allChanges);
          const catalogs = [
            ...receipts.map((receipt) => receipt.catalog),
            ...plans.flatMap((plan) => (plan.catalog ? [plan.catalog] : [])),
          ];
          const modSchema = z.object({
            provider: z.string(),
            projectId: z.string(),
            versionId: z.string(),
            incompatible: z
              .array(
                z.object({
                  provider: z.string(),
                  projectId: z.string(),
                  versionId: z.string().optional(),
                }),
              )
              .optional(),
          });
          const mods = catalogs.length
            ? (await minecraftModContentReceipts(connection, serverId, db)).flatMap((row) => {
                const parsed = modSchema.safeParse(row.artifact);
                return parsed.success && /^mods\/[^/]+\.jar$/.test(row.path)
                  ? [{ ...parsed.data, path: row.path }]
                  : [];
              })
            : [];
          const graphPaths = [
            ...mods.map((mod) => mod.path),
            ...receipts.map((receipt) => receipt.path),
            ...catalogs.flatMap((catalog) => catalog.mods.map((mod) => mod.path)),
          ];
          const directories = [
            ...new Set([
              ...moves.flatMap((move) => [parent(move.from), parent(move.to)]),
              ...graphPaths.map(parent),
            ]),
          ];
          const before = directories.length ? await files.listMany(directories) : [];
          const graphEntries = new Map<string, FilemanEntry>();
          for (const listing of before)
            if ('files' in listing)
              for (const entry of listing.files)
                graphEntries.set(`${listing.directory}/${entry.name}`, entry);
          assertDatapackDependencyGraph(receipts, changes, graphEntries, mods);
          for (const move of moves) {
            const from = before.find((result) => result.directory === parent(move.from));
            const to = before.find((result) => result.directory === parent(move.to));
            const source =
              from && 'files' in from
                ? from.files.find((entry) => entry.name === leaf(move.from))
                : undefined;
            if (
              !source ||
              source.kind === 'symlink' ||
              (move.kind === 'zip' && source.size !== move.size) ||
              ('modifiedAt' in move && move.modifiedAt && source.modifiedAt !== move.modifiedAt) ||
              !to ||
              !('files' in to) ||
              (to.files.some((entry) => entry.name === leaf(move.to)) &&
                !retirements.some((retirement) => retirement.from === move.to))
            )
              throw new DomainError('conflict');
          }
          await runtime.authorizeTransfer(current, serverId, true, connection, undefined, server);
          if (retirements.length || publications.some((move) => move.action === 'delete'))
            await authorizeServer(connection, current, serverId, 'game.minecraft.datapacks.delete');
          const discarded = [
            ...retirements,
            ...publications.filter((move) => move.action === 'delete'),
          ].map((move) => move.to);
          const id = randomUUID();
          await connection.transaction().execute(async (tx) => {
            await tx
              .insertInto('minecraft_datapack_applies')
              .values({
                id,
                server_id: serverId,
                actor_user_id: current.actorUserId,
                world: value.world,
                idempotency_key: value.idempotencyKey,
                changes: JSON.stringify(changes.map((change) => change.id)),
                cleanup: JSON.stringify(discarded),
                cleanup_state: discarded.length ? 'pending' : 'complete',
                state: 'dispatched',
                reload: selected === value.world ? 'required' : 'not_required',
              })
              .execute();
            if (changes.length)
              await tx
                .updateTable('minecraft_datapack_changes')
                .set({ state: 'dispatched', updated_at: new Date() })
                .where(
                  'id',
                  'in',
                  changes.map((change) => change.id),
                )
                .execute();
          });
          try {
            await runtime.authorizeTransfer(current, serverId, true, connection, undefined, server);
            if (retirements.length || publications.some((move) => move.action === 'delete'))
              await authorizeServer(
                connection,
                current,
                serverId,
                'game.minecraft.datapacks.delete',
              );
            // Replacement retirement must finish before publication: Wings executes
            // a rename array concurrently, so dependent moves cannot share a batch.
            if (retirements.length)
              await runtime.adapter.renameFiles(
                identifier,
                '',
                retirements.map(({ from, to }) => ({ from, to })),
              );
            if (publications.length)
              await runtime.adapter.renameFiles(
                identifier,
                '',
                publications.map(({ from, to }) => ({ from, to })),
              );
            const receipts = moves.length
              ? await verifyDatapackMoves(runtime.fileReadPhase(identifier, server), moves)
              : new Map<string, FilemanEntry>();
            await connection.transaction().execute(async (tx) => {
              if (changes.length) {
                const updates = changes.map((change) => {
                  const plan = parse(planSchema, change.plan);
                  const entry = plan.to ? receipts.get(plan.to) : undefined;
                  return {
                    id: change.id,
                    patch: entry?.modifiedAt ? { modifiedAt: entry.modifiedAt } : {},
                  };
                });
                await sql`UPDATE minecraft_datapack_changes AS change SET state='applied', plan=change.plan || receipt.patch, updated_at=now()
                  FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS receipt(id uuid,patch jsonb)
                  WHERE change.id=receipt.id`.execute(tx);
              }
              await tx
                .updateTable('minecraft_datapack_applies')
                .set({ state: 'published', updated_at: new Date() })
                .where('id', '=', id)
                .execute();
              await recordAudit(tx, current, 'minecraft.datapack.applied', {
                serverId,
                world: value.world,
                applyId: id,
                changes: changes.map((change) => ({ action: change.action, name: change.name })),
              });
            });
          } catch (error) {
            await connection.transaction().execute(async (tx) => {
              if (changes.length)
                await tx
                  .updateTable('minecraft_datapack_changes')
                  .set({ state: 'uncertain', error: failureCode(error), updated_at: new Date() })
                  .where(
                    'id',
                    'in',
                    changes.map((change) => change.id),
                  )
                  .execute();
              await tx
                .updateTable('minecraft_datapack_applies')
                .set({ state: 'uncertain', reload: 'uncertain', updated_at: new Date() })
                .where('id', '=', id)
                .execute();
            });
            throw new DomainError('operation_uncertain');
          }
          let reload: 'required' | 'not_required' | 'requested' | 'uncertain' =
            selected === value.world ? 'required' : 'not_required';
          if (selected === value.world && running) {
            // Fence before dispatch: an HTTP timeout must not replay a reload. Vanilla's
            // "Reloading!" precedes its async future and is not a completion signal.
            await connection
              .updateTable('minecraft_datapack_applies')
              .set({ reload: 'uncertain' })
              .where('id', '=', id)
              .execute();
            try {
              await runtime.authorizeTransfer(
                current,
                serverId,
                true,
                connection,
                undefined,
                server,
              );
              if (native.length) {
                await runtime.adapter.sendCommand(identifier, 'datapack list available');
                for (const pack of native)
                  await runtime.adapter.sendCommand(
                    identifier,
                    `datapack enable ${JSON.stringify(`file/${pack.name}`)}`,
                  );
              } else await runtime.adapter.sendCommand(identifier, 'reload');
              reload = 'requested';
            } catch {
              reload = 'uncertain';
            }
            await connection
              .updateTable('minecraft_datapack_applies')
              .set({ reload, updated_at: new Date() })
              .where('id', '=', id)
              .execute();
          }
          if (discarded.length) queueCleanup(current, serverId, id);
          return { state: 'published' as const, reload };
        },
      );
    },
  };
}
