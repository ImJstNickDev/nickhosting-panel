import { createHash, randomUUID } from 'node:crypto';
import type {
  ContentArtifact,
  ContentHttp,
  CurseForgeProvider,
  ModrinthProvider,
} from '@nickhosting/content-providers';
import { type AuthContext, DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { FilemanEntry } from '@nickhosting/game-sdk';
import { inspectMinecraftDatapackSelection } from '@nickhosting/minecraft';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { MinecraftDatapackCatalogPlan } from '../../../games/minecraft/src/datapack-contracts.js';
import type { Environment } from './admission.js';
import {
  type DatapackProvenance,
  type DatapackReceipt,
  datapackProvenanceSchema,
  datapackReceipts,
  datapackStateRows,
  receiptMatches,
} from './minecraft-datapack-dependencies.js';
import { createMinecraftDatapackService } from './minecraft-datapacks.js';
import { minecraftModContentReceipts } from './minecraft-mod-receipts.js';
import { inspectMinecraftCombination } from './minecraft-registry.js';
import { createMinecraftSourceStore } from './minecraft-sources.js';
import type { ManagementRuntime } from './runtime.js';

type Provider = ModrinthProvider | CurseForgeProvider;
type Resolved = Awaited<ReturnType<ModrinthProvider['resolveDatapackPlan']>>;
type Request = {
  provider: 'modrinth' | 'curseforge';
  projectId: string;
  versionId: string;
  world: string;
  optionalProjectIds?: string[];
};
type Cached = {
  scope: string;
  serverId: string;
  request: Request;
  expires: number;
  result: MinecraftDatapackCatalogPlan;
  resolved: Resolved;
  receipts: DatapackReceipt[];
  mods: DatapackProvenance['mods'];
  version: string;
  promise?: Promise<{
    changeId: string;
    state: string;
    changes: { changeId: string; state: string }[];
  }>;
  acquireKey?: string;
};
const plans = new Map<string, Cached>();
const scope = (context: AuthContext) => `${context.actorUserId}:${context.subjectUserId}`;
const parent = (path: string) => path.slice(0, path.lastIndexOf('/'));
const modSchema = z.object({
  provider: z.enum(['modrinth', 'curseforge']),
  projectId: z.string(),
  versionId: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  incompatible: z
    .array(
      z.object({ provider: z.string(), projectId: z.string(), versionId: z.string().optional() }),
    )
    .optional(),
});
const reason = {
  mod: 'mod_required',
  'incompatible-version': 'version_unavailable',
  unavailable: 'archive_unavailable',
  unresolved: 'unknown_dependency',
  'version-conflict': 'dependency_conflict',
  conflict: 'dependency_conflict',
} as const;

export function createMinecraftDatapackCatalogService(options: {
  db: Kysely<Database>;
  runtime: ManagementRuntime;
  env: Environment;
  http?: ContentHttp;
  curseforge?: CurseForgeProvider;
}) {
  const { db, runtime, env } = options;
  async function observe(
    context: AuthContext,
    serverId: string,
    world: string,
    provider: Request['provider'],
    modProjects: ReadonlySet<string>,
  ) {
    return runtime.fileReadScope(context, serverId, async (files, _identifier, connection) => {
      const profile = await connection
        .selectFrom('minecraft_server_profiles')
        .selectAll()
        .where('server_id', '=', serverId)
        .executeTakeFirst();
      if (!profile?.installed) throw new DomainError('integration_unavailable');
      const combination = await inspectMinecraftCombination(
        connection,
        profile.combination_id,
        env,
      );
      const rows = await datapackStateRows(connection, serverId, world);
      const candidates = datapackReceipts(rows);
      const draftSchema = z.object({
        from: z.string(),
        to: z.string(),
        size: z.number(),
        catalog: datapackProvenanceSchema,
      });
      const drafts = rows
        .filter((row) => row.state === 'ready' && row.action === 'install')
        .flatMap((row) => {
          const parsed = draftSchema.safeParse(row.plan);
          return parsed.success ? [parsed.data] : [];
        });
      const modRows = await minecraftModContentReceipts(connection, serverId, db);
      const mods = modRows.flatMap((row) => {
        const parsed = modSchema.safeParse(row.artifact);
        return parsed.success &&
          parsed.data.provider === provider &&
          /^mods\/[^/]+\.jar$/.test(row.path)
          ? [{ ...parsed.data, path: row.path }]
          : [];
      });
      const paths = [
        ...new Set([
          ...candidates.map((item) => parent(item.path)),
          ...drafts.map((item) => parent(item.from)),
          ...mods.map((item) => parent(item.path)),
        ]),
      ];
      const listings = paths.length ? await files.listMany(paths) : [];
      const entries = new Map<string, FilemanEntry>();
      for (const listing of listings)
        if ('files' in listing)
          for (const entry of listing.files)
            entries.set(`${listing.directory}/${entry.name}`, entry);
      const receipts = candidates.filter((item) => receiptMatches(item, entries.get(item.path)));
      for (const draft of drafts) {
        const entry = entries.get(draft.from);
        if (entry?.kind === 'file' && entry.size === draft.size)
          receipts.push({
            path: draft.to,
            size: draft.size,
            enabled: true,
            catalog: draft.catalog,
          });
      }
      const nativeDisabled = new Set<string>();
      if (receipts.length) {
        const level = await files.read({
          path: `${world}/level.dat`,
          maxBytes: 8 * 1024 ** 2,
          missing: 'allow',
        });
        if (level)
          try {
            for (const name of inspectMinecraftDatapackSelection(level)?.disabled ?? [])
              nativeDisabled.add(name);
          } catch {
            /* Unreadable native state remains unknown, never fabricated. */
          }
      }
      const verifiedMods: DatapackProvenance['mods'] = [];
      // Only explicit, previously installed provider identities may satisfy a mod requirement.
      // Hash once during preparation, then retain the observed size/mtime for the Apply fence.
      if (['fabric', 'forge', 'neoforge', 'quilt'].includes(combination.combination.profile)) {
        for (const mod of mods.filter((mod) => modProjects.has(mod.projectId))) {
          const entry = entries.get(mod.path);
          if (
            entry?.kind !== 'file' ||
            entry.size !== mod.size ||
            !entry.modifiedAt ||
            entry.size > 64 * 1024 ** 2
          )
            continue;
          const bytes = await files.read({
            path: mod.path,
            maxBytes: Math.max(1, entry.size),
            missing: 'allow',
          });
          if (bytes && createHash('sha256').update(bytes).digest('hex') === mod.sha256)
            verifiedMods.push({
              projectId: mod.projectId,
              versionId: mod.versionId,
              path: mod.path,
              size: entry.size,
              modifiedAt: entry.modifiedAt,
            });
        }
      }
      return {
        version: combination.combination.release,
        receipts,
        mods: verifiedMods,
        modCatalog: mods.filter((mod) => entries.get(mod.path)?.kind === 'file'),
        rows,
        nativeDisabled,
      };
    });
  }
  return {
    async plan(
      context: AuthContext,
      serverId: string,
      request: Request,
      provider: Provider,
      signal?: AbortSignal,
    ): Promise<MinecraftDatapackCatalogPlan> {
      const preliminary = await observe(
        context,
        serverId,
        request.world,
        request.provider,
        new Set(),
      );
      const resolved = await provider.resolveDatapackPlan(
        request.projectId,
        request.versionId,
        preliminary.version,
        signal,
        request.optionalProjectIds,
        new Map([
          ...preliminary.receipts
            .filter((item) => item.catalog.provider === request.provider)
            .map((item) => [item.catalog.projectId, item.catalog.versionId] as const),
          ...preliminary.modCatalog.map((item) => [item.projectId, item.versionId] as const),
        ]),
      );
      const modProjects = new Set(
        resolved.plan.blocked.filter((item) => item.reason === 'mod').map((item) => item.projectId),
      );
      for (const item of resolved.plan.items)
        for (const conflict of item.conflicts) modProjects.add(conflict.projectId);
      const observed = modProjects.size
        ? await observe(context, serverId, request.world, request.provider, modProjects)
        : preliminary;
      const blockers: MinecraftDatapackCatalogPlan['blockers'] = resolved.plan.blocked
        .filter(
          (item) =>
            item.reason !== 'mod' ||
            !observed.mods.some(
              (mod) =>
                mod.projectId === item.projectId &&
                (!item.versionId || mod.versionId === item.versionId),
            ),
        )
        .map((item) => ({
          projectId: item.projectId,
          name: item.name,
          reason: reason[item.reason],
        }));
      const conflicts: MinecraftDatapackCatalogPlan['conflicts'] = [];
      const items: MinecraftDatapackCatalogPlan['items'] = [];
      for (const item of resolved.plan.items) {
        const installed = observed.receipts.find(
          (receipt) =>
            receipt.catalog.provider === request.provider &&
            receipt.catalog.projectId === item.projectId &&
            receipt.catalog.versionId === item.versionId,
        );
        if (
          installed?.enabled &&
          observed.nativeDisabled.has(`file/${installed.path.split('/').at(-1)}`)
        )
          blockers.push({ projectId: item.projectId, name: item.name, reason: 'native_disabled' });
        items.push({
          provider: request.provider,
          projectId: item.projectId,
          versionId: item.versionId,
          name: item.name,
          disposition: installed ? (installed.enabled ? 'reuse' : 'enable') : 'install',
          dependency: item.projectId !== request.projectId,
        });
        for (const existing of observed.receipts.filter(
          (receipt) => receipt.enabled && receipt.catalog.provider === request.provider,
        )) {
          const excludes = item.conflicts.some(
            (ref) =>
              ref.projectId === existing.catalog.projectId &&
              (!ref.versionId || ref.versionId === existing.catalog.versionId),
          );
          const reverse = existing.catalog.conflicts.some(
            (ref) =>
              ref.projectId === item.projectId &&
              (!ref.versionId || ref.versionId === item.versionId),
          );
          const replaced =
            existing.catalog.projectId === item.projectId &&
            existing.catalog.versionId !== item.versionId;
          if (excludes || reverse || replaced) {
            if (!existing.modifiedAt) {
              blockers.push({
                projectId: existing.catalog.projectId,
                name: existing.path.split('/').at(-1) ?? existing.path,
                reason: 'prepared_conflict',
              });
              continue;
            }
            conflicts.push({
              path: existing.path,
              name: existing.path.split('/').at(-1) ?? existing.path,
              projectId: existing.catalog.projectId,
            });
          }
        }
        if (
          observed.modCatalog.some(
            (mod) =>
              item.conflicts.some(
                (ref) =>
                  ref.projectId === mod.projectId &&
                  (!ref.versionId || ref.versionId === mod.versionId),
              ) ||
              mod.incompatible?.some(
                (ref) =>
                  ref.provider === request.provider &&
                  ref.projectId === item.projectId &&
                  (!ref.versionId || ref.versionId === item.versionId),
              ),
          )
        )
          blockers.push({
            projectId: item.projectId,
            name: item.name,
            reason: 'dependency_conflict',
          });
      }
      const planId = randomUUID(),
        expires = Date.now() + 10 * 60_000;
      const result: MinecraftDatapackCatalogPlan = {
        planId,
        expiresAt: new Date(expires).toISOString(),
        items,
        optional: resolved.plan.optional.map((item) => ({
          projectId: item.projectId,
          name: item.name,
        })),
        conflicts: [...new Map(conflicts.map((item) => [item.path, item])).values()],
        blockers,
      };
      for (const [id, value] of plans) if (value.expires < Date.now()) plans.delete(id);
      const owned = [...plans].filter(([, value]) => value.scope === scope(context));
      while (owned.length >= 16) {
        const item = owned.shift();
        if (item) plans.delete(item[0]);
      }
      while (plans.size >= 128) {
        const key = plans.keys().next().value;
        if (key) plans.delete(key);
        else break;
      }
      plans.set(planId, {
        scope: scope(context),
        serverId,
        request,
        expires,
        result,
        resolved,
        receipts: observed.receipts,
        mods: observed.mods,
        version: observed.version,
      });
      return result;
    },
    async acquire(
      context: AuthContext,
      serverId: string,
      value: Request & {
        planId: string;
        disablePaths?: string[];
        idempotencyKey: string;
        name?: string;
        path?: string;
      },
    ) {
      const cached = plans.get(value.planId);
      if (
        !cached ||
        cached.scope !== scope(context) ||
        cached.serverId !== serverId ||
        cached.expires < Date.now() ||
        ['provider', 'projectId', 'versionId', 'world'].some(
          (key) => cached.request[key as keyof Request] !== value[key as keyof Request],
        )
      )
        throw new DomainError('content_plan_expired');
      if (cached.result.blockers.length) throw new DomainError('content_dependency_missing');
      const accepted = new Set(value.disablePaths ?? []);
      if (
        accepted.size !== cached.result.conflicts.length ||
        cached.result.conflicts.some((item) => !accepted.has(item.path))
      )
        throw new DomainError('content_dependency_conflict');
      const key = createHash('sha256')
        .update(
          JSON.stringify([value.idempotencyKey, value.name, value.path, [...accepted].sort()]),
        )
        .digest('hex');
      if (cached.acquireKey && cached.acquireKey !== key) throw new DomainError('conflict');
      if (cached.promise) return cached.promise;
      cached.acquireKey = key;
      cached.promise = (async () => {
        const current = await observe(context, serverId, value.world, value.provider, new Set());
        if (current.version !== cached.version) throw new DomainError('content_plan_expired');
        for (const item of cached.result.items.filter((item) => item.disposition !== 'install')) {
          if (
            !current.receipts.some(
              (receipt) =>
                receipt.catalog.provider === value.provider &&
                receipt.catalog.projectId === item.projectId &&
                receipt.catalog.versionId === item.versionId,
            )
          )
            throw new DomainError('content_plan_expired');
        }
        for (const conflict of cached.result.conflicts) {
          const before = cached.receipts.find((receipt) => receipt.path === conflict.path);
          const after = current.receipts.find((receipt) => receipt.path === conflict.path);
          if (!before || !after || JSON.stringify(before) !== JSON.stringify(after))
            throw new DomainError('content_plan_expired');
        }
        const service = createMinecraftDatapackService({ db, runtime, env });
        const store = createMinecraftSourceStore(db, context, env, {
          http: options.http,
          curseforge: options.curseforge,
        });
        const changes: { changeId: string; state: string }[] = [];
        const step = (suffix: string) =>
          createHash('sha256').update(`${value.idempotencyKey}:${suffix}`).digest('hex');
        for (const conflict of cached.result.conflicts) {
          changes.push(
            await service.prepare(context, serverId, {
              world: value.world,
              action: 'disable',
              path: conflict.path,
              idempotencyKey: step(`disable:${conflict.path}`),
            }),
          );
        }
        for (const item of cached.resolved.plan.items) {
          const choice = cached.result.items.find(
            (choice) => choice.projectId === item.projectId && choice.versionId === item.versionId,
          );
          if (choice?.disposition === 'reuse') continue;
          const existing = cached.receipts.find(
            (receipt) =>
              receipt.catalog.provider === value.provider &&
              receipt.catalog.projectId === item.projectId &&
              receipt.catalog.versionId === item.versionId,
          );
          if (choice?.disposition === 'enable' && existing) {
            changes.push(
              await service.prepare(context, serverId, {
                world: value.world,
                action: 'enable',
                path: existing.path,
                idempotencyKey: step(`enable:${existing.path}`),
              }),
            );
            continue;
          }
          const artifact = cached.resolved.artifacts.find(
            (artifact) =>
              artifact.projectId === item.projectId && artifact.versionId === item.versionId,
          );
          if (!artifact) throw new DomainError('validation_failed');
          const source = await store.acquireDatapack(
            {
              provider: value.provider,
              projectId: item.projectId,
              versionId: item.versionId,
              serverId,
              idempotencyKey: step(`source:${item.projectId}`),
            },
            undefined,
            artifact as ContentArtifact,
          );
          const root = item.projectId === value.projectId;
          const suffix = createHash('sha256')
            .update(`${item.projectId}:${item.versionId}`)
            .digest('hex')
            .slice(0, 12);
          let name =
            root && value.name
              ? value.name
              : `${value.provider}-${item.projectId.slice(0, 48)}-${suffix}.zip`;
          if (cached.result.conflicts.some((conflict) => conflict.path.split('/').at(-1) === name))
            name = `${name.replace(/\.zip$/i, '').slice(0, 108)}-${suffix}.zip`;
          changes.push(
            await service.prepare(
              context,
              serverId,
              {
                world: value.world,
                action: 'install',
                sourceId: source.id,
                name,
                path: root ? value.path : undefined,
                idempotencyKey: step(`prepare:${item.projectId}`),
              },
              {
                provider: value.provider,
                projectId: item.projectId,
                versionId: item.versionId,
                required: item.required,
                conflicts: item.conflicts,
                mods: cached.mods.filter((mod) =>
                  item.required.some((ref) => ref.projectId === mod.projectId),
                ),
              },
            ),
          );
        }
        return { changeId: changes.at(-1)?.changeId ?? value.planId, state: 'ready', changes };
      })();
      return cached.promise;
    },
  };
}
