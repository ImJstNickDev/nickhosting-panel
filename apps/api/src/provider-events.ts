import { DomainError, type SecretCodec } from '@nickhosting/core';
import { type Database, getSettings } from '@nickhosting/database';
import {
  providerEventSchema,
  verifyProviderEventSignature,
} from '@nickhosting/pterodactyl-adapter';
import { applyProviderBackupEvent, applyProviderChange } from '@nickhosting/server-management';
import type { Kysely } from 'kysely';

export const PROVIDER_EVENTS_PATH = '/v1/provider-events/pterodactyl';
export async function receiveProviderEvent(options: {
  db: Kysely<Database>;
  codec: SecretCodec;
  env: Readonly<Record<string, string | undefined>>;
  raw: string;
  headers: Headers;
}) {
  if (Buffer.byteLength(options.raw) > 65536) throw new DomainError('validation_failed', 413);
  // No session/cookie authority: only the scoped raw-body signature can authenticate this route.
  let input: unknown;
  try {
    input = JSON.parse(options.raw);
  } catch {
    throw new DomainError('validation_failed');
  }
  const parsed = providerEventSchema.safeParse(input);
  if (!parsed.success) throw new DomainError('validation_failed');
  const instanceId = parsed.data.instanceId;
  const [feed, { values }, secret] = await Promise.all([
    options.db
      .selectFrom('provider_change_feeds')
      .selectAll()
      .where('instance_id', '=', instanceId)
      .executeTakeFirst(),
    getSettings(options.db, options.env),
    options.db
      .selectFrom('encrypted_secrets')
      .select('envelope')
      .where('name', '=', `blueprintWebhook:${instanceId}`)
      .executeTakeFirst(),
  ]);
  if (
    !feed?.enabled ||
    !secret ||
    feed.provider_url !== values.pterodactylBaseUrl?.replace(/\/$/, '') ||
    feed.callback_url !== new URL(PROVIDER_EVENTS_PATH, values.publicUrl).href
  )
    throw new DomainError('forbidden');
  const event = verifyProviderEventSignature({
    body: options.raw,
    timestamp: options.headers.get('x-nickhosting-timestamp') ?? '',
    signature: options.headers.get('x-nickhosting-signature') ?? '',
    eventId: options.headers.get('x-nickhosting-event-id') ?? '',
    secret: options.codec.decrypt(secret.envelope, `blueprintWebhook:${instanceId}`),
  });
  if (event.type === 'backup.completed' || event.type === 'backup.restore-completed')
    await applyProviderBackupEvent(options.db, event);
  else await applyProviderChange(options.db, event);
  return { received: true };
}
