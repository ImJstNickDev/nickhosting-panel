import { type AuthContext, DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import {
  minecraftCombinationSchema,
  minecraftVersionChangeRequestSchema,
} from '@nickhosting/minecraft';
import {
  authorizeServer,
  enqueueServerOperation,
  getFabricCatalog,
  getForgeCatalog,
  getNeoForgeCatalog,
  getQuiltCatalog,
  type ManagementRuntime,
  minecraftCatalog,
  parse,
  replayManagedGameOperation,
  requireMinecraftChoice,
  resolveMinecraftPublicChoice,
} from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { minecraftCatalogLoaders } from '../../../packages/server-management/src/minecraft-catalog-projections.js';
import {
  minecraftRuntimeOwner,
  modpackMappingCompatible,
  modpackRuntimeTarget,
} from '../../../packages/server-management/src/modpack-runtime.js';
import type { Variables } from './app.js';

type C = Context<{ Variables: Variables }>;
export function registerMinecraftVersionRoutes(
  app: Hono<{ Variables: Variables }>,
  options: {
    db: Kysely<Database>;
    env: Readonly<Record<string, string | undefined>>;
    principal(c: C): Promise<AuthContext>;
    body(c: Context): Promise<unknown>;
    management(): Promise<ManagementRuntime>;
  },
) {
  const base = '/v1/servers/:id/minecraft/versions';
  const { db, env } = options;
  async function scope(c: C) {
    const actor = await options.principal(c);
    const server = await authorizeServer(
      db,
      actor,
      parse(z.uuid(), c.req.param('id')),
      'server:manage',
    );
    const [source, allocations, profile] = await Promise.all([
      db
        .selectFrom('runtime_egg_mappings')
        .selectAll()
        .where('id', '=', server.mapping_id)
        .executeTakeFirstOrThrow(),
      db.selectFrom('server_allocations').selectAll().where('server_id', '=', server.id).execute(),
      db
        .selectFrom('minecraft_server_profiles as profile')
        .innerJoin('minecraft_combinations as choice', 'choice.id', 'profile.combination_id')
        .select(['profile.combination_id', 'choice.combination'])
        .where('profile.server_id', '=', server.id)
        .executeTakeFirst(),
    ]);
    if (!profile || source.game_id !== 'minecraft') throw new DomainError('not_found');
    return { actor, server, source, allocations, profile };
  }
  async function visibleChoices({
    actor,
    server,
    source,
    allocations,
  }: Awaited<ReturnType<typeof scope>>) {
    const [mappings, owner] = await Promise.all([
      db
        .selectFrom('runtime_egg_mappings')
        .selectAll()
        .where('node_id', '=', server.node_id)
        .where('game_id', '=', 'minecraft')
        .where('enabled', '=', true)
        .execute(),
      actor.subjectUserId === server.owner_id
        ? undefined
        : minecraftRuntimeOwner(db, server.owner_id),
    ]);
    const eligible = mappings.filter((m) =>
      modpackMappingCompatible(server, source, m, allocations),
    );
    const catalog = await minecraftCatalog(db, actor, env, undefined, {
      mappingIds: eligible.map((m) => m.id),
      owner,
    });
    return catalog
      .filter(
        (v) =>
          v.capabilities.installation &&
          (server.connection_mode !== 'gateway' || v.capabilities.gateway),
      )
      .map(({ id, version, runtime }) => ({ id, version, runtime }));
  }
  app.get(base, async (c) => {
    const resource = await scope(c);
    const { profile } = resource;
    const light = c.req.query('view') === 'choices';
    const catalog = visibleChoices(resource);
    const loaderCatalogs = light
      ? undefined
      : Promise.all([
          getFabricCatalog(db),
          getQuiltCatalog(db),
          getForgeCatalog(db),
          getNeoForgeCatalog(db),
        ]);
    const [choices, catalogs] = await Promise.all([catalog, loaderCatalogs]);
    const choice = minecraftCombinationSchema.parse(profile.combination);
    const byGame = (versions: { minecraftVersion: string; loaders: { version: string }[] }[]) =>
      Object.fromEntries(
        versions.map((v) => [v.minecraftVersion, v.loaders.map((l) => l.version)]),
      );
    c.header('Cache-Control', 'no-store');
    return c.json({
      current: {
        combinationId: profile.combination_id,
        version: choice.release,
        runtime: choice.profile,
        loaderVersion: choice.loaderVersion ?? null,
      },
      choices,
      ...(catalogs && {
        loaders: {
          fabric: catalogs[0].loaders.map((v) => v.version),
          quilt: catalogs[1].loaders.map((v) => v.version),
          forge: byGame(catalogs[2].versions),
          neoforge: byGame(catalogs[3].versions),
        },
      }),
    });
  });
  app.get(`${base}/loaders`, async (c) => {
    await scope(c);
    const { runtime, version } = parse(
      z.strictObject({
        runtime: z.enum(['fabric', 'quilt', 'forge', 'neoforge']),
        version: z.string().min(1).max(128),
      }),
      c.req.query(),
    );
    c.header('Cache-Control', 'no-store');
    return c.json(await minecraftCatalogLoaders(db, runtime, version));
  });
  app.post(base, async (c) => {
    const resource = await scope(c);
    const { actor, server, source, allocations } = resource;
    const { mode, backupBefore, confirm, idempotencyKey, ...minecraftVersion } = parse(
      minecraftVersionChangeRequestSchema,
      await options.body(c),
    );
    if (backupBefore) await authorizeServer(db, actor, server.id, 'backups.create');
    const request = {
      action: mode === 'fresh' ? 'wipe' : 'reinstall',
      backupBefore,
      confirm,
      idempotencyKey,
      minecraftVersion,
    };
    const replay = await replayManagedGameOperation(db, actor, server.id, request, env);
    if (replay) return c.json(replay, 202);
    const choices = await visibleChoices(resource);
    if (!choices.some((choice) => choice.id === minecraftVersion.choiceId))
      throw new DomainError('conflict');
    const choice = await resolveMinecraftPublicChoice(
      db,
      async () => (await options.management()).adapter,
      actor,
      minecraftVersion,
      env,
    );
    if (
      !choice.capabilities.installation ||
      (server.connection_mode === 'gateway' && !choice.capabilities.gateway) ||
      !modpackMappingCompatible(server, source, choice.mapping, allocations)
    )
      throw new DomainError('integration_unavailable');
    await requireMinecraftChoice(
      db,
      await minecraftRuntimeOwner(db, server.owner_id),
      choice.row.id,
      env,
    );
    return c.json(
      await enqueueServerOperation(db, actor, server.id, request, env, {
        minecraftVersionTarget: {
          combinationId: choice.row.id,
          mappingId: choice.mapping.id,
          target: modpackRuntimeTarget(choice),
        },
      }),
      202,
    );
  });
}
