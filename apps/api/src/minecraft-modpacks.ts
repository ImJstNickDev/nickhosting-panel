import {
  type ContentHttp,
  type CurseForgeProvider,
  createModpackCatalog,
} from '@nickhosting/content-providers';
import { type AuthContext, DomainError, type SecretCodec } from '@nickhosting/core';
import type { createDatabase } from '@nickhosting/database';
import { authorizeServer, type ManagementRuntime, parse } from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  modpackCategoryIdsSchema,
  modpackProviderSchema,
} from '../../../packages/content-providers/src/modpack-catalog.js';
import { minecraftModpackSchemaAvailable } from '../../../packages/server-management/src/minecraft-modpack-schema.js';
import { minecraftContentProviders } from '../../../packages/server-management/src/minecraft-world-catalog.js';
import { createMinecraftModpackBridge } from '../../../packages/server-management/src/modpack-bridge.js';
import type { Variables } from './app.js';

type C = Context<{ Variables: Variables }>;
const identity = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^/\\\p{C}]+$/u);
const offset = z.coerce.number().int().min(0).max(9980).default(0);
const search = z.strictObject({
  provider: modpackProviderSchema,
  query: z.string().max(200).default(''),
  offset,
  categories: modpackCategoryIdsSchema.optional(),
});
export function registerMinecraftModpackRoutes(
  app: Hono<{ Variables: Variables }>,
  options: {
    db: ReturnType<typeof createDatabase>['db'];
    env: Readonly<Record<string, string | undefined>>;
    principal: (c: C, regularOnly?: boolean) => Promise<AuthContext>;
    body: (c: Context) => Promise<unknown>;
    management: () => Promise<ManagementRuntime>;
    codec?: SecretCodec;
    contentHttp?: ContentHttp;
  },
) {
  const base = '/v1/servers/:id/minecraft/modpacks';
  const { db, env, principal, body, management } = options;
  const content = async (
    runtime: ManagementRuntime,
  ): Promise<{ http?: ContentHttp; curseforge?: CurseForgeProvider }> =>
    options.codec
      ? ((await minecraftContentProviders(db, options.codec, env, options.contentHttp)).providers ??
        {})
      : await runtime.minecraftOptions();
  const ready = async () => {
    if (!(await minecraftModpackSchemaAvailable(db)))
      throw new DomainError('integration_unavailable');
  };
  const service = async (providers = false) => {
    await ready();
    const runtime = await management();
    return createMinecraftModpackBridge({
      db,
      runtime,
      env,
      ...(providers ? await content(runtime) : {}),
    });
  };
  app.use(`${base}/*`, async (c, next) => {
    c.header('cache-control', 'no-store');
    await next();
  });
  app.get(base, async (c) => {
    c.header('cache-control', 'no-store');
    const actor = await principal(c);
    return c.json(await (await service()).snapshot(actor, c.req.param('id')));
  });
  app.post(`${base}/prepare`, async (c) => {
    const actor = await principal(c);
    return c.json(
      await (await service(true)).prepare(actor, c.req.param('id'), await body(c)),
      202,
    );
  });
  app.post(`${base}/apply`, async (c) => {
    const actor = await principal(c);
    return c.json(await (await service()).apply(actor, c.req.param('id'), await body(c)), 202);
  });
  app.delete(`${base}/operations/:operationId`, async (c) => {
    const actor = await principal(c);
    const id = parse(z.uuid(), c.req.param('operationId'));
    return c.json(await (await service()).cancel(actor, c.req.param('id'), id));
  });
  app.post(`${base}/operations/:operationId/recover`, async (c) => {
    const actor = await principal(c);
    const id = parse(z.uuid(), c.req.param('operationId'));
    return c.json(await (await service()).recover(actor, c.req.param('id'), id));
  });
  const catalog = async (c: C) => {
    const actor = await principal(c);
    await authorizeServer(db, actor, c.req.param('id') ?? '', 'game.minecraft.modpacks.read');
    await ready();
    const profile = await db
      .selectFrom('minecraft_server_profiles')
      .select('server_id')
      .where('server_id', '=', c.req.param('id') ?? '')
      .executeTakeFirst();
    if (!profile) throw new DomainError('integration_unavailable');
    return content(await management());
  };
  const provider = async (c: C, id: z.infer<typeof modpackProviderSchema>) => {
    const providers = await catalog(c);
    if (!providers.http || (id === 'curseforge' && !providers.curseforge))
      throw new DomainError('integration_unavailable');
    return createModpackCatalog(id, { ...providers, http: providers.http });
  };
  app.get(`${base}/catalog`, async (c) => {
    const providers = await catalog(c);
    return c.json({
      providers: modpackProviderSchema.options.map((id) => ({
        id,
        available: Boolean(providers.http && (id !== 'curseforge' || providers.curseforge)),
      })),
    });
  });
  app.get(`${base}/catalog/search`, async (c) => {
    const { category, ...params } = c.req.query();
    const query = parse(search, {
      ...params,
      ...(category !== undefined ? { categories: c.req.queries('category') } : {}),
    });
    return c.json(await (await provider(c, query.provider)).search(query, c.req.raw.signal));
  });
  app.get(`${base}/catalog/categories`, async (c) => {
    const query = parse(z.strictObject({ provider: modpackProviderSchema }), c.req.query());
    const selected = await provider(c, query.provider);
    return c.json(
      selected.categories ? await selected.categories(c.req.raw.signal) : { items: [] },
    );
  });
  app.get(`${base}/catalog/:provider/:projectId`, async (c) => {
    const name = parse(modpackProviderSchema, c.req.param('provider'));
    const id = parse(identity, c.req.param('projectId'));
    return c.json(await (await provider(c, name)).details(id, c.req.raw.signal));
  });
  app.get(`${base}/catalog/:provider/:projectId/versions`, async (c) => {
    const name = parse(modpackProviderSchema, c.req.param('provider'));
    const id = parse(identity, c.req.param('projectId'));
    const query = parse(z.strictObject({ offset }), c.req.query());
    return c.json(await (await provider(c, name)).versions(id, query, c.req.raw.signal));
  });
}
