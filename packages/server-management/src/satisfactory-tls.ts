import { spawn } from 'node:child_process';
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError, type SecretCodec } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { Kysely } from 'kysely';
import { z } from 'zod';

const identitySchema = z
  .object({ certificatePem: z.string().max(32768), privateKeyPem: z.string().max(32768) })
  .strict();
export type SatisfactoryTlsIdentity = z.infer<typeof identitySchema>;
function identityName(serverId: string) {
  if (!z.uuid().safeParse(serverId).success) throw new DomainError('configuration_invalid');
  return `gateway.satisfactory.tls.${serverId}`;
}
export function validateSatisfactoryTlsIdentity(value: unknown): SatisfactoryTlsIdentity {
  try {
    const identity = identitySchema.parse(value);
    const cert = new X509Certificate(identity.certificatePem);
    const key = createPrivateKey(identity.privateKeyPem);
    if (!cert.checkPrivateKey(key) || !cert.verify(createPublicKey(key))) throw new Error();
    return identity;
  } catch {
    throw new DomainError('secret_invalid');
  }
}
export async function generateSatisfactoryTlsIdentity(
  serverId: string,
): Promise<SatisfactoryTlsIdentity> {
  identityName(serverId);
  const directory = await mkdtemp(join(tmpdir(), 'nickhosting-tls-'));
  try {
    await new Promise<void>((resolve, reject) => {
      // RSA generation writes variable-length progress to stderr. It is not
      // protocol output and must not exhaust an execFile buffer during creation.
      const child = spawn(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:3072',
          '-sha256',
          '-nodes',
          '-days',
          '3650',
          '-subj',
          `/CN=${serverId}`,
          '-addext',
          `subjectAltName=DNS:${serverId}`,
          '-keyout',
          join(directory, 'key.pem'),
          '-out',
          join(directory, 'cert.pem'),
        ],
        { stdio: 'ignore', timeout: 30000, killSignal: 'SIGKILL' },
      );
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('certificate_generation_failed')),
      );
    });
    return validateSatisfactoryTlsIdentity({
      privateKeyPem: await readFile(join(directory, 'key.pem'), 'utf8'),
      certificatePem: await readFile(join(directory, 'cert.pem'), 'utf8'),
    });
  } catch {
    throw new DomainError('integration_unavailable');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
/** Service-only accessor. Never expose this material through user APIs or route snapshots. */
export async function readSatisfactoryTlsIdentity(
  db: Kysely<Database>,
  codec: SecretCodec,
  serverId: string,
) {
  const name = identityName(serverId);
  const row = await db
    .selectFrom('encrypted_secrets')
    .select('envelope')
    .where('name', '=', name)
    .executeTakeFirst();
  return row
    ? validateSatisfactoryTlsIdentity(JSON.parse(codec.decrypt(row.envelope, name)))
    : null;
}
/** Insert-once identity survives retries, reinstallations and provider migrations. */
export async function ensureSatisfactoryTlsIdentity(
  db: Kysely<Database>,
  codec: SecretCodec,
  serverId: string,
) {
  const existing = await readSatisfactoryTlsIdentity(db, codec, serverId);
  if (existing) return existing;
  const name = identityName(serverId);
  const identity = await generateSatisfactoryTlsIdentity(serverId);
  await db
    .insertInto('encrypted_secrets')
    .values({ name, envelope: codec.encrypt(JSON.stringify(identity), name) })
    .onConflict((conflict) => conflict.column('name').doNothing())
    .execute();
  const persisted = await readSatisfactoryTlsIdentity(db, codec, serverId);
  if (!persisted) throw new DomainError('integration_unavailable');
  return persisted;
}
