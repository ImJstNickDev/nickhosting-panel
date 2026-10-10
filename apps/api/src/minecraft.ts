import { inspectModpack, ModrinthProvider } from '@nickhosting/content-providers';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { type createDatabase, getSettings, registerGame } from '@nickhosting/database';
import {
  createMinecraftIdentityProvider,
  minecraftAvatarUrl,
  minecraftEditablePropertyKeys,
  minecraftManifest,
  minecraftWizard,
  parseMinecraftProperties,
  verifyMinecraftPlayer,
} from '@nickhosting/minecraft';
import {
  authorizeServer,
  createManagedServer,
  createMinecraftSourceStore,
  createServerSchema,
  enqueueServerOperation,
  importMinecraftEvidence,
  inspectMinecraftCombination,
  listMinecraftOwnerCombinations,
  listMinecraftWorlds,
  type ManagementRuntime,
  minecraftCatalog,
  minecraftContentWipePreview,
  operationSchema,
  ownerOnly,
  parse,
  prepareMinecraftContentPlan,
  prepareMinecraftCreationConfig,
  registerMinecraftCombination,
  requireMinecraftChoice,
  setMinecraftAvailability,
  syncMinecraftCatalog,
} from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { minecraftStoredConfigurationSchema } from '../../../packages/server-management/src/minecraft-content-contracts.js';
import type { Variables } from './app.js';

