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
    const [catalog, mappings, registered] = await Promise.all([
      minecraftCatalog(db, actor, env),
      db
        .selectFrom('runtime_egg_mappings')
        .selectAll()
        .where('node_id', '=', server.node_id)
        .where('game_id', '=', 'minecraft')
        .where('enabled', '=', true)
        .execute(),
      db
        .selectFrom('minecraft_combinations as choice')
        .innerJoin('runtime_egg_mappings as mapping', 'mapping.id', 'choice.mapping_id')
        .select(['choice.id', 'choice.mapping_id'])
        .where('mapping.node_id', '=', server.node_id)
        .where('choice.enabled', '=', true)
        .execute(),
    ]);
    const ownerAllowed =
      actor.subjectUserId === server.owner_id
        ? null
        : new Set(
            (await minecraftCatalog(db, await minecraftRuntimeOwner(db, server.owner_id), env)).map(
              (c) => c.id,
            ),
          );
    const eligible = new Set(
      mappings
        .filter((m) => modpackMappingCompatible(server, source, m, allocations))
        .map((m) => m.id),
    );
    const mappingById = new Map(registered.map((r) => [r.id, r.mapping_id]));
    return catalog
      .filter(
        (v) =>
          (!ownerAllowed || ownerAllowed.has(v.id)) &&
          v.capabilities.installation &&
          (server.connection_mode !== 'gateway' || v.capabilities.gateway) &&
          eligible.has(mappingById.get(v.id) ?? v.id.split(':')[1] ?? ''),
      )
      .map(({ id, version, runtime }) => ({ id, version, runtime }));
  }
  app.get(base, async (c) => {
    const resource = await scope(c);
    const { profile } = resource;
    const [choices, fabric, quilt, forge, neoforge] = await Promise.all([
      visibleChoices(resource),
      getFabricCatalog(db),
      getQuiltCatalog(db),
      getForgeCatalog(db),
      getNeoForgeCatalog(db),
    ]);
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
      loaders: {
        fabric: fabric.loaders.map((v) => v.version),
        quilt: quilt.loaders.map((v) => v.version),
        forge: byGame(forge.versions),
        neoforge: byGame(neoforge.versions),
      },
    });
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
