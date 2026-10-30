import {
  type ContentHttp,
  type CurseForgeProvider,
  ModrinthProvider,
} from '@nickhosting/content-providers';
import { type AuthContext, DomainError, type SecretCodec } from '@nickhosting/core';
import type { createDatabase } from '@nickhosting/database';
import { authorizeServer, type ManagementRuntime, parse } from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { minecraftDatapackWorldSchema } from '../../../games/minecraft/src/datapack-contracts.js';
import { createMinecraftDatapackCatalogService } from '../../../packages/server-management/src/minecraft-datapack-catalog.js';
import { createMinecraftDatapackService } from '../../../packages/server-management/src/minecraft-datapacks.js';
import { minecraftContentProviders } from '../../../packages/server-management/src/minecraft-world-catalog.js';
import type { Variables } from './app.js';

type C = Context<{ Variables: Variables }>;
type Options = {
  db: ReturnType<typeof createDatabase>['db'];
  env: Readonly<Record<string, string | undefined>>;
  principal: (c: C, regularOnly?: boolean) => Promise<AuthContext>;
  body: (c: Context) => Promise<unknown>;
  management: () => Promise<ManagementRuntime>;
  codec?: SecretCodec;
  contentHttp?: ContentHttp;
};
const providerId = z.enum(['modrinth', 'curseforge']);
const projectId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const searchSchema = z.strictObject({
  provider: providerId,
  query: z.string().max(256).default(''),
  offset: z.coerce.number().int().min(0).max(9980).default(0),
});
export function registerMinecraftDatapackRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Options,
) {
  const { db, env, principal, body, management } = options;
  const service = async () =>
    createMinecraftDatapackService({ db, env, runtime: await management() });
  const base = '/v1/servers/:id/minecraft/datapacks';
  app.get(base, async (c) => {
    c.header('cache-control', 'no-store');
    return c.json(
      await (await service()).snapshot(await principal(c), c.req.param('id'), c.req.query('world')),
    );
  });
  app.post(`${base}/changes`, async (c) =>
    c.json(
      await (await service()).prepare(await principal(c), c.req.param('id'), await body(c)),
      201,
    ),
  );
  app.delete(`${base}/changes/:changeId`, async (c) => {
    await (await service()).cancel(await principal(c), c.req.param('id'), c.req.param('changeId'));
    return c.body(null, 204);
  });
  app.post(`${base}/apply`, async (c) =>
    c.json(await (await service()).apply(await principal(c), c.req.param('id'), await body(c))),
  );
  app.get(`${base}/inspect`, async (c) =>
    c.json(await (await service()).inspect(await principal(c), c.req.param('id'), c.req.query())),
  );
  app.post(`${base}/recover`, async (c) =>
    c.json(await (await service()).recover(await principal(c), c.req.param('id'), await body(c))),
  );
  const catalog = async (c: C) => {
    const context = await principal(c);
    await authorizeServer(db, context, c.req.param('id') ?? '', 'game.minecraft.datapacks.read');
    const runtime = await management();
    const content: { http?: ContentHttp; curseforge?: CurseForgeProvider } = options.codec
      ? ((await minecraftContentProviders(db, options.codec, env, options.contentHttp)).providers ??
        {})
      : await runtime.minecraftOptions();
    return {
      context,
      runtime,
      content,
      modrinth: content.http ? new ModrinthProvider(content.http) : undefined,
    };
  };
  app.get(`${base}/catalog`, async (c) => {
    const { content, modrinth } = await catalog(c);
    return c.json({
      providers: [
        { id: 'modrinth', available: !!modrinth },
        { id: 'curseforge', available: !!content.curseforge },
      ],
    });
  });
  app.get(`${base}/catalog/search`, async (c) => {
    const query = parse(searchSchema, c.req.query());
    const { content, modrinth } = await catalog(c);
    const provider = query.provider === 'modrinth' ? modrinth : content.curseforge;
    if (!provider) throw new DomainError('integration_unavailable');
    return c.json(
      await provider.searchDatapacks(query.query, query.offset, undefined, c.req.raw.signal),
    );
  });
  app.get(`${base}/catalog/:provider/:projectId/files`, async (c) => {
    const id = parse(projectId, c.req.param('projectId'));
    const name = parse(providerId, c.req.param('provider'));
    const offset = parse(z.coerce.number().int().min(0).max(9980), c.req.query('offset') ?? 0);
    const { content, modrinth } = await catalog(c);
    const provider = name === 'modrinth' ? modrinth : content.curseforge;
    if (!provider) throw new DomainError('integration_unavailable');
    return c.json(await provider.datapackFiles(id, offset, c.req.raw.signal));
  });
  const planRequest = z.strictObject({
    provider: providerId,
    projectId,
    versionId: projectId,
    world: minecraftDatapackWorldSchema,
    optionalProjectIds: z.array(projectId).max(512).optional(),
  });
  app.post(`${base}/catalog/plan`, async (c) => {
    const value = parse(planRequest, await body(c));
    const { content, context, runtime, modrinth } = await catalog(c);
    const serverId = c.req.param('id');
    await authorizeServer(db, context, serverId, 'game.minecraft.datapacks.write');
    const provider = value.provider === 'modrinth' ? modrinth : content.curseforge;
    if (!provider) throw new DomainError('integration_unavailable');
    return c.json(
      await createMinecraftDatapackCatalogService({ db, env, runtime, ...content }).plan(
        context,
        serverId,
        value,
        provider,
        c.req.raw.signal,
      ),
    );
  });
  app.post(`${base}/catalog/acquire`, async (c) => {
    const value = parse(
      planRequest.extend({
        planId: z.uuid().optional(),
        disablePaths: z.array(z.string().max(512)).max(512).optional(),
        idempotencyKey: projectId,
        name: z.string().max(128).optional(),
        path: z.string().max(512).optional(),
      }),
      await body(c),
    );
    const { content, context, runtime, modrinth } = await catalog(c);
    const serverId = c.req.param('id');
    await authorizeServer(db, context, serverId, 'game.minecraft.datapacks.write');
    const service = createMinecraftDatapackCatalogService({ db, env, runtime, ...content });
    let planId = value.planId;
    if (!planId) {
      const provider = value.provider === 'modrinth' ? modrinth : content.curseforge;
      if (!provider) throw new DomainError('integration_unavailable');
      planId = (await service.plan(context, serverId, value, provider, c.req.raw.signal)).planId;
    }
    return c.json(await service.acquire(context, serverId, { ...value, planId }), 201);
  });
}
