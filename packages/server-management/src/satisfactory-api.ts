import { randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { type AuthContext, DomainError, type SecretCodec } from '@nickhosting/core';
import { type Database, recordAudit } from '@nickhosting/database';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import {
  SatisfactoryApi,
  type SatisfactoryApiTransport,
} from '../../../games/satisfactory/src/api.js';
import { decodeNativePlayerIdentity } from '../../../games/satisfactory/src/native-auth.js';
import {
  satisfactoryAdvancedSettingsSchema,
  satisfactoryAdvancedSettingsUpdateSchema,
} from '../../../games/satisfactory/src/settings.js';
import {
  changeSatisfactoryWorld,
  type SatisfactoryWorldAction,
} from '../../../games/satisfactory/src/worlds.js';
import { authorizeServer } from './registry.js';
import { readSatisfactoryTlsIdentity } from './satisfactory-tls.js';

const tokenSchema = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/);
function tokenName(id: string): string {
  return `satisfactory.api-token.${z.uuid().parse(id)}`;
}
export function satisfactoryPinnedTransport(
  endpoint: { address: string; port: number },
  certificatePem: string,
  token: string,
  playerId?: string,
): SatisfactoryApiTransport {
  if (playerId !== undefined && !decodeNativePlayerIdentity(playerId))
    throw new DomainError('validation_failed');
  const secret = tokenSchema.parse(token),
    expected = new X509Certificate(certificatePem).raw;
  if (
    !isIP(endpoint.address) ||
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65535
  )
    throw new DomainError('configuration_invalid');
  return {
    request(body, signal) {
      return new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify(body));
        const req = request(
          {
            hostname: endpoint.address,
            port: endpoint.port,
            path: '/api/v1',
            method: 'POST',
            agent: false,
            ca: certificatePem,
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
            checkServerIdentity: (_host, cert) =>
              !cert.raw ||
              cert.raw.length !== expected.length ||
              !timingSafeEqual(cert.raw, expected)
                ? new Error('certificate_mismatch')
                : undefined,
            headers: {
              Authorization: `Bearer ${secret}`,
              ...(playerId ? { 'X-FactoryGame-PlayerId': playerId } : {}),
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Length': String(payload.length),
            },
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
              : AbortSignal.timeout(10000),
          },
          (res) => {
            if (res.statusCode === 204) {
              res.resume();
              resolve(undefined);
              return;
            }
            if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
              res.resume();
              reject(
                new DomainError(
                  playerId && res.statusCode === 401
                    ? 'unauthenticated'
                    : playerId && res.statusCode === 403
                      ? 'forbidden'
                      : 'integration_unavailable',
                ),
              );
              return;
            }
            const chunks: Buffer[] = [];
            let length = 0;
            res.on('data', (chunk: Buffer) => {
              length += chunk.length;
              if (length > 1048576) {
                res.destroy();
                reject(new DomainError('integration_unavailable'));
              } else chunks.push(chunk);
            });
            res.on('error', () => reject(new DomainError('integration_unavailable')));
            res.on('end', () => {
              try {
                const text = Buffer.concat(chunks).toString('utf8');
                // Map changes can acknowledge with HTTP 202 and an empty body.
                // Keep undefined reserved for 204 authentication verification.
                resolve(res.statusCode === 202 && text.length === 0 ? {} : JSON.parse(text));
              } catch {
                reject(new DomainError('integration_unavailable'));
              }
            });
          },
        );
        req.on('error', () => reject(new DomainError('integration_unavailable')));
        req.end(payload);
      });
    },
  };
}
async function target(db: Kysely<Database>, id: string) {
  const server = await db
    .selectFrom('managed_servers as s')
    .innerJoin('runtime_egg_mappings as m', 'm.id', 's.mapping_id')
    .select([
      's.id',
      's.active_operation_id',
      's.installation_state',
      's.runtime_state',
      'm.game_id',
    ])
    .where('s.id', '=', id)
    .where('s.deleted_at', 'is', null)
    .executeTakeFirst();
  if (server?.game_id !== 'satisfactory') throw new DomainError('not_found');
  const allocation = await db
    .selectFrom('server_allocations')
    .select(['backend_address', 'port'])
    .where('server_id', '=', id)
    .where('role', '=', 'game')
    .executeTakeFirst();
  if (!allocation?.backend_address) throw new DomainError('integration_unavailable');
  return { server, endpoint: { address: allocation.backend_address, port: allocation.port } };
}
export async function satisfactoryApiConfigured(
  db: Kysely<Database>,
  serverId: string,
): Promise<boolean> {
  return !!(await db
    .selectFrom('encrypted_secrets')
    .select('name')
    .where('name', '=', tokenName(serverId))
    .executeTakeFirst());
}
export async function resolveSatisfactoryApi(
  db: Kysely<Database>,
  codec: SecretCodec,
  serverId: string,
  overrideToken?: string,
  playerId?: string,
): Promise<SatisfactoryApi> {
  const { endpoint } = await target(db, serverId);
  const identity = await readSatisfactoryTlsIdentity(db, codec, serverId);
  if (!identity) throw new DomainError('integration_unavailable');
  const name = tokenName(serverId);
  const stored =
    overrideToken === undefined
      ? await db
          .selectFrom('encrypted_secrets')
          .select('envelope')
          .where('name', '=', name)
          .executeTakeFirst()
      : undefined;
  const token = overrideToken ?? (stored ? codec.decrypt(stored.envelope, name) : undefined);
  if (!token) throw new DomainError('configuration_invalid');
  return new SatisfactoryApi(
    satisfactoryPinnedTransport(endpoint, identity.certificatePem, token, playerId),
  );
}
async function locked<T>(
  db: Kysely<Database>,
  context: AuthContext,
  id: string,
  work: (db: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.connection().execute(async (connection) => {
    const result = await sql<{
      acquired: boolean;
    }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${`:nickhosting:server:${id}`},0)) as acquired`.execute(
      connection,
    );
    if (!result.rows[0]?.acquired) throw new DomainError('conflict');
    try {
      const server = await authorizeServer(connection, context, id, 'server:manage');
      if (server.active_operation_id) throw new DomainError('conflict');
      await target(connection, id);
      return await work(connection);
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${`:nickhosting:server:${id}`},0))`.execute(
        connection,
      );
    }
  });
}
export async function setSatisfactoryApiToken(
  db: Kysely<Database>,
  codec: SecretCodec,
  context: AuthContext,
  id: string,
  input: unknown,
): Promise<void> {
  const token = tokenSchema.parse(input);
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64').toString('utf8'));
    if (payload.pl !== 'APIToken') throw new Error();
  } catch {
    throw new DomainError('validation_failed');
  }
  await locked(db, context, id, async (connection) => {
    await (await resolveSatisfactoryApi(connection, codec, id, token)).state();
    await authorizeServer(connection, context, id, 'server:manage');
    const name = tokenName(id);
    await connection
      .insertInto('encrypted_secrets')
      .values({ name, envelope: codec.encrypt(token, name) })
      .onConflict((c) => c.column('name').doUpdateSet({ envelope: codec.encrypt(token, name) }))
      .execute();
    await recordAudit(connection, context, 'satisfactory.api-token.updated', { serverId: id });
  });
}
export async function applySatisfactoryOptions(
  db: Kysely<Database>,
  codec: SecretCodec,
  context: AuthContext,
  id: string,
  input: unknown,
): Promise<void> {
  const options = z.record(z.string().min(1).max(256), z.string().max(4096)).parse(input);
  if (Object.keys(options).length > 128) throw new DomainError('validation_failed');
  await locked(db, context, id, async (connection) => {
    const api = await resolveSatisfactoryApi(connection, codec, id);
    await recordAudit(connection, context, 'satisfactory.options.requested', {
      serverId: id,
      keys: Object.keys(options),
    });
    await authorizeServer(connection, context, id, 'server:manage');
    await api.applyOptions(options);
    await recordAudit(connection, context, 'satisfactory.options.updated', {
      serverId: id,
      keys: Object.keys(options),
    });
  });
}

