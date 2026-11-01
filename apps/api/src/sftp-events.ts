import { createHash, timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';
import { DomainError, type SecretCodec } from '@nickhosting/core';
import { type Database, getSecret, getSettings } from '@nickhosting/database';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';

export const SFTP_EVENTS_PATH = '/v1/provider-events/sftpgo';
const virtualPath = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      value.startsWith('/') &&
      !value.includes('\\') &&
      [...value].every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ) &&
      posix.normalize(value) === value &&
      !value.split('/').includes('..'),
  );
export const sftpEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: z.uuid(),
    eventId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),
    // SFTPGo emits nanoseconds, outside JavaScript's safe integer range.
    timestamp: z.string().regex(/^[1-9][0-9]{15,19}$/),
    username: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,79}$/),
    event: z.enum(['upload', 'download', 'delete', 'rename', 'mkdir', 'rmdir', 'copy']),
    status: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    virtualPath,
    virtualTargetPath: z.union([z.literal(''), virtualPath]),
    fileSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    protocol: z.literal('SFTP'),
  })
  .strict()
  .refine((value) => !['rename', 'copy'].includes(value.event) || value.virtualTargetPath !== '');
export type SftpEvent = z.infer<typeof sftpEventSchema>;

/** Stable across HTTP redelivery; excludes result so retries cannot create contradictory rows. */
export function sftpEventAuditId(event: SftpEvent): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'sftpgo-event-v1',
        event.instanceId,
        event.eventId,
        event.timestamp,
        event.username,
        event.event,
        event.virtualPath,
        event.virtualTargetPath,
      ]),
    )
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export async function receiveSftpEvent(options: {
  db: Kysely<Database>;
  codec: SecretCodec;
  env: Readonly<Record<string, string | undefined>>;
  raw: string;
  headers: Headers;
}) {
  if (Buffer.byteLength(options.raw) > 65536) throw new DomainError('validation_failed', 413);
  const secret = await getSecret(options.db, options.codec, 'sftpgoEventSecret', options.env);
  if (!secret) throw new DomainError('integration_unavailable');
  const authorization = options.headers.get('authorization') ?? '';
  if (
    !timingSafeEqual(
      createHash('sha256').update(authorization).digest(),
      createHash('sha256').update(`Bearer ${secret}`).digest(),
    )
  )
    throw new DomainError('forbidden');
  let input: unknown;
  try {
    input = JSON.parse(options.raw);
  } catch {
    throw new DomainError('validation_failed');
  }
  const parsed = sftpEventSchema.safeParse(input);
  if (!parsed.success) throw new DomainError('validation_failed');
  const event = parsed.data;
  const occurredAt = new Date(Number(BigInt(event.timestamp) / 1_000_000n));
  if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() > Date.now() + 60_000)
    throw new DomainError('validation_failed');
  const { values: settings } = await getSettings(options.db, options.env);
  if (!settings.sftpgoInstanceId || event.instanceId !== settings.sftpgoInstanceId)
    throw new DomainError('forbidden');
  // A username prefix is not proof. Only a persisted provider binding grants attribution.
  // Viewer identities live in a separate table and can never pass this lookup.
  const matches = await options.db
    .selectFrom('external_sftp_credentials as credential')
    .innerJoin('managed_servers as server', 'server.id', 'credential.server_id')
    .select([
      'credential.id',
      'credential.actor_id',
      'credential.server_id',
      'credential.provider_ref',
      'credential.created_at',
      'credential.expires_at',
      'server.pterodactyl_uuid',
    ])
    .where(sql<string>`credential.provider_ref->>'username'`, '=', event.username)
    .where(sql<string>`credential.provider_ref->>'instanceId'`, '=', event.instanceId)
    .where('credential.created_at', '<=', occurredAt)
    .where(sql<boolean>`credential.provider_ref->>'credentialId' = credential.id::text`)
    .where(sql<boolean>`credential.provider_ref->>'serverId' = credential.server_id::text`)
    .where(
      sql<boolean>`credential.provider_ref->>'externalServerUuid' = server.pterodactyl_uuid::text`,
    )
    // Regrant preserves a primary username but creates a new credential row.
    // Audit attributes a proven account/server pair, not its current authorization.
    // Retained sessions may emit real events after expiry/revocation (issue #18).
    .distinctOn(['credential.actor_id', 'credential.server_id'])
    .orderBy('credential.actor_id')
    .orderBy('credential.server_id')
    .orderBy('credential.created_at', 'desc')
    .limit(2)
    .execute();
  if (matches.length !== 1) return { received: true, ignored: true };
  const credential = matches[0];
  if (!credential) return { received: true, ignored: true };
  const ref = credential.provider_ref as Record<string, unknown> | null;
  if (
    !ref ||
    ref.credentialId !== credential.id ||
    ref.serverId !== credential.server_id ||
    ref.externalServerUuid !== credential.pterodactyl_uuid ||
    occurredAt < credential.created_at
  )
    return { received: true, ignored: true };
  const operationId = sftpEventAuditId(event);
  // A single bounded statement, independent of the transfer and of browser sessions.
  await options.db
    .insertInto('audit_events')
    .values({
      id: operationId,
      actor_user_id: credential.actor_id,
      subject_user_id: credential.actor_id,
      action: `server.sftp.file.${event.event}`,
      correlation_id: operationId,
      created_at: occurredAt,
      metadata: {
        serverId: credential.server_id,
        operationId,
        outcome: event.status === 1 ? 'succeeded' : 'failed',
        path: event.virtualPath,
        ...(event.virtualTargetPath ? { target: event.virtualTargetPath } : {}),
        credentialUsername: event.username,
        source: 'sftp',
        ...(['upload', 'download', 'copy'].includes(event.event) ? { bytes: event.fileSize } : {}),
      },
    })
    .onConflict((conflict) => conflict.column('id').doNothing())
    .execute();
  return { received: true, ignored: false };
}
