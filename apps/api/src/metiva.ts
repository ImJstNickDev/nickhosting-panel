import { type AuthContext, DomainError, type SecretCodec } from '@nickhosting/core';
import {
  clearMetivaSecret,
  type Database,
  gameMetivaSecret,
  getGameMetivaStatus,
  storeSecret,
} from '@nickhosting/database';
import { trustedGameModules } from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Variables } from './app.js';

type App = Hono<{ Variables: Variables }>;
interface Options {
  db: Kysely<Database>;
  codec: SecretCodec;
  env: Readonly<Record<string, string | undefined>>;
}

export function registerOwnerMetivaRoutes(
  app: App,
  {
    db,
    codec,
    env,
    principal,
  }: Options & {
    principal(c: Context<{ Variables: Variables }>, regularOnly: boolean): Promise<AuthContext>;
  },
) {
  const path = '/v1/owner/integrations/:gameId/metiva-token';
  const scope = (id: string) => {
    if (!trustedGameModules.get(id)) throw new DomainError('not_found');
    return gameMetivaSecret(id);
  };
  app.get(path, async (c) => {
    const actor = await principal(c, true);
    const id = c.req.param('gameId');
    scope(id);
    return c.json(await getGameMetivaStatus(db, actor, id, env));
  });
  app.put(path, async (c) => {
    const actor = await principal(c, true);
    const name = scope(c.req.param('gameId'));
    if (!c.req.header('content-type')?.startsWith('application/json'))
      throw new DomainError('validation_failed');
    const parsed = z
      .strictObject({ value: z.string().max(1028) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new DomainError('validation_failed');
    await storeSecret(db, actor, codec, name, parsed.data.value, env);
    return c.body(null, 204);
  });
  app.delete(path, async (c) => {
    const actor = await principal(c, true);
    await clearMetivaSecret(db, actor, scope(c.req.param('gameId')), env);
    return c.body(null, 204);
  });
  app.delete('/v1/owner/secrets/metivaAccessToken', async (c) => {
    await clearMetivaSecret(db, await principal(c, true), 'metivaAccessToken', env);
    return c.body(null, 204);
  });
}
