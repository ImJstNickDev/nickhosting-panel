import { createHash } from 'node:crypto';
import { DomainError, type SecretCodec } from '@nickhosting/core';
import { getGameMetivaToken } from '@nickhosting/database';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  type OpenworldRelease,
  openworldReleaseSchema,
  readOpenworldArchive,
  readOpenworldCatalog,
} from '../../../games/openworld/src/catalog-source.js';
import type { DB, Environment } from './admission.js';

const tickets = 'openworld:linux-x64:install:v1';
const ticketLifetime = 30 * 60_000;
const claim = z.object({ expires: z.int().positive(), release: openworldReleaseSchema });
interface ReleaseCatalog {
  source: 'metiva' | 'official';
  syncedAt: Date;
  releases: OpenworldRelease[];
}
const runtime = 'dedicated-linux-x64';
const refreshIntervalMs = 60_000;
const refreshes = new WeakMap<
  DB,
  { key: string; nextAttempt: number; pending?: Promise<ReleaseCatalog> }
>();

export function issueOpenworldArtifactUrl(
  codec: SecretCodec,
  publicUrl: string | undefined,
  release: OpenworldRelease,
) {
  if (!publicUrl) throw new DomainError('configuration_invalid');
  const url = new URL('/v1/runtime-artifacts/openworld', publicUrl);
  const value = {
    expires: Date.now() + ticketLifetime,
    release: openworldReleaseSchema.parse(release),
  };
  const envelope = codec.encrypt(JSON.stringify(value), tickets);
  url.searchParams.set('ticket', Buffer.from(JSON.stringify(envelope)).toString('base64url'));
  return url.toString();
}
export function readOpenworldInstallTicket(codec: SecretCodec, ticket: string | undefined) {
  try {
    if (!ticket || ticket.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(ticket)) throw new Error();
    const verified = codec.decrypt(
      JSON.parse(Buffer.from(ticket, 'base64url').toString()),
      tickets,
    );
    const { expires, release } = claim.parse(JSON.parse(verified));
    if (expires <= Date.now()) throw new Error();
    return release;
  } catch {
    throw new DomainError('forbidden');
  }
}
function savedCatalog(db: DB, key: string) {
  return db
    .selectFrom('openworld_release_catalog')
    .select(['source', 'synced_at as syncedAt', 'releases'])
    .where('runtime', '=', runtime)
    .where('credential_hash', '=', key)
    .executeTakeFirst();
}

async function replaceCatalog(
  db: DB,
  token: string | undefined,
  key: string,
): Promise<ReleaseCatalog> {
  // Allocate the generation before network I/O. A slow old fetch cannot replace a
  // newer result from another API process or from a different credential.
  const { generation } = await db
    .selectNoFrom(sql<string>`nextval('openworld_catalog_sync_order')`.as('generation'))
    .executeTakeFirstOrThrow();
  const result = await readOpenworldCatalog(token);
  const values = {
    credential_hash: key,
    source: result.source,
    releases: JSON.stringify(result.releases),
    sync_order: generation,
    synced_at: sql<Date>`clock_timestamp()`,
  };
  const saved = await db
    .insertInto('openworld_release_catalog')
    .values({ runtime, ...values })
    .onConflict((c) =>
      c
        .column('runtime')
        .doUpdateSet(values)
        .where('openworld_release_catalog.sync_order', '<', generation),
    )
    .returning(['source', 'synced_at as syncedAt', 'releases'])
    .executeTakeFirst();
  if (saved) return saved;
  const newer = await savedCatalog(db, key);
  if (!newer) throw new DomainError('conflict');
  return newer;
}

export async function openworldReleaseCatalog(
  db: DB,
  codec: SecretCodec,
  env: Environment,
  mode: 'owner' | 'wizard' | 'sync',
): Promise<ReleaseCatalog> {
  const token = await getGameMetivaToken(db, codec, 'openworld', env);
  const key = createHash('sha256')
    .update(token ?? '')
    .digest('hex');
  const saved = mode === 'sync' ? undefined : await savedCatalog(db, key);
  const last = refreshes.get(db);
  const now = Date.now();
  if (
    saved &&
    (mode === 'owner' ||
      saved.syncedAt.getTime() + refreshIntervalMs > now ||
      (last?.key === key && last.nextAttempt > now))
  )
    return saved;

  let pending = last?.key === key ? last.pending : undefined;
  if (!pending) {
    const attempt: { key: string; nextAttempt: number; pending?: Promise<ReleaseCatalog> } = {
      key,
      nextAttempt: now + refreshIntervalMs,
    };
    pending = replaceCatalog(db, token, key).finally(() => {
      attempt.pending = undefined;
      attempt.nextAttempt = Date.now() + refreshIntervalMs;
    });
    attempt.pending = pending;
    refreshes.set(db, attempt);
  }
  if (saved) {
    // A wizard with a usable snapshot never waits on the network. The next
    // explicit Owner sync bypasses the backoff and reports any provider error.
    void pending.catch(() => {});
    return saved;
  }
  return pending;
}
export async function listOpenworldReleases(db: DB, codec: SecretCodec, env: Environment = {}) {
  return (await openworldReleaseCatalog(db, codec, env, 'wizard')).releases;
}

export async function downloadOpenworldRelease(
  db: DB,
  codec: SecretCodec,
  env: Environment,
  release: OpenworldRelease,
) {
  return readOpenworldArchive(release, await getGameMetivaToken(db, codec, 'openworld', env));
}