export async function mutateSatisfactoryWorld(
  db: Kysely<Database>,
  codec: SecretCodec,
  context: AuthContext,
  id: string,
  request: SatisfactoryWorldAction,
): Promise<void> {
  await locked(db, context, id, async (connection) => {
    const { server } = await target(connection, id);
    if (server.installation_state !== 'installed' || server.runtime_state !== 'running')
      throw new DomainError('conflict');
    const api = await resolveSatisfactoryApi(connection, codec, id);
    const safetySave = `nickhosting_before_${request.action}_${randomUUID().replaceAll('-', '')}`;
    await recordAudit(connection, context, `satisfactory.world.${request.action}.requested`, {
      serverId: id,
      safetySave,
    });
    await changeSatisfactoryWorld(api, request, safetySave, () =>
      authorizeServer(connection, context, id, 'server:manage').then(() => undefined),
    );
    await recordAudit(
      connection,
      context,
      `satisfactory.world.${request.action}.${request.action === 'save' ? 'completed' : 'accepted'}`,
      {
        serverId: id,
      },
    );
  });
}
export async function applySatisfactoryAdvancedSettings(
  db: Kysely<Database>,
  codec: SecretCodec,
  context: AuthContext,
  id: string,
  input: unknown,
): Promise<void> {
  const parsed = satisfactoryAdvancedSettingsUpdateSchema.parse(input);
  await locked(db, context, id, async (connection) => {
    const { server } = await target(connection, id);
    if (server.installation_state !== 'installed' || server.runtime_state !== 'running')
      throw new DomainError('conflict');
    const api = await resolveSatisfactoryApi(connection, codec, id);
    const [state, current] = await Promise.all([
      api.state(),
      api.advancedSettings().then((value) => satisfactoryAdvancedSettingsSchema.parse(value)),
    ]);
    if (
      !state.isGameRunning ||
      state.activeSessionName !== parsed.expectedSessionName ||
      (!current.creativeModeEnabled && !parsed.confirmEnable)
    )
      throw new DomainError('conflict');
    if (
      Object.keys(parsed.settings).some((key) => !Object.hasOwn(current.advancedGameSettings, key))
    )
      throw new DomainError('validation_failed');
    await recordAudit(connection, context, 'satisfactory.advanced-settings.requested', {
      serverId: id,
      keys: Object.keys(parsed.settings),
    });
    await authorizeServer(connection, context, id, 'server:manage');
    await api.applyAdvancedSettings(parsed.settings);
    await recordAudit(connection, context, 'satisfactory.advanced-settings.updated', {
      serverId: id,
      keys: Object.keys(parsed.settings),
    });
  });
}
