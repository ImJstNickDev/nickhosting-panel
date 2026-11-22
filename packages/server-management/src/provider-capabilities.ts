import { createHash } from 'node:crypto';
import type { Database } from '@nickhosting/database';
import {
  discoverNickHostingExtension,
  nickHostingExtensionSchema,
} from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql } from 'kysely';

export function providerCredentialBinding(baseURL: string, applicationKey?: string) {
  return createHash('sha256')
    .update(JSON.stringify([baseURL, applicationKey]))
    .digest('hex');
}

/** Checking features confers no authority over any provider resource. Serialize
 * concurrent probes and always return the timestamp of the original request. */
export async function providerCapabilities(
  db: Kysely<Database>,
  options: Parameters<typeof discoverNickHostingExtension>[0],
) {
  const binding = providerCredentialBinding(options.baseURL, options.applicationKey);
  return db.transaction().execute(async (tx) => {
    const { rows } = await sql<{
      binding: string | null;
      checked_at: Date | null;
      extension: unknown;
    }>`
      select binding, checked_at, extension from blueprint_capability_discovery
      where singleton for update`.execute(tx);
    const previous = rows[0];
    const checkedAt = new Date();
    if (previous?.binding === binding && previous.checked_at) {
      const age = checkedAt.getTime() - previous.checked_at.getTime();
      const payload = nickHostingExtensionSchema.nullable().safeParse(previous.extension);
      if (age >= 0 && age < 60000 && payload.success)
        return { binding, checkedAt: previous.checked_at, extension: payload.data };
    }
    const extension = await discoverNickHostingExtension(options);
    await sql`update blueprint_capability_discovery set binding = ${binding}, checked_at = ${checkedAt},
      extension = ${JSON.stringify(extension)}::jsonb where singleton`.execute(tx);
    return { binding, checkedAt, extension };
  });
}
