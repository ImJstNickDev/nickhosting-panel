import type { ContentHttp, CurseForgeProvider } from '@nickhosting/content-providers';
import { type AuthContext, DomainError, type SecretCodec } from '@nickhosting/core';
import type { createDatabase } from '@nickhosting/database';
import { authorizeServer, type ManagementRuntime, parse } from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  modProviderSchema,
  pluginProviderSchema,
} from '../../../packages/content-providers/src/mod-catalog.js';
import { minecraftAddonProviders } from '../../../packages/server-management/src/minecraft-addon-providers.js';
import { minecraftModSchemaAvailable } from '../../../packages/server-management/src/minecraft-mod-schema.js';
import { createMinecraftModsService } from '../../../packages/server-management/src/minecraft-mods.js';
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
const projectId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const boolean = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .default(false);
const search = z.strictObject({
  provider: pluginProviderSchema,
  query: z.string().max(256).default(''),
  offset: z.coerce.number().int().min(0).max(9980).default(0),
  includeIncompatible: boolean,
});
export function registerMinecraftModRoutes(app: Hono<{ Variables: Variables }>, options: Options) {
  registerMinecraftAddonRoutes(app, options, 'mod');
  registerMinecraftAddonRoutes(app, options, 'plugin');
}
function registerMinecraftAddonRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Options,
  kind: 'mod' | 'plugin',
) {
  const providerId = kind === 'plugin' ? pluginProviderSchema : modProviderSchema;
  const { db, env, principal, body, management } = options,
    base =
      kind === 'plugin' ? '/v1/servers/:id/minecraft/plugins' : '/v1/servers/:id/minecraft/mods';
  const service = async (withProviders = false) => {
    if (!(await minecraftModSchemaAvailable(db, kind)))
      throw new DomainError('integration_unavailable');
    const runtime = await management();
    const content: { http?: ContentHttp; curseforge?: CurseForgeProvider } = withProviders
      ? options.codec
        ? ((await minecraftContentProviders(db, options.codec, env, options.contentHttp))
            .providers ?? {})
        : await runtime.minecraftOptions()
      : {};
    return createMinecraftModsService({ db, env, runtime, ...content, kind });
  };
  app.get(base, async (c) => {
    c.header('cache-control', 'no-store');
    return c.json(await (await service()).snapshot(await principal(c), c.req.param('id')));
  });
  app.get(`${base}/restart-status`, async (c) => {
    c.header('cache-control', 'no-store');
    return c.json(await (await service()).restartStatus(await principal(c), c.req.param('id')));
  });
  app.get(`${base}/updates`, async (c) => {
    c.header('cache-control', 'no-store');
    const query = parse(z.strictObject({ preferBeta: boolean }), c.req.query());
    return c.json(
      await (await service(true)).updates(await principal(c), c.req.param('id'), query.preferBeta),
    );
  });
  app.get(`${base}/alternatives/:provider/:projectId`, async (c) => {
    c.header('cache-control', 'no-store');
    const name = parse(providerId, c.req.param('provider'));
    const id = parse(projectId, c.req.param('projectId'));
    const query = parse(
      z.strictObject({ revision: z.coerce.number().int().nonnegative() }),
      c.req.query(),
    );
    return c.json(
      await (await service(true)).alternatives(
        await principal(c),
        c.req.param('id'),
        name,
        id,
        query.revision,
      ),
    );
  });
  app.put(`${base}/selection`, async (c) =>
    c.json(
      await (await service(true)).select(await principal(c), c.req.param('id'), await body(c)),
      202,
    ),
  );
  app.post(`${base}/changes`, async (c) =>
    c.json(
      await (await service()).change(await principal(c), c.req.param('id'), await body(c)),
      201,
    ),
  );
  app.post(`${base}/toggle`, async (c) =>
    c.json(await (await service()).toggle(await principal(c), c.req.param('id'), await body(c))),
  );
  app.delete(`${base}/changes/:changeId`, async (c) => {
    await (await service()).cancel(await principal(c), c.req.param('id'), c.req.param('changeId'));
    return c.body(null, 204);
  });
  app.post(`${base}/apply`, async (c) =>
    c.json(await (await service()).apply(await principal(c), c.req.param('id'), await body(c))),
  );
  app.post(`${base}/recover`, async (c) =>
    c.json(await (await service()).recover(await principal(c), c.req.param('id'))),
  );
  const catalog = async (c: C) => {
    const context = await principal(c);
    await authorizeServer(db, context, c.req.param('id') ?? '');
    const runtime = await management();
    const content: { http?: ContentHttp; curseforge?: CurseForgeProvider } = options.codec
      ? ((await minecraftContentProviders(db, options.codec, env, options.contentHttp)).providers ??
        {})
      : await runtime.minecraftOptions();
    const profile = await createMinecraftModsService({ db, env, runtime, kind }).profile(
      c.req.param('id') ?? '',
    );
    if (!profile.supported) throw new DomainError('integration_unavailable');
    return {
      content,
      target: profile.target,
      providers: minecraftAddonProviders({ ...content, kind }),
    };
  };
  app.get(`${base}/catalog`, async (c) => {
    const { providers } = await catalog(c);
    return c.json({
      providers:
        kind === 'plugin'
          ? [
              ...(['modrinth', 'hangar', 'spiget', 'curseforge'] as const).map((id) => ({
                id,
                available: !!providers[id],
              })),
              { id: 'voxel', available: false, comingSoon: true },
              { id: 'builtbybit', available: false, comingSoon: true },
            ]
          : modProviderSchema.options.map((id) => ({ id, available: !!providers[id] })),
    });
  });
  app.get(`${base}/catalog/search`, async (c) => {
    const query = parse(search.extend({ provider: providerId }), c.req.query()),
      { providers, target } = await catalog(c);
    const provider = providers[query.provider];
    if (!provider) throw new DomainError('integration_unavailable');
    return c.json(await provider.searchMods({ ...query, target, signal: c.req.raw.signal }));
  });
  app.get(`${base}/catalog/:provider/:projectId`, async (c) => {
    const name = parse(providerId, c.req.param('provider')),
      id = parse(projectId, c.req.param('projectId')),
      { providers } = await catalog(c);
    const provider = providers[name];
    if (!provider) throw new DomainError('integration_unavailable');
    return c.json(await provider.modDetails(id, c.req.raw.signal));
  });
  app.get(`${base}/catalog/:provider/:projectId/versions`, async (c) => {
    const name = parse(providerId, c.req.param('provider')),
      id = parse(projectId, c.req.param('projectId')),
      query = parse(
        z.strictObject({
          offset: search.shape.offset,
          includeIncompatible: boolean,
          preferBeta: boolean,
        }),
        c.req.query(),
      ),
      { providers, target } = await catalog(c);
    const provider = providers[name];
    if (!provider) throw new DomainError('integration_unavailable');
    return c.json(await provider.modVersions(id, { ...query, target, signal: c.req.raw.signal }));
  });
}