type C = Context<{ Variables: Variables }>;
// Public choices carry all runtime-selection authority; an Owner-only mapping
// selector is neither required nor accepted by the dedicated creation endpoint.
const minecraftCreateSchema = createServerSchema.omit({ mappingId: true }).required({
  minecraft: true,
});
export function registerMinecraftRoutes(
  app: Hono<{ Variables: Variables }>,
  options: {
    db: ReturnType<typeof createDatabase>['db'];
    env: Readonly<Record<string, string | undefined>>;
    principal: (c: C, regularOnly?: boolean) => Promise<AuthContext>;
    body: (c: Context) => Promise<unknown>;
    management: () => Promise<ManagementRuntime>;
  },
) {
  const { db, env, principal, body, management } = options;
  const owner = async (c: C) => {
    const context = await principal(c, true);
    ownerOnly(context);
    return context;
  };
  app.get('/v1/owner/minecraft/manifest', async (c) => {
    await owner(c);
    return c.json(minecraftManifest);
  });
  app.post('/v1/owner/minecraft/register', async (c) => {
    const context = await owner(c);
    const rollout = parse(
      z
        .object({
          state: z.enum(['development', 'private-testing', 'public', 'disabled-for-new-servers']),
          allowedUserIds: z.array(z.string().min(1)).max(10000).default([]),
        })
        .strict(),
      await body(c),
    );
    await registerGame(db, context, minecraftManifest, { gameId: 'minecraft-java', ...rollout });
    return c.body(null, 204);
  });
  app.post('/v1/owner/minecraft/catalog/sync', async (c) => {
    const context = await owner(c);
    return c.json(
      await syncMinecraftCatalog(db, (await management()).adapter, context, await body(c), env),
    );
  });
  const detail = (choice: Awaited<ReturnType<typeof inspectMinecraftCombination>>) => ({
    id: choice.row.id,
    mappingId: choice.row.mapping_id,
    enabled: choice.row.enabled,
    combination: choice.combination,
    runtime: choice.row.resolved_runtime,
    binding: choice.row.binding,
    identityDigest: choice.row.identity_digest,
    mappingDigest: choice.mappingDigest,
    support: choice.support,
    supportAuthority: choice.supportAuthority,
    capabilities: choice.capabilities,
    evidence: choice.evidence,
  });
  app.get('/v1/owner/minecraft/compatibility', async (c) => {
    await owner(c);
    return c.json(await listMinecraftOwnerCombinations(db, c.req.query(), env));
  });
  app.get('/v1/owner/minecraft/compatibility/:id', async (c) => {
    await owner(c);
    return c.json(detail(await inspectMinecraftCombination(db, c.req.param('id'), env)));
  });
  app.post('/v1/owner/minecraft/compatibility', async (c) => {
    const context = await owner(c);
    return c.json(
      await registerMinecraftCombination(
        db,
        (await management()).adapter,
        context,
        await body(c),
        env,
      ),
      201,
    );
  });
  app.put('/v1/owner/minecraft/compatibility/:id/availability', async (c) => {
    await setMinecraftAvailability(db, await owner(c), c.req.param('id'), await body(c), env);
    return c.body(null, 204);
  });
  app.post('/v1/owner/minecraft/compatibility/:id/evidence', async (c) => {
    await importMinecraftEvidence(db, await owner(c), c.req.param('id'), await body(c), env);
    return c.body(null, 204);
  });
  app.get('/v1/minecraft/choices', async (c) =>
    c.json(await minecraftCatalog(db, await principal(c), env)),
  );
  app.get('/v1/minecraft/wizard', async (c) => {
    const choices = await minecraftCatalog(db, await principal(c), env);
    return c.json(
      minecraftWizard(
        choices.map((choice) => ({
          id: choice.id,
          release: choice.version,
          runtime: choice.runtime,
          nameKey: `games.minecraft-java.runtimes.${choice.runtime}`,
        })),
      ),
    );
  });
  app.get('/v1/minecraft/players/:name', async (c) => {
    await principal(c);
    const settings = await getSettings(db, env);
    const player = await verifyMinecraftPlayer(
      c.req.param('name'),
      createMinecraftIdentityProvider({
        userAgent: settings.values.minecraftMetadataUserAgent ?? '',
      }),
    );
    return c.json({
      ...player,
      avatar: minecraftAvatarUrl(player, c.req.query('avatar') === 'true'),
    });
  });
  const contentOptions = async (context: AuthContext, serverId?: string) => {
    const service = await management();
    const store = createMinecraftSourceStore(db, context, env);
    return {
      service,
      store,
      options: {
        ...(await service.minecraftOptions()),
        adapter: service.adapter,
        archiveResolver: store.archiveResolver,
        worldArchiveResolver: store.worldArchiveResolver,
        creationArchiveResolver: (sourceId: string) =>
          serverId
            ? store.resolveForServer(sourceId, serverId)
            : store.resolveForCreation(sourceId),
        acquireModpack: async (projectId: string, versionId: string, scope: string) => {
          const source = await store.acquireModrinth({
            projectId,
            versionId,
            serverId,
            idempotencyKey: scope,
          });
          const resolved = serverId
            ? await store.resolveForServer(source.id, serverId)
            : await store.resolveForCreation(source.id);
          if (!resolved.sha256) throw new DomainError('operation_uncertain');
          return { ...resolved, sha256: resolved.sha256, sourceId: source.id };
        },
      },
    };
  };
  const contentTarget = async (context: AuthContext, choiceId: string) => {
    const choice = await requireMinecraftChoice(db, context, choiceId, env);
    return {
      minecraftVersion: choice.combination.release,
      loader: choice.combination.profile,
      ...(choice.combination.loaderVersion
        ? { loaderVersion: choice.combination.loaderVersion }
        : {}),
    };
  };
  app.get('/v1/minecraft/modpacks/search', async (c) => {
    const context = await principal(c);
    const input = parse(
      z
        .object({
          query: z.string().max(256).default(''),
          offset: z.coerce.number().int().min(0).max(10000).default(0),
        })
        .strict(),
      c.req.query(),
    );
    const choices = await minecraftCatalog(db, context, env);
    if (!choices.length) return c.json({ hits: [], offset: input.offset });
    const { options: content } = await contentOptions(context);
    const raw = await new ModrinthProvider(content.http).searchModpacks(input.query, input.offset);
    const result = parse(
      z.object({
        hits: z
          .array(
            z.object({
              project_id: z.string(),
              title: z.string(),
              description: z.string(),
              versions: z.array(z.string()),
              categories: z.array(z.string()),
            }),
          )
          .max(100),
      }),
      raw,
    );
    return c.json({
      offset: input.offset,
      hits: result.hits
        .filter((hit) =>
          choices.some(
            (choice) =>
              hit.versions.includes(choice.version) && hit.categories.includes(choice.runtime),
          ),
        )
        .map(({ project_id, title, description }) => ({
          projectId: project_id,
          title,
          description,
        })),
    });
  });
  app.get('/v1/minecraft/modpacks/:projectId/versions', async (c) => {
    const context = await principal(c);
    const choices = await minecraftCatalog(db, context, env);
    if (!choices.length) return c.json([]);
    const { options: content } = await contentOptions(context);
    const versions = await new ModrinthProvider(content.http).modpackVersions(
      c.req.param('projectId'),
    );
    // Selection remains provisional until authenticated archive inspection proves its precise loader version.
    return c.json(
      versions
        .filter((version) =>
          choices.some(
            (choice) =>
              version.game_versions.includes(choice.version) &&
              version.loaders.includes(choice.runtime),
          ),
        )
        .map((version) => ({
          projectId: version.project_id,
          versionId: version.id,
          name: version.name,
          version: version.version_number,
        })),
    );
  });
  app.get('/v1/minecraft/content/search', async (c) => {
    const context = await principal(c);
    const input = parse(
      z
        .object({
          choiceId: z.uuid(),
          provider: z.enum(['modrinth', 'curseforge']),
          query: z.string().max(256).default(''),
          type: z.enum(['mod', 'plugin', 'modpack']).default('mod'),
          offset: z.coerce.number().int().min(0).max(10000).default(0),
        })
        .strict(),
      c.req.query(),
    );
    const target = await contentTarget(context, input.choiceId);
    const { options: content } = await contentOptions(context);
    if (input.provider === 'modrinth')
      return c.json(
        await new ModrinthProvider(content.http).search(
          input.query,
          target,
          input.type,
          input.offset,
        ),
      );
    if (!content.curseforge || input.type !== 'mod' || input.offset !== 0)
      throw new DomainError('integration_unavailable');
    return c.json(await content.curseforge.search(input.query, target));
  });
  app.get('/v1/minecraft/content/versions', async (c) => {
    const context = await principal(c);
    const input = parse(
      z
        .object({
          choiceId: z.uuid(),
          provider: z.enum(['modrinth', 'curseforge']),
          projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        })
        .strict(),
      c.req.query(),
    );
    const target = await contentTarget(context, input.choiceId);
    const { options: content } = await contentOptions(context);
    if (input.provider === 'modrinth')
      return c.json(await new ModrinthProvider(content.http).versions(input.projectId, target));
    if (!content.curseforge || !/^[1-9]\d*$/.test(input.projectId))
      throw new DomainError('integration_unavailable');
    return c.json(await content.curseforge.versions(Number(input.projectId), target));
  });
  app.post('/v1/minecraft/wizard', async (c) => {
    const context = await principal(c);
    const input = parse(z.object({ sourceId: z.uuid() }).strict(), await body(c));
    const { options: content, store } = await contentOptions(context);
    const source = await store.resolveForCreation(input.sourceId);
    const plan = await inspectModpack(source.path, { curseforge: content.curseforge });
    const choices = await minecraftCatalog(db, context, env);
    const matching = [];
    for (const choice of choices) {
      const detail = await inspectMinecraftCombination(db, choice.id, env);
      if (
        choice.version === plan.target.minecraftVersion &&
        choice.runtime === plan.target.loader &&
        detail.combination.loaderVersion === plan.target.loaderVersion
      )
        matching.push(choice);
    }
    const first = matching[0];
    if (!first) throw new DomainError('integration_unavailable');
    return c.json(
      minecraftWizard(
        matching.map((choice) => ({
          id: choice.id,
          release: choice.version,
          runtime: choice.runtime,
          nameKey: `games.minecraft-java.runtimes.${choice.runtime}`,
        })),
        {
          provider: plan.format === 'curseforge' ? 'curseforge' : 'modrinth',
          projectId: input.sourceId,
          versionId: input.sourceId,
          release: first.version,
          runtime: first.runtime,
          loaderVersion: plan.target.loaderVersion ?? '',
          choiceId: first.id,
        },
      ),
    );
  });
  app.post('/v1/minecraft/servers', async (c) => {
    const context = await principal(c);
    const input = parse(minecraftCreateSchema, await body(c));
    const choice = await requireMinecraftChoice(db, context, input.minecraft.choiceId, env);
    const { service, options: content } = await contentOptions(context);
    const prepared = await prepareMinecraftCreationConfig(
      db,
      input.minecraft.choiceId,
      input.minecraft.configuration,
      content,
    );
    return c.json(
      await createManagedServer(
        db,
        service.adapter,
        context,
        {
          ...input,
          mappingId: choice.row.mapping_id,
          minecraft: { ...input.minecraft, configuration: prepared.configuration },
        },
        env,
        { minecraftInitialContent: prepared.initialContent },
      ),
      202,
    );
  });
  app.post('/v1/servers/:id/minecraft/operations', async (c) => {
    const context = await principal(c),
      serverId = c.req.param('id');
    await authorizeServer(db, context, serverId, 'server:manage');
    const input = parse(operationSchema, await body(c));
    const { options: content } = await contentOptions(context, serverId);
    if (input.action === 'minecraft-content') {
      const plan = await prepareMinecraftContentPlan(db, serverId, input.command, content);
      return c.json(
        await enqueueServerOperation(
          db,
          context,
          serverId,
          { ...input, command: plan.command },
          env,
          { minecraftPlan: plan },
        ),
        202,
      );
    }
    if (input.action !== 'reinstall' && input.action !== 'wipe')
      throw new DomainError('validation_failed');
    const profile = await db
      .selectFrom('minecraft_server_profiles')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (!profile) throw new DomainError('not_found');
    const prepared = await prepareMinecraftCreationConfig(
      db,
      profile.combination_id,
      (() => {
        const { eula, properties, operators, whitelist, modpack } = parse(
          minecraftStoredConfigurationSchema,
          profile.configuration,
        );
        return { eula, properties, operators, whitelist, modpack };
      })(),
      content,
    );
    return c.json(
      await enqueueServerOperation(db, context, serverId, input, env, {
        minecraftInitialContent: prepared.initialContent,
      }),
      202,
    );
  });
  app.get('/v1/servers/:id/minecraft/wipe-preview', async (c) => {
    const serverId = c.req.param('id'),
      context = await principal(c);
    const server = await authorizeServer(db, context, serverId, 'server:manage');
    if (!server.pterodactyl_identifier) throw new DomainError('conflict');
    return c.json({
      deletePaths: await minecraftContentWipePreview(
        (await management()).adapter,
        server.pterodactyl_identifier,
      ),
    });
  });
  app.get('/v1/servers/:id/minecraft/worlds', async (c) => {
    const context = await principal(c),
      serverId = c.req.param('id');
    await authorizeServer(db, context, serverId, 'server:manage');
    return c.json(
      await listMinecraftWorlds(
        db,
        (await management()).adapter,
        serverId,
        async () => {
          await authorizeServer(db, await principal(c), serverId, 'server:manage');
        },
        env,
      ),
    );
  });
  app.get('/v1/servers/:id/minecraft', async (c) => {
    const serverId = c.req.param('id');
    const context = await principal(c);
    await authorizeServer(db, context, serverId);
    const profile = await db
      .selectFrom('minecraft_server_profiles')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (!profile) throw new DomainError('not_found');
    const choice = await inspectMinecraftCombination(db, profile.combination_id, env);
    const service = await management();
    const effectiveProperties = await service.access(
      context,
      serverId,
      false,
      async (identifier) => {
        const properties = parseMinecraftProperties(
          Buffer.from(
            await service.adapter.readFile(identifier, 'server.properties', 1048576),
          ).toString('utf8'),
        );
        return Object.fromEntries(
          Object.entries(properties).filter(([key]) => minecraftEditablePropertyKeys.includes(key)),
        );
      },
    );
    const content = await db
      .selectFrom('minecraft_content_items')
      .select(['path', 'artifact', 'installed_at'])
      .where('server_id', '=', serverId)
      .execute();
    return c.json({
      choiceId: profile.combination_id,
      version: choice.combination.release,
      runtime: choice.combination.profile,
      supportedProperties: Object.keys(effectiveProperties),
      effectiveProperties,
      installed: profile.installed,
      configuration: profile.configuration,
      content,
    });
  });
}
