import type { ContentHttp } from '@nickhosting/content-providers';
import { type AuthContext, DomainError, type SecretCodec } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { Context, Hono } from 'hono';
import type { Kysely } from 'kysely';
import { createMinecraftSourceStore } from '../../../packages/server-management/src/minecraft-sources.js';
import {
  createMinecraftWorldCatalog,
  minecraftContentProviders,
} from '../../../packages/server-management/src/minecraft-world-catalog.js';
import type { Variables } from './app.js';

type C = Context<{ Variables: Variables }>;
export function registerMinecraftWorldCatalogRoutes(
  app: Hono<{ Variables: Variables }>,
  options: {
    db: Kysely<Database>;
    codec: SecretCodec;
    env: Readonly<Record<string, string | undefined>>;
    principal: (c: C, regularOnly?: boolean) => Promise<AuthContext>;
    acquireUploadSlot: () => () => void;
    /** Trusted isolated provider fixture; no browser can supply this transport. */
    http?: ContentHttp;
  },
) {
  const catalog = async (c: C) =>
    createMinecraftWorldCatalog(
      options.db,
      await options.principal(c),
      c.req.param('id') ?? '',
      options,
    );
  app.get('/v1/servers/:id/minecraft/world-catalog', async (c) =>
    c.json(await (await catalog(c)).availability()),
  );
  app.get('/v1/servers/:id/minecraft/world-catalog/search', async (c) =>
    c.json(await (await catalog(c)).search(c.req.query())),
  );
  app.get('/v1/servers/:id/minecraft/world-catalog/curseforge/:projectId/files', async (c) =>
    c.json(await (await catalog(c)).files(c.req.param('projectId'), c.req.query())),
  );
  app.post('/v1/minecraft/sources/world-catalog', async (c) => {
    const context = await options.principal(c);
    if (!c.req.header('content-type')?.startsWith('application/json'))
      throw new DomainError('validation_failed');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new DomainError('validation_failed');
    }
    // The store parses/authorizes the exact request before fetching any archive.
    // Provider composition only reads local settings and encrypted credentials.
    const configured = await minecraftContentProviders(
      options.db,
      options.codec,
      options.env,
      options.http,
    );
    const release = options.acquireUploadSlot();
    try {
      return c.json(
        await createMinecraftSourceStore(options.db, context, options.env, {
          http: configured.providers?.http,
          curseforge: configured.providers?.curseforge,
        }).acquireWorldCatalog(body, c.req.raw.signal),
        201,
      );
    } finally {
      release();
    }
  });
}
