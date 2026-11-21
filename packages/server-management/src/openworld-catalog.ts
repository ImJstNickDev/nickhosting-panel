import { createHash } from 'node:crypto';
import { DomainError, type SecretCodec } from '@nickhosting/core';
import { getGameMetivaToken } from '@nickhosting/database';
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
const catalogs = new WeakMap<
  DB,
  { key: string; expires: number; pending: Promise<OpenworldRelease[]> }
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
export async function listOpenworldReleases(db: DB, codec: SecretCodec, env: Environment = {}) {
  const token = await getGameMetivaToken(db, codec, 'openworld', env);
  const key = createHash('sha256')
    .update(token ?? '')
    .digest('hex');
  const current = catalogs.get(db);
  if (current && current.key === key && current.expires > Date.now()) return current.pending;
  const pending = readOpenworldCatalog(token);
  const entry = { key, expires: Date.now() + 60_000, pending };
  catalogs.set(db, entry);
  try {
    return await pending;
  } catch (error) {
    if (catalogs.get(db) === entry) catalogs.delete(db);
    throw error;
  }
}
export async function downloadOpenworldRelease(
  db: DB,
  codec: SecretCodec,
  env: Environment,
  release: OpenworldRelease,
) {
  return readOpenworldArchive(release, await getGameMetivaToken(db, codec, 'openworld', env));
}
